import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

/**
 * iScored room snapshots (v2.117.0).
 *
 * The safety net for the destructive half of the iScored integration. What has
 * to hold:
 *
 *   1. capture writes the v1 shape, groups scores under the right game, and
 *      NEVER drops a score whose game the list read missed (orphanScores).
 *   2. a partial capture still writes a file, and does not arm the debounce.
 *   3. the debounce collapses the Wed 22:00 multi-tournament fire on one
 *      account into a single snapshot; `force` bypasses it.
 *   4. prune never leaves a gameroom with nothing.
 *   5. planRestore matches on iScored's apostrophe-stripping name rule and
 *      replays per-player BESTS only.
 *   6. executeRestore emits one setGameTags call PER TAG, re-links the local
 *      `games` row, and one failing game never strands the next.
 *   7. the admin param guard refuses traversal before touching the FS.
 *   8. maintenance snapshots BEFORE it rotates anything.
 *
 * No Playwright: the session registry's test client factory + a mocked
 * IScoredApiClient stand in for both halves of the integration.
 */

// ─────────────────────────────────────────────────────────────────────────────
// iScored public-API seam
// ─────────────────────────────────────────────────────────────────────────────

const iscoredApi: {
    allScores: any;
    throwOnGetAll: string | null;
    submitted: Array<{ gameId: string; name: string; score: number }>;
    rejectScoresFor: Set<string>;
} = { allScores: { scores: [] }, throwOnGetAll: null, submitted: [], rejectScoresFor: new Set() };

vi.mock('../engine/IScoredApiClient.js', () => ({
    IScoredApiClient: class {
        constructor(_opts: unknown) { /* no network in tests */ }
        static parseGameroomName(url: string) { return url.split('/').pop() || null; }
        async getAllScores() {
            if (iscoredApi.throwOnGetAll) throw new Error(iscoredApi.throwOnGetAll);
            return iscoredApi.allScores;
        }
        async submitScore(gameId: string, name: string, score: number) {
            if (iscoredApi.rejectScoresFor.has(name)) throw new Error(`iScored rejected ${name}`);
            iscoredApi.submitted.push({ gameId, name, score });
            return { GameID: gameId, gameName: '', scores: [], submittedScore: { name, rank: '1', score: String(score) } };
        }
    },
}));

const { IScoredSnapshotService } = await import('../services/IScoredSnapshotService.js');
const { normalizeIScoredScoreResponse } = await import('../utils/iscoredScores.js');
const { setupTestDb, createTestRoom, createTestTournament } = await import('./helpers.js');
const { getDatabase } = await import('../database/database.js');

type Creds = import('../utils/iscoredCreds.js').IScoredCreds;

const creds = (username: string, gameroom = username): Creds => ({
    username,
    password: 'pw',
    publicUrl: `https://www.iscored.info/${gameroom}`,
    gameroomName: gameroom,
    source: 'room',
});

/** Minimal stand-in for the authenticated Playwright client. */
function fakeClient(overrides: Partial<Record<string, any>> = {}) {
    const calls: string[] = [];
    const client: any = {
        calls,
        games: [] as Array<{ id: string; name: string; hidden: boolean; locked: boolean; tags: string[] }>,
        async getGamesOnIScored() { calls.push('getGamesOnIScored'); return client.games; },
        async createGame(name: string) { calls.push(`createGame:${name}`); return `new-${name.replace(/\s+/g, '_')}`; },
        async setGameTags(id: string, tag: string) { calls.push(`setGameTags:${id}:${tag}`); },
        async setGameStatus(id: string, s: { hidden?: boolean; locked?: boolean }) { calls.push(`setGameStatus:${id}:${!!s.hidden}:${!!s.locked}`); },
        async submitScore(id: string, name: string, score: number) { calls.push(`submitScore:${id}:${name}:${score}`); },
        async connect() {}, async disconnect() {},
        ...overrides,
    };
    return client;
}

let tmpRoot: string;

beforeEach(async () => {
    await setupTestDb();
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'arcaid-snap-'));
    IScoredSnapshotService.setRootForTests(tmpRoot);
    IScoredSnapshotService.resetDebounceForTests();
    iscoredApi.allScores = { scores: [] };
    iscoredApi.throwOnGetAll = null;
    iscoredApi.submitted = [];
    iscoredApi.rejectScoresFor = new Set();
    delete process.env.ISCORED_SNAPSHOT_DEBOUNCE_MS;
    delete process.env.ISCORED_SNAPSHOTS_ENABLED;
});

afterEach(async () => {
    IScoredSnapshotService.setRootForTests(null);
    if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

/** Read the single snapshot written for a gameroom. */
async function readOnly(gameroom: string) {
    const dir = path.join(tmpRoot, gameroom);
    const files = (await fsp.readdir(dir)).filter(f => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    return JSON.parse(await fsp.readFile(path.join(dir, files[0]!), 'utf-8'));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 + 2 — capture
// ─────────────────────────────────────────────────────────────────────────────

describe('IScoredSnapshotService.capture', () => {
    it('writes the v1 shape with scores grouped under the right game', async () => {
        const client = fakeClient();
        client.games = [
            { id: '1', name: 'Bad Cats', hidden: false, locked: false, tags: ['weekly'] },
            { id: '2', name: 'WHO dunnit', hidden: true, locked: true, tags: [] },
        ];
        iscoredApi.allScores = {
            scores: [
                { name: 'Krobs', game: '1', gameName: 'Bad Cats', score: '12345678', date: 'd1', rank: '1' },
                { name: 'Justin', game: '1', gameName: 'Bad Cats', score: '999', date: 'd2', rank: '2' },
                { name: 'Ghost', game: '2', gameName: 'WHO dunnit', score: '500', date: 'd3', rank: '1' },
            ],
        };

        const res = await IScoredSnapshotService.capture(client, creds('acct', 'testroom'), 'maintenance', ['room-a']);
        expect(res.ok).toBe(true);
        expect(res.name).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/);

        const snap = await readOnly('testroom');
        expect(snap.v).toBe(1);
        expect(snap.reason).toBe('maintenance');
        expect(snap.roomIds).toEqual(['room-a']);
        expect(snap.account).toMatchObject({ gameroomName: 'testroom', username: 'acct', source: 'room' });
        expect(snap.gamesCaptured).toBe(true);
        expect(snap.scoresCaptured).toBe(true);
        expect(snap.counts).toEqual({ games: 2, scores: 3 });
        expect(snap.games[0]).toMatchObject({ id: '1', name: 'Bad Cats', hidden: false, locked: false, tags: ['weekly'] });
        expect(snap.games[0].scores.map((s: any) => s.name)).toEqual(['Krobs', 'Justin']);
        expect(snap.games[1]).toMatchObject({ id: '2', hidden: true, locked: true });
        expect(snap.games[1].scores).toHaveLength(1);
        expect(snap.orphanScores).toEqual([]);
    });

    it('keeps scores whose game id matched nothing in the game list (orphanScores)', async () => {
        const client = fakeClient();
        client.games = [{ id: '1', name: 'Bad Cats', hidden: false, locked: false, tags: [] }];
        iscoredApi.allScores = {
            scores: [
                { name: 'Krobs', game: '1', gameName: 'Bad Cats', score: '10', date: '', rank: '1' },
                { name: 'Nobody', game: '404', gameName: 'Vanished', score: '77', date: '', rank: '1' },
            ],
        };

        await IScoredSnapshotService.capture(client, creds('acct', 'testroom'), 'nightly', []);
        const snap = await readOnly('testroom');

        expect(snap.orphanScores).toHaveLength(1);
        expect(snap.orphanScores[0].GameID).toBe('404');
        expect(snap.orphanScores[0].scores[0].name).toBe('Nobody');
        expect(snap.counts.scores).toBe(2); // orphans count too — never dropped
    });

    it('still writes the file when the score API throws, flagged scoresCaptured:false', async () => {
        const client = fakeClient();
        client.games = [{ id: '1', name: 'Bad Cats', hidden: false, locked: false, tags: [] }];
        iscoredApi.throwOnGetAll = 'iScored API error: 503';

        const res = await IScoredSnapshotService.capture(client, creds('acct', 'testroom'), 'cleanup', []);
        expect(res.ok).toBe(true);

        const snap = await readOnly('testroom');
        expect(snap.scoresCaptured).toBe(false);
        expect(snap.scoresError).toMatch(/503/);
        expect(snap.gamesCaptured).toBe(true);
        expect(snap.games).toHaveLength(1);
    });

    it('flags gamesCaptured:false when the game list read throws, and still writes', async () => {
        const client = fakeClient({ getGamesOnIScored: async () => { throw new Error('page closed'); } });
        iscoredApi.allScores = { scores: [{ name: 'Krobs', game: '1', gameName: 'Bad Cats', score: '10' }] };

        await IScoredSnapshotService.capture(client, creds('acct', 'testroom'), 'reconcile', []);
        const snap = await readOnly('testroom');

        expect(snap.gamesCaptured).toBe(false);
        expect(snap.games).toEqual([]);
        // Every score survives as an orphan rather than vanishing with the list.
        expect(snap.orphanScores).toHaveLength(1);
    });

    it('re-reads before trusting an empty game list (a single [] is ambiguous)', async () => {
        let n = 0;
        const client = fakeClient({
            getGamesOnIScored: async () => {
                n++;
                return n === 1 ? [] : [{ id: '7', name: 'Late Read', hidden: false, locked: false, tags: [] }];
            },
        });

        await IScoredSnapshotService.capture(client, creds('acct', 'testroom'), 'manual', []);
        const snap = await readOnly('testroom');

        expect(n).toBe(2);
        expect(snap.gamesCaptured).toBe(true);
        expect(snap.games).toHaveLength(1);
    });

    it('flags the list as MISSING when it is empty twice but the score API still shows games', async () => {
        // getGamesOnIScored swallows transport failures into [] — an empty list
        // alongside live scores is a failed read, not an empty room.
        const client = fakeClient({ getGamesOnIScored: async () => [] });
        iscoredApi.allScores = { scores: [{ name: 'Krobs', game: '9', gameName: 'Ghost', score: '100', date: '', rank: '1' }] };

        const first = await IScoredSnapshotService.capture(client, creds('acct', 'testroom'), 'maintenance', []);
        const snap = await readOnly('testroom');

        expect(first.ok).toBe(true);
        expect(snap.gamesCaptured).toBe(false);
        expect(snap.games).toHaveLength(0);
        expect(snap.orphanScores).toHaveLength(1);
        // A partial capture must not arm the debounce.
        const second = await IScoredSnapshotService.capture(client, creds('acct', 'testroom'), 'maintenance', []);
        expect(second.skipped).toBeUndefined();
    });

    it('captureBeforeMutation swallows everything — the mutation is never blocked', async () => {
        const client = fakeClient({ getGamesOnIScored: async () => { throw new Error('boom'); } });
        IScoredSnapshotService.setRootForTests(path.join(tmpRoot, 'x\0y')); // unwritable path
        await expect(
            IScoredSnapshotService.captureBeforeMutation(client, creds('acct', 'testroom'), 'unpin', []),
        ).resolves.toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 — debounce
// ─────────────────────────────────────────────────────────────────────────────

describe('IScoredSnapshotService.capture — per-account debounce', () => {
    const okClient = () => {
        const c = fakeClient();
        c.games = [{ id: '1', name: 'Bad Cats', hidden: false, locked: false, tags: [] }];
        return c;
    };

    it('skips a second capture for the same account inside the window', async () => {
        const client = okClient();
        const first = await IScoredSnapshotService.capture(client, creds('acct', 'testroom'), 'maintenance', []);
        const second = await IScoredSnapshotService.capture(client, creds('acct', 'testroom'), 'maintenance', []);

        expect(first.skipped).toBeUndefined();
        expect(second.skipped).toBe(true);
        expect(second.name).toBeUndefined();
        await readOnly('testroom'); // exactly one file
    });

    it('does not skip a DIFFERENT account', async () => {
        const client = okClient();
        await IScoredSnapshotService.capture(client, creds('acct-a', 'room-a'), 'maintenance', []);
        const other = await IScoredSnapshotService.capture(client, creds('acct-b', 'room-b'), 'maintenance', []);

        expect(other.skipped).toBeUndefined();
        expect(other.name).toBeDefined();
    });

    it('force bypasses the window', async () => {
        const client = okClient();
        await IScoredSnapshotService.capture(client, creds('acct', 'testroom'), 'maintenance', []);
        const forced = await IScoredSnapshotService.capture(client, creds('acct', 'testroom'), 'nightly', [], { force: true });

        expect(forced.skipped).toBeUndefined();
        expect(forced.name).toBeDefined();
    });

    it('a PARTIAL capture does not arm the debounce — the next mutation retries', async () => {
        const client = okClient();
        iscoredApi.throwOnGetAll = 'down';
        const partial = await IScoredSnapshotService.capture(client, creds('acct', 'testroom'), 'maintenance', []);
        expect(partial.ok).toBe(true);
        expect(partial.snapshot!.scoresCaptured).toBe(false);

        iscoredApi.throwOnGetAll = null;
        const retry = await IScoredSnapshotService.capture(client, creds('acct', 'testroom'), 'maintenance', []);
        expect(retry.skipped).toBeUndefined();
        expect(retry.snapshot!.scoresCaptured).toBe(true);
    });

    it('a zero-length window disables debouncing entirely', async () => {
        process.env.ISCORED_SNAPSHOT_DEBOUNCE_MS = '0';
        const client = okClient();
        await IScoredSnapshotService.capture(client, creds('acct', 'testroom'), 'maintenance', []);
        const second = await IScoredSnapshotService.capture(client, creds('acct', 'testroom'), 'maintenance', []);
        expect(second.skipped).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 — prune
// ─────────────────────────────────────────────────────────────────────────────

describe('IScoredSnapshotService.prune', () => {
    const nameFor = (daysAgo: number) =>
        `${new Date(Date.now() - daysAgo * 86400000).toISOString().replace(/[:.]/g, '-')}.json`;

    async function seed(gameroom: string, daysAgoList: number[], extra: string[] = []) {
        const dir = path.join(tmpRoot, gameroom);
        await fsp.mkdir(dir, { recursive: true });
        const written: string[] = [];
        for (const d of daysAgoList) {
            const n = nameFor(d);
            await fsp.writeFile(path.join(dir, n), '{}', 'utf-8');
            written.push(n);
        }
        for (const e of extra) await fsp.writeFile(path.join(dir, e), 'x', 'utf-8');
        return { dir, written };
    }

    it('deletes snapshots older than the retention window', async () => {
        const { dir } = await seed('testroom', [0, 5, 60, 90]);
        const pruned = await IScoredSnapshotService.prune(30);

        expect(pruned).toBe(2);
        const left = (await fsp.readdir(dir)).length;
        expect(left).toBe(2);
    });

    it('never deletes the newest file, even when everything is expired', async () => {
        const { dir, written } = await seed('testroom', [100, 200, 300]);
        const pruned = await IScoredSnapshotService.prune(30);

        expect(pruned).toBe(2);
        const left = await fsp.readdir(dir);
        expect(left).toHaveLength(1);
        expect(left[0]).toBe(written[0]); // the newest of the three
    });

    it('ignores files that are not snapshots', async () => {
        const { dir } = await seed('testroom', [0, 90], ['README.md', 'notes.txt']);
        await IScoredSnapshotService.prune(30);

        const left = await fsp.readdir(dir);
        expect(left).toContain('README.md');
        expect(left).toContain('notes.txt');
        expect(left.filter(f => f.endsWith('.json'))).toHaveLength(1);
    });

    it('leaves a single-snapshot gameroom alone', async () => {
        const { dir } = await seed('testroom', [999]);
        expect(await IScoredSnapshotService.prune(1)).toBe(0);
        expect(await fsp.readdir(dir)).toHaveLength(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// list()
// ─────────────────────────────────────────────────────────────────────────────

describe('IScoredSnapshotService.list', () => {
    it('reports one row per snapshot, newest first, with the partial flags', async () => {
        const client = fakeClient();
        client.games = [{ id: '1', name: 'Bad Cats', hidden: false, locked: false, tags: [] }];
        await IScoredSnapshotService.capture(client, creds('a', 'room-a'), 'manual', [], { force: true });
        iscoredApi.throwOnGetAll = 'down';
        await IScoredSnapshotService.capture(client, creds('b', 'room-b'), 'manual', [], { force: true });

        const rows = await IScoredSnapshotService.list();
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map(r => r.gameroom))).toEqual(new Set(['room-a', 'room-b']));
        expect(rows[0]!.capturedAt >= rows[1]!.capturedAt).toBe(true);
        expect(rows.find(r => r.gameroom === 'room-b')!.scoresCaptured).toBe(false);
        expect(rows.find(r => r.gameroom === 'room-a')!.games).toBe(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 — planRestore (pure)
// ─────────────────────────────────────────────────────────────────────────────

describe('IScoredSnapshotService.planRestore', () => {
    const snapshot = (games: any[]) => ({
        v: 1 as const,
        capturedAt: new Date().toISOString(),
        reason: 'manual' as const,
        account: { gameroomName: 'r', publicUrl: 'u', username: 'a', source: 'room' as const },
        roomIds: [],
        gamesCaptured: true,
        scoresCaptured: true,
        counts: { games: games.length, scores: 0 },
        games,
        orphanScores: [],
    });

    it('splits present vs missing on the apostrophe-stripped, case-folded name', async () => {
        const snap = snapshot([
            { id: '1', name: "Elvira's House", hidden: false, locked: false, tags: [], scores: [] },
            { id: '2', name: 'Bad Cats', hidden: false, locked: false, tags: [], scores: [] },
        ]);
        // iScored stored the apostrophe-free, differently-cased variant.
        const live = [{ id: '900', name: '  ELVIRAS HOUSE ' }];

        const plan = IScoredSnapshotService.planRestore(snap, live, []);

        expect(plan.alreadyPresent).toEqual([{ id: '1', name: "Elvira's House", liveId: '900' }]);
        expect(plan.toCreate.map(g => g.id)).toEqual(['2']);
    });

    it('replays per-player BESTS only, one entry per player', async () => {
        const snap = snapshot([{
            id: '1', name: 'Bad Cats', hidden: true, locked: true, tags: ['weekly', 'DG'],
            scores: [
                { name: 'Krobs', score: '100', date: '', rank: '3' },
                { name: 'krobs', score: '900', date: '', rank: '1' },
                { name: 'Justin', score: '500', date: '', rank: '2' },
                { name: '', score: '1', date: '', rank: '4' },
            ],
        }]);

        const plan = IScoredSnapshotService.planRestore(snap, [], []);
        const game = plan.toCreate[0]!;

        expect(game.scoreCount).toBe(2);
        // Case-insensitive player keying, and the WINNING row's casing is the one
        // replayed — which is exactly what iScored itself does (it canonicalizes a
        // player's display casing to their highest-scoring entry).
        expect(game.scores).toEqual([{ name: 'krobs', score: 900 }, { name: 'Justin', score: 500 }]);
        expect(game).toMatchObject({ hidden: true, locked: true, tags: ['weekly', 'DG'] });
    });

    it('honours the gameIds filter and reports the local rows that would be re-linked', async () => {
        const snap = snapshot([
            { id: '1', name: 'Bad Cats', hidden: false, locked: false, tags: [], scores: [] },
            { id: '2', name: 'WHO dunnit', hidden: false, locked: false, tags: [], scores: [] },
        ]);
        const localRows = [
            { id: 'g-1', name: 'Bad Cats', iscored_id: '1' },
            { id: 'g-2', name: 'WHO dunnit', iscored_id: '2' },
            { id: 'g-3', name: 'Unrelated', iscored_id: null },
        ];

        const plan = IScoredSnapshotService.planRestore(snap, [], localRows, ['2']);

        expect(plan.toCreate).toHaveLength(1);
        expect(plan.toCreate[0]!.id).toBe('2');
        expect(plan.toCreate[0]!.localGameRows).toEqual([{ id: 'g-2', name: 'WHO dunnit' }]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 — executeRestore
// ─────────────────────────────────────────────────────────────────────────────

describe('IScoredSnapshotService.executeRestore', () => {
    async function seedLocalGame(iscoredId: string, name: string) {
        const db = await getDatabase();
        const roomId = await createTestRoom(`er-${iscoredId}`, `ER ${iscoredId}`);
        const tId = await createTestTournament(roomId, { name: `T ${iscoredId}` });
        const gameId = crypto.randomUUID();
        await db.run(
            `INSERT INTO games (id, tournament_id, game_room_id, name, iscored_id, status, start_date)
             VALUES (?, ?, ?, ?, ?, 'COMPLETED', ?)`,
            gameId, tId, roomId, name, iscoredId, new Date().toISOString(),
        );
        return gameId;
    }

    it('creates, tags one-call-per-tag, sets status, submits bests and re-links the local row', async () => {
        const gameId = await seedLocalGame('1', 'Bad Cats');
        const client = fakeClient();
        const plan = {
            alreadyPresent: [],
            toCreate: [{
                id: '1', name: 'Bad Cats', hidden: true, locked: false,
                tags: ['weekly', 'DG'],
                scores: [{ name: 'Krobs', score: 900 }, { name: 'Justin', score: 500 }],
                scoreCount: 2,
                localGameRows: [{ id: gameId, name: 'Bad Cats' }],
            }],
        };

        const results = await IScoredSnapshotService.executeRestore(client, creds('acct', 'testroom'), plan);

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            snapshotId: '1', newId: 'new-Bad_Cats', scoresSubmitted: 2, scoresRejected: 0, relinkedLocalGames: 1,
        });
        expect(results[0]!.error).toBeUndefined();

        // ONE setGameTags call per tag — never comma-joined.
        expect(client.calls.filter((c: string) => c.startsWith('setGameTags:'))).toEqual([
            'setGameTags:new-Bad_Cats:weekly',
            'setGameTags:new-Bad_Cats:DG',
        ]);
        // Opened first (scores are rejected on a locked game), snapshot state applied LAST.
        const statusCalls = client.calls.filter((c: string) => c.startsWith('setGameStatus:'));
        expect(statusCalls).toEqual([
            'setGameStatus:new-Bad_Cats:false:false',
            'setGameStatus:new-Bad_Cats:true:false',
        ]);
        expect(client.calls.indexOf('setGameStatus:new-Bad_Cats:true:false'))
            .toBeGreaterThan(client.calls.indexOf('setGameTags:new-Bad_Cats:DG'));

        // Scores go through the REST API (ISCORED_API_ENABLED defaults on).
        expect(iscoredApi.submitted).toEqual([
            { gameId: 'new-Bad_Cats', name: 'Krobs', score: 900 },
            { gameId: 'new-Bad_Cats', name: 'Justin', score: 500 },
        ]);

        const db = await getDatabase();
        const row = await db.get('SELECT iscored_id FROM games WHERE id = ?', gameId);
        expect(row.iscored_id).toBe('new-Bad_Cats');
    });

    it('counts rejected scores without aborting the game', async () => {
        await seedLocalGame('1', 'Bad Cats');
        iscoredApi.rejectScoresFor = new Set(['Justin']);
        const client = fakeClient();

        const results = await IScoredSnapshotService.executeRestore(client, creds('acct', 'testroom'), {
            alreadyPresent: [],
            toCreate: [{
                id: '1', name: 'Bad Cats', hidden: false, locked: false, tags: [],
                scores: [{ name: 'Krobs', score: 900 }, { name: 'Justin', score: 500 }],
                scoreCount: 2, localGameRows: [],
            }],
        });

        expect(results[0]).toMatchObject({ scoresSubmitted: 1, scoresRejected: 1 });
        expect(results[0]!.newId).toBe('new-Bad_Cats');
    });

    it('records a failing game and continues with the next one', async () => {
        const client = fakeClient({
            createGame: async (name: string) => {
                if (name === 'Boom') throw new Error('createGame blew up');
                return `new-${name}`;
            },
        });

        const results = await IScoredSnapshotService.executeRestore(client, creds('acct', 'testroom'), {
            alreadyPresent: [],
            toCreate: [
                { id: '1', name: 'Boom', hidden: false, locked: false, tags: [], scores: [], scoreCount: 0, localGameRows: [] },
                { id: '2', name: 'Fine', hidden: false, locked: false, tags: [], scores: [], scoreCount: 0, localGameRows: [] },
            ],
        });

        expect(results).toHaveLength(2);
        expect(results[0]!.error).toMatch(/blew up/);
        expect(results[0]!.newId).toBeNull();
        expect(results[1]!.newId).toBe('new-Fine');
    });

    it('falls back to the Playwright submit path when the API is disabled', async () => {
        const prev = process.env.ISCORED_API_ENABLED;
        process.env.ISCORED_API_ENABLED = 'false';
        try {
            const client = fakeClient();
            await IScoredSnapshotService.executeRestore(client, creds('acct', 'testroom'), {
                alreadyPresent: [],
                toCreate: [{
                    id: '1', name: 'Bad Cats', hidden: false, locked: false, tags: [],
                    scores: [{ name: 'Krobs', score: 900 }], scoreCount: 1, localGameRows: [],
                }],
            });
            expect(client.calls).toContain('submitScore:new-Bad_Cats:Krobs:900');
            expect(iscoredApi.submitted).toEqual([]);
        } finally {
            if (prev === undefined) delete process.env.ISCORED_API_ENABLED;
            else process.env.ISCORED_API_ENABLED = prev;
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7 — param guard
// ─────────────────────────────────────────────────────────────────────────────

describe('snapshot path guard', () => {
    it('refuses traversal and malformed names at the service boundary', () => {
        expect(IScoredSnapshotService.resolvePath('..', '2026-08-20T14-03-11-123Z.json')).toBeNull();
        expect(IScoredSnapshotService.resolvePath('room/../..', '2026-08-20T14-03-11-123Z.json')).toBeNull();
        expect(IScoredSnapshotService.resolvePath('testroom', '../../../etc/passwd')).toBeNull();
        expect(IScoredSnapshotService.resolvePath('testroom', '..\\..\\arcaid.db')).toBeNull();
        expect(IScoredSnapshotService.resolvePath('testroom', 'arcaid.db')).toBeNull();
        expect(IScoredSnapshotService.resolvePath('testroom', '2026-08-20T14-03-11-123Z.json'))
            .toBe(path.join(tmpRoot, 'testroom', '2026-08-20T14-03-11-123Z.json'));
    });

    it('the admin routes reject a traversal name without touching the FS', async () => {
        const request = (await import('supertest')).default;
        const express = (await import('express')).default;
        const { signToken } = await import('../api/auth.js');
        const { default: adminRouter } = await import('../api/routes/admin.js');

        const app = express();
        app.use(express.json());
        app.use('/api/admin', adminRouter);
        const token = signToken({ role: 'super_admin', gameRoomIds: [], username: 'super' });

        const readSpy = vi.spyOn(fs, 'existsSync');
        for (const badName of ['..%2F..%2Farcaid.db', 'arcaid.db', 'not-a-timestamp.json']) {
            const res = await request(app)
                .get(`/api/admin/iscored-snapshots/testroom/${badName}/download`)
                .set('Authorization', `Bearer ${token}`);
            expect([400, 404]).toContain(res.status);
        }
        const res = await request(app)
            .delete('/api/admin/iscored-snapshots/..%2F..%2Fdata/2026-08-20T14-03-11-123Z.json')
            .set('Authorization', `Bearer ${token}`);
        expect([400, 404]).toContain(res.status);
        readSpy.mockRestore();
    });

    it('the admin list route is super-admin gated', async () => {
        const request = (await import('supertest')).default;
        const express = (await import('express')).default;
        const { default: adminRouter } = await import('../api/routes/admin.js');

        const app = express();
        app.use(express.json());
        app.use('/api/admin', adminRouter);

        expect((await request(app).get('/api/admin/iscored-snapshots')).status).toBe(401);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8 — the maintenance hook
// ─────────────────────────────────────────────────────────────────────────────

describe('TournamentEngine.runMaintenance — pre-mutation snapshot', () => {
    it('snapshots with reason "maintenance" before any slot work', async () => {
        const { IScoredSessionRegistry } = await import('../engine/IScoredSessionRegistry.js');
        const { TournamentEngine } = await import('../engine/TournamentEngine.js');
        const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');

        const order: string[] = [];
        const client = fakeClient({
            getGamesOnIScored: async () => { order.push('client'); return []; },
        });
        const registry = IScoredSessionRegistry.getInstance();
        registry.setClientFactoryForTests(() => client);

        const spy = vi.spyOn(IScoredSnapshotService, 'captureBeforeMutation')
            .mockImplementation(async () => { order.push('snapshot'); });

        try {
            const roomId = await createTestRoom('snap-maint', 'Snap Maint');
            await GameRoomSettingsService.set(roomId, 'ISCORED_USERNAME', 'acct');
            await GameRoomSettingsService.set(roomId, 'ISCORED_PASSWORD', 'pw');
            await GameRoomSettingsService.set(roomId, 'ISCORED_PUBLIC_URL', 'https://www.iscored.info/snaproom');
            const tId = await createTestTournament(roomId, { name: 'Snap T' });

            await TournamentEngine.getInstance().runMaintenance(tId);

            expect(spy).toHaveBeenCalledTimes(1);
            const [, credsArg, reason, roomIds] = spy.mock.calls[0]!;
            expect(reason).toBe('maintenance');
            expect(roomIds).toEqual([roomId]);
            expect((credsArg as Creds).gameroomName).toBe('snaproom');
            expect(order[0]).toBe('snapshot'); // before ANY client work
        } finally {
            spy.mockRestore();
            registry.setClientFactoryForTests(null);
            await registry.shutdown();
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9 — the normalisation extraction
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeIScoredScoreResponse (extracted from ScoreSyncPoller)', () => {
    it('groups the flat getAllScores payload by game id', () => {
        const out = normalizeIScoredScoreResponse({
            scores: [
                { name: 'A', game: '1', gameName: 'One', score: 10, date: 'd', rank: '1' },
                { name: 'B', game: '1', gameName: 'One', score: 5, date: 'd', rank: '2' },
                { name: 'C', game: '2', gameName: 'Two', score: 7, date: 'd', rank: '1' },
            ],
        });
        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({ GameID: '1', gameName: 'One' });
        expect(out[0]!.scores.map(s => s.name)).toEqual(['A', 'B']);
        expect(out[0]!.scores[0]!.score).toBe('10'); // scores stringified, as the poller always did
        expect(out[1]!.GameID).toBe('2');
    });

    it('accepts a bare array, tolerates GameID casing, and drops id-less entries', () => {
        const out = normalizeIScoredScoreResponse([
            { name: 'A', GameID: '9', gameName: 'Nine', score: 1 },
            { name: 'B', score: 2 },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0]!.GameID).toBe('9');
    });

    it('returns [] on an unexpected shape instead of throwing', () => {
        expect(normalizeIScoredScoreResponse(null)).toEqual([]);
        expect(normalizeIScoredScoreResponse({ nope: true })).toEqual([]);
    });
});
