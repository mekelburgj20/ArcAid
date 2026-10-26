import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { entryAllowed } from '../utils/tournamentEntry.js';
import { TournamentEntryService, NOT_ON_ROSTER_MESSAGE } from '../services/TournamentEntryService.js';

/**
 * Tournament entry — `Entry: Room members` / `Invited players` (v2.179.0, W39,
 * ADR 0033 §6). Owner rulings 2026-10-26: the roster is its own list and an
 * invite-only event that requires check-in still needs check-in; an invite
 * link joins the room and enters the tournament; typed scores are roster-only.
 */

const USER = '123456789012345678';
const OTHER = '223456789012345678';
const DESKTOP = 'castcade-entry-1';
const MINUTE = 60_000;

const playerToken = (discordId: string) =>
    signToken({ role: 'player', gameRoomIds: [], discordId, username: discordId });
const adminToken = (roomId: string) =>
    signToken({ role: 'room_admin', discordId: 'admin-1', username: 'Admin', gameRoomIds: [roomId] });

async function createApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    const { default: entryRouter } = await import('../api/routes/entry.js');
    app.use('/api', entryRouter);
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

async function addMember(roomId: string, userId: string) {
    const db = await getDatabase();
    await db.run(`INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'submission')`, userId, roomId);
}

async function createRotation(roomId: string, opts: { invited?: boolean; link?: boolean; request?: boolean } = {}) {
    const db = await getDatabase();
    const tournamentId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, entry_mode, entry_methods)
         VALUES (?, 'Invite Cup', 'WG', 'pinball', '{}', 1, ?, 'rotation', ?, ?)`,
        tournamentId, roomId, opts.invited ? 'invited' : 'members',
        JSON.stringify({ link: !!opts.link, request: !!opts.request }),
    );
    if (opts.invited && opts.link) await TournamentEntryService.ensureInviteCode(tournamentId);
    const gameId = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, game_room_id, start_date) VALUES (?, ?, 'Bad Cats', 'ACTIVE', ?, ?)`,
        gameId, tournamentId, roomId, new Date(Date.now() - 60 * MINUTE).toISOString(),
    );
    return { tournamentId, gameId };
}

async function createEvent(roomId: string, opts: { invited: boolean; checkin: boolean }) {
    const db = await getDatabase();
    const tournamentId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, checkin_required, entry_mode)
         VALUES (?, 'Invite Night', 'WG', 'pinball', '{}', 1, ?, 'event', ?, ?)`,
        tournamentId, roomId, opts.checkin ? 1 : 0, opts.invited ? 'invited' : 'members',
    );
    return tournamentId;
}

describe('entryAllowed — the one rule (W39)', () => {
    const base = { format: 'rotation' as const, roomless: false, checkinRequired: false, isMember: true, isParticipant: false };
    it('members mode is unchanged: a member is in', () => {
        expect(entryAllowed(base)).toBe(true);
        expect(entryAllowed({ ...base, entryMode: 'members' })).toBe(true);
    });
    it('invited: only the roster, membership is not enough', () => {
        expect(entryAllowed({ ...base, entryMode: 'invited', onRoster: false })).toBe(false);
        expect(entryAllowed({ ...base, isMember: false, entryMode: 'invited', onRoster: true })).toBe(true);
    });
    it('invited event that requires check-in: roster AND check-in', () => {
        const ev = { ...base, format: 'event' as const, checkinRequired: true, entryMode: 'invited' as const };
        expect(entryAllowed({ ...ev, onRoster: true, isParticipant: false })).toBe(false);
        expect(entryAllowed({ ...ev, onRoster: false, isParticipant: true })).toBe(false);
        expect(entryAllowed({ ...ev, onRoster: true, isParticipant: true })).toBe(true);
    });
});

describe('invite-only tournaments', () => {
    let app: express.Express;
    let roomId: string;

    beforeEach(async () => {
        app = await createApp();
        roomId = await createTestRoom('entry-room', 'Entry Room');
        await addMember(roomId, USER);
    }, 60_000); // the first run imports three routers

    it('typed scores: a member not on the roster is refused (403 NOT_ON_ROSTER); on the roster the gate passes', async () => {
        const { tournamentId } = await createRotation(roomId, { invited: true });
        const res = await request(app)
            .post(`/api/rooms/${roomId}/community-scores/${encodeURIComponent('Bad Cats')}`)
            .set('Authorization', `Bearer ${playerToken(USER)}`)
            .send({ score: 1000, engine: 'vpx', device: 'pc' });
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: NOT_ON_ROSTER_MESSAGE, code: 'NOT_ON_ROSTER' });

        await TournamentEntryService.addToRoster(tournamentId, USER, 'host', 'admin-1');
        expect(await TournamentEntryService.checkRosterSubmission(tournamentId, USER)).toEqual({ ok: true });
        // A members-mode tournament never asks.
        const open = await createRotation(roomId);
        expect(await TournamentEntryService.checkRosterSubmission(open.tournamentId, OTHER)).toEqual({ ok: true });
    });

    it('device scores: not on the roster → not on the board; on the roster → lands', async () => {
        const codeRes = await request(app).post('/api/me/witness/pairing-code')
            .set('Authorization', `Bearer ${playerToken(USER)}`).send({});
        const pair = await request(app).get('/api/witness/pair')
            .query({ code: codeRes.body.code, device: DESKTOP, username: 'Owner', type: 'desktop' });
        const token = pair.body.token as string;
        const { tournamentId, gameId } = await createRotation(roomId, { invited: true });
        const db = await getDatabase();
        const play = (score: number) => {
            const ended = Math.floor(Date.now() / 1000);
            return request(app).get('/api/witness/score').query({
                device: DESKTOP, token, table: 'Bad Cats (Williams 1989)', rom: 'bcats_l5', slug: 'vpx-badcats',
                score, started: ended - 300, ended, dur: 300, reason: 'game_over',
            });
        };
        const boardRows = async () => db.all(
            `SELECT score FROM score_history WHERE game_id = ? AND source = 'vpx'`, gameId,
        ) as Promise<Array<{ score: number }>>;

        await play(1_000_000);
        expect(await boardRows()).toHaveLength(0);

        await TournamentEntryService.addToRoster(tournamentId, USER, 'host', 'admin-1');
        const res = await play(2_000_000);
        expect(res.body.status).toBe('ingested');
        expect((await boardRows()).map(r => r.score)).toEqual([2_000_000]);
    });

    it('a roster spot alone lets a NON-member\'s device reach the tournament (it is a direct entry)', async () => {
        // A limited tournament, so `openLimitedGames` (the same candidate,
        // routing and entry filters a real play goes through) lists it.
        const { tournamentId, gameId } = await createRotation(roomId, { invited: true });
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET max_attempts = 3 WHERE id = ?', tournamentId);
        const { VpxScoreIngestService } = await import('../services/VpxScoreIngestService.js');
        const open = () => VpxScoreIngestService.openLimitedGames({
            canonicalUserId: OTHER, target: { roomId: null, tournamentId: null }, deviceType: 'desktop',
            nowTs: Math.floor(Date.now() / 1000),
        });
        expect(await open()).toEqual([]); // OTHER is not a member and not on the roster
        await TournamentEntryService.addToRoster(tournamentId, OTHER, 'host', 'admin-1');
        expect((await open()).map(g => g.gameId)).toEqual([gameId]);
    });

    it('event check-in: a self check-in needs a roster spot; the host\'s add puts the player on the roster', async () => {
        const eventId = await createEvent(roomId, { invited: true, checkin: true });
        const { EventService, NotOnRosterError } = await import('../services/EventService.js');
        await expect(EventService.checkIn(eventId, USER)).rejects.toBeInstanceOf(NotOnRosterError);

        await EventService.checkIn(eventId, OTHER, 'admin', 'admin-1');
        expect(await TournamentEntryService.isOnRoster(eventId, OTHER)).toBe(true);

        await TournamentEntryService.addToRoster(eventId, USER, 'invite', 'invite:X');
        const row = await EventService.checkIn(eventId, USER);
        expect(row.user_id).toBe(USER);
    });

    it('invite link: accepting joins an open room and enters the tournament; the link dies when reset or switched off', async () => {
        const { tournamentId } = await createRotation(roomId, { invited: true, link: true });
        const code = (await TournamentEntryService.getConfig(tournamentId))!.inviteCode!;

        const info = await request(app).get(`/api/tournament-invites/${code}`);
        expect(info.body).toMatchObject({ tournamentId, tournamentName: 'Invite Cup', roomSlug: 'entry-room' });

        const accept = await request(app).post(`/api/tournament-invites/${code}/accept`)
            .set('Authorization', `Bearer ${playerToken(OTHER)}`).send({});
        expect(accept.status).toBe(200);
        expect(accept.body).toMatchObject({ tournamentId, room: 'member' });
        const db = await getDatabase();
        expect(await db.get('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?', roomId, OTHER)).toBeTruthy();
        expect(await TournamentEntryService.isOnRoster(tournamentId, OTHER)).toBe(true);

        const fresh = await TournamentEntryService.resetInviteCode(tournamentId);
        expect(fresh).not.toBe(code);
        expect((await request(app).get(`/api/tournament-invites/${code}`)).status).toBe(404);

        await TournamentEntryService.setConfig(tournamentId, 'invited', { link: false, request: false });
        expect((await request(app).get(`/api/tournament-invites/${fresh}`)).status).toBe(404);
    });

    it('invite link into an approval-only room files a join request and still enters the tournament', async () => {
        const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');
        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');
        const { tournamentId } = await createRotation(roomId, { invited: true, link: true });
        const code = (await TournamentEntryService.getConfig(tournamentId))!.inviteCode!;
        const accept = await request(app).post(`/api/tournament-invites/${code}/accept`)
            .set('Authorization', `Bearer ${playerToken(OTHER)}`).send({});
        expect(accept.body).toMatchObject({ room: 'pending' });
        expect(await TournamentEntryService.isOnRoster(tournamentId, OTHER)).toBe(true);
    });

    it('requests: refused when the host takes none; otherwise pending → approve puts them on the roster, deny does not', async () => {
        const closed = await createRotation(roomId, { invited: true });
        const refused = await request(app).post(`/api/rooms/${roomId}/tournaments/${closed.tournamentId}/entry/request`)
            .set('Authorization', `Bearer ${playerToken(USER)}`).send({});
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe('METHOD_OFF');

        const { tournamentId } = await createRotation(roomId, { invited: true, request: true });
        const asked = await request(app).post(`/api/rooms/${roomId}/tournaments/${tournamentId}/entry/request`)
            .set('Authorization', `Bearer ${playerToken(USER)}`).send({});
        expect(asked.body).toEqual({ status: 'pending' });
        await request(app).post(`/api/rooms/${roomId}/tournaments/${tournamentId}/entry/request`)
            .set('Authorization', `Bearer ${playerToken(OTHER)}`).send({});

        const queue = await request(app).get(`/api/rooms/${roomId}/admin/tournaments/${tournamentId}/roster`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`);
        expect(queue.body.requests).toHaveLength(2);
        const [first, second] = queue.body.requests as Array<{ id: number; userId: string }>;

        await request(app).post(`/api/rooms/${roomId}/admin/tournaments/${tournamentId}/entry-requests/${first!.id}/approve`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`).send({});
        await request(app).post(`/api/rooms/${roomId}/admin/tournaments/${tournamentId}/entry-requests/${second!.id}/deny`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`).send({});
        expect(await TournamentEntryService.isOnRoster(tournamentId, first!.userId)).toBe(true);
        expect(await TournamentEntryService.isOnRoster(tournamentId, second!.userId)).toBe(false);

        const mine = await request(app).get(`/api/rooms/${roomId}/tournaments/${tournamentId}/entry/me`)
            .set('Authorization', `Bearer ${playerToken(second!.userId)}`);
        expect(mine.body).toMatchObject({ mode: 'invited', onRoster: false, request: 'denied', canRequest: true });
    });

    it('host add by @name resolves through the shared resolver and lists the player by name', async () => {
        const { tournamentId } = await createRotation(roomId, { invited: true });
        const db = await getDatabase();
        await db.run(`INSERT OR REPLACE INTO user_profiles (discord_user_id, display_name) VALUES (?, 'Mox')`, OTHER);
        const add = await request(app).post(`/api/rooms/${roomId}/admin/tournaments/${tournamentId}/roster`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`).send({ userId: '@Mox' });
        expect(add.status).toBe(201);
        const list = await request(app).get(`/api/rooms/${roomId}/admin/tournaments/${tournamentId}/roster`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`);
        expect(list.body.roster).toEqual([expect.objectContaining({ userId: OTHER, label: 'Mox', source: 'host' })]);
        const missing = await request(app).post(`/api/rooms/${roomId}/admin/tournaments/${tournamentId}/roster`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`).send({ userId: '@Nobody' });
        expect(missing.status).toBe(404);
    });

    it('the PUBLIC tournament list and event read never carry the invite code (it is a secret)', async () => {
        const { tournamentId } = await createRotation(roomId, { invited: true, link: true });
        expect((await TournamentEntryService.getConfig(tournamentId))!.inviteCode).toBeTruthy();
        const list = await request(app).get(`/api/rooms/${roomId}/tournaments`);
        expect(list.status).toBe(200);
        const row = (list.body as Array<Record<string, unknown>>).find(t => t.id === tournamentId)!;
        expect(row.entry_mode).toBe('invited');
        expect(row).not.toHaveProperty('invite_code');

        const eventId = await createEvent(roomId, { invited: true, checkin: false });
        await TournamentEntryService.setConfig(eventId, 'invited', { link: true, request: false });
        const { EventService } = await import('../services/EventService.js');
        expect(await EventService.getEvent(eventId)).not.toHaveProperty('invite_code');
    });

    it('an edit that omits the entry setting keeps it (never reopens an invite-only tournament)', async () => {
        const { tournamentId } = await createRotation(roomId);
        const { TournamentService } = await import('../services/TournamentService.js');
        const base = { name: 'Invite Cup', type: 'WG', cadence: {}, game_room_id: roomId, is_active: true };
        await TournamentService.update(tournamentId, { ...base, entry_mode: 'invited', entry_methods: { link: true, request: false } });
        await TournamentService.update(tournamentId, base);
        const config = await TournamentEntryService.getConfig(tournamentId);
        expect(config).toMatchObject({ mode: 'invited', methods: { link: true, request: false } });
        expect(config!.inviteCode).toMatch(/^[A-Z2-9]{8}$/);
    });
});
