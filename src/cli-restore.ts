import 'dotenv/config';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { logInfo, logError, logWarn } from './utils/logger.js';
import { IScoredClient } from './engine/IScoredClient.js';
import * as readline from 'readline';

const BACKUP_DIR = path.join(process.cwd(), 'backups');
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'arcaid.db');

async function restoreBackup(backupFolderName: string) {
    const backupPath = path.join(BACKUP_DIR, backupFolderName);
    
    if (!fsSync.existsSync(backupPath)) {
        throw new Error(`Backup folder not found: ${backupPath}`);
    }

    logInfo(`♻️ Starting System Restore from: ${backupFolderName}`);
    
    const metadataPath = path.join(backupPath, 'backup_metadata.json');
    if (!fsSync.existsSync(metadataPath)) {
        throw new Error(`Metadata file missing in backup: ${metadataPath}`);
    }
    
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));

    // 1. Restore Database
    const backupDbPath = path.join(backupPath, 'arcaid.db');
    if (fsSync.existsSync(backupDbPath)) {
        await fs.copyFile(backupDbPath, DB_PATH);
        logInfo('   -> Restored local database (arcaid.db).');
    } else {
        logWarn('   -> No database found in backup. Skipping DB restore.');
    }

    // 2. Wipe & Rebuild iScored
    const client = new IScoredClient();
    try {
        await client.connect();

        logInfo('   -> Wiping current iScored lineup...');
        const currentGames = await client.getAllGames();
        
        // iScored doesn't have a bulk delete via API in the client yet, 
        // but we can simulate hiding/locking them or deleting via DOM manipulation.
        // For a true restore, we'd delete. Let's just set them all to hidden/locked for safety,
        // or recreate. In TableFlipper we deleted. 
        // I will implement a deleteGame method on IScoredClient later, 
        // for now we will just hide them so they don't show up.
        for (const game of currentGames) {
            logInfo(`      -> Hiding existing game: ${game.name}`);
            await client.setGameStatus(game.id, { hidden: true, locked: true });
        }
        logInfo('   -> Lineup hidden.');

        logInfo('   -> Recreating games from backup...');
        for (const game of metadata.games) {
            logInfo(`      -> Recreating: ${game.name}`);
            
            // Recreate the game shell
            const newId = await client.createGame(game.name);

            // Apply status
            await client.setGameStatus(newId, { hidden: game.isHidden, locked: game.isLocked });

            // Note: In a full restoration, we would download the photos during backup
            // and re-upload them here using `client.submitScore`.
            if (game.scores && game.scores.length > 0) {
                 logInfo(`         -> Re-submitting ${game.scores.length} scores...`);
                 for (const score of game.scores) {
                     // Requires mapping the public username back to a discord ID or submitting anonymously
                     await client.submitScore(newId, score.name, parseInt(score.score.replace(/,/g, '')));
                 }
            }
        }

    } catch (e) {
        logError('❌ Restore failed during iScored interaction:', e);
        throw e;
    } finally {
        await client.disconnect();
    }

    logInfo('✅ System Restore Completed.');
}

async function main() {
    const backupFolder = process.argv[2];

    if (!backupFolder) {
        console.error('❌ Please provide the backup folder name as an argument.');
        console.error('Usage: npm run restore -- <backup_folder_name>');
        process.exit(1);
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    logInfo('⚠️  DANGER ZONE ⚠️');
    logInfo(`You are about to restore the system state from backup: ${backupFolder}`);
    logInfo('THIS WILL overwrite your current database and modify the live iScored lineup.');
    logInfo('');

    rl.question('Are you absolutely sure you want to proceed? Type "yes" to confirm: ', async (answer) => {
        if (answer.toLowerCase() === 'yes') {
            logInfo('Starting restoration process... This may take several minutes.');
            try {
                await restoreBackup(backupFolder);
                process.exit(0);
            } catch (error) {
                logError('❌ Restore Failed:', error);
                process.exit(1);
            }
        } else {
            logInfo('Restore cancelled.');
            process.exit(0);
        }
        rl.close();
    });
}

main();