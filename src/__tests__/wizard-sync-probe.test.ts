import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'crypto';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { SyncLogService } from '../services/SyncLogService.js';
import { WizardImportService, parseWizardManifest, describeWizardChanges } from '../services/WizardImportService.js';

/**
 * C11 (v2.202.0): the Wizard sync reads the discovery dates the manifest
 * carries, says "N tables new on the Wizard since the last run" in its sync
 * log, records the manifest's MD5 as the run's `source_version`, and — on the
 * nightly pass only — probes the stable release's 285-byte `release-meta.json`
 * first and skips the 1.4 MB manifest when the checksum matches.
 */
const OLD = {
    name: 'Cactus Canyon (Bally 1998)', manufacturer: 'Bally', year: 1998, fps: 55, vpsdbId: 'vZDUDUii',
    firstAvailableAt: '2025-03-29T23:15:23Z', updatedAt: '2026-09-15T04:13:44Z',
    tutorialYouTubeID: 'dQw4w9WgXcQ', tutorialTitle: 'Cactus Canyon rules',
};
const NEW = {
    name: 'Getaway: Baby Driver Edition (Williams 1992)', manufacturer: 'Williams', year: 1992, fps: 60, vpsdbId: 'cCV4A6uc',
    firstAvailableAt: '2026-10-21T13:15:30Z', updatedAt: '2026-10-21T13:15:30Z',
};
const MANIFEST_V1 = { 'vpx-cactuscanyon': OLD };
const MANIFEST_V2 = { 'vpx-cactuscanyon': { ...OLD, updatedAt: '2026-10-20T00:00:00Z' }, 'vpx-getawaypup': NEW };
const md5 = (v: unknown) => createHash('md5').update(JSON.stringify(v), 'utf8').digest('hex');

describe('parseWizardManifest — discovery dates and the tutorial', () => {
    it('keeps the ISO dates and turns tutorialYouTubeID into a tutorial entry', () => {
        const [cc] = parseWizardManifest(MANIFEST_V1).tables;
        expect(cc).toMatchObject({
            firstAvailableAt: '2025-03-29T23:15:23Z', updatedAt: '2026-09-15T04:13:44Z',
            tutorial: { title: 'Cactus Canyon rules', youtubeId: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
        });
    });

    it('drops a date that does not parse and a tutorial id that is not a YouTube id', () => {
        const [t] = parseWizardManifest({ 'vpx-x': { ...OLD, firstAvailableAt: 'yesterday', tutorialYouTubeID: 'not a yt id!' } }).tables;
        expect(t!.firstAvailableAt).toBeNull();
        expect(t!.tutorial).toBeUndefined();
    });
});

describe('describeWizardChanges', () => {
    const tables = parseWizardManifest(MANIFEST_V2).tables;

    it('counts tables that first shipped after the baseline and names them', () => {
        expect(describeWizardChanges(tables, '2026-10-01T04:30:00Z', 'v2.0.18'))
            .toBe('Table Manager v2.0.18, 1 table new on the Wizard since 2026-10-01 (Getaway: Baby Driver Edition); 1 updated upstream');
    });

    it('says so when nothing is new', () => {
        expect(describeWizardChanges(tables, '2026-10-25T04:30:00Z')).toBe('no tables new on the Wizard since 2026-10-25');
    });

    it('has no baseline on the first run', () => {
        expect(describeWizardChanges(tables, null)).toMatch(/^2 tables on the Wizard \(first run/);
    });
});

describe('WizardImportService.importFromWizard — summary, source_version and the release-meta probe', () => {
    let manifestBody: unknown = MANIFEST_V1;
    let releaseMeta: { status: number; body?: unknown } = { status: 404 };
    const fetched: string[] = [];

    beforeEach(async () => {
        await setupTestDb();
        manifestBody = MANIFEST_V1;
        releaseMeta = { status: 404 };
        fetched.length = 0;
        vi.stubGlobal('fetch', async (url: string) => {
            fetched.push(String(url));
            if (String(url) === WizardImportService.MANIFEST_URL) {
                return { ok: true, status: 200, json: async () => manifestBody, text: async () => JSON.stringify(manifestBody) };
            }
            if (String(url) === WizardImportService.RELEASE_META_URL) {
                return { ok: releaseMeta.status === 200, status: releaseMeta.status, json: async () => releaseMeta.body };
            }
            return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    async function latestLog() {
        const [log] = await SyncLogService.getBySource('wizard', 1);
        return log!;
    }

    /** The fixture's discovery dates are in October 2026; a run "last night"
     *  must have started before them for anything to count as new since. */
    async function backdateLatestRun(startedAt: string) {
        const db = await getDatabase();
        await db.run('UPDATE sync_logs SET started_at = ? WHERE id = ?', startedAt, (await latestLog()).id);
    }

    it('writes the tutorial, the summary and the manifest MD5 on a full run', async () => {
        await WizardImportService.importFromWizard();
        const log = await latestLog();
        expect(log.status).toBe('success');
        expect(log.source_version).toBe(md5(MANIFEST_V1));
        expect(log.summary).toMatch(/first run/);

        const db = await getDatabase();
        const row = await db.get<{ tutorial_urls: string }>('SELECT tutorial_urls FROM global_games WHERE vps_id = ?', 'vZDUDUii');
        expect(JSON.parse(row!.tutorial_urls)).toEqual([
            { title: 'Cactus Canyon rules', youtubeId: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
        ]);
    });

    it('the second run says what is new on the Wizard since the first', async () => {
        await WizardImportService.importFromWizard();
        await backdateLatestRun('2026-10-01T04:30:00Z');
        manifestBody = MANIFEST_V2;
        const result = await WizardImportService.importFromWizard();
        // Baby Driver is a second manifest entry on the SAME VPS game as the
        // plain Getaway would be — here it is simply a new row — but the point
        // is the summary counts the Wizard's own "first shipped" date, not
        // catalogue rows.
        expect(result.unchanged).toBeUndefined();
        const log = await latestLog();
        expect(log.summary).toBe('1 table new on the Wizard since 2026-10-01 (Getaway: Baby Driver Edition); 1 updated upstream');
        expect(log.source_version).toBe(md5(MANIFEST_V2));
    });

    it('the nightly pass skips the manifest when release-meta matches the last success', async () => {
        await WizardImportService.importFromWizard();
        fetched.length = 0;
        releaseMeta = { status: 200, body: { version: 'v2.0.18', tableCount: 1, manifestChecksum: md5(MANIFEST_V1) } };

        const result = await WizardImportService.importFromWizard({ skipIfUnchanged: true });
        expect(result).toMatchObject({ unchanged: true, imported: 0, updated: 0 });
        expect(fetched).toEqual([WizardImportService.RELEASE_META_URL]);
        const log = await latestLog();
        expect(log).toMatchObject({ status: 'success', records_fetched: 1, source_version: md5(MANIFEST_V1) });
        expect(log.summary).toBe('Unchanged since Table Manager v2.0.18 — release-meta probe, manifest not fetched');
    });

    it('does the full sync when the checksum moved, when the probe fails, and always for the admin button', async () => {
        await WizardImportService.importFromWizard();
        await backdateLatestRun('2026-10-01T04:30:00Z');

        releaseMeta = { status: 200, body: { version: 'v2.0.19', manifestChecksum: 'somethingelse' } };
        manifestBody = MANIFEST_V2;
        expect((await WizardImportService.importFromWizard({ skipIfUnchanged: true })).unchanged).toBeUndefined();
        expect((await latestLog()).summary).toMatch(/^Table Manager v2\.0\.19, 1 table new/);

        releaseMeta = { status: 503 };
        fetched.length = 0;
        expect((await WizardImportService.importFromWizard({ skipIfUnchanged: true })).unchanged).toBeUndefined();
        expect(fetched).toContain(WizardImportService.MANIFEST_URL);

        releaseMeta = { status: 200, body: { version: 'v2.0.19', manifestChecksum: md5(MANIFEST_V2) } };
        fetched.length = 0;
        expect((await WizardImportService.importFromWizard()).unchanged).toBeUndefined();
        expect(fetched).not.toContain(WizardImportService.RELEASE_META_URL);
    });
});
