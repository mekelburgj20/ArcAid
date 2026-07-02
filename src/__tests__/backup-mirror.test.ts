import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { syncDirDedup } from '../engine/BackupManager.js';

// Unit tests for the asset-mirror dedup copier (Option A backup split). The
// mirror is append-only and copies only new/changed files, so each scheduled
// backup costs ~one asset copy total instead of re-bundling multi-GB per run.
describe('syncDirDedup (asset mirror dedup)', () => {
    let root: string;
    let src: string;
    let dst: string;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'arcaid-mirror-'));
        src = path.join(root, 'src');
        dst = path.join(root, 'dst');
        await fs.mkdir(src, { recursive: true });
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    it('copies new files (including nested dirs) on first sync', async () => {
        await fs.writeFile(path.join(src, 'a.txt'), 'aaa');
        await fs.mkdir(path.join(src, 'sub'));
        await fs.writeFile(path.join(src, 'sub', 'b.txt'), 'bbb');

        const r = await syncDirDedup(src, dst);

        expect(r.copied).toBe(2);
        expect(r.skipped).toBe(0);
        expect(await fs.readFile(path.join(dst, 'a.txt'), 'utf8')).toBe('aaa');
        expect(await fs.readFile(path.join(dst, 'sub', 'b.txt'), 'utf8')).toBe('bbb');
    });

    it('skips unchanged files on a second sync', async () => {
        await fs.writeFile(path.join(src, 'a.txt'), 'aaa');
        await syncDirDedup(src, dst);

        const r2 = await syncDirDedup(src, dst);

        expect(r2.copied).toBe(0);
        expect(r2.skipped).toBe(1);
    });

    it('re-copies a file whose size changed', async () => {
        const f = path.join(src, 'a.txt');
        await fs.writeFile(f, 'aaa');
        await syncDirDedup(src, dst);

        await fs.writeFile(f, 'aaaaaa'); // size 3 -> 6
        const r = await syncDirDedup(src, dst);

        expect(r.copied).toBe(1);
        expect(await fs.readFile(path.join(dst, 'a.txt'), 'utf8')).toBe('aaaaaa');
    });

    it('keeps mirror files that no longer exist in the source (append-only)', async () => {
        await fs.writeFile(path.join(src, 'keep.txt'), 'keep');
        await syncDirDedup(src, dst);

        await fs.rm(path.join(src, 'keep.txt'));
        await fs.writeFile(path.join(src, 'new.txt'), 'new');
        const r = await syncDirDedup(src, dst);

        expect(r.copied).toBe(1); // only new.txt
        // The removed source file is retained in the mirror.
        expect(await fs.readFile(path.join(dst, 'keep.txt'), 'utf8')).toBe('keep');
    });
});
