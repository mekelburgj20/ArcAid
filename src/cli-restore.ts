import 'dotenv/config';
import * as readline from 'readline';
import { logInfo, logError } from './utils/logger.js';
import { listBackups, verifyBackup, restoreBackup, isValidBackupName } from './services/BackupService.js';

/**
 * Multi-tenant-safe restore CLI.
 *
 * This is a thin wrapper around BackupService.restoreBackup(name). It restores
 * the SQLite DB (WAL-safe standalone artifact produced by VACUUM INTO) plus the
 * data/ asset subdirs (score-photos, styles, catalogue-images, iscored-styles).
 *
 * It deliberately does NOT:
 *   - recreate iScored games with new ids (the legacy TableFlipper behaviour), or
 *   - assume a single env-level iScored account.
 * In the multi-tenant model each game_room carries its own iScored credentials in
 * game_room_settings, and game state lives in the restored DB. Reconciliation with
 * iScored happens through ScoreSyncPoller / TournamentEngine after the app restarts.
 *
 * Usage:
 *   npm run restore -- <backup_folder_name>
 *   npm run restore -- --list
 *   npm run restore -- --verify <backup_folder_name>
 */

function usage(): void {
    console.error('Usage:');
    console.error('  npm run restore -- <backup_folder_name>     Restore DB + assets from a backup');
    console.error('  npm run restore -- --list                   List available backups');
    console.error('  npm run restore -- --verify <name>          Run integrity_check on a backup (no changes)');
    console.error('');
    console.error('NOTE: Stop the app/container before restoring. A pre-restore safety copy of the');
    console.error('      live DB is written to <db>.pre-restore. See docs/runbooks/restore.md.');
}

async function doList(): Promise<void> {
    const backups = await listBackups();
    if (backups.length === 0) {
        console.log('No backups found.');
        return;
    }
    console.log('Available backups (newest first):');
    for (const b of backups) {
        const mb = (b.size / (1024 * 1024)).toFixed(2);
        console.log(`  ${b.name}   (${mb} MB, created ${b.createdAt})`);
    }
}

async function doVerify(name: string): Promise<void> {
    const v = await verifyBackup(name);
    if (v.ok) {
        console.log(`OK: backup "${name}" passed integrity_check.`);
    } else {
        console.error(`FAILED: backup "${name}" integrity_check: ${v.result}`);
        process.exit(1);
    }
}

function confirm(question: string): Promise<boolean> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase() === 'yes');
        });
    });
}

async function doRestore(name: string): Promise<void> {
    if (!isValidBackupName(name)) {
        console.error(`Invalid backup name: "${name}"`);
        process.exit(1);
    }

    // Pre-flight integrity check so the operator sees a clear yes/no before confirming.
    console.log(`Verifying backup "${name}" integrity...`);
    const v = await verifyBackup(name);
    if (!v.ok) {
        console.error(`Backup "${name}" FAILED integrity_check: ${v.result}`);
        console.error('Aborting. Nothing was changed.');
        process.exit(1);
    }
    console.log('   -> integrity_check: ok');

    console.log('');
    console.log('WARNING: DANGER ZONE');
    console.log(`You are about to overwrite the live database and data/ assets from backup: ${name}`);
    console.log('Make sure the app/container is STOPPED before continuing.');
    console.log('A pre-restore safety copy of the current DB will be saved to <db>.pre-restore.');
    console.log('');

    const ok = await confirm('Type "yes" to proceed: ');
    if (!ok) {
        console.log('Restore cancelled.');
        process.exit(0);
    }

    logInfo(`CLI restore starting for backup "${name}"...`);
    await restoreBackup(name);
    console.log(`Restore complete. Start the app/container to bring the restored state online.`);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        usage();
        process.exit(1);
    }

    const first = args[0];
    if (!first) {
        usage();
        process.exit(1);
    }

    if (first === '--list' || first === '-l') {
        await doList();
        process.exit(0);
    }

    if (first === '--verify' || first === '-v') {
        const name = args[1];
        if (!name) {
            usage();
            process.exit(1);
        }
        await doVerify(name);
        process.exit(0);
    }

    if (first.startsWith('-')) {
        usage();
        process.exit(1);
    }

    await doRestore(first);
    process.exit(0);
}

main().catch((error) => {
    logError('Restore failed:', error);
    console.error('Restore failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
});
