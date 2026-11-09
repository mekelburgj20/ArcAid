import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

/**
 * A33 (v2.232.0): a player joins an event's AtGames private tournament from
 * Arcaid. Pinned:
 *   - the invitation code comes from the event row, never the client;
 *   - the player's AtGames session is forgotten whether the join works or not
 *     (owner 2026-11-08: ask every time, store nothing);
 *   - a wrong password is a 401 with no join attempt;
 *   - the public event payload names the code to signed-in viewers only.
 */

const calls = { joinCodes: [] as string[], forgets: 0, signIns: 0, lists: 0 };
let signInFails = false;
/** The signed-in player's own AtGames tournaments (A40), or an error to throw. */
let myTournaments: unknown[] | Error = [];

vi.mock('../services/AtGamesPrivateClient.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/AtGamesPrivateClient.js')>();
    class FakeClient {
        async ensureSession() {
            calls.signIns++;
            if (signInFails) throw new actual.AtGamesAuthError('AtGames login failed for p***@x.com (HTTP 500)');
            return { token: 't', accountId: 555, userName: 'Player', expiresAt: null };
        }
        async joinPrivateTournament(code: string) { calls.joinCodes.push(code); return { id: 1260, name: 'AtGames Night' }; }
        async listPrivateTournaments() {
            calls.lists++;
            if (myTournaments instanceof Error) throw myTournaments;
            return myTournaments;
        }
        forget() { calls.forgets++; }
    }
    return { ...actual, AtGamesPrivateClient: FakeClient };
});

// This file makes more joins than the real 5-per-minute login limiter allows.
vi.mock('../api/rateLimit.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../api/rateLimit.js')>();
    const pass = (_req: unknown, _res: unknown, next: () => void) => next();
    return { ...actual, authLimiter: pass };
});

const { setupTestDb, createTestRoom } = await import('./helpers.js');
const { getDatabase } = await import('../database/database.js');
const { signToken } = await import('../api/auth.js');
const { EventService } = await import('../services/EventService.js');

async function app() {
    const a = express();
    a.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    a.use('/api/rooms', roomsRouter);
    return a;
}

describe('POST /:roomId/events/:id/atgames-join', () => {
    let roomId: string;
    let eventId: string;
    const player = () => signToken({ role: 'player', gameRoomIds: [], discordId: 'player-1', username: 'player-1' });

    beforeEach(async () => {
        calls.joinCodes.length = 0; calls.forgets = 0; calls.signIns = 0; calls.lists = 0; signInFails = false;
        myTournaments = [];
        await setupTestDb();
        roomId = await createTestRoom(`atj-${crypto.randomUUID().slice(0, 8)}`, 'ATJ Room');
        const db = await getDatabase();
        eventId = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, atgames_tournament_id, atgames_invite_code)
             VALUES (?, 'AtGames Night', 'DG', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event', '1260', 'ETX2MKJ')`,
            eventId, roomId,
        );
        const start = Date.now() + 60 * 60_000;
        await EventService.createOrUpdateEvent(eventId, {
            rounds: [{ roundNo: 1, gameName: 'Soccer Kings Deluxe', scheduledStartAt: new Date(start).toISOString(), scheduledEndAt: new Date(start + 30 * 60_000).toISOString() }],
            checkinRequired: false,
        });
    });

    it('joins with the code from the event row (ignoring any sent by the client), links, and forgets the session', async () => {
        const res = await request(await app())
            .post(`/api/rooms/${roomId}/events/${eventId}/atgames-join`)
            .set('Authorization', `Bearer ${player()}`)
            .send({ email: 'p@x.com', password: 'secret', invitationCode: 'EVIL123' });
        expect(res.status).toBe(200);
        expect(res.body.linked).toBe(true);
        expect(calls.joinCodes).toEqual(['ETX2MKJ']);
        expect(calls.forgets).toBe(1);

        const db = await getDatabase();
        const link = await db.get('SELECT 1 AS ok FROM user_identity_links WHERE provider_user_id = ?', 'atgames:555');
        expect(link).toBeTruthy();
    });

    it('a wrong password is a 401, no join, session still forgotten', async () => {
        signInFails = true;
        const res = await request(await app())
            .post(`/api/rooms/${roomId}/events/${eventId}/atgames-join`)
            .set('Authorization', `Bearer ${player()}`)
            .send({ email: 'p@x.com', password: 'wrong' });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('ATGAMES_AUTH');
        expect(calls.joinCodes).toEqual([]);
        expect(calls.forgets).toBe(1);
    });

    it('needs a signed-in player and a linked event', async () => {
        const a = await app();
        const signedOut = await request(a).post(`/api/rooms/${roomId}/events/${eventId}/atgames-join`).send({ email: 'p@x.com', password: 'x' });
        expect(signedOut.status).toBe(401);

        const db = await getDatabase();
        await db.run('UPDATE tournaments SET atgames_invite_code = NULL WHERE id = ?', eventId);
        const unlinked = await request(a)
            .post(`/api/rooms/${roomId}/events/${eventId}/atgames-join`)
            .set('Authorization', `Bearer ${player()}`)
            .send({ email: 'p@x.com', password: 'x' });
        expect(unlinked.status).toBe(400);
        expect(calls.signIns).toBe(0);
    });

    it('the public event payload shows the code to signed-in viewers only', async () => {
        const a = await app();
        const anon = await request(a).get(`/api/rooms/${roomId}/events/${eventId}`);
        expect(anon.body.atgames).toEqual({ joinable: true, code: null, joinedVia: null });
        const signed = await request(a).get(`/api/rooms/${roomId}/events/${eventId}`).set('Authorization', `Bearer ${player()}`);
        expect(signed.body.atgames).toEqual({ joinable: true, code: 'ETX2MKJ', joinedVia: null });
    });

    // ---- A40 (v2.237.0): Joined follows the player ----

    const join = async (a: express.Express, token = player()) => request(a)
        .post(`/api/rooms/${roomId}/events/${eventId}/atgames-join`)
        .set('Authorization', `Bearer ${token}`)
        .send({ email: 'p@x.com', password: 'secret' });
    const joinedVia = async (a: express.Express, token: string) =>
        (await request(a).get(`/api/rooms/${roomId}/events/${eventId}`).set('Authorization', `Bearer ${token}`)).body.atgames.joinedVia;

    it('a join is stored for the player, so the event page reads Joined on any device', async () => {
        const a = await app();
        const res = await join(a);
        expect(res.body.alreadyMember).toBe(false);
        expect(await joinedVia(a, player())).toBe('arcaid');
        const other = signToken({ role: 'player', gameRoomIds: [], discordId: 'player-2', username: 'player-2' });
        expect(await joinedVia(a, other)).toBeNull();
    });

    it('a player already in the tournament (joined in the AtGames app) is told so, not refused', async () => {
        myTournaments = [{ id: 1260, name: 'AtGames Night', invitationCode: 'ETX2MKJ', membershipRole: 'MEMBER' }];
        const a = await app();
        const res = await join(a);
        expect(res.status).toBe(200);
        expect(res.body.alreadyMember).toBe(true);
        expect(res.body.linked).toBe(true);
        expect(calls.joinCodes).toEqual([]);
        expect(calls.forgets).toBe(1);
        expect(await joinedVia(a, player())).toBe('verified');

        const db = await getDatabase();
        const row = await db.get<{ summary: string }>(
            `SELECT summary FROM activity_log WHERE event_type = 'atgames_joined' AND tournament_id = ?`, eventId,
        );
        expect(row?.summary).toMatch(/already in the AtGames tournament/);
    });

    it('a failed look at the player\'s own list falls through to the join', async () => {
        myTournaments = new Error('AtGames list timed out');
        const res = await join(await app());
        expect(res.status).toBe(200);
        expect(res.body.alreadyMember).toBe(false);
        expect(calls.joinCodes).toEqual(['ETX2MKJ']);
    });

    it('"Already joined" marks the viewer joined with no AtGames call, and the undo takes it back', async () => {
        const a = await app();
        const path = `/api/rooms/${roomId}/events/${eventId}/atgames-joined`;
        const marked = await request(a).post(path).set('Authorization', `Bearer ${player()}`).send({});
        expect(marked.status).toBe(200);
        expect(marked.body.joinedVia).toBe('self');
        expect(calls.signIns).toBe(0);
        expect(await joinedVia(a, player())).toBe('self');

        const undone = await request(a).delete(path).set('Authorization', `Bearer ${player()}`);
        expect(undone.body.joinedVia).toBeNull();
        expect(await joinedVia(a, player())).toBeNull();
    });

    it('the undo never removes a join Arcaid saw, and a self mark never downgrades one', async () => {
        const a = await app();
        await join(a);
        const path = `/api/rooms/${roomId}/events/${eventId}/atgames-joined`;
        const marked = await request(a).post(path).set('Authorization', `Bearer ${player()}`).send({});
        expect(marked.body.joinedVia).toBe('arcaid');
        const undone = await request(a).delete(path).set('Authorization', `Bearer ${player()}`);
        expect(undone.body.joinedVia).toBe('arcaid');
    });

    it('a self mark is upgraded when the player later joins through Arcaid', async () => {
        const a = await app();
        await request(a).post(`/api/rooms/${roomId}/events/${eventId}/atgames-joined`).set('Authorization', `Bearer ${player()}`).send({});
        await join(a);
        expect(await joinedVia(a, player())).toBe('arcaid');
    });

    it('"Already joined" needs a signed-in player and a linked, unfinished event', async () => {
        const a = await app();
        const path = `/api/rooms/${roomId}/events/${eventId}/atgames-joined`;
        expect((await request(a).post(path).send({})).status).toBe(401);

        const db = await getDatabase();
        await db.run(`UPDATE tournaments SET event_finished_at = datetime('now') WHERE id = ?`, eventId);
        expect((await request(a).post(path).set('Authorization', `Bearer ${player()}`).send({})).status).toBe(400);

        await db.run(`UPDATE tournaments SET event_finished_at = NULL, atgames_invite_code = NULL WHERE id = ?`, eventId);
        const unlinked = await request(a).post(path).set('Authorization', `Bearer ${player()}`).send({});
        expect(unlinked.status).toBe(400);
        expect(unlinked.body.code).toBe('NOT_LINKED');
    });

    it('reads through the identity link: a Google sign-in sees the Discord account\'s mark', async () => {
        const a = await app();
        const db = await getDatabase();
        await db.run(`INSERT OR IGNORE INTO user_identity_links (provider_user_id, canonical_user_id) VALUES ('google:p1', 'player-1')`);
        await request(a).post(`/api/rooms/${roomId}/events/${eventId}/atgames-joined`).set('Authorization', `Bearer ${player()}`).send({});
        const google = signToken({ role: 'player', gameRoomIds: [], discordId: 'google:p1', username: 'p1' });
        expect(await joinedVia(a, google)).toBe('self');
    });

    it('a linked player whose AtGames score in the event was already pulled reads as joined', async () => {
        const a = await app();
        const db = await getDatabase();
        // A pulled score of a linked player, and one of a player who links later.
        await db.run(
            `INSERT INTO score_history (game_name, game_room_id, iscored_username, discord_user_id, score, source, submitted_by_user_id, submitted_during_tournament_id)
             VALUES ('Soccer Kings Deluxe', ?, 'Player', 'player-1', 1000, 'atgames', 'player-1', ?),
                    ('Soccer Kings Deluxe', ?, 'Later', 'atgames:777', 900, 'atgames', NULL, ?),
                    ('Soccer Kings Deluxe', ?, 'Typed', 'player-4', 800, 'tournament', 'player-4', ?)`,
            roomId, eventId, roomId, eventId, roomId, eventId,
        );
        expect(await joinedVia(a, player())).toBe('scores');

        const later = signToken({ role: 'player', gameRoomIds: [], discordId: 'player-3', username: 'player-3' });
        expect(await joinedVia(a, later)).toBeNull();
        await db.run(`INSERT OR IGNORE INTO user_identity_links (provider_user_id, canonical_user_id) VALUES ('atgames:777', 'player-3')`);
        expect(await joinedVia(a, later)).toBe('scores');

        // A typed score proves nothing about AtGames.
        const typed = signToken({ role: 'player', gameRoomIds: [], discordId: 'player-4', username: 'player-4' });
        expect(await joinedVia(a, typed)).toBeNull();
    });
});

describe('AtGamesJoinService.isMember', () => {
    it('matches the event\'s AtGames tournament by id or by invitation code, case-insensitively', async () => {
        const { AtGamesJoinService } = await import('../services/AtGamesJoinService.js');
        const list = [{ id: 1260, name: 'AtGames Night', invitationCode: 'ETX2MKJ' }];
        expect(AtGamesJoinService.isMember(list, { atgamesId: '1260', code: null })).toBe(true);
        expect(AtGamesJoinService.isMember(list, { atgamesId: null, code: 'etx2mkj ' })).toBe(true);
        expect(AtGamesJoinService.isMember(list, { atgamesId: '999', code: 'OTHER' })).toBe(false);
        expect(AtGamesJoinService.isMember([], { atgamesId: '1260', code: 'ETX2MKJ' })).toBe(false);
    });
});

describe('GET /:roomId/atgames/joinable (A36, scoreboard card button)', () => {
    it('lists only ACTIVE rounds of linked, unfinished events; the code only for a signed-in viewer', async () => {
        await setupTestDb();
        await seedLinkedEvent();
        const db = await getDatabase();
        const a = await app();

        // Round still SCHEDULED: no button yet.
        let res = await request(a).get(`/api/rooms/${linkedRoom}/atgames/joinable`);
        expect(res.body.games).toEqual([]);

        await db.run(`UPDATE games SET status = 'ACTIVE' WHERE tournament_id = ? AND round_no = 1`, linkedEvent);
        const round = await db.get<{ id: string }>('SELECT id FROM games WHERE tournament_id = ? AND round_no = 1', linkedEvent);

        res = await request(a).get(`/api/rooms/${linkedRoom}/atgames/joinable`);
        expect(res.body.games).toEqual([{ gameId: round!.id, tournamentId: linkedEvent, tournamentName: 'Card Night', code: null, joinedVia: null }]);

        const token = signToken({ role: 'player', gameRoomIds: [], discordId: 'p-2', username: 'p-2' });
        res = await request(a).get(`/api/rooms/${linkedRoom}/atgames/joinable`).set('Authorization', `Bearer ${token}`);
        expect(res.body.games[0].code).toBe('CARD123');
        expect(res.body.games[0].joinedVia).toBeNull();

        // A40: the card reads the viewer's server-side join.
        await request(a).post(`/api/rooms/${linkedRoom}/events/${linkedEvent}/atgames-joined`).set('Authorization', `Bearer ${token}`).send({});
        res = await request(a).get(`/api/rooms/${linkedRoom}/atgames/joinable`).set('Authorization', `Bearer ${token}`);
        expect(res.body.games[0].joinedVia).toBe('self');
        res = await request(a).get(`/api/rooms/${linkedRoom}/atgames/joinable`);
        expect(res.body.games[0].joinedVia).toBeNull();

        // Finished event: gone.
        await db.run(`UPDATE tournaments SET event_finished_at = datetime('now') WHERE id = ?`, linkedEvent);
        res = await request(a).get(`/api/rooms/${linkedRoom}/atgames/joinable`);
        expect(res.body.games).toEqual([]);
    });
});

let linkedRoom = '';
let linkedEvent = '';
async function seedLinkedEvent() {
    linkedRoom = await createTestRoom(`card-${crypto.randomUUID().slice(0, 8)}`, 'Card Room');
    linkedEvent = crypto.randomUUID();
    const db = await getDatabase();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, atgames_tournament_id, atgames_invite_code)
         VALUES (?, 'Card Night', 'DG', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event', '1262', 'CARD123')`,
        linkedEvent, linkedRoom,
    );
    const start = Date.now() + 60 * 60_000;
    await EventService.createOrUpdateEvent(linkedEvent, {
        rounds: [{ roundNo: 1, gameName: 'Arkanoid (Pinball)', scheduledStartAt: new Date(start).toISOString(), scheduledEndAt: new Date(start + 30 * 60_000).toISOString() }],
        checkinRequired: false,
    });
}
