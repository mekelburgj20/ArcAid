import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { IGDBImportService } from '../services/IGDBImportService.js';
import { SyncLogService } from '../services/SyncLogService.js';
import { IGDB_PLATFORM_MAP, IGDB_PLATFORM_NAMES, IGDB_TARGET_PLATFORMS } from '../utils/platformMapping.js';
import { signToken } from '../api/auth.js';

/**
 * igdb-import-hardening (2026-08).
 *
 * The IGDB bulk seed had never completed a run, and had no tests at all. These
 * cover the defects that made it uncompletable — transport retry, bounded
 * auth retry, keyset checkpoint/resume, a real completeness verdict, the
 * corrected platform ids, pending status, and the single-flight guard.
 *
 * Everything talks to a stubbed `fetch`. The stub is corpus-driven: it parses
 * the Apicalypse `where id > N` / `limit L` out of the query and answers the
 * matching slice, so keyset paging is genuinely exercised rather than asserted
 * against a canned response.
 */

interface StubGame {
    id: number;
    name: string;
    platforms: number[];
    game_type?: number;
    cover?: { image_id: string };
    first_release_date?: number;
}

/** One scripted HTTP outcome for the /games endpoint. */
type GamesScript =
    | { kind: 'status'; status: number; headers?: Record<string, string>; body?: string }
    | { kind: 'network'; message: string };

interface MockState {
    corpus: StubGame[];
    count: number | null;
    /** Consumed in order before the corpus answers. */
    gamesScript: GamesScript[];
    /** Rows the stub claims /platforms returns; defaults to our own names. */
    platformRows?: Array<{ id: number; name: string }>;
    /** From this /games call onward, answer 429 (simulates a mid-run stall). */
    failFromGamesCall?: number;
    calls: { games: number; count: number; token: number; platforms: number };
    gamesQueries: string[];
}

let mock: MockState;

function jsonResponse(body: unknown) {
    return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

function parseNumber(query: string, re: RegExp): number | null {
    const m = query.match(re);
    return m ? Number(m[1]) : null;
}

function installFetchMock() {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        // Twitch OAuth
        if (typeof url === 'string' && url.includes('id.twitch.tv')) {
            mock.calls.token++;
            return jsonResponse({ access_token: `tok-${mock.calls.token}`, expires_in: 86400, token_type: 'bearer' });
        }

        // IGDB cover images — the background pass.
        if (typeof url === 'string' && url.includes('images.igdb.com')) {
            return {
                ok: true,
                status: 200,
                headers: { get: () => null },
                arrayBuffer: async () => new ArrayBuffer(4),
            } as unknown as Response;
        }

        const body = String(init?.body ?? '');

        if (typeof url === 'string' && url.endsWith('/games/count')) {
            mock.calls.count++;
            if (mock.count == null) {
                // A non-transient failure, so the importer gives up on the
                // denominator immediately rather than burning its retry budget.
                return {
                    ok: false,
                    status: 400,
                    headers: { get: () => null },
                    json: async () => ({}),
                    text: async () => 'count unavailable',
                } as unknown as Response;
            }
            return jsonResponse({ count: mock.count });
        }

        if (typeof url === 'string' && url.endsWith('/platforms')) {
            mock.calls.platforms++;
            // Default: IGDB agrees with us, so a run produces no spurious
            // mismatch warnings. Tests override to simulate disagreement.
            const rows = mock.platformRows
                ?? Object.entries(IGDB_PLATFORM_NAMES).map(([id, name]) => ({ id: Number(id), name }));
            return jsonResponse(rows);
        }

        if (typeof url === 'string' && url.endsWith('/genres')) return jsonResponse([{ id: 1, name: 'Shooter' }]);
        if (typeof url === 'string' && url.endsWith('/themes')) return jsonResponse([{ id: 1, name: 'Action' }]);
        if (typeof url === 'string' && url.endsWith('/game_modes')) return jsonResponse([{ id: 1, name: 'Single player' }]);

        if (typeof url === 'string' && url.endsWith('/games')) {
            mock.calls.games++;
            mock.gamesQueries.push(body);

            if (mock.failFromGamesCall != null && mock.calls.games >= mock.failFromGamesCall) {
                return {
                    ok: false,
                    status: 429,
                    headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? '0' : null) },
                    json: async () => [],
                    text: async () => 'rate limited',
                } as unknown as Response;
            }

            const scripted = mock.gamesScript.shift();
            if (scripted) {
                if (scripted.kind === 'network') throw new Error(scripted.message);
                return {
                    ok: scripted.status >= 200 && scripted.status < 300,
                    status: scripted.status,
                    headers: { get: (h: string) => scripted.headers?.[h.toLowerCase()] ?? null },
                    json: async () => [],
                    text: async () => scripted.body ?? '',
                } as unknown as Response;
            }

            const after = parseNumber(body, /where id > (\d+)/) ?? 0;
            const limit = parseNumber(body, /limit (\d+)/) ?? 500;
            const page = mock.corpus
                .filter(g => g.id > after)
                .sort((a, b) => a.id - b.id)
                .slice(0, limit);
            return jsonResponse(page);
        }

        throw new Error(`Unexpected fetch URL in test: ${url}`);
    }));
}

function resetMock(overrides: Partial<MockState> = {}) {
    mock = {
        corpus: [],
        count: null,
        gamesScript: [],
        platformRows: [],
        calls: { games: 0, count: 0, token: 0, platforms: 0 },
        gamesQueries: [],
        ...overrides,
    };
}

function makeCorpus(n: number, startId = 100): StubGame[] {
    return Array.from({ length: n }, (_, i) => ({
        id: startId + i,
        name: `Test Game ${startId + i}`,
        platforms: [52],
        game_type: 0,
    }));
}

describe('IGDB importer hardening', () => {
    beforeEach(async () => {
        await setupTestDb();
        process.env.TWITCH_CLIENT_ID = 'test-client-id';
        process.env.TWITCH_CLIENT_SECRET = 'test-client-secret';
        resetMock();
        installFetchMock();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        delete process.env.TWITCH_CLIENT_ID;
        delete process.env.TWITCH_CLIENT_SECRET;
    });

    // ── Transport: retry, Retry-After, bounded auth retry ───────────────────

    describe('igdbFetch transport', () => {
        // The retry logic is private; reached directly so a failing assertion
        // points at the transport rather than at whichever import used it.
        const igdbFetch = (endpoint: string, query: string) =>
            (IGDBImportService as unknown as {
                igdbFetch: (e: string, q: string) => Promise<unknown>;
            }).igdbFetch(endpoint, query);

        it('retries a 429 and succeeds on the following attempt', async () => {
            resetMock({ corpus: makeCorpus(1), gamesScript: [{ kind: 'status', status: 429, body: 'slow down' }] });
            const result = await igdbFetch('games', 'fields id; where id > 0; limit 500;');
            expect(Array.isArray(result)).toBe(true);
            expect((result as unknown[]).length).toBe(1);
            expect(mock.calls.games).toBe(2);
        });

        it('honours Retry-After (delta-seconds) rather than its own backoff', async () => {
            resetMock({
                corpus: makeCorpus(1),
                gamesScript: [{ kind: 'status', status: 429, headers: { 'retry-after': '1' }, body: 'slow down' }],
            });
            const started = Date.now();
            await igdbFetch('games', 'fields id; where id > 0; limit 500;');
            const elapsed = Date.now() - started;
            // Retry-After: 1 means at least a second. The unjittered backoff
            // for attempt 1 tops out at 1000ms too, so the load-bearing part of
            // this assertion is the floor: a jittered backoff could have fired
            // as early as ~500ms, Retry-After cannot.
            expect(elapsed).toBeGreaterThanOrEqual(950);
            expect(mock.calls.games).toBe(2);
        });

        it('retries 5xx as transient', async () => {
            resetMock({
                corpus: makeCorpus(1),
                gamesScript: [
                    { kind: 'status', status: 503, body: 'unavailable' },
                    { kind: 'status', status: 502, body: 'bad gateway' },
                ],
            });
            const result = await igdbFetch('games', 'fields id; where id > 0; limit 500;');
            expect((result as unknown[]).length).toBe(1);
            expect(mock.calls.games).toBe(3);
        });

        it('retries network-level failures', async () => {
            resetMock({
                corpus: makeCorpus(1),
                gamesScript: [{ kind: 'network', message: 'ECONNRESET' }],
            });
            const result = await igdbFetch('games', 'fields id; where id > 0; limit 500;');
            expect((result as unknown[]).length).toBe(1);
            expect(mock.calls.games).toBe(2);
        });

        it('gives up after the attempt cap and throws with the last body', async () => {
            resetMock({
                gamesScript: Array.from({ length: 5 }, () => (
                    { kind: 'status', status: 429, headers: { 'retry-after': '0' }, body: 'rate limited' } as GamesScript
                )),
            });
            await expect(igdbFetch('games', 'fields id; where id > 0; limit 500;'))
                .rejects.toThrow(/failed after 5 attempts/i);
            expect(mock.calls.games).toBe(5);
        });

        it('does not retry a non-transient error status', async () => {
            resetMock({ gamesScript: [{ kind: 'status', status: 400, body: 'syntax error' }] });
            await expect(igdbFetch('games', 'bad query'))
                .rejects.toThrow(/returned 400/);
            expect(mock.calls.games).toBe(1);
        });

        it('refreshes the token on 401 exactly once, then throws actionably', async () => {
            // Two 401s in a row. The old code recursed on every 401 with no
            // bound, so this input never terminated.
            resetMock({
                gamesScript: [
                    { kind: 'status', status: 401, body: 'unauthorized' },
                    { kind: 'status', status: 401, body: 'unauthorized' },
                ],
            });
            await expect(igdbFetch('games', 'fields id; where id > 0; limit 500;'))
                .rejects.toThrow(/401 twice/i);
            expect(mock.calls.games).toBe(2);
        });

        it('recovers when the second attempt after a 401 succeeds', async () => {
            resetMock({
                corpus: makeCorpus(1),
                gamesScript: [{ kind: 'status', status: 401, body: 'unauthorized' }],
            });
            const result = await igdbFetch('games', 'fields id; where id > 0; limit 500;');
            expect((result as unknown[]).length).toBe(1);
            // The cached token was cleared, so a fresh one was minted.
            expect(mock.calls.token).toBeGreaterThanOrEqual(2);
        });

        it('clears the cached token when a 401 is seen', async () => {
            resetMock({ corpus: makeCorpus(1), gamesScript: [{ kind: 'status', status: 401, body: 'nope' }] });
            await igdbFetch('games', 'fields id; where id > 0; limit 500;');
            const db = await getDatabase();
            // A fresh token was stored by the retry — the point is that the
            // stale one did not survive.
            const row = await db.get("SELECT value FROM settings WHERE key = 'TWITCH_ACCESS_TOKEN'");
            expect(row?.value).toBe(`tok-${mock.calls.token}`);
        });
    });

    // ── Platform translation ────────────────────────────────────────────────

    describe('platform id translation', () => {
        it('maps the three corrected ids to the right canonical platforms', () => {
            expect(IGDB_PLATFORM_MAP[86]).toBe('tg16');
            expect(IGDB_PLATFORM_MAP[62]).toBe('jaguar');
            expect(IGDB_PLATFORM_MAP[50]).toBe('3do');
        });

        it('no longer translates the three ids that meant something else', () => {
            // 51 = Famicom Disk System, 67 = Intellivision, 87 = Virtual Boy.
            expect(IGDB_PLATFORM_MAP[51]).toBeUndefined();
            expect(IGDB_PLATFORM_MAP[67]).toBeUndefined();
            expect(IGDB_PLATFORM_MAP[87]).toBeUndefined();
        });

        it('excludes PC, Switch and Wii from the crawl but keeps translating them', () => {
            expect(IGDB_TARGET_PLATFORMS).not.toContain(6);
            expect(IGDB_TARGET_PLATFORMS).not.toContain(130);
            expect(IGDB_TARGET_PLATFORMS).not.toContain(5);
            expect(IGDB_PLATFORM_MAP[6]).toBe('pc');
            expect(IGDB_PLATFORM_MAP[130]).toBe('switch');
            expect(IGDB_PLATFORM_MAP[5]).toBe('wii');
            expect(IGDB_TARGET_PLATFORMS).toContain(52);
            expect(IGDB_TARGET_PLATFORMS).toContain(86);
        });

        it('writes the corrected canonical platform onto the imported row', async () => {
            resetMock({
                corpus: [{ id: 100, name: 'Bonk Adventure', platforms: [86], game_type: 0 }],
                count: 1,
            });
            await IGDBImportService.importFromIGDB();
            const db = await getDatabase();
            const row = await db.get(`SELECT platforms FROM global_games WHERE igdb_id = 100`);
            expect(JSON.parse(row.platforms)).toContain('tg16');
        });

        it('skips a game whose platforms are all untranslatable', async () => {
            resetMock({
                corpus: [{ id: 100, name: 'FDS Only', platforms: [51], game_type: 0 }],
                count: 1,
            });
            const result = await IGDBImportService.importFromIGDB();
            expect(result.imported).toBe(0);
            expect(result.skipped).toBe(1);
        });

        it('WARNs on a live /platforms name mismatch without aborting', async () => {
            resetMock({
                corpus: makeCorpus(1),
                count: 1,
                platformRows: [{ id: 52, name: 'Something Else Entirely' }],
            });
            const mismatches = await IGDBImportService.verifyPlatformIds();
            expect(mismatches).toEqual([
                expect.objectContaining({ id: 52, actual: 'Something Else Entirely' }),
            ]);
        });
    });

    // ── Keyset paging, checkpoint, resume ───────────────────────────────────

    describe('keyset pagination and checkpointing', () => {
        it('pages by cursor, not offset, and advances past the last id seen', async () => {
            resetMock({ corpus: makeCorpus(1200, 1), count: 1200 });
            const result = await IGDBImportService.importFromIGDB();

            expect(result.total).toBe(1200);
            // No offset anywhere; every page carries a cursor.
            for (const q of mock.gamesQueries) {
                expect(q).not.toMatch(/offset/);
                expect(q).toMatch(/where id > \d+/);
                expect(q).toMatch(/sort id asc/);
            }
            // First page from 0, then from the last id of each previous page.
            expect(mock.gamesQueries[0]).toMatch(/where id > 0/);
            expect(mock.gamesQueries[1]).toMatch(/where id > 500/);
            expect(mock.gamesQueries[2]).toMatch(/where id > 1000/);
        });

        it('persists a checkpoint after every page', async () => {
            resetMock({ corpus: makeCorpus(1200, 1), count: 1200 });
            await IGDBImportService.importFromIGDB();

            const db = await getDatabase();
            const log = await db.get(`SELECT * FROM sync_logs WHERE source = 'igdb' ORDER BY started_at DESC LIMIT 1`);
            expect(log.last_id).toBe(1200);
            expect(log.pages_done).toBe(3);
            expect(log.records_fetched).toBe(1200);
            expect(log.expected_total).toBe(1200);
            expect(log.target_fingerprint).toContain('game_type = 0');
        });

        it('resumes an interrupted run from its cursor instead of restarting', async () => {
            const db = await getDatabase();
            const fingerprint = `platforms = (${IGDB_TARGET_PLATFORMS.join(',')}) & game_type = 0`;
            await db.run(
                `INSERT INTO sync_logs (
                    id, source, status, started_at, heartbeat_at,
                    records_imported, records_updated, records_skipped,
                    pages_done, records_fetched, expected_total, last_id, target_fingerprint
                 ) VALUES ('ckpt-1', 'igdb', 'interrupted', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
                           400, 0, 100, 1, 500, 700, 500, ?)`,
                fingerprint,
            );

            resetMock({ corpus: makeCorpus(700, 1), count: 700 });
            const result = await IGDBImportService.importFromIGDB();

            expect(result.resumed).toBe(true);
            // Picked up at the cursor — never re-fetched the first 500.
            expect(mock.gamesQueries[0]).toMatch(/where id > 500/);
            // Cumulative: 500 carried forward + 200 new.
            expect(result.total).toBe(700);
            expect(result.imported).toBe(400 + 200);
        });

        it('ignores a checkpoint taken against a different query', async () => {
            const db = await getDatabase();
            await db.run(
                `INSERT INTO sync_logs (
                    id, source, status, started_at, heartbeat_at,
                    pages_done, records_fetched, expected_total, last_id, target_fingerprint
                 ) VALUES ('ckpt-2', 'igdb', 'interrupted', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
                           1, 500, 700, 500, 'platforms = (999) & game_type = 0')`,
            );

            resetMock({ corpus: makeCorpus(10, 1), count: 10 });
            const result = await IGDBImportService.importFromIGDB();

            expect(result.resumed).toBe(false);
            expect(mock.gamesQueries[0]).toMatch(/where id > 0/);
        });

        it('restart: true abandons a resumable checkpoint', async () => {
            const db = await getDatabase();
            const fingerprint = `platforms = (${IGDB_TARGET_PLATFORMS.join(',')}) & game_type = 0`;
            await db.run(
                `INSERT INTO sync_logs (
                    id, source, status, started_at, heartbeat_at,
                    pages_done, records_fetched, expected_total, last_id, target_fingerprint
                 ) VALUES ('ckpt-3', 'igdb', 'interrupted', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
                           1, 500, 700, 500, ?)`,
                fingerprint,
            );

            resetMock({ corpus: makeCorpus(10, 1), count: 10 });
            const result = await IGDBImportService.importFromIGDB({ restart: true });

            expect(result.resumed).toBe(false);
            expect(mock.gamesQueries[0]).toMatch(/where id > 0/);
        });

        it('does not resume a run that completed successfully', async () => {
            const db = await getDatabase();
            const fingerprint = `platforms = (${IGDB_TARGET_PLATFORMS.join(',')}) & game_type = 0`;
            await db.run(
                `INSERT INTO sync_logs (
                    id, source, status, started_at, heartbeat_at, completed_at,
                    pages_done, records_fetched, expected_total, last_id, target_fingerprint
                 ) VALUES ('done-1', 'igdb', 'success', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
                           '2026-08-01T01:00:00.000Z', 2, 700, 700, 700, ?)`,
                fingerprint,
            );

            resetMock({ corpus: makeCorpus(10, 1), count: 10 });
            const result = await IGDBImportService.importFromIGDB();
            expect(result.resumed).toBe(false);
        });

        it('leaves a thrown run resumable, with its counts intact', async () => {
            // Page 1 lands; every call from page 2 onward is a 429, so the
            // retry budget runs out and the run throws mid-crawl.
            resetMock({ corpus: makeCorpus(1200, 1), count: 1200, failFromGamesCall: 2 });

            await expect(IGDBImportService.importFromIGDB()).rejects.toThrow();

            const db = await getDatabase();
            const log = await db.get(`SELECT * FROM sync_logs WHERE source = 'igdb' ORDER BY started_at DESC LIMIT 1`);
            expect(log.status).toBe('error');
            expect(log.last_id).toBe(500);
            expect(log.records_fetched).toBe(500);
            expect(log.records_imported).toBe(500);

            const checkpoint = await SyncLogService.findResumable(
                'igdb', `platforms = (${IGDB_TARGET_PLATFORMS.join(',')}) & game_type = 0`,
            );
            expect(checkpoint?.lastId).toBe(500);
            expect(checkpoint?.imported).toBe(500);
        });
    });

    // ── Completeness verdict ────────────────────────────────────────────────

    describe('count-based completeness', () => {
        it('asks the count endpoint with the same where-clause as the crawl', async () => {
            resetMock({ corpus: makeCorpus(10, 1), count: 10 });
            await IGDBImportService.importFromIGDB();
            expect(mock.calls.count).toBe(1);
            const db = await getDatabase();
            const log = await db.get(`SELECT * FROM sync_logs WHERE source = 'igdb' ORDER BY started_at DESC LIMIT 1`);
            expect(log.expected_total).toBe(10);
        });

        it('completes a full run as success', async () => {
            resetMock({ corpus: makeCorpus(10, 1), count: 10 });
            const result = await IGDBImportService.importFromIGDB();
            expect(result.status).toBe('success');
        });

        it('completes a short run as partial, not success', async () => {
            // The source says 1000; the crawl only ever sees 10. Previously a
            // short page was taken as the end of the result set and this
            // reported success.
            resetMock({ corpus: makeCorpus(10, 1), count: 1000 });
            const result = await IGDBImportService.importFromIGDB();
            expect(result.status).toBe('partial');

            const db = await getDatabase();
            const log = await db.get(`SELECT * FROM sync_logs WHERE source = 'igdb' ORDER BY started_at DESC LIMIT 1`);
            expect(log.status).toBe('partial');
            expect(JSON.parse(log.errors)[0]).toMatch(/10 of ~1000/);
        });

        it('tolerates a 2% shortfall as success (the count races the crawl)', async () => {
            resetMock({ corpus: makeCorpus(99, 1), count: 100 });
            const result = await IGDBImportService.importFromIGDB();
            expect(result.status).toBe('success');
        });

        it('does not judge a sampled run short', async () => {
            resetMock({ corpus: makeCorpus(1200, 1), count: 1200 });
            const result = await IGDBImportService.importFromIGDB({ limit: 500 });
            expect(result.total).toBe(500);
            expect(result.status).toBe('success');
        });

        it('runs without a verdict when the count is unavailable', async () => {
            resetMock({ corpus: makeCorpus(10, 1), count: null });
            const result = await IGDBImportService.importFromIGDB();
            expect(result.expectedTotal).toBeNull();
            expect(result.status).toBe('success');
        });
    });

    // ── Catalogue effects ───────────────────────────────────────────────────

    describe('catalogue writes', () => {
        it('stamps bulk rows pending, not approved', async () => {
            resetMock({ corpus: makeCorpus(3, 1), count: 3 });
            await IGDBImportService.importFromIGDB();
            const db = await getDatabase();
            const rows = await db.all(`SELECT status FROM global_games WHERE imported_from = 'igdb'`);
            expect(rows.length).toBe(3);
            expect(rows.every((r: { status: string }) => r.status === 'pending')).toBe(true);
        });

        it('keeps a big import out of the room-facing (approved) catalogue', async () => {
            resetMock({ corpus: makeCorpus(5, 1), count: 5 });
            await IGDBImportService.importFromIGDB();
            const db = await getDatabase();
            const approved = await db.get(
                `SELECT COUNT(*) AS n FROM global_games WHERE status = 'approved'`,
            );
            expect(approved.n).toBe(0);
        });

        it('writes the dedup key so imported rows use the index path', async () => {
            resetMock({ corpus: [{ id: 100, name: 'The Amazing Game!', platforms: [52], game_type: 0 }], count: 1 });
            await IGDBImportService.importFromIGDB();
            const db = await getDatabase();
            const row = await db.get(`SELECT normalized_name FROM global_games WHERE igdb_id = 100`);
            expect(row.normalized_name).toBe('amazing game');
        });

        it('downloads covers after the metadata pass, not inside the row loop', async () => {
            resetMock({
                corpus: [{ id: 100, name: 'Covered', platforms: [52], game_type: 0, cover: { image_id: 'abc' } }],
                count: 1,
            });
            await IGDBImportService.importFromIGDB();
            const db = await getDatabase();
            const row = await db.get(`SELECT local_image_path FROM global_games WHERE igdb_id = 100`);
            expect(row.local_image_path).toBe('data/catalogue-images/igdb/100.jpg');
        });
    });
});

// ── Single-flight guard on the admin endpoint ───────────────────────────────

describe('POST /api/admin/catalogue/sync-igdb — single flight', () => {
    beforeEach(async () => {
        await setupTestDb();
        process.env.TWITCH_CLIENT_ID = 'test-client-id';
        process.env.TWITCH_CLIENT_SECRET = 'test-client-secret';
        resetMock({ corpus: [], count: 0 });
        installFetchMock();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        delete process.env.TWITCH_CLIENT_ID;
        delete process.env.TWITCH_CLIENT_SECRET;
    });

    async function createTestApp() {
        const app = express();
        app.use(express.json());
        const { default: adminRouter } = await import('../api/routes/admin.js');
        app.use('/api/admin', adminRouter);
        return app;
    }

    const superAdmin = () => signToken({ role: 'super_admin', gameRoomIds: [] });

    it('409s while a run is genuinely in flight, and reports its progress', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO sync_logs (
                id, source, status, started_at, heartbeat_at,
                records_imported, pages_done, records_fetched, expected_total, last_id
             ) VALUES ('live-1', 'igdb', 'running', ?, ?, 250, 1, 500, 5000, 500)`,
            new Date().toISOString(), new Date().toISOString(),
        );

        const app = await createTestApp();
        const res = await request(app)
            .post('/api/admin/catalogue/sync-igdb')
            .set('Authorization', `Bearer ${superAdmin()}`)
            .send({});

        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/already running/i);
        expect(res.body.job).toMatchObject({ id: 'live-1', pages_done: 1, records_fetched: 500, expected_total: 5000 });
    });

    it('does not let a dead run block a new one', async () => {
        const db = await getDatabase();
        const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        await db.run(
            `INSERT INTO sync_logs (id, source, status, started_at, heartbeat_at, last_id)
             VALUES ('dead-1', 'igdb', 'running', ?, ?, 500)`,
            stale, stale,
        );

        const app = await createTestApp();
        const res = await request(app)
            .post('/api/admin/catalogue/sync-igdb')
            .set('Authorization', `Bearer ${superAdmin()}`)
            .send({});

        expect(res.status).toBe(202);

        // The 202 fires a background import. Let it finish against this test's
        // DB — otherwise it runs on past teardown and logs SQLITE_MISUSE into
        // whichever test follows.
        await vi.waitFor(async () => {
            const row = await db.get(
                `SELECT status FROM sync_logs WHERE source = 'igdb' AND id != 'dead-1' ORDER BY started_at DESC LIMIT 1`,
            );
            expect(row?.status === 'success' || row?.status === 'partial').toBe(true);
        }, { timeout: 8000, interval: 100 });
    });

    it('400s with the provider error when the credentials are rejected', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            if (typeof url === 'string' && url.includes('id.twitch.tv')) {
                return { ok: false, status: 403, text: async () => 'invalid client secret' } as unknown as Response;
            }
            throw new Error(`Unexpected fetch URL in test: ${url}`);
        }));

        const app = await createTestApp();
        const res = await request(app)
            .post('/api/admin/catalogue/sync-igdb')
            .set('Authorization', `Bearer ${superAdmin()}`)
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid client secret/);
    });
});

// ── sync_logs lifecycle ─────────────────────────────────────────────────────

describe('sync_logs lifecycle', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    it('opens a run as running, not success', async () => {
        const id = await SyncLogService.start('igdb');
        const db = await getDatabase();
        const row = await db.get('SELECT * FROM sync_logs WHERE id = ?', id);
        expect(row.status).toBe('running');
        expect(row.heartbeat_at).toBeTruthy();
        expect(row.completed_at).toBeNull();
    });

    it('sweeps a run abandoned by a dead process to interrupted', async () => {
        const db = await getDatabase();
        const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        await db.run(
            `INSERT INTO sync_logs (id, source, status, started_at, heartbeat_at)
             VALUES ('abandoned', 'igdb', 'running', ?, ?)`,
            stale, stale,
        );

        const swept = await SyncLogService.sweepStaleRunning();
        expect(swept).toBe(1);
        const row = await db.get(`SELECT * FROM sync_logs WHERE id = 'abandoned'`);
        expect(row.status).toBe('interrupted');
        expect(row.completed_at).toBeTruthy();
    });

    it('leaves a live run alone', async () => {
        const id = await SyncLogService.start('igdb');
        const swept = await SyncLogService.sweepStaleRunning();
        expect(swept).toBe(0);
        const db = await getDatabase();
        const row = await db.get('SELECT * FROM sync_logs WHERE id = ?', id);
        expect(row.status).toBe('running');
    });

    it('records progress and bumps the heartbeat', async () => {
        const id = await SyncLogService.start('igdb');
        const db = await getDatabase();
        const before = await db.get('SELECT heartbeat_at FROM sync_logs WHERE id = ?', id);

        await new Promise(r => setTimeout(r, 5));
        await SyncLogService.recordProgress(id, {
            lastId: 900, pagesDone: 2, recordsFetched: 1000, imported: 800, updated: 100, skipped: 100,
        });

        const after = await db.get('SELECT * FROM sync_logs WHERE id = ?', id);
        expect(after.last_id).toBe(900);
        expect(after.pages_done).toBe(2);
        expect(after.records_imported).toBe(800);
        expect(after.heartbeat_at >= before.heartbeat_at).toBe(true);
    });
});
