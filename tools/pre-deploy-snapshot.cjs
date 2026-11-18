// Pre-deploy database snapshot (X1, docs/infrastructure-improvement-plan.md §3).
//
// Migrations are forward-only and run when the new container boots, so the
// only way back from a bad one is a file taken BEFORE it ran. `deploy.yml`
// pipes this script into the RUNNING container just before it is replaced:
//
//     docker exec -i -u arcaid -w /app arcaid node - < tools/pre-deploy-snapshot.cjs
//
// It writes `data/pre-deploy/pre-deploy-<UTC stamp>.db` with `VACUUM INTO`
// (safe while the app is writing: one consistent, fully checkpointed file, no
// -wal / -shm to carry), checks the copy opens and passes `PRAGMA quick_check`,
// then keeps the newest KEEP files. Any failure exits non-zero BEFORE anything
// is deleted, and the deploy stops with prod untouched.
//
// CommonJS, no dependencies beyond the app's own `sqlite3`: it runs from
// stdin inside whatever image is live, so it cannot rely on a file that only
// a newer image carries. Rollback steps: docs/runbooks/rollback.md.
//
// Env (defaults are the container's): ARCAID_DB, ARCAID_SNAPSHOT_DIR,
// ARCAID_SNAPSHOT_KEEP.
'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const DB = process.env.ARCAID_DB || path.join(process.cwd(), 'data', 'arcaid.db');
const DIR = process.env.ARCAID_SNAPSHOT_DIR || path.join(path.dirname(DB), 'pre-deploy');
const KEEP = Math.max(1, Number.parseInt(process.env.ARCAID_SNAPSHOT_KEEP || '20', 10) || 20);
const NAME = /^pre-deploy-\d{8}T\d{6}Z\.db$/;

function open(file, mode) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(file, mode, err => (err ? reject(err) : resolve(db)));
    });
}
const run = (db, sql) => new Promise((resolve, reject) => db.run(sql, err => (err ? reject(err) : resolve())));
const get = (db, sql) => new Promise((resolve, reject) => db.get(sql, (err, row) => (err ? reject(err) : resolve(row))));
const close = db => new Promise((resolve, reject) => db.close(err => (err ? reject(err) : resolve())));

async function main() {
    if (!fs.existsSync(DB)) throw new Error(`database not found at ${DB}`);
    fs.mkdirSync(DIR, { recursive: true });

    // 20261117T154501Z: sorts by name in time order, no characters a shell minds.
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const out = path.join(DIR, `pre-deploy-${stamp}.db`);
    if (fs.existsSync(out)) throw new Error(`${out} already exists`); // VACUUM INTO refuses an existing target

    // OPEN_READWRITE without CREATE: never makes a database, and a WAL
    // database needs a writable -shm even to be read.
    const live = await open(DB, sqlite3.OPEN_READWRITE);
    try {
        live.configure('busyTimeout', 30000);
        await run(live, `VACUUM INTO '${out.replace(/'/g, "''")}'`);
    } finally {
        await close(live);
    }

    const copy = await open(out, sqlite3.OPEN_READONLY);
    let check;
    try {
        check = await get(copy, 'PRAGMA quick_check');
    } finally {
        await close(copy);
    }
    if (!check || check.quick_check !== 'ok') {
        throw new Error(`snapshot failed quick_check: ${JSON.stringify(check)}`);
    }

    // Retention only after the new file is proven good.
    const files = fs.readdirSync(DIR).filter(f => NAME.test(f)).sort().reverse();
    const removed = [];
    for (const old of files.slice(KEEP)) {
        fs.unlinkSync(path.join(DIR, old));
        removed.push(old);
    }

    const size = fs.statSync(out).size;
    console.log(`pre-deploy snapshot: ${out} (${size} bytes), ${Math.min(files.length, KEEP)} kept, ${removed.length} removed`);
}

main().catch(err => {
    console.error(`pre-deploy snapshot FAILED: ${err && err.message ? err.message : err}`);
    process.exit(1);
});
