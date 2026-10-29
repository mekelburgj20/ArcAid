import { SyncLogService } from './SyncLogService.js';
import { logInfo, logWarn, logError } from '../utils/logger.js';

/**
 * Scheduled catalogue syncs (v2.195.0, WORK.md C4).
 *
 * The admin Catalogue page's sync buttons each kick one importer; this runs
 * the LIVE-SOURCE importers in one nightly pass so nobody has to click them.
 * "Live source" means the importer reads a feed that changes on its own:
 *
 *   vps            VPS database JSON (new games + table files daily)
 *   wizard         Legends Unchained Table Manager manifest (per release)
 *   steam-pinball  Steam DLC lists — Pinball FX / FX Classic / Midnight /
 *                  Classic VR / Zaccaria, and Pinball FX VR since v2.195.0
 *   atgames        AtGames' own catalogue feed + storefront
 *   opdb           OPDB export — only when `OPDB_API_KEY` is configured
 *
 * Deliberately NOT scheduled:
 *   fx-vr  a baked-in curated list — re-running it can never find anything
 *          the owner has not already typed in; its live twin is the Pinball
 *          FX VR Steam app inside `steam-pinball`.
 *   igdb   a multi-hour crawl with its own checkpoint/resume contract and
 *          single-flight guard; it stays an explicit admin action.
 *
 * Order matters once: VPS runs first so a Wizard row's `vpsdbId` lands as a
 * step-1 external-id match on a row VPS has just refreshed.
 *
 * Each importer owns its own `sync_logs` row and Discord alert (`error` /
 * `partial` → `SYNC_ALERT_CHANNEL_ID`), so this runner adds no bookkeeping of
 * its own: it only sequences, skips a source whose run is still live, and
 * keeps one failure from stopping the rest. Off switch:
 * `CATALOGUE_AUTOSYNC_ENABLED='false'` (env or global setting); default ON,
 * because the owner asked for the clicking to stop (2026-10-28).
 */
export type ScheduledSource = 'vps' | 'wizard' | 'steam-pinball' | 'atgames' | 'opdb';

/** The nightly order. `opdb` is appended at run time when its key is present. */
export const SCHEDULED_SOURCES: ScheduledSource[] = ['vps', 'wizard', 'steam-pinball', 'atgames'];

export type SourceRunner = () => Promise<unknown>;

const DEFAULT_RUNNERS: Record<ScheduledSource, SourceRunner> = {
    vps: async () => {
        const { VpsImportService } = await import('./VpsImportService.js');
        return VpsImportService.importFromVps();
    },
    wizard: async () => {
        const { WizardImportService } = await import('./WizardImportService.js');
        return WizardImportService.importFromWizard();
    },
    'steam-pinball': async () => {
        const { SteamPinballImportService } = await import('./SteamPinballImportService.js');
        return SteamPinballImportService.importAll();
    },
    atgames: async () => {
        const { AtGamesImportService } = await import('./AtGamesImportService.js');
        return AtGamesImportService.applyTags();
    },
    opdb: async () => {
        const { OPDBImportService } = await import('./OPDBImportService.js');
        return OPDBImportService.importFromOPDB();
    },
};

export interface ScheduledRunResult {
    ran: ScheduledSource[];
    skipped: Array<{ source: ScheduledSource; reason: 'already_running' }>;
    failed: Array<{ source: ScheduledSource; error: string }>;
}

export class CatalogueSyncService {
    /** `CATALOGUE_AUTOSYNC_ENABLED` — env wins, then the global setting; default ON. */
    static async isEnabled(): Promise<boolean> {
        if (process.env.CATALOGUE_AUTOSYNC_ENABLED === 'false') return false;
        try {
            const { SettingsService } = await import('./SettingsService.js');
            return (await SettingsService.get('CATALOGUE_AUTOSYNC_ENABLED')) !== 'false';
        } catch {
            return true;
        }
    }

    /** The sources tonight's pass will run, in order. */
    static sourcesForTonight(env: NodeJS.ProcessEnv = process.env): ScheduledSource[] {
        const sources = [...SCHEDULED_SOURCES];
        if (env.OPDB_API_KEY) sources.push('opdb');
        return sources;
    }

    /**
     * Runs the scheduled importers one after another. A source whose previous
     * run is still live (a `running` sync_logs row with a fresh heartbeat) is
     * skipped rather than doubled up; a source that throws is recorded and the
     * pass continues. `runners` exists for tests.
     */
    static async runScheduled(opts: {
        sources?: ScheduledSource[];
        runners?: Partial<Record<ScheduledSource, SourceRunner>>;
    } = {}): Promise<ScheduledRunResult> {
        const sources = opts.sources ?? this.sourcesForTonight();
        const runners = { ...DEFAULT_RUNNERS, ...(opts.runners ?? {}) };
        const result: ScheduledRunResult = { ran: [], skipped: [], failed: [] };

        logInfo(`Catalogue autosync: starting (${sources.join(' → ')}).`);
        for (const source of sources) {
            try {
                const active = await SyncLogService.getActiveRun(source);
                if (active) {
                    logWarn(`Catalogue autosync: ${source} skipped — a run started ${active.started_at} is still live.`);
                    result.skipped.push({ source, reason: 'already_running' });
                    continue;
                }
                const startedAt = Date.now();
                await runners[source]();
                result.ran.push(source);
                logInfo(`Catalogue autosync: ${source} finished in ${Math.round((Date.now() - startedAt) / 1000)}s.`);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                result.failed.push({ source, error: message });
                logError(`Catalogue autosync: ${source} failed:`, err);
            }
        }
        logInfo(
            `Catalogue autosync: done — ran ${result.ran.length}, skipped ${result.skipped.length}, failed ${result.failed.length}` +
            (result.failed.length > 0 ? ` (${result.failed.map(f => f.source).join(', ')})` : '') + '.',
        );
        return result;
    }
}
