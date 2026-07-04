import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { getDatabase } from '../database/database.js';
import { logInfo, logError, logWarn } from '../utils/logger.js';
import { IScoredClient } from './IScoredClient.js';

const BACKUP_DIR = path.join(process.cwd(), 'backups');
const DATA_DIR = path.join(process.cwd(), 'data');

// Uploaded-asset subdirs under data/. Used by RESTORE (a legacy bundled backup
// may contain any of these). Everything else in data/ (the live DB + -wal/-shm,
// debug screenshots, rotated logs, scratch files) is excluded — the DB is
// captured via VACUUM INTO.
const ASSET_SUBDIRS = ['score-photos', 'styles', 'catalogue-images', 'iscored-styles'];

// Subdirs the backup mirror actually stores. `catalogue-images` is DELIBERATELY
// excluded: it's the multi-GB bulk (VPS/OPDB imports) and is fully re-fetchable
// via the catalogue importers, so backing it up wastes disk (it caused a 100%-
// disk incident). score-photos (irreplaceable) + the small style dirs are kept.
// After a bare-metal restore, re-run the catalogue sync to repopulate images.
const MIRROR_SUBDIRS = ASSET_SUBDIRS.filter((d) => d !== 'catalogue-images');

// Single shared, deduplicated asset store (NOT a per-timestamp backup). The
// scheduled/manual backup syncs the asset subdirs into here instead of copying
// them into every backup dir, so N backups cost ~one asset copy total. Excluded
// from listBackups / pruneBackups so it's never shown as or pruned like a backup.
const MIRROR_DIRNAME = 'assets-mirror';

export class BackupManager {
    private static instance: BackupManager;

    private constructor() {}

    public static getInstance(): BackupManager {
        if (!BackupManager.instance) {
            BackupManager.instance = new BackupManager();
        }
        return BackupManager.instance;
    }

    /**
     * Creates a system backup: a WAL-safe SQLite snapshot (via VACUUM INTO) in a
     * per-timestamp dir, a deduplicated sync of the uploaded-asset subdirs into
     * the shared backups/assets-mirror/, and optional live iScored state.
     *
     * @param client Optional. When omitted (or no ISCORED_PUBLIC_URL), the live
     *               iScored-state capture is skipped cleanly and metadata.games
     *               is written as [] with iscoredCaptured: false.
     */
    public async createBackup(client?: IScoredClient): Promise<string | null> {
        logInfo('Starting System Backup...');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(BACKUP_DIR, timestamp);

        try {
            await fs.mkdir(backupPath, { recursive: true });

            // 1. Backup Local SQLite DB — WAL-safe via VACUUM INTO against the
            //    open connection. Produces a fully-checkpointed standalone DB
            //    (no -wal/-shm sidecars).
            const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'arcaid.db');
            if (fsSync.existsSync(dbPath)) {
                const destPath = path.join(backupPath, 'arcaid.db');
                // VACUUM INTO rejects an existing target — guard defensively
                // even though the per-timestamp dir should be fresh.
                if (fsSync.existsSync(destPath)) {
                    await fs.unlink(destPath);
                }
                // Normalize to forward-slashes and escape single quotes for the
                // SQL string literal. VACUUM INTO does not accept a bound `?`
                // parameter in older SQLite, so the path must be embedded.
                const normalized = path.resolve(destPath).replace(/\\/g, '/');
                const sqlLiteral = normalized.replace(/'/g, "''");
                const db = await getDatabase();
                await db.exec(`VACUUM INTO '${sqlLiteral}'`);
                logInfo('   -> Wrote WAL-safe database snapshot (arcaid.db) via VACUUM INTO.');

                // Backstop integrity check on the live connection.
                try {
                    const check = await db.get('PRAGMA integrity_check');
                    const result = check?.integrity_check ?? 'unknown';
                    if (result !== 'ok') {
                        logWarn(`   -> Source DB integrity_check returned: ${result}`);
                    }
                } catch (e) {
                    logWarn('   -> integrity_check backstop failed (non-fatal).');
                }
            } else {
                logWarn('   -> Local database not found, skipping DB copy.');
            }

            // 2. Sync uploaded-asset subdirs into the shared deduplicated mirror
            //    (backups/assets-mirror/) — only new/changed files are copied, so
            //    each backup stays DB-sized instead of re-bundling multi-GB of
            //    (mostly static) catalogue images every run.
            await this.syncAssetMirror();

            // 3. Backup iScored State (optional — only when a client is supplied).
            const publicUrl = process.env.ISCORED_PUBLIC_URL;
            let metadata: any = { timestamp, iscoredCaptured: false, games: [] };

            if (client && publicUrl) {
                logInfo('   -> Fetching live iScored state...');
                const liveGames = await client.getAllGames();

                for (const game of liveGames) {
                    let scores = [];
                    if (!game.isHidden) {
                        try {
                            scores = await client.scrapePublicScores(publicUrl, game.id);
                        } catch (e) {
                            logWarn(`      -> Could not scrape scores for ${game.name}`);
                        }
                    }

                    metadata.games.push({
                        ...game,
                        scores
                    });
                }
                metadata.iscoredCaptured = true;
                logInfo(`   -> Captured state for ${liveGames.length} games.`);
            } else if (!client) {
                logInfo('   -> No iScored client supplied. Skipping live state capture.');
            } else {
                logWarn('   -> ISCORED_PUBLIC_URL not configured. Skipping live state capture.');
            }

            // 4. Write Metadata
            await fs.writeFile(
                path.join(backupPath, 'backup_metadata.json'),
                JSON.stringify(metadata, null, 2)
            );

            logInfo(`Backup completed successfully: ${backupPath}`);
            return backupPath;

        } catch (error) {
            logError('Backup failed:', error);
            return null;
        }
    }

    /**
     * Sync the uploaded-asset subdirs from data/ into the single shared,
     * deduplicated mirror at backups/assets-mirror/<subdir>/. Only new or changed
     * files (by size + mtime) are copied; unchanged files are skipped. Append-only:
     * files removed from the source are intentionally KEPT in the mirror so an
     * irreplaceable asset (e.g. a score photo) is never lost to a transient source
     * glitch. One mirror is shared across all backups, so the asset footprint is
     * ~one copy total instead of one-per-backup.
     */
    private async syncAssetMirror(): Promise<void> {
        const mirrorRoot = path.join(BACKUP_DIR, MIRROR_DIRNAME);
        let copied = 0;
        let skipped = 0;
        for (const subdir of MIRROR_SUBDIRS) {
            const src = path.join(DATA_DIR, subdir);
            if (!fsSync.existsSync(src)) continue;
            try {
                const r = await syncDirDedup(src, path.join(mirrorRoot, subdir));
                copied += r.copied;
                skipped += r.skipped;
            } catch (e) {
                logWarn(`   -> Failed to mirror asset dir data/${subdir}: ${e instanceof Error ? e.message : e}`);
            }
        }
        logInfo(`   -> Asset mirror synced (${copied} new/changed, ${skipped} unchanged).`);
    }

    /**
     * Prune old backup directories per retention policy. Deletes those beyond
     * retentionCount (keeps newest N) and/or older than retentionDays.
     * Returns the number of backup dirs removed. No-op if both unset/0.
     */
    public async pruneBackups(opts: { retentionCount?: number; retentionDays?: number }): Promise<number> {
        const { retentionCount, retentionDays } = opts;
        if ((!retentionCount || retentionCount <= 0) && (!retentionDays || retentionDays <= 0)) {
            return 0;
        }

        if (!fsSync.existsSync(BACKUP_DIR)) {
            return 0;
        }

        // List backup dirs newest-first (mirrors BackupService.listBackups ordering:
        // descending by name, which is an ISO timestamp).
        const entries = await fs.readdir(BACKUP_DIR, { withFileTypes: true });
        const dirs = entries
            .filter((e) => e.isDirectory() && e.name !== MIRROR_DIRNAME)
            .map((e) => e.name)
            .sort((a, b) => b.localeCompare(a));

        const toDelete = new Set<string>();

        // Count-based retention: keep newest N.
        if (retentionCount && retentionCount > 0) {
            for (const name of dirs.slice(retentionCount)) {
                toDelete.add(name);
            }
        }

        // Age-based retention: delete older than retentionDays. Age is derived
        // from the backup dir NAME (an ISO timestamp) — FS-independent and
        // reliable. Some filesystems report birthtime as epoch 0, which would
        // otherwise mark every backup (including the newest) older-than-cutoff
        // and delete the lot. Fall back to birthtime only if the name doesn't
        // parse, and never delete a dir we genuinely can't date.
        if (retentionDays && retentionDays > 0) {
            const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
            for (const name of dirs) {
                let createdMs = BackupManager.parseBackupTimestamp(name);
                if (createdMs === null) {
                    try {
                        createdMs = (await fs.stat(path.join(BACKUP_DIR, name))).birthtime.getTime();
                    } catch {
                        continue; // unreadable — skip (never delete what we can't date)
                    }
                }
                if (createdMs !== null && createdMs > 0 && createdMs < cutoff) {
                    toDelete.add(name);
                }
            }
        }

        // Absolute floor: never prune the single newest backup, regardless of
        // policy or clock/FS quirks — a backup system must never self-empty.
        const newest = dirs[0];
        if (newest) toDelete.delete(newest);

        let pruned = 0;
        for (const name of toDelete) {
            const full = path.join(BACKUP_DIR, name);
            try {
                await fs.rm(full, { recursive: true, force: true });
                logInfo(`   -> Pruned old backup: ${name}`);
                pruned++;
            } catch (e) {
                logWarn(`   -> Failed to prune backup ${name}: ${e instanceof Error ? e.message : e}`);
            }
        }

        if (pruned > 0) {
            logInfo(`Pruned ${pruned} old backup(s).`);
        }
        return pruned;
    }

    /**
     * Parses a backup dir name (an ISO timestamp with ':' and '.' replaced by
     * '-', e.g. "2026-06-18T03-00-00-000Z") back into epoch ms. Returns null if
     * the name isn't in that exact format (caller falls back to birthtime).
     */
    private static parseBackupTimestamp(name: string): number | null {
        const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
        if (!m) return null;
        const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
        return Number.isNaN(ms) ? null : ms;
    }
}

/**
 * Recursively copy srcDir → dstDir, copying only files that are new or changed
 * (different size, or source mtime newer than the mirror's). Unchanged files are
 * skipped. Never deletes from dst — append-only mirror semantics. Exported for
 * unit testing of the dedup logic.
 */
export async function syncDirDedup(srcDir: string, dstDir: string): Promise<{ copied: number; skipped: number }> {
    await fs.mkdir(dstDir, { recursive: true });
    const entries = await fs.readdir(srcDir, { withFileTypes: true });
    let copied = 0;
    let skipped = 0;
    for (const entry of entries) {
        const s = path.join(srcDir, entry.name);
        const d = path.join(dstDir, entry.name);
        if (entry.isDirectory()) {
            const r = await syncDirDedup(s, d);
            copied += r.copied;
            skipped += r.skipped;
        } else if (entry.isFile()) {
            let needCopy = true;
            try {
                const [ss, ds] = await Promise.all([fs.stat(s), fs.stat(d)]);
                if (ds.size === ss.size && ds.mtimeMs >= ss.mtimeMs) needCopy = false;
            } catch {
                needCopy = true; // dest missing or unreadable → copy
            }
            if (needCopy) {
                await fs.copyFile(s, d);
                copied++;
            } else {
                skipped++;
            }
        }
    }
    return { copied, skipped };
}
