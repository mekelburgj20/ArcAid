import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';

// The self-service PUT resolves typed-username nominees via
// `resolveDiscordMember` (v2.98.1 field-report fix). Mock ONLY that export —
// everything else in utils/discord stays real (no-ops without a bot token),
// so the resolution-matrix tests above are unaffected.
const resolveDiscordMemberMock = vi.hoisted(() => vi.fn());
vi.mock('../utils/discord.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/discord.js')>();
    return { ...actual, resolveDiscordMember: resolveDiscordMemberMock };
});

// The nominee typeahead endpoint (v2.99.0) resolves via `searchGuildMembers`.
// Mock ONLY that export — `resolveServerNickname` and the memo cache stay
// real so they're unaffected by this file's mocking.
const searchGuildMembersMock = vi.hoisted(() => vi.fn());
vi.mock('../services/DiscordNicknameResolver.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/DiscordNicknameResolver.js')>();
    return { ...actual, searchGuildMembers: searchGuildMembersMock };
});
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { TournamentEngine } from '../engine/TournamentEngine.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { PickAwardGate } from '../services/PickAwardGate.js';
import { PickDispositionService, SelfNominationError } from '../services/PickDispositionService.js';

// ---------------------------------------------------------------------------
// Next-win disposition — resolution matrix (ROADMAP "Next-win disposition +
// dynasty option + rotation-readiness nudge", locked 2026-08-09).
//
// {no-row, nominate, forfeit} x {dynasty allowed, blocked}, plus one-shot
// consumption and self-nomination rejection. Drives through the real
// `runMaintenance` -> `processSlotMaintenance` -> `resolveNextPicker` path
// (same approach as tournament-winner-attribution.test.ts / pick-prompt-feed
// .test.ts) so the matrix is proven against production code, not a
// reimplementation of it.
// ---------------------------------------------------------------------------

async function seedSubmission(gameId: string, opts: {
    iscoredUsername: string;
    submittedByUserId: string;
    score: number;
}) {
    const db = await getDatabase();
    const id = `${gameId}-${opts.iscoredUsername.toLowerCase()}`;
    await db.run(
        `INSERT INTO submissions (id, game_id, discord_user_id, submitted_by_user_id, iscored_username, score, timestamp)
         VALUES (?, ?, 'COMMUNITY', ?, ?, ?, ?)`,
        id, gameId, opts.submittedByUserId, opts.iscoredUsername, opts.score, new Date().toISOString(),
    );
}

async function getPickerSlot(tournamentId: string) {
    const db = await getDatabase();
    return db.get(
        `SELECT * FROM games WHERE tournament_id = ? AND status = 'QUEUED' AND name = '[Pending Pick]'`,
        tournamentId,
    );
}

let roomCounter = 0;

async function setupTournament(opts: { allowDynasty?: boolean; autoPick?: boolean } = {}) {
    roomCounter += 1;
    const roomId = await createTestRoom(`nwd-room-${roomCounter}`, `NWD Room ${roomCounter}`);
    await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
    const tournamentId = await createTestTournament(roomId, { name: `NWD Tournament ${roomCounter}` });
    const db = await getDatabase();
    if (opts.allowDynasty === false) {
        await db.run('UPDATE tournaments SET allow_dynasty = 0 WHERE id = ?', tournamentId);
    }
    if (opts.autoPick === false) {
        await db.run('UPDATE tournaments SET auto_pick = 0 WHERE id = ?', tournamentId);
    }
    PickAwardGate.invalidate();
    return { roomId, tournamentId };
}

describe('Next-win disposition — resolution matrix', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    it('no row + dynasty allowed -> default behavior (winner gets the pick)', async () => {
        const { tournamentId } = await setupTournament();
        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        await seedSubmission(gameId, { iscoredUsername: 'Winner', submittedByUserId: 'W1', score: 500 });

        await TournamentEngine.getInstance().runMaintenance(tournamentId);

        const slot = await getPickerSlot(tournamentId);
        expect(slot?.picker_discord_id).toBe('W1');
        expect(slot?.picker_type).toBe('WINNER');
    });

    it('nominate + dynasty allowed -> nominee gets the pick (full WINNER window), disposition one-shot consumed', async () => {
        const { tournamentId } = await setupTournament();
        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        await seedSubmission(gameId, { iscoredUsername: 'Winner', submittedByUserId: 'W2', score: 500 });
        await PickDispositionService.set(tournamentId, 'W2', 'nominate', 'N2');

        await TournamentEngine.getInstance().runMaintenance(tournamentId);

        const slot = await getPickerSlot(tournamentId);
        expect(slot?.picker_discord_id).toBe('N2');
        expect(slot?.picker_type).toBe('WINNER');
        expect(await PickDispositionService.get(tournamentId, 'W2')).toBeNull();
    });

    it('forfeit + dynasty allowed -> runner-up gets the pick immediately (RUNNER_UP, no wait)', async () => {
        const { tournamentId } = await setupTournament();
        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        await seedSubmission(gameId, { iscoredUsername: 'Winner', submittedByUserId: 'W3', score: 500 });
        await seedSubmission(gameId, { iscoredUsername: 'Runner', submittedByUserId: 'R3', score: 400 });
        await PickDispositionService.set(tournamentId, 'W3', 'forfeit');

        await TournamentEngine.getInstance().runMaintenance(tournamentId);

        const slot = await getPickerSlot(tournamentId);
        expect(slot?.picker_discord_id).toBe('R3');
        expect(slot?.picker_type).toBe('RUNNER_UP');
    });

    it('dynasty blocked + no row -> runner-up gets the pick immediately', async () => {
        const { tournamentId } = await setupTournament({ allowDynasty: false });
        const prevGameId = await createTestGame(tournamentId, {
            status: 'COMPLETED',
            endDate: new Date(Date.now() - 60_000).toISOString(),
        });
        await seedSubmission(prevGameId, { iscoredUsername: 'Winner', submittedByUserId: 'W4', score: 999 });

        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        await seedSubmission(gameId, { iscoredUsername: 'Winner', submittedByUserId: 'W4', score: 500 });
        await seedSubmission(gameId, { iscoredUsername: 'Runner', submittedByUserId: 'R4', score: 400 });

        await TournamentEngine.getInstance().runMaintenance(tournamentId);

        const slot = await getPickerSlot(tournamentId);
        expect(slot?.picker_discord_id).toBe('R4');
        expect(slot?.picker_type).toBe('RUNNER_UP');
    });

    it('dynasty blocked + forfeit -> still resolves to the runner-up (forfeit unaffected by the block)', async () => {
        const { tournamentId } = await setupTournament({ allowDynasty: false });
        const prevGameId = await createTestGame(tournamentId, {
            status: 'COMPLETED',
            endDate: new Date(Date.now() - 60_000).toISOString(),
        });
        await seedSubmission(prevGameId, { iscoredUsername: 'Winner', submittedByUserId: 'W5', score: 999 });

        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        await seedSubmission(gameId, { iscoredUsername: 'Winner', submittedByUserId: 'W5', score: 500 });
        await seedSubmission(gameId, { iscoredUsername: 'Runner', submittedByUserId: 'R5', score: 400 });
        await PickDispositionService.set(tournamentId, 'W5', 'forfeit');

        await TournamentEngine.getInstance().runMaintenance(tournamentId);

        const slot = await getPickerSlot(tournamentId);
        expect(slot?.picker_discord_id).toBe('R5');
        expect(slot?.picker_type).toBe('RUNNER_UP');
    });

    it('dynasty blocked + nominate -> still resolves to the nominee (nominate unaffected by the block)', async () => {
        const { tournamentId } = await setupTournament({ allowDynasty: false });
        const prevGameId = await createTestGame(tournamentId, {
            status: 'COMPLETED',
            endDate: new Date(Date.now() - 60_000).toISOString(),
        });
        await seedSubmission(prevGameId, { iscoredUsername: 'Winner', submittedByUserId: 'W6', score: 999 });

        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        await seedSubmission(gameId, { iscoredUsername: 'Winner', submittedByUserId: 'W6', score: 500 });
        await PickDispositionService.set(tournamentId, 'W6', 'nominate', 'N6');

        await TournamentEngine.getInstance().runMaintenance(tournamentId);

        const slot = await getPickerSlot(tournamentId);
        expect(slot?.picker_discord_id).toBe('N6');
        expect(slot?.picker_type).toBe('WINNER');
    });

    it('dynasty blocked + no eligible runner-up -> falls through to the no-winner-found path (no picker slot created)', async () => {
        const { tournamentId } = await setupTournament({ allowDynasty: false, autoPick: false });
        const prevGameId = await createTestGame(tournamentId, {
            status: 'COMPLETED',
            endDate: new Date(Date.now() - 60_000).toISOString(),
        });
        await seedSubmission(prevGameId, { iscoredUsername: 'Winner', submittedByUserId: 'W7', score: 999 });

        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        // Only ONE submission on the current slot — no 2nd place to fall back to.
        await seedSubmission(gameId, { iscoredUsername: 'Winner', submittedByUserId: 'W7', score: 500 });

        await TournamentEngine.getInstance().runMaintenance(tournamentId);

        expect(await getPickerSlot(tournamentId)).toBeUndefined();
    });

    it('one-shot consumption: a second rotation win by the same player reverts to their own queue', async () => {
        const { tournamentId } = await setupTournament();
        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        await seedSubmission(gameId, { iscoredUsername: 'Winner', submittedByUserId: 'W8', score: 500 });
        await PickDispositionService.set(tournamentId, 'W8', 'nominate', 'N8');

        await TournamentEngine.getInstance().runMaintenance(tournamentId);
        const firstSlot = await getPickerSlot(tournamentId);
        expect(firstSlot?.picker_discord_id).toBe('N8');
        expect(await PickDispositionService.get(tournamentId, 'W8')).toBeNull();

        // Simulate N8 repurposing the placeholder into a second real game
        // (mirrors what the /pick-game "pending pick, slots full" branch does)
        // and W8 winning it again with NO new disposition set.
        const db = await getDatabase();
        await db.run(
            `UPDATE games SET name = 'Second Game', status = 'ACTIVE', start_date = ? WHERE id = ?`,
            new Date().toISOString(), firstSlot.id,
        );
        await seedSubmission(firstSlot.id, { iscoredUsername: 'Winner', submittedByUserId: 'W8', score: 700 });

        await TournamentEngine.getInstance().runMaintenance(tournamentId);
        const secondSlot = await getPickerSlot(tournamentId);
        expect(secondSlot?.id).not.toBe(firstSlot.id);
        expect(secondSlot?.picker_discord_id).toBe('W8');
        expect(secondSlot?.picker_type).toBe('WINNER');
    });

    it('self-nomination is rejected', async () => {
        const { tournamentId } = await setupTournament();
        await expect(
            PickDispositionService.set(tournamentId, 'W9', 'nominate', 'W9'),
        ).rejects.toBeInstanceOf(SelfNominationError);

        // No row should have been written.
        expect(await PickDispositionService.get(tournamentId, 'W9')).toBeNull();
    });

    it('clear() reverts a stored disposition back to use-my-queue', async () => {
        const { tournamentId } = await setupTournament();
        await PickDispositionService.set(tournamentId, 'W10', 'forfeit');
        expect(await PickDispositionService.get(tournamentId, 'W10')).not.toBeNull();

        await PickDispositionService.clear(tournamentId, 'W10');
        expect(await PickDispositionService.get(tournamentId, 'W10')).toBeNull();
    });
});

describe('Next-win disposition — onboarding branch (nominee not yet a room member)', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    it('flags onboarding when the nominee has no room_members row for this room', async () => {
        const { tournamentId } = await setupTournament();
        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        await seedSubmission(gameId, { iscoredUsername: 'Winner', submittedByUserId: 'W11', score: 500 });
        await PickDispositionService.set(tournamentId, 'W11', 'nominate', 'N11-not-a-member');

        const db = await getDatabase();
        const tournamentRow = await db.get('SELECT * FROM tournaments WHERE id = ?', tournamentId);
        const activeGame = await db.get('SELECT * FROM games WHERE id = ?', gameId);

        const engine = TournamentEngine.getInstance() as any;
        const resolution = await engine.resolveNextPicker(db, tournamentRow, {
            id: activeGame.id, tournamentId, name: activeGame.name,
        }, 'W11', 'Winner', 'Winner');

        expect(resolution.pickerId).toBe('N11-not-a-member');
        expect(resolution.onboardingNominee).toBe('N11-not-a-member');

        // Never throws even with no live Discord client/channel configured.
        await expect(engine.announceNomineeOnboarding('N11-not-a-member', tournamentRow, null, { game: 'game' })).resolves.toBeUndefined();
    });

    it('does NOT flag onboarding when the nominee already has a room_members row', async () => {
        const { roomId, tournamentId } = await setupTournament();
        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        await seedSubmission(gameId, { iscoredUsername: 'Winner', submittedByUserId: 'W12', score: 500 });
        await PickDispositionService.set(tournamentId, 'W12', 'nominate', 'N12-member');

        const db = await getDatabase();
        await db.run(
            `INSERT INTO room_members (user_id, room_id, source) VALUES (?, ?, 'submission')`,
            'N12-member', roomId,
        );

        const tournamentRow = await db.get('SELECT * FROM tournaments WHERE id = ?', tournamentId);
        const activeGame = await db.get('SELECT * FROM games WHERE id = ?', gameId);

        const engine = TournamentEngine.getInstance() as any;
        const resolution = await engine.resolveNextPicker(db, tournamentRow, {
            id: activeGame.id, tournamentId, name: activeGame.name,
        }, 'W12', 'Winner', 'Winner');

        expect(resolution.pickerId).toBe('N12-member');
        expect(resolution.onboardingNominee).toBeNull();
    });
});

describe('Next-win disposition — admin on-behalf route', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    async function createApp() {
        const express = (await import('express')).default;
        const app = express();
        app.use(express.json());
        const { default: roomsRouter } = await import('../api/routes/rooms.js');
        app.use('/api/rooms', roomsRouter);
        return app;
    }

    it('PUT sets a disposition on behalf of a player and writes an audit row', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const { AuditService } = await import('../services/AuditService.js');
        const app = await createApp();

        const { roomId, tournamentId } = await setupTournament();
        const adminToken = signToken({ role: 'room_admin', gameRoomIds: [roomId], discordId: 'admin-1' });

        const res = await request(app)
            .put(`/api/rooms/${roomId}/admin/tournaments/${tournamentId}/pick-disposition`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ disposition: 'nominate', nomineeDiscordId: 'N13', forUserId: 'W13' });

        expect(res.status).toBe(200);
        expect(res.body.disposition).toEqual({ disposition: 'nominate', nomineeDiscordId: 'N13' });
        expect(await PickDispositionService.get(tournamentId, 'W13')).not.toBeNull();

        const rows = await AuditService.getByTarget('tournament', tournamentId);
        expect(rows.length).toBe(1);
        expect(rows[0]!.action).toBe('pick_disposition.set');
        expect(rows[0]!.actor).toBe('admin-1');
        expect(JSON.parse(rows[0]!.details)).toMatchObject({ forUserId: 'W13', disposition: 'nominate', nomineeDiscordId: 'N13' });
    });

    it('DELETE clears a disposition on behalf of a player and writes an audit row', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const { AuditService } = await import('../services/AuditService.js');
        const app = await createApp();

        const { roomId, tournamentId } = await setupTournament();
        await PickDispositionService.set(tournamentId, 'W14', 'forfeit');
        const adminToken = signToken({ role: 'room_admin', gameRoomIds: [roomId], discordId: 'admin-2' });

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/admin/tournaments/${tournamentId}/pick-disposition/W14`)
            .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(200);
        expect(await PickDispositionService.get(tournamentId, 'W14')).toBeNull();

        const rows = await AuditService.getByTarget('tournament', tournamentId);
        expect(rows.some(r => r.action === 'pick_disposition.clear' && r.actor === 'admin-2')).toBe(true);
    });

    it('403s a room_admin token scoped to a DIFFERENT room', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const app = await createApp();

        const { roomId, tournamentId } = await setupTournament();
        const otherAdminToken = signToken({ role: 'room_admin', gameRoomIds: ['some-other-room'], discordId: 'admin-3' });

        const res = await request(app)
            .put(`/api/rooms/${roomId}/admin/tournaments/${tournamentId}/pick-disposition`)
            .set('Authorization', `Bearer ${otherAdminToken}`)
            .send({ disposition: 'forfeit', forUserId: 'W15' });

        expect(res.status).toBe(403);
    });

    it('self-nomination via the admin route 400s with SELF_NOMINATION', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const app = await createApp();

        const { roomId, tournamentId } = await setupTournament();
        const adminToken = signToken({ role: 'room_admin', gameRoomIds: [roomId], discordId: 'admin-4' });

        const res = await request(app)
            .put(`/api/rooms/${roomId}/admin/tournaments/${tournamentId}/pick-disposition`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ disposition: 'nominate', nomineeDiscordId: 'W16', forUserId: 'W16' });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('SELF_NOMINATION');
    });
});

describe('Next-win disposition — self-service route', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    async function createApp() {
        const express = (await import('express')).default;
        const app = express();
        app.use(express.json());
        const { default: roomsRouter } = await import('../api/routes/rooms.js');
        app.use('/api/rooms', roomsRouter);
        return app;
    }

    it('GET/PUT/DELETE round-trip a player\'s own disposition', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const app = await createApp();

        const { roomId, tournamentId } = await setupTournament();
        const playerToken = signToken({ role: 'player', gameRoomIds: [], discordId: 'W17' });

        const empty = await request(app)
            .get(`/api/rooms/${roomId}/tournaments/${tournamentId}/pick-disposition`)
            .set('Authorization', `Bearer ${playerToken}`);
        expect(empty.status).toBe(200);
        expect(empty.body.disposition).toBeNull();

        const put = await request(app)
            .put(`/api/rooms/${roomId}/tournaments/${tournamentId}/pick-disposition`)
            .set('Authorization', `Bearer ${playerToken}`)
            .send({ disposition: 'forfeit' });
        expect(put.status).toBe(200);
        expect(put.body.disposition.disposition).toBe('forfeit');

        const del = await request(app)
            .delete(`/api/rooms/${roomId}/tournaments/${tournamentId}/pick-disposition`)
            .set('Authorization', `Bearer ${playerToken}`);
        expect(del.status).toBe(200);
        expect(await PickDispositionService.get(tournamentId, 'W17')).toBeNull();
    });

    it('rejects a nominate with no nomineeDiscordId', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const app = await createApp();

        const { roomId, tournamentId } = await setupTournament();
        const playerToken = signToken({ role: 'player', gameRoomIds: [], discordId: 'W18' });

        const res = await request(app)
            .put(`/api/rooms/${roomId}/tournaments/${tournamentId}/pick-disposition`)
            .set('Authorization', `Bearer ${playerToken}`)
            .send({ disposition: 'nominate' });
        expect(res.status).toBe(400);
    });

    it('401s with no token', async () => {
        const request = (await import('supertest')).default;
        const app = await createApp();
        const { roomId, tournamentId } = await setupTournament();

        const res = await request(app).get(`/api/rooms/${roomId}/tournaments/${tournamentId}/pick-disposition`);
        expect(res.status).toBe(401);
    });

    // ------------------------------------------------------------------
    // Typed-username nominees (v2.98.1 field report: '@chuckribbits' was
    // rejected even though the caption promised "@mention" support).
    // Player route ONLY — the admin on-behalf route deliberately accepts
    // raw ids (its Discord twin gets real user options from the client).
    // ------------------------------------------------------------------

    it('typed-username nominee resolves against the linked guild, stores the id, ships the display name', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const app = await createApp();

        const { roomId, tournamentId } = await setupTournament();
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-nwd');
        resolveDiscordMemberMock.mockReset().mockResolvedValue({ id: '444455556666777788', displayName: 'ChuckRibbits' });
        const playerToken = signToken({ role: 'player', gameRoomIds: [], discordId: 'W19' });

        const res = await request(app)
            .put(`/api/rooms/${roomId}/tournaments/${tournamentId}/pick-disposition`)
            .set('Authorization', `Bearer ${playerToken}`)
            .send({ disposition: 'nominate', nomineeDiscordId: '@chuckribbits' });

        expect(res.status).toBe(200);
        expect(res.body.disposition).toEqual({ disposition: 'nominate', nomineeDiscordId: '444455556666777788', nomineeDisplayName: 'ChuckRibbits' });
        expect(resolveDiscordMemberMock).toHaveBeenCalledWith('@chuckribbits', 'guild-nwd');
        const stored = await PickDispositionService.get(tournamentId, 'W19');
        expect(stored?.nominee_discord_id).toBe('444455556666777788');
    });

    it('unresolvable typed-username nominee 400s (hard gate — an unresolved name would DM nobody)', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const app = await createApp();

        const { roomId, tournamentId } = await setupTournament();
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-nwd');
        resolveDiscordMemberMock.mockReset().mockResolvedValue(null);
        const playerToken = signToken({ role: 'player', gameRoomIds: [], discordId: 'W20' });

        const res = await request(app)
            .put(`/api/rooms/${roomId}/tournaments/${tournamentId}/pick-disposition`)
            .set('Authorization', `Bearer ${playerToken}`)
            .send({ disposition: 'nominate', nomineeDiscordId: '@nobody-here' });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/Couldn't find a Discord member/);
        expect(await PickDispositionService.get(tournamentId, 'W20')).toBeNull();
    });

    it('typed-username nominee with no linked guild 400s without calling the resolver', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const app = await createApp();

        const { roomId, tournamentId } = await setupTournament();
        resolveDiscordMemberMock.mockReset();
        const playerToken = signToken({ role: 'player', gameRoomIds: [], discordId: 'W21' });

        const res = await request(app)
            .put(`/api/rooms/${roomId}/tournaments/${tournamentId}/pick-disposition`)
            .set('Authorization', `Bearer ${playerToken}`)
            .send({ disposition: 'nominate', nomineeDiscordId: '@someone' });

        expect(res.status).toBe(400);
        expect(resolveDiscordMemberMock).not.toHaveBeenCalled();
    });

    it('numeric nominee ids still pass through untouched (no resolver call)', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const app = await createApp();

        const { roomId, tournamentId } = await setupTournament();
        resolveDiscordMemberMock.mockReset();
        const playerToken = signToken({ role: 'player', gameRoomIds: [], discordId: 'W22' });

        const res = await request(app)
            .put(`/api/rooms/${roomId}/tournaments/${tournamentId}/pick-disposition`)
            .set('Authorization', `Bearer ${playerToken}`)
            .send({ disposition: 'nominate', nomineeDiscordId: '555566667777888899' });

        expect(res.status).toBe(200);
        expect(res.body.disposition).toEqual({ disposition: 'nominate', nomineeDiscordId: '555566667777888899' });
        expect(resolveDiscordMemberMock).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Nominee typeahead — `GET /:roomId/guild-members/search` (v2.99.0). Powers
// the Picks page's Discord-style live suggestions as a player types in the
// "Give my pick to…" free-text fallback. A typeahead must never 500 — every
// failure/empty-input branch below degrades to `{ members: [] }`.
// ---------------------------------------------------------------------------
describe('Next-win disposition — nominee typeahead (guild-members/search)', () => {
    beforeEach(async () => {
        await setupTestDb();
        searchGuildMembersMock.mockReset();
    });

    async function createApp() {
        const express = (await import('express')).default;
        const app = express();
        app.use(express.json());
        const { default: roomsRouter } = await import('../api/routes/rooms.js');
        app.use('/api/rooms', roomsRouter);
        return app;
    }

    it('401s a tokenless request', async () => {
        const request = (await import('supertest')).default;
        const app = await createApp();
        const { roomId } = await setupTournament();

        const res = await request(app).get(`/api/rooms/${roomId}/guild-members/search?q=chuck`);

        expect(res.status).toBe(401);
        expect(searchGuildMembersMock).not.toHaveBeenCalled();
    });

    it('a query under 2 characters returns empty and never calls the resolver', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const app = await createApp();
        const { roomId } = await setupTournament();
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-ta');
        const playerToken = signToken({ role: 'player', gameRoomIds: [], discordId: 'TA1' });

        const res = await request(app)
            .get(`/api/rooms/${roomId}/guild-members/search?q=c`)
            .set('Authorization', `Bearer ${playerToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ members: [] });
        expect(searchGuildMembersMock).not.toHaveBeenCalled();
    });

    it('no DISCORD_GUILD_ID configured returns empty and never calls the resolver', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const app = await createApp();
        const { roomId } = await setupTournament();
        const playerToken = signToken({ role: 'player', gameRoomIds: [], discordId: 'TA2' });

        const res = await request(app)
            .get(`/api/rooms/${roomId}/guild-members/search?q=chuck`)
            .set('Authorization', `Bearer ${playerToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ members: [] });
        expect(searchGuildMembersMock).not.toHaveBeenCalled();
    });

    it('happy path maps resolver results through to the response', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const app = await createApp();
        const { roomId } = await setupTournament();
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-ta');
        searchGuildMembersMock.mockResolvedValue([
            { discordUserId: '444455556666777788', displayName: 'ChuckRibbits', username: 'chuckribbits', avatarHash: 'abc123' },
        ]);
        const playerToken = signToken({ role: 'player', gameRoomIds: [], discordId: 'TA3' });

        const res = await request(app)
            .get(`/api/rooms/${roomId}/guild-members/search?q=chuck`)
            .set('Authorization', `Bearer ${playerToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            members: [
                { discordUserId: '444455556666777788', displayName: 'ChuckRibbits', username: 'chuckribbits', avatarHash: 'abc123' },
            ],
        });
        expect(searchGuildMembersMock).toHaveBeenCalledWith('guild-ta', 'chuck');
    });

    it('strips one leading @ before calling the resolver', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const app = await createApp();
        const { roomId } = await setupTournament();
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-ta');
        searchGuildMembersMock.mockResolvedValue([]);
        const playerToken = signToken({ role: 'player', gameRoomIds: [], discordId: 'TA4' });

        const res = await request(app)
            .get(`/api/rooms/${roomId}/guild-members/search?q=${encodeURIComponent('@chuck')}`)
            .set('Authorization', `Bearer ${playerToken}`);

        expect(res.status).toBe(200);
        expect(searchGuildMembersMock).toHaveBeenCalledWith('guild-ta', 'chuck');
    });

    it('a resolver throw degrades to empty members, never a 500', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const app = await createApp();
        const { roomId } = await setupTournament();
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-ta');
        searchGuildMembersMock.mockRejectedValue(new Error('discord REST blew up'));
        const playerToken = signToken({ role: 'player', gameRoomIds: [], discordId: 'TA5' });

        const res = await request(app)
            .get(`/api/rooms/${roomId}/guild-members/search?q=chuck`)
            .set('Authorization', `Bearer ${playerToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ members: [] });
    });
});
