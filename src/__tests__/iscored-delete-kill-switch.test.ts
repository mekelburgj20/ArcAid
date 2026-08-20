import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { IScoredSessionRegistry } from '../engine/IScoredSessionRegistry.js';
import { TournamentEngine } from '../engine/TournamentEngine.js';
import { unpinGameFromScoreboard } from '../engine/gameCreation.js';
import { iscoredDeletesAllowed } from '../utils/iscoredCreds.js';
import type { IScoredClient } from '../engine/IScoredClient.js';

/**
 * Per-room iScored DELETE kill-switch (`ISCORED_ALLOW_DELETE`, v2.120.0).
 *
 * A room may bridge Arcaid to an iScored board it does not own outright. With
 * the switch off, NO Arcaid code path may remove a game from that board —
 * cleanup rules archive locally instead, and the admin delete paths either skip
 * the remote side effect (routes whose purpose is the LOCAL removal) or refuse
 * outright with 409 (routes whose purpose IS the remote delete). Everything
 * reversible/additive — lock, unlock, hide, unhide, create, submit, reorder —
 * stays allowed.
 *
 * The load-bearing assertion in every case below is the same: the fake iScored
 * client's `deleteGame` is never called.
 */

vi.mock('../utils/logger.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/logger.js')>();
    return { ...actual, logWarn: vi.fn() };
});
import { logWarn } from '../utils/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Fake Playwright client — every iScored mutation the guarded sites can reach. */
function makeFakeClient() {
    const deleteGame = vi.fn(async () => true);
    const setGameStatus = vi.fn(async () => {});
    const getGamesOnIScored = vi.fn(async () => [] as unknown[]);
    const client = {
        connect: async () => {},
        disconnect: async () => {},
        deleteGame,
        setGameStatus,
        getGamesOnIScored,
    } as unknown as IScoredClient;
    return { client, deleteGame, setGameStatus, getGamesOnIScored };
}

/** Real per-room iScored creds so the routes get past their creds gate. */
async function seedIScoredCreds(roomId: string): Promise<void> {
    await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'true');
    await GameRoomSettingsService.set(roomId, 'ISCORED_USERNAME', 'testacct');
    await GameRoomSettingsService.set(roomId, 'ISCORED_PASSWORD', 'testpw');
    await GameRoomSettingsService.set(roomId, 'ISCORED_PUBLIC_URL', 'https://iscored.info/testacct');
}

async function addGame(opts: {
    tournamentId: string | null;
    roomId: string;
    name: string;
    status: string;
    iscoredId: string | null;
}): Promise<string> {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, iscored_id, start_date, end_date, game_room_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, opts.tournamentId, opts.name, opts.status, opts.iscoredId,
        new Date().toISOString(),
        opts.status === 'COMPLETED' ? new Date().toISOString() : null,
        opts.roomId,
    );
    return id;
}

const statusOf = async (id: string): Promise<string | undefined> => {
    const db = await getDatabase();
    const row = await db.get<{ status: string }>('SELECT status FROM games WHERE id = ?', id);
    return row?.status;
};

const gameExists = async (id: string): Promise<boolean> => {
    const db = await getDatabase();
    return !!(await db.get('SELECT id FROM games WHERE id = ?', id));
};

async function createTestApp() {
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

const adminToken = (roomId: string) => signToken({ role: 'room_admin', gameRoomIds: [roomId] });

const KILL_SWITCH_409 =
    'iScored deletes are disabled for this room (Room Settings → iScored → Allow Arcaid to delete games on iScored).';

let fake: ReturnType<typeof makeFakeClient>;

beforeEach(async () => {
    vi.mocked(logWarn).mockClear();
    fake = makeFakeClient();
    IScoredSessionRegistry.getInstance().setClientFactoryForTests(() => fake.client);
    // TournamentEngine.deleteGameCompletely does a final score sync over HTTP
    // before deleting. Stub it out so the tests never touch the network.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline (test)'); }));
});

afterEach(async () => {
    const reg = IScoredSessionRegistry.getInstance();
    reg.setClientFactoryForTests(null);
    await reg.shutdown();
    vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
// (a) The helper
// ─────────────────────────────────────────────────────────────────────────────

describe('iscoredDeletesAllowed — default-on-when-absent', () => {
    it('returns true when the setting is absent (existing rooms keep their behaviour)', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('ks-absent', 'KS Absent');
        expect(await iscoredDeletesAllowed(roomId)).toBe(true);
    });

    it("returns true for 'true'", async () => {
        await setupTestDb();
        const roomId = await createTestRoom('ks-true', 'KS True');
        await GameRoomSettingsService.set(roomId, 'ISCORED_ALLOW_DELETE', 'true');
        expect(await iscoredDeletesAllowed(roomId)).toBe(true);
    });

    it("returns false for 'false' — the only value that disables deletes", async () => {
        await setupTestDb();
        const roomId = await createTestRoom('ks-false', 'KS False');
        await GameRoomSettingsService.set(roomId, 'ISCORED_ALLOW_DELETE', 'false');
        expect(await iscoredDeletesAllowed(roomId)).toBe(false);
    });

    it('returns true for a null/undefined roomId (env-fallback back-compat)', async () => {
        await setupTestDb();
        expect(await iscoredDeletesAllowed(null)).toBe(true);
        expect(await iscoredDeletesAllowed(undefined)).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) Cleanup rules
// ─────────────────────────────────────────────────────────────────────────────

describe('runCleanup — kill-switch archives locally instead of deleting', () => {
    it('never calls deleteGame, still ARCHIVES the completed games, and WARNs once', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('ks-cleanup-off', 'KS Cleanup Off');
        await GameRoomSettingsService.set(roomId, 'ISCORED_ALLOW_DELETE', 'false');
        const tId = await createTestTournament(roomId, { name: 'Daily Grind' });
        const g1 = await addGame({ tournamentId: tId, roomId, name: 'G1', status: 'COMPLETED', iscoredId: 'ISC_1' });
        const g2 = await addGame({ tournamentId: tId, roomId, name: 'G2', status: 'COMPLETED', iscoredId: 'ISC_2' });

        // sharedClient = the inline-from-maintenance path (a live session the
        // caller already holds). It must be left untouched all the same.
        await TournamentEngine.getInstance().runCleanup(tId, { mode: 'immediate' }, fake.client, null);

        expect(fake.deleteGame).not.toHaveBeenCalled();
        expect(await statusOf(g1)).toBe('ARCHIVED');
        expect(await statusOf(g2)).toBe('ARCHIVED');

        const warnings = vi.mocked(logWarn).mock.calls
            .map((c) => String(c[0]))
            .filter((m) => m.includes('iScored deletes disabled for this room'));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(tId);
        expect(warnings[0]).toContain(roomId);
    });

    it('the standalone (creds, no shared client) path is guarded too — no session is even opened', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('ks-cleanup-standalone', 'KS Cleanup Standalone');
        await seedIScoredCreds(roomId);
        await GameRoomSettingsService.set(roomId, 'ISCORED_ALLOW_DELETE', 'false');
        const tId = await createTestTournament(roomId, { name: 'Weekly Grind' });
        const g = await addGame({ tournamentId: tId, roomId, name: 'Standalone', status: 'COMPLETED', iscoredId: 'ISC_S' });

        // sharedCreds omitted → runCleanup resolves creds itself and would open
        // its own registry session. The guard must short-circuit before that.
        await TournamentEngine.getInstance().runCleanup(tId, { mode: 'immediate' });

        expect(fake.deleteGame).not.toHaveBeenCalled();
        expect(await statusOf(g)).toBe('ARCHIVED');
    });

    it('with the switch ON (absent) cleanup still deletes on iScored — existing behaviour intact', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('ks-cleanup-on', 'KS Cleanup On');
        const tId = await createTestTournament(roomId, { name: 'Daily Grind' });
        const g = await addGame({ tournamentId: tId, roomId, name: 'G1', status: 'COMPLETED', iscoredId: 'ISC_1' });

        await TournamentEngine.getInstance().runCleanup(tId, { mode: 'immediate' }, fake.client, null);

        expect(fake.deleteGame).toHaveBeenCalledTimes(1);
        expect(fake.deleteGame).toHaveBeenCalledWith('ISC_1', 'G1');
        expect(await statusOf(g)).toBe('ARCHIVED');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) Engine delete + unpin
// ─────────────────────────────────────────────────────────────────────────────

describe('deleteGameCompletely / unpin — local work proceeds, iScored untouched', () => {
    it('deleteGameCompletely skips the iScored delete and reports skipped', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('ks-delcomplete', 'KS DelComplete');
        await seedIScoredCreds(roomId);
        await GameRoomSettingsService.set(roomId, 'ISCORED_ALLOW_DELETE', 'false');
        const tId = await createTestTournament(roomId, { name: 'Daily Grind' });
        const gameId = await addGame({ tournamentId: tId, roomId, name: 'Wrong Game', status: 'ACTIVE', iscoredId: 'ISC_WRONG' });

        const result = await TournamentEngine.getInstance().deleteGameCompletely(gameId);

        expect(fake.deleteGame).not.toHaveBeenCalled();
        expect(result.iscoredStatus).toBe('skipped');
        expect(await gameExists(gameId)).toBe(false); // local work still happened
    });

    it('deleteGameCompletely still deletes on iScored when the switch is on', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('ks-delcomplete-on', 'KS DelComplete On');
        await seedIScoredCreds(roomId);
        const tId = await createTestTournament(roomId, { name: 'Daily Grind' });
        const gameId = await addGame({ tournamentId: tId, roomId, name: 'Wrong Game', status: 'ACTIVE', iscoredId: 'ISC_WRONG' });

        const result = await TournamentEngine.getInstance().deleteGameCompletely(gameId);

        expect(fake.deleteGame).toHaveBeenCalledWith('ISC_WRONG', 'Wrong Game');
        expect(result.iscoredStatus).toBe('deleted');
    });

    it('unpin removes the local pin but leaves the iScored entity alone', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('ks-unpin', 'KS Unpin');
        await seedIScoredCreds(roomId);
        await GameRoomSettingsService.set(roomId, 'ISCORED_ALLOW_DELETE', 'false');
        const gameId = await addGame({ tournamentId: null, roomId, name: 'Pinned', status: 'ACTIVE', iscoredId: 'ISC_PIN' });

        const result = await unpinGameFromScoreboard({ roomId, gameId, deleteOnIScored: true });

        expect(fake.deleteGame).not.toHaveBeenCalled();
        expect(result.deleted).toBe(true);
        expect(result.iscoredStatus).toBe('skipped');
        expect(await gameExists(gameId)).toBe(false);
    });

    it('unpin still deletes on iScored when the switch is on', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('ks-unpin-on', 'KS Unpin On');
        await seedIScoredCreds(roomId);
        const gameId = await addGame({ tournamentId: null, roomId, name: 'Pinned', status: 'ACTIVE', iscoredId: 'ISC_PIN' });

        const result = await unpinGameFromScoreboard({ roomId, gameId, deleteOnIScored: true });

        expect(fake.deleteGame).toHaveBeenCalledWith('ISC_PIN', 'Pinned');
        expect(result.iscoredStatus).toBe('deleted');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) Admin routes
// ─────────────────────────────────────────────────────────────────────────────

describe('admin routes — kill-switch semantics', () => {
    it('DELETE game-states/:gameId does the LOCAL delete and reports iscoredStatus=skipped', async () => {
        await setupTestDb();
        const app = await createTestApp();
        const roomId = await createTestRoom('ks-route-gamestate', 'KS Route GameState');
        await seedIScoredCreds(roomId);
        await GameRoomSettingsService.set(roomId, 'ISCORED_ALLOW_DELETE', 'false');
        const tId = await createTestTournament(roomId);
        const gameId = await addGame({ tournamentId: tId, roomId, name: 'Phantom', status: 'COMPLETED', iscoredId: 'ISC_PH' });

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/admin/game-states/${gameId}`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ deleteFromIScored: true, confirm: true });

        expect(res.status).toBe(200);
        expect(res.body.iscoredStatus).toBe('skipped');
        expect(res.body.message).toBe(KILL_SWITCH_409);
        expect(fake.deleteGame).not.toHaveBeenCalled();
        expect(await gameExists(gameId)).toBe(false); // the local removal is the point of this route
    });

    it('DELETE admin/games/:gameId removes the game locally and reports iscoredStatus=skipped', async () => {
        await setupTestDb();
        const app = await createTestApp();
        const roomId = await createTestRoom('ks-route-games', 'KS Route Games');
        await seedIScoredCreds(roomId);
        await GameRoomSettingsService.set(roomId, 'ISCORED_ALLOW_DELETE', 'false');
        const tId = await createTestTournament(roomId);
        const gameId = await addGame({ tournamentId: tId, roomId, name: 'Retired', status: 'COMPLETED', iscoredId: 'ISC_RET' });

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/admin/games/${gameId}`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({});

        expect(res.status).toBe(200);
        expect(res.body.iscoredStatus).toBe('skipped');
        expect(fake.deleteGame).not.toHaveBeenCalled();
        expect(await gameExists(gameId)).toBe(false);
    });

    it("POST sync-iscored {action:'delete'} is refused with 409 — its whole purpose is the remote delete", async () => {
        await setupTestDb();
        const app = await createTestApp();
        const roomId = await createTestRoom('ks-route-sync', 'KS Route Sync');
        await seedIScoredCreds(roomId);
        await GameRoomSettingsService.set(roomId, 'ISCORED_ALLOW_DELETE', 'false');
        const tId = await createTestTournament(roomId);
        const gameId = await addGame({ tournamentId: tId, roomId, name: 'Synced', status: 'ACTIVE', iscoredId: 'ISC_SY' });

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/game-states/${gameId}/sync-iscored`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ action: 'delete' });

        expect(res.status).toBe(409);
        expect(res.body.error).toBe(KILL_SWITCH_409);
        expect(fake.deleteGame).not.toHaveBeenCalled();
        // The local iscored_id must NOT have been cleared either.
        const db = await getDatabase();
        const row = await db.get<{ iscored_id: string | null }>('SELECT iscored_id FROM games WHERE id = ?', gameId);
        expect(row?.iscored_id).toBe('ISC_SY');
    });

    it('POST iscored-reconcile is refused with 409 before any session is acquired', async () => {
        await setupTestDb();
        const app = await createTestApp();
        const roomId = await createTestRoom('ks-route-reconcile', 'KS Route Reconcile');
        await seedIScoredCreds(roomId);
        await GameRoomSettingsService.set(roomId, 'ISCORED_ALLOW_DELETE', 'false');

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/game-states/iscored-reconcile`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ gameIds: ['9999'] });

        expect(res.status).toBe(409);
        expect(res.body.error).toBe(KILL_SWITCH_409);
        expect(fake.deleteGame).not.toHaveBeenCalled();
        expect(fake.getGamesOnIScored).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// (e) Reversible operations stay allowed
// ─────────────────────────────────────────────────────────────────────────────

describe('reversible/additive iScored operations are unaffected by the kill-switch', () => {
    it("sync-iscored 'lock' and 'unlock' still work with deletes disabled", async () => {
        await setupTestDb();
        const app = await createTestApp();
        const roomId = await createTestRoom('ks-lock', 'KS Lock');
        await seedIScoredCreds(roomId);
        await GameRoomSettingsService.set(roomId, 'ISCORED_ALLOW_DELETE', 'false');
        const tId = await createTestTournament(roomId);
        const gameId = await addGame({ tournamentId: tId, roomId, name: 'Lockable', status: 'ACTIVE', iscoredId: 'ISC_LK' });

        const lock = await request(app)
            .post(`/api/rooms/${roomId}/admin/game-states/${gameId}/sync-iscored`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ action: 'lock' });
        expect(lock.status).toBe(200);

        const unlock = await request(app)
            .post(`/api/rooms/${roomId}/admin/game-states/${gameId}/sync-iscored`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ action: 'unlock' });
        expect(unlock.status).toBe(200);

        expect(fake.setGameStatus).toHaveBeenCalledWith('ISC_LK', { locked: true });
        expect(fake.setGameStatus).toHaveBeenCalledWith('ISC_LK', { locked: false, hidden: false });
        expect(fake.deleteGame).not.toHaveBeenCalled();
    });
});
