import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb } from './helpers.js';
import { SyncLogService } from '../services/SyncLogService.js';
import { CatalogueSyncService, SCHEDULED_SOURCES, type ScheduledSource } from '../services/CatalogueSyncService.js';

/**
 * Nightly catalogue syncs (v2.195.0, WORK.md C4). The runner sequences the
 * live-source importers; each importer keeps its own sync log and alert, so
 * these tests only cover what the runner itself decides.
 */
describe('CatalogueSyncService.runScheduled', () => {
    const calls: string[] = [];
    const stub = (source: ScheduledSource) => async () => { calls.push(source); };

    beforeEach(async () => {
        await setupTestDb();
        calls.length = 0;
        delete process.env.CATALOGUE_AUTOSYNC_ENABLED;
        delete process.env.OPDB_API_KEY;
    });

    afterEach(() => {
        delete process.env.CATALOGUE_AUTOSYNC_ENABLED;
        delete process.env.OPDB_API_KEY;
    });

    it('runs the live sources in order — VPS before the Wizard manifest — and never FX VR or IGDB', async () => {
        const runners = Object.fromEntries(SCHEDULED_SOURCES.map(s => [s, stub(s)])) as Record<ScheduledSource, () => Promise<void>>;
        const result = await CatalogueSyncService.runScheduled({ runners });
        expect(calls).toEqual(['vps', 'wizard', 'steam-pinball', 'atgames']);
        expect(result.ran).toEqual(['vps', 'wizard', 'steam-pinball', 'atgames']);
        expect(result.failed).toEqual([]);
        expect(result.skipped).toEqual([]);
        expect(SCHEDULED_SOURCES).not.toContain('fx-vr');
        expect(SCHEDULED_SOURCES).not.toContain('igdb');
    });

    it('appends OPDB only when the key is configured', () => {
        expect(CatalogueSyncService.sourcesForTonight({})).toEqual(['vps', 'wizard', 'steam-pinball', 'atgames']);
        expect(CatalogueSyncService.sourcesForTonight({ OPDB_API_KEY: 'k' })).toEqual(['vps', 'wizard', 'steam-pinball', 'atgames', 'opdb']);
    });

    it('one failing source does not stop the rest', async () => {
        const result = await CatalogueSyncService.runScheduled({
            sources: ['vps', 'wizard', 'atgames'],
            runners: {
                vps: stub('vps'),
                wizard: async () => { throw new Error('GitHub returned 503'); },
                atgames: stub('atgames'),
            },
        });
        expect(calls).toEqual(['vps', 'atgames']);
        expect(result.ran).toEqual(['vps', 'atgames']);
        expect(result.failed).toEqual([{ source: 'wizard', error: 'GitHub returned 503' }]);
    });

    it('skips a source whose previous run is still live instead of doubling it up', async () => {
        // A `running` row with a fresh heartbeat is a live run (the IGDB
        // single-flight rule); a dead one would not block.
        await SyncLogService.start('vps');
        const result = await CatalogueSyncService.runScheduled({
            sources: ['vps', 'wizard'],
            runners: { vps: stub('vps'), wizard: stub('wizard') },
        });
        expect(calls).toEqual(['wizard']);
        expect(result.skipped).toEqual([{ source: 'vps', reason: 'already_running' }]);
    });

    it('is on by default and off with CATALOGUE_AUTOSYNC_ENABLED=false', async () => {
        expect(await CatalogueSyncService.isEnabled()).toBe(true);
        process.env.CATALOGUE_AUTOSYNC_ENABLED = 'false';
        expect(await CatalogueSyncService.isEnabled()).toBe(false);
    });
});
