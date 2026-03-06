import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { getDatabase } from '../database/database.js';
import { logInfo, logError, logWarn } from '../utils/logger.js';
import { IScoredClient } from './IScoredClient.js';

const BACKUP_DIR = path.join(process.cwd(), 'backups');

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
     * Creates a full system backup, including DB and iScored state.
     */
    public async createBackup(client: IScoredClient): Promise<string | null> {
        logInfo('📦 Starting System Backup...');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(BACKUP_DIR, timestamp);

        try {
            await fs.mkdir(backupPath, { recursive: true });

            // 1. Backup Local SQLite DB
            const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'arcaid.db');
            if (fsSync.existsSync(dbPath)) {
                await fs.copyFile(dbPath, path.join(backupPath, 'arcaid.db'));
                logInfo('   -> Copied local database (arcaid.db).');
            } else {
                logWarn('   -> Local database not found, skipping DB copy.');
            }

            // 2. Backup iScored State
            const publicUrl = process.env.ISCORED_PUBLIC_URL;
            let metadata: any = { timestamp, games: [] };

            if (publicUrl) {
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
                logInfo(`   -> Captured state for ${liveGames.length} games.`);
            } else {
                logWarn('   -> ISCORED_PUBLIC_URL not configured. Skipping live state capture.');
            }

            // 3. Write Metadata
            await fs.writeFile(
                path.join(backupPath, 'backup_metadata.json'), 
                JSON.stringify(metadata, null, 2)
            );

            logInfo(`✅ Backup completed successfully: ${backupPath}`);
            return backupPath;

        } catch (error) {
            logError('❌ Backup failed:', error);
            return null;
        }
    }
}
