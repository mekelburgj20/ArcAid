import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { logInfo, logError } from '../utils/logger.js';

const BACKUP_DIR = path.join(process.cwd(), 'backups');
const DATA_DIR = path.join(process.cwd(), 'data');

export interface BackupInfo {
    name: string;
    size: number;
    createdAt: string;
}

/**
 * List all available backups sorted by date descending.
 */
export async function listBackups(): Promise<BackupInfo[]> {
    if (!fs.existsSync(BACKUP_DIR)) {
        return [];
    }

    const entries = await fsp.readdir(BACKUP_DIR, { withFileTypes: true });
    const backups: BackupInfo[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const backupPath = path.join(BACKUP_DIR, entry.name);

        let size = 0;
        let createdAt = '';

        try {
            const stat = await fsp.stat(backupPath);
            createdAt = stat.birthtime.toISOString();

            // Sum file sizes in the backup directory
            const files = await fsp.readdir(backupPath);
            for (const file of files) {
                const fileStat = await fsp.stat(path.join(backupPath, file));
                size += fileStat.size;
            }
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
 * Restore a backup by copying its arcaid.db over the current database.
 */
export async function restoreBackup(name: string): Promise<void> {
    if (!isValidBackupName(name)) {
        throw new Error('Invalid backup name');
    }

    const backupDbPath = path.join(BACKUP_DIR, name, 'arcaid.db');

    if (!fs.existsSync(backupDbPath)) {
        throw new Error(`Backup "${name}" does not contain a database file`);
    }

    const targetDbPath = process.env.DB_PATH || path.join(DATA_DIR, 'arcaid.db');

    logInfo(`Restoring backup "${name}" to ${targetDbPath}...`);
    await fsp.copyFile(backupDbPath, targetDbPath);
    logInfo(`Backup "${name}" restored successfully.`);
}
