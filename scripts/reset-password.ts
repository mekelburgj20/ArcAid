import { initDatabase, getDatabase } from '../src/database/database.js';

async function main() {
    await initDatabase();
    const db = await getDatabase();
    const row = await db.get("SELECT value FROM settings WHERE key = 'ADMIN_PASSWORD_HASH'");
    if (row) {
        await db.run("DELETE FROM settings WHERE key = 'ADMIN_PASSWORD_HASH'");
        console.log('Admin password cleared. Next login will set a new password.');
    } else {
        console.log('No password hash found. First login will set the password.');
    }
    process.exit(0);
}

main();
