import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

/**
 * X1 — `tools/pre-deploy-snapshot.cjs`, the script `deploy.yml` pipes into the
 * running container before it replaces it. Run here the way the deploy runs
 * it: from STDIN (`node -`), so it is proven to need no file on disk.
 *
 *   1. It writes one consistent copy of a database that is OPEN and in WAL
 *      mode, with rows that are still only in the write-ahead log.
 *   2. It keeps the newest N snapshots and removes the rest.
 *   3. A failure exits non-zero and removes nothing.
 */

const SCRIPT = fs.readFileSync(path.join(process.cwd(), 'tools', 'pre-deploy-snapshot.cjs'), 'utf8');

function snapshot(env: Record<string, string>) {
    return spawnSync(process.execPath, ['-'], {
        input: SCRIPT, cwd: process.cwd(), encoding: 'utf8',
        env: { ...process.env, ...env },
    });
}

describe('X1 — pre-deploy database snapshot', () => {
    let dir: string;
    let dbFile: string;
    let snapDir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arcaid-x1-'));
        dbFile = path.join(dir, 'arcaid.db');
        snapDir = path.join(dir, 'pre-deploy');
    });
    afterEach(() => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the WAL briefly */ }
    });

    const env = (over: Record<string, string> = {}) =>
        ({ ARCAID_DB: dbFile, ARCAID_SNAPSHOT_DIR: snapDir, ...over });
    const snapshots = () => (fs.existsSync(snapDir) ? fs.readdirSync(snapDir).sort() : []);

    it('copies a live WAL database, rows still in the write-ahead log included', async () => {
        const live = await open({ filename: dbFile, driver: sqlite3.Database });
        try {
            await live.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;`);
            await live.exec(`CREATE TABLE scores (id INTEGER PRIMARY KEY, score INTEGER)`);
            await live.run(`INSERT INTO scores (score) VALUES (1446600), (908760)`);
            // The connection stays OPEN, as the app's does during a deploy.

            const res = snapshot(env());
            expect(res.stderr).toBe('');
            expect(res.status).toBe(0);
            expect(res.stdout).toMatch(/pre-deploy snapshot: .*pre-deploy-\d{8}T\d{6}Z\.db \(\d+ bytes\), 1 kept, 0 removed/);

            const files = snapshots();
            expect(files).toHaveLength(1);
            expect(files[0]).toMatch(/^pre-deploy-\d{8}T\d{6}Z\.db$/);
            // One standalone file: nothing else to carry in a rollback.
            const copy = await open({ filename: path.join(snapDir, files[0]!), driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
            try {
                expect(await copy.all(`SELECT score FROM scores ORDER BY id`)).toEqual([{ score: 1446600 }, { score: 908760 }]);
            } finally {
                await copy.close();
            }
            // The live database is untouched and still writable.
            await live.run(`INSERT INTO scores (score) VALUES (1)`);
            expect((await live.get<{ n: number }>(`SELECT COUNT(*) AS n FROM scores`))!.n).toBe(3);
        } finally {
            await live.close();
        }
    });

    it('keeps the newest N and removes older snapshots, never other files', async () => {
        const live = await open({ filename: dbFile, driver: sqlite3.Database });
        await live.exec(`CREATE TABLE t (x)`);
        await live.close();
        fs.mkdirSync(snapDir);
        const old = ['pre-deploy-20260101T000000Z.db', 'pre-deploy-20260102T000000Z.db', 'pre-deploy-20260103T000000Z.db'];
        for (const f of [...old, 'notes.txt', 'pre-deploy-manual.db']) fs.writeFileSync(path.join(snapDir, f), 'x');

        const res = snapshot(env({ ARCAID_SNAPSHOT_KEEP: '2' }));
        expect(res.status).toBe(0);
        expect(res.stdout).toMatch(/2 kept, 2 removed/);
        const left = snapshots();
        expect(left).toHaveLength(4);
        expect(left).toContain('notes.txt');
        expect(left).toContain('pre-deploy-manual.db');
        expect(left).toContain('pre-deploy-20260103T000000Z.db');
        expect(left).not.toContain('pre-deploy-20260101T000000Z.db');
        expect(left).not.toContain('pre-deploy-20260102T000000Z.db');
    });

    it('fails loudly and removes nothing when there is no database', () => {
        fs.mkdirSync(snapDir);
        fs.writeFileSync(path.join(snapDir, 'pre-deploy-20260101T000000Z.db'), 'x');
        const res = snapshot(env({ ARCAID_SNAPSHOT_KEEP: '1' }));
        expect(res.status).toBe(1);
        expect(res.stderr).toMatch(/pre-deploy snapshot FAILED: database not found/);
        expect(snapshots()).toEqual(['pre-deploy-20260101T000000Z.db']);
        // It must never create a database where there was none.
        expect(fs.existsSync(dbFile)).toBe(false);
    });
});
