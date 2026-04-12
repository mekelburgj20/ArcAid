import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

(async () => {
    const db = await open({
        filename: 'data/arcaid.db',
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });
    const rows = await db.all(
        "SELECT opdb_id, vps_id, ipdb_url FROM global_games WHERE ipdb_url IS NOT NULL LIMIT 5"
    );
    console.log('Sample ipdb_url values:');
    for (const r of rows) console.log(JSON.stringify(r));

    const opdbOnly = await db.get(
        "SELECT COUNT(*) as n FROM global_games WHERE opdb_id IS NOT NULL AND vps_id IS NULL AND ipdb_url IS NOT NULL"
    );
    const vpsOnly = await db.get(
        "SELECT COUNT(*) as n FROM global_games WHERE opdb_id IS NULL AND vps_id IS NOT NULL AND ipdb_url IS NOT NULL"
    );
    const both = await db.get(
        "SELECT COUNT(*) as n FROM global_games WHERE opdb_id IS NOT NULL AND vps_id IS NOT NULL AND ipdb_url IS NOT NULL"
    );
    console.log('opdb-only with ipdb_url:', opdbOnly.n);
    console.log('vps-only  with ipdb_url:', vpsOnly.n);
    console.log('both      with ipdb_url:', both.n);

    await db.close();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
