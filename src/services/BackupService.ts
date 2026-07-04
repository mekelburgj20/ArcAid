import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { logInfo, logError, logWarn } from '../utils/logger.js';

const BACKUP_DIR = path.join(process.cwd(), 'backups');
const DATA_DIR = path.join(process.cwd(), 'data');

/**
 * Asset subdirectories under `data/`. Restored from a backup's own
 * `data/<subdir>/` (legacy bundled backups) or, failing that, from the shared
 * deduplicated mirror (DB-only backups carry no asset copy of their own).
 */
const ASSET_SUBDIRS = ['score-photos', 'styles', 'catalogue-images', 'iscored-styles'];

// Shared deduplicated asset store written by BackupManager — not a restorable
// point-in-time backup, so it's excluded from the backup listing and used as the
// asset source when a backup dir has no bundled assets of its own.
const MIRROR_DIRNAME = 'assets-mirror';

export interface BackupInfo {
    name: string;
    size: number;
    createdAt: string;
}

export interface VerifyResult {
    ok: boolean;
    result: string;
}

/**
 * Recursively sum the byte size of a file or directory tree.
 */
async function dirSize(target: string): Promise<number> {
    let total = 0;
    let stat: fs.Stats;
    try {
        stat = await fsp.stat(target);
    } catch {
        return 0;
    }
    if (stat.isFile()) {
        return stat.size;
    }
    if (!stat.isDirectory()) {
        return 0;
    }
    const entries = await fsp.readdir(target, { withFileTypes: true });
    for (const entry of entries) {
        total += await dirSize(path.join(target, entry.name));
    }
    return total;
}

/**
 * List all available backups sorted by date descending.
 * Size summation is recursive so the `data/` asset subtree is counted.
 */
export async function listBackups(): Promise<BackupInfo[]> {
    if (!fs.existsSync(BACKUP_DIR)) {
        return [];
    }

    const entries = await fsp.readdir(BACKUP_DIR, { withFileTypes: true });
    const backups: BackupInfo[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === MIRROR_DIRNAME) continue;

        const backupPath = path.join(BACKUP_DIR, entry.name);

        let size = 0;
        let createdAt = '';

        try {
            const stat = await fsp.stat(backupPath);
            createdAt = stat.birthtime.toISOString();

            // Recursive size: includes the data/ asset subtree, not just top-level files.
            size = await dirSize(backupPath);
        } catch {
            continue;
        }

        backups.push({
            name: entry.name,
            size,
            createdAt,
        });
    }

    backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return backups;
}

/**
 * Validate that a backup name is safe (no directory traversal).
 */
export function isValidBackupName(name: string): boolean {
    return !name.includes('..') && !name.includes('/') && !name.includes('\\') && name.length > 0;
}

/**
 * Open a backup's arcaid.db read-only and run `PRAGMA integrity_check`.
 * Returns `{ ok, result }` where `ok` is true only when the check returns 'ok'.
 *
 * Safe to call standalone (verify endpoint / CLI dry-run) — never touches the live DB.
 */
export async function verifyBackup(name: string): Promise<VerifyResult> {
    if (!isValidBackupName(name)) {
        return { ok: false, result: 'invalid backup name' };
    }

    const backupDbPath = path.join(BACKUP_DIR, name, 'arcaid.db');
    if (!fs.existsSync(backupDbPath)) {
        return { ok: false, result: `backup "${name}" does not contain a database file` };
    }

    let conn;
    try {
        conn = await open({
            filename: backupDbPath,
            driver: sqlite3.Database,
            mode: sqlite3.OPEN_READONLY,
        });
        // integrity_check returns one row "ok" on success, or one row per problem.
        const rows = await conn.all<{ integrity_check: string }[]>('PRAGMA integrity_check');
        const result = rows.map((r) => r.integrity_check).join('; ') || 'no result';
        return { ok: result === 'ok', result };
    } catch (error: any) {
        return { ok: false, result: `integrity check failed to run: ${error?.message ?? String(error)}` };
    } finally {
        if (conn) {
            try {
                await conn.close();
            } catch {
                /* best-effort close */
            }
        }
    }
}

/**
 * Recursively copy a backup's `data/<subdir>` trees back into the live `data/<subdir>`.
 * Subdirs absent from the backup are skipped (a fresh-install backup may omit some).
 * Existing live asset files are replaced (force).
 */
async function restoreAssets(backupDir: string): Promise<void> {
    const mirrorRoot = path.join(BACKUP_DIR, MIRROR_DIRNAME);
    for (const subdir of ASSET_SUBDIRS) {
        // Prefer the backup's own point-in-time assets (legacy bundled backups);
        // fall back to the shared deduplicated mirror (DB-only backups carry no
        // assets of their own).
        let src = path.join(backupDir, 'data', subdir);
        let origin = 'backup';
        if (!fs.existsSync(src)) {
            src = path.join(mirrorRoot, subdir);
            origin = 'mirror';
        }
        if (!fs.existsSync(src)) {
            if (subdir === 'catalogue-images') {
                logInfo('   -> No "catalogue-images" in backup (excluded from the mirror by design) — re-run the catalogue importers to repopulate.');
            } else {
                logInfo(`   -> No "${subdir}" assets in backup or mirror; skipping.`);
            }
            continue;
        }
        const dst = path.join(DATA_DIR, subdir);
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.cp(src, dst, { recursive: true, force: true });
        logInfo(`   -> Restored assets: data/${subdir}/ (from ${origin}).`);
    }
}

/**
 * Restore a backup over the live install: DB + asset subdirs.
 *
 * Hardened flow:
 *   1. Path-traversal guard on `name`.
 *   2. `verifyBackup` (PRAGMA integrity_check) on the BACKUP artifact BEFORE
 *      touching anything live — abort if not "ok".
 *   3. Safety-copy the current live DB aside (arcaid.db.pre-restore) so a bad
 *      restore is recoverable.
 *   4. Delete stale live `-wal`/`-shm` sidecars so the restored standalone file
 *      isn't shadowed by an old WAL.
 *   5. Copy the backup's `arcaid.db` over the live DB.
 *   6. Restore asset subdirs from `backupDir/data/<subdir>`.
 *
 * The caller is expected to handle process restart/exit after this returns.
 */
export async function restoreBackup(name: string): Promise<void> {
    if (!isValidBackupName(name)) {
        throw new Error('Invalid backup name');
    }

    const backupDir = path.join(BACKUP_DIR, name);
    const backupDbPath = path.join(backupDir, 'arcaid.db');

    if (!fs.existsSync(backupDbPath)) {
        throw new Error(`Backup "${name}" does not contain a database file`);
    }

    // Verify the backup artifact BEFORE we touch the live DB.
    logInfo(`Verifying backup "${name}" integrity before restore...`);
    const verify = await verifyBackup(name);
    if (!verify.ok) {
        throw new Error(`Backup "${name}" failed integrity check; aborting restore. Detail: ${verify.result}`);
    }
    logInfo('   -> Backup integrity_check: ok.');

    const targetDbPath = process.env.DB_PATH || path.join(DATA_DIR, 'arcaid.db');

    // Safety-copy the current live DB aside so a bad restore is recoverable.
    if (fs.existsSync(targetDbPath)) {
        const preRestorePath = `${targetDbPath}.pre-restore`;
        try {
            await fsp.copyFile(targetDbPath, preRestorePath);
            logInfo(`   -> Saved pre-restore copy of live DB: ${preRestorePath}`);
        } catch (error) {
            logWarn(`   -> Could not save pre-restore copy of live DB: ${String(error)}`);
        }
    }

    // Remove stale live -wal/-shm sidecars so the restored standalone DB isn't
    // shadowed by an old WAL. The restored file is fully checkpointed (VACUUM INTO).
    for (const sidecar of [`${targetDbPath}-wal`, `${targetDbPath}-shm`]) {
        if (fs.existsSync(sidecar)) {
            try {
                await fsp.rm(sidecar, { force: true });
                logInfo(`   -> Removed stale sidecar: ${path.basename(sidecar)}`);
            } catch (error) {
                logWarn(`   -> Could not remove stale sidecar ${sidecar}: ${String(error)}`);
            }
        }
    }

    logInfo(`Restoring backup "${name}" database to ${targetDbPath}...`);
    await fsp.copyFile(backupDbPath, targetDbPath);
    logInfo('   -> Restored database (arcaid.db).');

    // Restore asset subdirs.
    await restoreAssets(backupDir);

    logInfo(`Backup "${name}" restored successfully (DB + assets).`);
}
