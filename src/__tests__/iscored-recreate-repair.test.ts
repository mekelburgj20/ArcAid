import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';

/**
 * iScored link repair — `action: 'recreate'` + the link-check endpoint (v2.123.2).
 *
 * The incident (rtx_pinball, 2026-08-21): an admin deleted a DUPLICATE game on
 * iScored and took out the entry Arcaid was linked to. The local row stayed
 * ACTIVE holding a dead `iscored_id`, so every score push answered "Access
 * Denied" — and the Game States page offered nothing to fix it, because "Create
 * on iScored" only rendered when the id was already NULL and the only action
 * that NULLs it (`delete`) had no button.
 *
 * What has to hold:
 *
 *   1. recreate on a DEAD link creates a fresh entry, tags it, opens it,
 *      re-links the local row, and replays the Arcaid-side per-player BESTS.
 *   2. recreate on a LIVE link is refused with 409 — it must never be able to
 *      duplicate a game that is sitting right there on the board.
 *   3. recreate with a NULL id is simply a create (the old button's job).
 *   4. a score iScored rejects is COUNTED, and the repair still completes —
 *      one bad name must not strand the rest of the room.
 *   5. the link-check endpoint reports present/missing per linked game.
 *   6. the pre-mutation snapshot fires with reason 'recreate' (rollback net).
 *   7. a sync failure that says "Access Denied" on an ACTIVE game names the
 *      repair path in the log, so the next operator does not have to guess.
 *
 * No Playwright and no network: the session registry's test client factory and
 * a mocked IScoredApiClient stand in for both halves of the integration.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Seams
// ─────────────────────────────────────────────────────────────────────────────

/** Shared control for the mocked public-API client (score replay + submit sync). */
const iscoredApi: {
    submitted: Array<{ gameId: string; name: string; score: number }>;
    rejectScoresFor: Set<string>;
    throwOnSubmit: string | null;
    allScores: unknown;
} = { submitted: [], rejectScoresFor: new Set(), throwOnSubmit: null, allScores: { scores: [] } };

vi.mock('../engine/IScoredApiClient.js', () => ({
    IScoredApiClient: class {
        constructor(_opts: unknown) { /* no network in tests */ }
        static parseGameroomName(url: string) { return url.split('/').pop() || null; }
        async getAllScores() { return iscoredApi.allScores; }
        async submitScore(gameId: string, name: string, score: number) {
            if (iscoredApi.throwOnSubmit) throw new Error(iscoredApi.throwOnSubmit);
            if (iscoredApi.rejectScoresFor.has(name)) throw new Error(`iScored rejected ${name}`);
            iscoredApi.submitted.push({ gameId, name, score });
            return { GameID: gameId, gameName: '', scores: [] };
        }
    },
}));

vi.mock('../utils/logger.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/logger.js')>();
    return { ...actual, logWarn: vi.fn(), logError: vi.fn() };
});
import { logError } from '../utils/logger.js';

import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { IScoredSessionRegistry } from '../engine/IScoredSessionRegistry.js';
import { IScoredSnapshotService } from '../services/IScoredSnapshotService.js';
import type { IScoredClient } from '../engine/IScoredClient.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Fake authenticated Playwright client, recording every mutation in order. */
function makeFakeClient(opts: { onBoard?: Array<{ id: string; name: string }> } = {}) {
    const calls: string[] = [];
    const board = opts.onBoard ?? [];
    const createGame = vi.fn(async (name: string, _styleId?: string) => {
        calls.push(`createGame:${name}`);
        return 'ISC_NEW';
    });
    const setGameTags = vi.fn(async (id: string, tag: string) => { calls.push(`setGameTags:${id}:${tag}`); });
    const setGameStatus = vi.fn(async (id: string, s: { hidden?: boolean; locked?: boolean }) => {
        calls.push(`setGameStatus:${id}:hidden=${!!s.hidden}:locked=${!!s.locked}`);
    });
    const getGamesOnIScored = vi.fn(async () => {
        calls.push('getGamesOnIScored');
        return board.map(g => ({ ...g, hidden: false, locked: false, tags: [] }));
    });
    const submitScore = vi.fn(async (id: string, name: string, score: number) => {
        calls.push(`client.submitScore:${id}:${name}:${score}`);
    });
    const deleteGame = vi.fn(async () => true);
    const repositionLineup = vi.fn(async () => {});
    const client = {
        connect: async () => {}, disconnect: async () => {},
        createGame, setGameTags, setGameStatus, getGamesOnIScored,
        submitScore, deleteGame, repositionLineup,
    } as unknown as IScoredClient;
    return { client, calls, createGame, setGameTags, setGameStatus, getGamesOnIScored, submitScore, deleteGame };
}

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
    status?: string;
    iscoredId: string | null;
}): Promise<string> {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, iscored_id, start_date, end_date, game_room_id)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
        id, opts.tournamentId, opts.name, opts.status ?? 'ACTIVE', opts.iscoredId,
        new Date().toISOString(), opts.roomId,
    );
    return id;
}

/** Raw submissions row — the helper's version forces its own id + score_history. */
async function addSubmission(gameId: string, username: string, score: number): Promise<void> {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO submissions (id, game_id, discord_user_id, iscored_username, score, timestamp)
         VALUES (?, ?, 'SYSTEM', ?, ?, ?)`,
        `${gameId}-${username.toLowerCase()}-${score}`, gameId, username, score, new Date().toISOString(),
    );
}

async function addHistory(gameId: string, roomId: string, gameName: string, username: string, score: number): Promise<void> {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO score_history (game_name, game_room_id, game_id, iscored_username, score, source)
         VALUES (?, ?, ?, ?, ?, 'tournament')`,
        gameName, roomId, gameId, username, score,
    );
}

async function createTestApp() {
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

const adminToken = (roomId: string) => signToken({ role: 'room_admin', gameRoomIds: [roomId] });

const iscoredIdOf = async (gameId: string): Promise<string | null> => {
    const db = await getDatabase();
    const row = await db.get<{ iscored_id: string | null }>('SELECT iscored_id FROM games WHERE id = ?', gameId);
    return row?.iscored_id ?? null;
};

let fake: ReturnType<typeof makeFakeClient>;

// The rooms router pulls in a large dependency graph on first touch. Pay it
// once here rather than against whichever test happens to run first (it costs
// more than the 10s global testTimeout allows).
beforeAll(async () => {
    await import('../api/routes/rooms.js');
}, 120000);

function useClient(onBoard?: Array<{ id: string; name: string }>) {
    fake = makeFakeClient({ onBoard });
    IScoredSessionRegistry.getInstance().setClientFactoryForTests(() => fake.client);
    return fake;
}

// The env-fallback iScored account (ISCORED_USERNAME/PASSWORD/PUBLIC_URL in a
// developer's .env) would satisfy "no credentials" rooms and turn the 400 cases
// into 200s — CI has no .env, a workstation usually does. Pin it per test.
const ENV_CREDS_KEYS = ['ISCORED_USERNAME', 'ISCORED_PASSWORD', 'ISCORED_PUBLIC_URL'] as const;
let savedEnvCreds: Record<string, string | undefined> = {};

beforeEach(async () => {
    vi.mocked(logError).mockClear();
    iscoredApi.submitted = [];
    iscoredApi.rejectScoresFor = new Set();
    iscoredApi.throwOnSubmit = null;
    delete process.env.ISCORED_API_ENABLED;
    savedEnvCreds = {};
    for (const k of ENV_CREDS_KEYS) { savedEnvCreds[k] = process.env[k]; delete process.env[k]; }
    useClient();
});

afterEach(async () => {
    for (const k of ENV_CREDS_KEYS) {
        if (savedEnvCreds[k] === undefined) delete process.env[k]; else process.env[k] = savedEnvCreds[k];
    }
    const reg = IScoredSessionRegistry.getInstance();
    reg.setClientFactoryForTests(null);
    await reg.shutdown();
    IScoredSnapshotService.setRootForTests(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1 — the repair itself
// ─────────────────────────────────────────────────────────────────────────────

describe("sync-iscored action 'recreate' — the dead-link repair", () => {
    it('creates a fresh entry, tags + opens it, re-links the row, and replays per-player bests', async () => {
        await setupTestDb();
        const app = await createTestApp();
        const roomId = await createTestRoom('rr-repair', 'RR Repair');
        await seedIScoredCreds(roomId);
        const tId = await createTestTournament(roomId, { type: 'DG' });
        // The board still holds an unrelated game — the dead id is NOT on it.
        useClient([{ id: 'ISC_OTHER', name: 'Something Else' }]);
        const gameId = await addGame({ tournamentId: tId, roomId, name: 'Clown Deluxe', iscoredId: '105425' });

        // Two players, one with a lower earlier attempt: only the BEST goes back.
        await addSubmission(gameId, 'Krobs', 4_000_000);
        await addSubmission(gameId, 'Krobs', 9_000_000);
        await addSubmission(gameId, 'Nova', 2_500_000);

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/game-states/${gameId}/sync-iscored`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ action: 'recreate' });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            newId: 'ISC_NEW', oldId: '105425', scoresSubmitted: 2, scoresRejected: 0,
        });

        // The 3-call create shape, in order, with the tournament type as the tag.
        expect(fake.createGame).toHaveBeenCalledWith('Clown Deluxe', undefined);
        expect(fake.setGameTags).toHaveBeenCalledTimes(1);
        expect(fake.setGameTags).toHaveBeenCalledWith('ISC_NEW', 'DG');
        expect(fake.setGameStatus).toHaveBeenCalledWith('ISC_NEW', { locked: false, hidden: false });
        const order = fake.calls.filter(c => !c.startsWith('client.submitScore'));
        expect(order).toEqual([
            'getGamesOnIScored',
            'createGame:Clown Deluxe',
            'setGameTags:ISC_NEW:DG',
            'setGameStatus:ISC_NEW:hidden=false:locked=false',
        ]);

        // Re-linked locally — this is what makes ScoreSyncPoller work again.
        expect(await iscoredIdOf(gameId)).toBe('ISC_NEW');

        // Bests only, onto the NEW id.
        expect(iscoredApi.submitted.map(s => s.gameId)).toEqual(['ISC_NEW', 'ISC_NEW']);
        const byName = Object.fromEntries(iscoredApi.submitted.map(s => [s.name, s.score]));
        expect(byName).toEqual({ Krobs: 9_000_000, Nova: 2_500_000 });

        // Audit row records both ids and the replay tally.
        const db = await getDatabase();
        const audit = await db.get<{ details: string }>(
            "SELECT details FROM audit_log WHERE action = 'game_state.iscored_recreate' AND target_id = ?",
            gameId,
        );
        expect(audit).toBeTruthy();
        expect(JSON.parse(audit!.details)).toMatchObject({
            oldId: '105425', newId: 'ISC_NEW', submitted: 2, rejected: 0,
        });
    });

    it('falls back to score_history when the submissions rows were unlinked', async () => {
        await setupTestDb();
        const app = await createTestApp();
        const roomId = await createTestRoom('rr-history', 'RR History');
        await seedIScoredCreds(roomId);
        const tId = await createTestTournament(roomId);
        const gameId = await addGame({ tournamentId: tId, roomId, name: 'Attack From Mars', iscoredId: 'ISC_DEAD' });
        await addHistory(gameId, roomId, 'Attack From Mars', 'Krobs', 500);
        await addHistory(gameId, roomId, 'Attack From Mars', 'Krobs', 1500);

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/game-states/${gameId}/sync-iscored`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ action: 'recreate' });

        expect(res.status).toBe(200);
        expect(res.body.scoresSubmitted).toBe(1);
        expect(iscoredApi.submitted).toEqual([{ gameId: 'ISC_NEW', name: 'Krobs', score: 1500 }]);
    });

    it('refuses with 409 — and creates nothing — when the id is still on the board', async () => {
        await setupTestDb();
        const app = await createTestApp();
        const roomId = await createTestRoom('rr-live', 'RR Live');
        await seedIScoredCreds(roomId);
        const tId = await createTestTournament(roomId);
        useClient([{ id: '105425', name: 'Clown Deluxe' }]);
        const gameId = await addGame({ tournamentId: tId, roomId, name: 'Clown Deluxe', iscoredId: '105425' });
        await addSubmission(gameId, 'Krobs', 1000);

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/game-states/${gameId}/sync-iscored`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ action: 'recreate' });

        expect(res.status).toBe(409);
        expect(res.body.error).toBe('This game still exists on iScored (id 105425) — nothing to repair.');
        expect(fake.createGame).not.toHaveBeenCalled();
        expect(iscoredApi.submitted).toHaveLength(0);
        expect(await iscoredIdOf(gameId)).toBe('105425');
    });

    it('with a NULL iscored_id it is simply a create — no board read needed', async () => {
        await setupTestDb();
        const app = await createTestApp();
        const roomId = await createTestRoom('rr-null', 'RR Null');
        await seedIScoredCreds(roomId);
        const tId = await createTestTournament(roomId, { type: 'WG' });
        const gameId = await addGame({ tournamentId: tId, roomId, name: 'Theatre of Magic', iscoredId: null });

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/game-states/${gameId}/sync-iscored`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ action: 'recreate' });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ newId: 'ISC_NEW', oldId: null });
        expect(fake.getGamesOnIScored).not.toHaveBeenCalled();
        expect(fake.setGameTags).toHaveBeenCalledWith('ISC_NEW', 'WG');
        expect(await iscoredIdOf(gameId)).toBe('ISC_NEW');
    });

    it('tags a PINNED row with the pin default rather than a tournament type', async () => {
        await setupTestDb();
        const app = await createTestApp();
        const roomId = await createTestRoom('rr-pin', 'RR Pin');
        await seedIScoredCreds(roomId);
        const gameId = await addGame({ tournamentId: null, roomId, name: 'Pinned Table', iscoredId: null });

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/game-states/${gameId}/sync-iscored`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ action: 'recreate' });

        expect(res.status).toBe(200);
        expect(fake.setGameTags).toHaveBeenCalledWith('ISC_NEW', 'MG');
    });

    it('counts a rejected score and still completes the repair', async () => {
        await setupTestDb();
        const app = await createTestApp();
        const roomId = await createTestRoom('rr-reject', 'RR Reject');
        await seedIScoredCreds(roomId);
        const tId = await createTestTournament(roomId);
        const gameId = await addGame({ tournamentId: tId, roomId, name: 'Medieval Madness', iscoredId: 'ISC_DEAD' });
        await addSubmission(gameId, 'Krobs', 1000);
        await addSubmission(gameId, 'BadName', 2000);
        iscoredApi.rejectScoresFor = new Set(['BadName']);

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/game-states/${gameId}/sync-iscored`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ action: 'recreate' });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ newId: 'ISC_NEW', scoresSubmitted: 1, scoresRejected: 1 });
        // The rejection did not abort the repair: the re-link still landed.
        expect(await iscoredIdOf(gameId)).toBe('ISC_NEW');
    });

    it('captures a pre-mutation snapshot with reason "recreate"', async () => {
        await setupTestDb();
        const app = await createTestApp();
        const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'arcaid-recreate-'));
        IScoredSnapshotService.setRootForTests(tmpRoot);
        IScoredSnapshotService.resetDebounceForTests();
        try {
            const roomId = await createTestRoom('rr-snap', 'RR Snap');
            await seedIScoredCreds(roomId);
            const tId = await createTestTournament(roomId);
            const gameId = await addGame({ tournamentId: tId, roomId, name: 'Snapped', iscoredId: 'ISC_DEAD' });

            const res = await request(app)
                .post(`/api/rooms/${roomId}/admin/game-states/${gameId}/sync-iscored`)
                .set('Authorization', `Bearer ${adminToken(roomId)}`)
                .send({ action: 'recreate' });
            expect(res.status).toBe(200);

            const dir = path.join(tmpRoot, 'testacct');
            const files = (await fsp.readdir(dir)).filter(f => f.endsWith('.json'));
            expect(files).toHaveLength(1);
            const snap = JSON.parse(await fsp.readFile(path.join(dir, files[0]!), 'utf-8'));
            expect(snap.reason).toBe('recreate');
            expect(snap.roomIds).toEqual([roomId]);
        } finally {
            await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
        }
    });

    it('uses the Playwright client for the replay when the API is disabled', async () => {
        await setupTestDb();
        const app = await createTestApp();
        process.env.ISCORED_API_ENABLED = 'false';
        const roomId = await createTestRoom('rr-noapi', 'RR NoApi');
        await seedIScoredCreds(roomId);
        const tId = await createTestTournament(roomId);
        const gameId = await addGame({ tournamentId: tId, roomId, name: 'No API', iscoredId: 'ISC_DEAD' });
        await addSubmission(gameId, 'Krobs', 777);

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/game-states/${gameId}/sync-iscored`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ action: 'recreate' });

        expect(res.status).toBe(200);
        expect(res.body.scoresSubmitted).toBe(1);
        expect(fake.submitScore).toHaveBeenCalledWith('ISC_NEW', 'Krobs', 777);
        expect(iscoredApi.submitted).toHaveLength(0);
    });

    it("keeps the legacy 'create' action working for API compatibility", async () => {
        await setupTestDb();
        const app = await createTestApp();
        const roomId = await createTestRoom('rr-legacy', 'RR Legacy');
        await seedIScoredCreds(roomId);
        const tId = await createTestTournament(roomId);
        const gameId = await addGame({ tournamentId: tId, roomId, name: 'Legacy Create', iscoredId: null });

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/game-states/${gameId}/sync-iscored`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ action: 'create' });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, action: 'create' });
        expect(await iscoredIdOf(gameId)).toBe('ISC_NEW');
        // The legacy action stays exactly as it was: no tags, no unlock, no replay.
        expect(fake.setGameTags).not.toHaveBeenCalled();
        expect(iscoredApi.submitted).toHaveLength(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 — the diagnosis
// ─────────────────────────────────────────────────────────────────────────────

describe('GET game-states/iscored-link-check', () => {
    it('reports present/missing per linked game from one board read', async () => {
        await setupTestDb();
        const app = await createTestApp();
        const roomId = await createTestRoom('rr-check', 'RR Check');
        await seedIScoredCreds(roomId);
        const tId = await createTestTournament(roomId);
        useClient([{ id: 'ISC_ALIVE', name: 'Alive' }]);

        const aliveId = await addGame({ tournamentId: tId, roomId, name: 'Alive', iscoredId: 'ISC_ALIVE' });
        const deadId = await addGame({ tournamentId: tId, roomId, name: 'Dead', status: 'COMPLETED', iscoredId: 'ISC_GONE' });
        // Neither of these may appear: no link, and a link that is meant to be gone.
        await addGame({ tournamentId: tId, roomId, name: 'Unlinked', status: 'QUEUED', iscoredId: null });
        await addGame({ tournamentId: tId, roomId, name: 'Old', status: 'ARCHIVED', iscoredId: 'ISC_ARCHIVED' });

        const res = await request(app)
            .get(`/api/rooms/${roomId}/admin/game-states/iscored-link-check`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`);

        expect(res.status).toBe(200);
        expect(res.body.missingCount).toBe(1);
        expect(fake.getGamesOnIScored).toHaveBeenCalledTimes(1);
        const byId = Object.fromEntries(res.body.games.map((g: any) => [g.gameId, g]));
        expect(Object.keys(byId)).toHaveLength(2);
        expect(byId[aliveId]).toMatchObject({ name: 'Alive', iscoredId: 'ISC_ALIVE', present: true, status: 'ACTIVE' });
        expect(byId[deadId]).toMatchObject({ name: 'Dead', iscoredId: 'ISC_GONE', present: false, status: 'COMPLETED' });
    });

    it('400s when the room has no iScored credentials', async () => {
        await setupTestDb();
        const app = await createTestApp();
        const roomId = await createTestRoom('rr-nocreds', 'RR NoCreds');

        const res = await request(app)
            .get(`/api/rooms/${roomId}/admin/game-states/iscored-link-check`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`);

        expect(res.status).toBe(400);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 — the early warning
// ─────────────────────────────────────────────────────────────────────────────

describe('IScoredSubmitSync — "Access Denied" on an ACTIVE game names the repair path', () => {
    it('appends the Check-iScored-links hint', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('rr-hint', 'RR Hint');
        await seedIScoredCreds(roomId);
        const tId = await createTestTournament(roomId);
        await addGame({ tournamentId: tId, roomId, name: 'Clown Deluxe', iscoredId: '105425' });
        iscoredApi.throwOnSubmit = 'Access Denied';

        const { syncScoreToIScored } = await import('../services/IScoredSubmitSync.js');
        await syncScoreToIScored({ roomId, gameName: 'Clown Deluxe', username: 'Krobs', score: 10 });

        const messages = vi.mocked(logError).mock.calls.map(c => String(c[0]));
        expect(messages.some(m => m.includes('use Game States → Check iScored links'))).toBe(true);
    });

    it('leaves an unrelated failure message alone', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('rr-hint2', 'RR Hint2');
        await seedIScoredCreds(roomId);
        const tId = await createTestTournament(roomId);
        await addGame({ tournamentId: tId, roomId, name: 'Clown Deluxe', iscoredId: '105425' });
        iscoredApi.throwOnSubmit = 'socket hang up';

        const { syncScoreToIScored } = await import('../services/IScoredSubmitSync.js');
        await syncScoreToIScored({ roomId, gameName: 'Clown Deluxe', username: 'Krobs', score: 10 });

        const messages = vi.mocked(logError).mock.calls.map(c => String(c[0]));
        expect(messages.some(m => m.includes('socket hang up'))).toBe(true);
        expect(messages.some(m => m.includes('Check iScored links'))).toBe(false);
    });
});
