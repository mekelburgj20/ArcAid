import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { getDatabase } from '../database/database.js';
import { logInfo, logError, logWarn } from '../utils/logger.js';
import { IScoredClient } from './IScoredClient.js';

const BACKUP_DIR = path.join(process.cwd(), 'backups');
const DATA_DIR = path.join(process.cwd(), 'data');

// Uploaded-asset subdirs that are part of the backup set. Everything else in
// data/ (the live DB + -wal/-shm, debug screenshots, rotated logs, scratch
// files) is intentionally excluded — the DB is captured via VACUUM INTO.
const ASSET_SUBDIRS = ['score-photos', 'styles', 'catalogue-images', 'iscored-styles'];

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
     * Creates a full system backup: a WAL-safe SQLite snapshot (via VACUUM INTO),
     * the uploaded-asset subdirs, and optional live iScored state.
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

            // 2. Backup uploaded-asset subdirs.
            await this.copyDataAssets(backupPath);

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
     * Recursively copies the uploaded-asset subdirs from data/ into
     * destDir/data/<subdir>/. Each subdir may be absent on a fresh install —
     * guarded with existsSync per dir.
     */
    private async copyDataAssets(destDir: string): Promise<void> {
        for (const subdir of ASSET_SUBDIRS) {
            const src = path.join(DATA_DIR, subdir);
            if (!fsSync.existsSync(src)) continue;
            const dst = path.join(destDir, 'data', subdir);
            try {
                await fs.cp(src, dst, { recursive: true });
                logInfo(`   -> Copied asset dir: data/${subdir}.`);
            } catch (e) {
                logWarn(`   -> Failed to copy asset dir data/${subdir}: ${e instanceof Error ? e.message : e}`);
            }
        }
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
            .filter((e) => e.isDirectory())
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
