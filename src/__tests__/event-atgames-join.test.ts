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

const calls = { joinCodes: [] as string[], forgets: 0, signIns: 0 };
let signInFails = false;

vi.mock('../services/AtGamesPrivateClient.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/AtGamesPrivateClient.js')>();
    class FakeClient {
        async ensureSession() {
            calls.signIns++;
            if (signInFails) throw new actual.AtGamesAuthError('AtGames login failed for p***@x.com (HTTP 500)');
            return { token: 't', accountId: 555, userName: 'Player', expiresAt: null };
        }
        async joinPrivateTournament(code: string) { calls.joinCodes.push(code); return { id: 1260, name: 'AtGames Night' }; }
        forget() { calls.forgets++; }
    }
    return { ...actual, AtGamesPrivateClient: FakeClient };
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
        calls.joinCodes.length = 0; calls.forgets = 0; calls.signIns = 0; signInFails = false;
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
        expect(anon.body.atgames).toEqual({ joinable: true, code: null });
        const signed = await request(a).get(`/api/rooms/${roomId}/events/${eventId}`).set('Authorization', `Bearer ${player()}`);
        expect(signed.body.atgames).toEqual({ joinable: true, code: 'ETX2MKJ' });
    });
});
