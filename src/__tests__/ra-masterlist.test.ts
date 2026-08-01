import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { RAMasterListService, RA_SYNC_SOURCE, MASTER_LIST_MAX_AGE_MS } from '../services/RAMasterListService.js';
import { SyncLogService } from '../services/SyncLogService.js';
import { RA_CONSOLE_ENGINE_MAP } from '../utils/scoreProvenance.js';
import { raSearchHandler } from '../api/raCatalogueHandlers.js';

/**
 * RA on-demand import §2 — master list sync, staleness gate, search.
 *
 * `fetch` is stubbed with a per-console corpus so the sync's reconciliation
 * (upsert, per-console delete, failure isolation) is genuinely exercised
 * rather than asserted against one canned page.
 */

const TEST_KEY = 'test-ra-key';

interface MockState {
    /** consoleId → rows the API answers with. */
    corpus: Map<number, Array<Record<string, unknown>>>;
    /** consoleIds whose request should fail. */
    failConsoles: Set<number>;
    calls: number[];
}

let mock: MockState;

function installFetchMock() {
    mock = { corpus: new Map(), failConsoles: new Set(), calls: [] };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const consoleId = Number(new URL(url).searchParams.get('i'));
        mock.calls.push(consoleId);
        if (mock.failConsoles.has(consoleId)) {
            return {
                ok: false, status: 500,
                headers: { get: () => null },
                text: async () => 'boom',
            } as unknown as Response;
        }
        const rows = mock.corpus.get(consoleId) ?? [];
        return {
            ok: true, status: 200,
            headers: { get: () => null },
            text: async () => JSON.stringify(rows),
        } as unknown as Response;
    }));
}

function raRow(id: number, title: string, consoleId: number, extra: Record<string, unknown> = {}) {
    return {
        ID: id, Title: title, ConsoleID: consoleId, ConsoleName: `Console ${consoleId}`,
        ImageIcon: `/Images/${id}.png`, NumAchievements: 10, NumLeaderboards: 3,
        DateModified: '2026-01-01 00:00:00', ...extra,
    };
}

/** Seeds one master-list row directly, bypassing the API. */
async function seedRaGame(
    raGameId: number, title: string, consoleId = 7,
    opts: { syncedAt?: string; numLeaderboards?: number } = {},
) {
    const db = await getDatabase();
    const { normalizeGameName } = await import('../utils/catalogueUtils.js');
    await db.run(
        `INSERT OR REPLACE INTO ra_games (
            ra_game_id, console_id, console_name, title, normalized_title,
            image_icon, num_achievements, num_leaderboards, date_modified, synced_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        raGameId, consoleId, `Console ${consoleId}`, title, normalizeGameName(title),
        `/Images/${raGameId}.png`, 10, opts.numLeaderboards ?? 3, '2026-01-01 00:00:00',
        opts.syncedAt ?? new Date().toISOString(),
    );
}

describe('RA master list (contract §2)', () => {
    const originalKey = process.env.RA_API_KEY;

    beforeEach(async () => {
        await setupTestDb();
        process.env.RA_API_KEY = TEST_KEY;
        installFetchMock();
    });

    afterEach(async () => {
        // `ensureFresh` starts a sync it does not await; let it finish before
        // the next test replaces the DB under it.
        await RAMasterListService.settle();
        vi.unstubAllGlobals();
        if (originalKey === undefined) delete process.env.RA_API_KEY;
        else process.env.RA_API_KEY = originalKey;
    });

    describe('syncAll', () => {
        it('pulls every mapped console and upserts the rows', async () => {
            mock.corpus.set(7, [raRow(1, 'Donkey Kong', 7), raRow(2, 'Super Mario Bros.', 7)]);
            mock.corpus.set(27, [raRow(3, 'Pac-Man', 27)]);

            const result = await RAMasterListService.syncAll({ pauseMs: 0 });

            const mappedConsoles = Object.keys(RA_CONSOLE_ENGINE_MAP).length;
            expect(mock.calls.sort((a, b) => a - b))
                .toEqual(Object.keys(RA_CONSOLE_ENGINE_MAP).map(Number).sort((a, b) => a - b));
            expect(result.consoles).toBe(mappedConsoles);
            expect(result.consolesFailed).toBe(0);
            expect(result.imported).toBe(3);
            expect(result.total).toBe(3);
            expect(result.status).toBe('success');

            const db = await getDatabase();
            const row = await db.get(`SELECT * FROM ra_games WHERE ra_game_id = 1`);
            expect(row.title).toBe('Donkey Kong');
            expect(row.normalized_title).toBe('donkey kong');
            expect(row.console_id).toBe(7);
            expect(row.num_leaderboards).toBe(3);
        });

        it('counts a second run as updates, not imports', async () => {
            mock.corpus.set(7, [raRow(1, 'Donkey Kong', 7)]);
            await RAMasterListService.syncAll({ pauseMs: 0 });

            mock.corpus.set(7, [raRow(1, 'Donkey Kong (USA)', 7, { NumLeaderboards: 9 })]);
            const second = await RAMasterListService.syncAll({ pauseMs: 0 });

            expect(second.imported).toBe(0);
            expect(second.updated).toBe(1);

            const db = await getDatabase();
            const row = await db.get(`SELECT * FROM ra_games WHERE ra_game_id = 1`);
            expect(row.title).toBe('Donkey Kong (USA)');
            expect(row.num_leaderboards).toBe(9);
        });

        it('deletes rows RA no longer lists for that console', async () => {
            mock.corpus.set(7, [raRow(1, 'Keeper', 7), raRow(2, 'Goner', 7)]);
            await RAMasterListService.syncAll({ pauseMs: 0 });

            mock.corpus.set(7, [raRow(1, 'Keeper', 7)]);
            const second = await RAMasterListService.syncAll({ pauseMs: 0 });

            expect(second.removed).toBe(1);
            const db = await getDatabase();
            const rows = await db.all(`SELECT ra_game_id FROM ra_games`);
            expect(rows.map((r: any) => r.ra_game_id)).toEqual([1]);
        });

        it('isolates a failed console: its rows survive and the run is partial', async () => {
            mock.corpus.set(7, [raRow(1, 'NES game', 7)]);
            mock.corpus.set(27, [raRow(2, 'Arcade game', 27)]);
            await RAMasterListService.syncAll({ pauseMs: 0 });

            // Console 7 now fails. Its row must NOT be swept — a transient RA
            // hiccup is not evidence the games ceased to exist.
            mock.failConsoles.add(7);
            mock.corpus.set(27, [raRow(2, 'Arcade game', 27)]);
            const second = await RAMasterListService.syncAll({ pauseMs: 0 });

            expect(second.consolesFailed).toBe(1);
            expect(second.status).toBe('partial');

            const db = await getDatabase();
            const survivor = await db.get(`SELECT * FROM ra_games WHERE ra_game_id = 1`);
            expect(survivor, 'a failed console must not lose its rows').toBeTruthy();
        });

        it('keeps existing rows when a console answers with an empty list', async () => {
            mock.corpus.set(7, [raRow(1, 'NES game', 7)]);
            await RAMasterListService.syncAll({ pauseMs: 0 });

            mock.corpus.set(7, []);
            await RAMasterListService.syncAll({ pauseMs: 0 });

            const db = await getDatabase();
            expect(await db.get(`SELECT * FROM ra_games WHERE ra_game_id = 1`)).toBeTruthy();
        });

        it('records the run on sync_logs with the running/progress lifecycle', async () => {
            mock.corpus.set(7, [raRow(1, 'Donkey Kong', 7)]);
            await RAMasterListService.syncAll({ pauseMs: 0 });

            const db = await getDatabase();
            const log = await db.get(`SELECT * FROM sync_logs WHERE source = ?`, RA_SYNC_SOURCE);
            expect(log).toBeTruthy();
            expect(log.status).toBe('success');
            expect(log.completed_at).toBeTruthy();
            expect(log.heartbeat_at).toBeTruthy();
            expect(log.pages_done).toBeGreaterThan(0);
            expect(log.records_fetched).toBe(1);
        });

        it('is single-flight — a concurrent call joins the running sync', async () => {
            mock.corpus.set(7, [raRow(1, 'Donkey Kong', 7)]);
            const [a, b] = await Promise.all([
                RAMasterListService.syncAll({ pauseMs: 0 }),
                RAMasterListService.syncAll({ pauseMs: 0 }),
            ]);
            expect(a).toBe(b);

            const db = await getDatabase();
            const logs = await db.all(`SELECT id FROM sync_logs WHERE source = ?`, RA_SYNC_SOURCE);
            expect(logs).toHaveLength(1);
        });
    });

    describe('staleness gate (ensureFresh)', () => {
        it('reports an empty table as stale and kicks off a sync', async () => {
            mock.corpus.set(7, [raRow(1, 'Donkey Kong', 7)]);
            const status = await RAMasterListService.ensureFresh();
            expect(status.stale).toBe(true);
            expect(status.syncing).toBe(true);
        });

        it('leaves a fresh table alone — no API call at all', async () => {
            await seedRaGame(1, 'Donkey Kong');
            const status = await RAMasterListService.ensureFresh();
            expect(status.stale).toBe(false);
            expect(status.syncing).toBe(false);
            expect(mock.calls).toHaveLength(0);
        });

        it('treats a list older than the max age as stale', async () => {
            const old = new Date(Date.now() - MASTER_LIST_MAX_AGE_MS - 60_000).toISOString();
            await seedRaGame(1, 'Donkey Kong', 7, { syncedAt: old });
            const status = await RAMasterListService.getStatus();
            expect(status.stale).toBe(true);
        });

        it('does not re-attempt within the cooldown after a recent failed run', async () => {
            // A failing sync must not turn every search into a fresh 20-console
            // crawl — our outage would become an RA fair-use violation.
            const logId = await SyncLogService.start(RA_SYNC_SOURCE);
            await SyncLogService.complete(logId, { status: 'error', errors: ['nope'] });

            const status = await RAMasterListService.ensureFresh();
            expect(status.stale).toBe(true);
            expect(status.syncing).toBe(false);
            expect(mock.calls).toHaveLength(0);
        });

        it('does not sync when no API key is configured', async () => {
            delete process.env.RA_API_KEY;
            const status = await RAMasterListService.ensureFresh();
            expect(status.syncing).toBe(false);
            expect(mock.calls).toHaveLength(0);
        });
    });

    describe('search', () => {
        beforeEach(async () => {
            await seedRaGame(1, 'Donkey Kong', 7, { numLeaderboards: 4 });
            await seedRaGame(2, 'Donkey Kong Jr.', 7, { numLeaderboards: 2 });
            await seedRaGame(3, 'Super Mario Bros.', 7);
            await seedRaGame(4, 'Pac-Man', 27, { numLeaderboards: 8 });
        });

        it('matches on the normalized title, so punctuation does not block a hit', async () => {
            // "Donkey Kong Jr." normalizes to "donkey kong jr" — a raw LIKE on
            // the user's "Donkey Kong Jr" would miss the stored period.
            const results = await RAMasterListService.search('Donkey Kong Jr');
            expect(results.map(r => r.raGameId)).toContain(2);
        });

        it('does a contains match, not just a prefix', async () => {
            const results = await RAMasterListService.search('mario');
            expect(results.map(r => r.raGameId)).toEqual([3]);
        });

        it('ranks an exact normalized match ahead of a longer contains match', async () => {
            const results = await RAMasterListService.search('Donkey Kong');
            expect(results[0].raGameId).toBe(1);
            expect(results.map(r => r.raGameId)).toEqual([1, 2]);
        });

        it('caps the result set', async () => {
            const results = await RAMasterListService.search('o', 2);
            expect(results.length).toBeLessThanOrEqual(2);
        });

        it('returns an absolute media URL for the icon', async () => {
            const [first] = await RAMasterListService.search('Pac-Man');
            expect(first.iconUrl).toBe('https://media.retroachievements.org/Images/4.png');
        });

        it('answers empty for a blank query rather than everything', async () => {
            expect(await RAMasterListService.search('   ')).toEqual([]);
        });

        it('treats LIKE wildcards as literal characters', async () => {
            // Without escaping, '%' would match every row in the table.
            expect(await RAMasterListService.search('%')).toEqual([]);
        });

        it('annotates rows already in the catalogue', async () => {
            const db = await getDatabase();
            await db.run(
                `INSERT INTO global_games (id, name, type, status, ra_id, score_eligibility)
                 VALUES ('gg-1', 'Donkey Kong', 'arcade', 'approved', 1, 'score')`,
            );

            const results = await RAMasterListService.search('Donkey Kong');
            const dk = results.find(r => r.raGameId === 1)!;
            expect(dk.inCatalogue).toBe(true);
            expect(dk.globalGameId).toBe('gg-1');
            expect(dk.scoreEligibility).toBe('score');

            const jr = results.find(r => r.raGameId === 2)!;
            expect(jr.inCatalogue).toBe(false);
            expect(jr.globalGameId).toBeNull();
        });
    });

    describe('search endpoint (shared by all three surfaces)', () => {
        function makeApp() {
            const app = express();
            app.get('/ra-catalogue/search', raSearchHandler);
            return app;
        }

        beforeEach(async () => {
            await seedRaGame(1, 'Donkey Kong', 7);
        });

        it('ships results plus the freshness envelope and attribution', async () => {
            const res = await request(makeApp()).get('/ra-catalogue/search?q=Donkey');
            expect(res.status).toBe(200);
            expect(res.body.results).toHaveLength(1);
            expect(res.body.results[0]).toMatchObject({
                raGameId: 1, title: 'Donkey Kong', consoleId: 7, inCatalogue: false,
            });
            expect(res.body.masterList).toMatchObject({ total: 1, stale: false });
            expect(res.body.masterList.lastSyncedAt).toBeTruthy();
            expect(res.body.configured).toBe(true);
            expect(res.body.attribution.source).toBe('RetroAchievements');
        });

        it('answers 200 with no results for a blank query', async () => {
            const res = await request(makeApp()).get('/ra-catalogue/search');
            expect(res.status).toBe(200);
            expect(res.body.results).toEqual([]);
        });

        it('honours ?limit and caps it', async () => {
            await seedRaGame(2, 'Donkey Kong Jr.', 7);
            const res = await request(makeApp()).get('/ra-catalogue/search?q=Donkey&limit=1');
            expect(res.body.results).toHaveLength(1);
        });
    });
});
