/**
 * Backfill VPS Images Script
 *
 * Many VPS entries (~60%) lack a top-level `imgUrl` but still have a usable
 * image on one of their tableFiles or b2sFiles. The original VpsImportService
 * only looked at `imgUrl`, so ~1450 catalogue rows ended up with no image.
 *
 * This script:
 *   1. Fetches the VPS database
 *   2. Finds every global_games row with vps_id set and image_url IS NULL
 *   3. Resolves the fallback URL via the same getPrimaryImageUrl() precedence:
 *        table.imgUrl → tableFiles[].imgUrl → b2sFiles[].imgUrl
 *   4. Downloads the image to data/catalogue-images/vps/ (skips if already present)
 *   5. Updates image_url + local_image_path on the DB row
 *
 * Idempotent. Safe to re-run. Only touches rows that are currently missing images.
 *
 * Usage:
 *   npx tsx scripts/backfill-vps-images.ts           # run backfill
 *   npx tsx scripts/backfill-vps-images.ts --dry-run # report counts only
 */

import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { initDatabase, getDatabase } from '../src/database/database.js';

interface VpsFile {
    id?: string;
    urls?: Array<{ url: string; broken?: boolean }>;
    imgUrl?: string;
    version?: string;
}

interface VpsTableFile extends VpsFile {
    tableFormat?: string;
}

interface VpsTable {
    id: string;
    name: string;
    imgUrl?: string;
    tableFiles?: VpsTableFile[];
    b2sFiles?: VpsFile[];
}

function getPrimaryImageUrl(table: VpsTable): string | undefined {
    if (table.imgUrl) return table.imgUrl;
    if (table.tableFiles?.length) {
        const tf = table.tableFiles.find(f => f.imgUrl);
        if (tf?.imgUrl) return tf.imgUrl;
    }
    if (table.b2sFiles?.length) {
        const bf = table.b2sFiles.find(f => f.imgUrl);
        if (bf?.imgUrl) return bf.imgUrl;
    }
    return undefined;
}

async function downloadImage(url: string, vpsId: string): Promise<string | undefined> {
    try {
        const dir = path.join(process.cwd(), 'data', 'catalogue-images', 'vps');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const ext = path.extname(url.split('?')[0] || '') || '.jpg';
        const safeName = vpsId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
        const filePath = path.join(dir, `${safeName}${ext}`);
        const relPath = `data/catalogue-images/vps/${safeName}${ext}`;

        if (fs.existsSync(filePath)) return relPath;

        const resp = await fetch(url);
        if (!resp.ok) return undefined;
        const buffer = Buffer.from(await resp.arrayBuffer());
        fs.writeFileSync(filePath, buffer);
        return relPath;
    } catch {
        return undefined;
    }
}

async function main() {
    const DRY_RUN = process.argv.includes('--dry-run');
    console.log(`Backfill VPS images${DRY_RUN ? ' (DRY RUN)' : ''}`);

    await initDatabase();
    const db = await getDatabase();

    console.log('Fetching VPS database...');
    const resp = await fetch('https://virtualpinballspreadsheet.github.io/vps-db/db/vpsdb.json');
    if (!resp.ok) throw new Error(`VPS API returned ${resp.status}`);
    const tables: VpsTable[] = await resp.json();
    console.log(`VPS returned ${tables.length} entries`);

    const byId = new Map(tables.map(t => [t.id, t]));

    const rows = await db.all<Array<{ id: string; name: string; vps_id: string }>>(
        `SELECT id, name, vps_id FROM global_games
         WHERE vps_id IS NOT NULL
           AND (image_url IS NULL OR local_image_path IS NULL)`
    );
    console.log(`Found ${rows.length} catalogue rows to backfill`);

    let resolved = 0;
    let downloaded = 0;
    let patched = 0;
    let noSource = 0;
    let failed = 0;
    const CONCURRENCY = 10;

    const tasks = rows.map(row => async () => {
        const vps = byId.get(row.vps_id);
        if (!vps) return;
        const url = getPrimaryImageUrl(vps);
        if (!url) { noSource++; return; }
        resolved++;

        if (DRY_RUN) return;

        const localPath = await downloadImage(url, row.vps_id);
        if (!localPath) { failed++; return; }
        downloaded++;

        const result = await db.run(
            `UPDATE global_games SET image_url = COALESCE(image_url, ?), local_image_path = ? WHERE id = ?`,
            url, localPath, row.id
        );
        if ((result.changes ?? 0) > 0) patched++;
    });

    const running: Set<Promise<void>> = new Set();
    let processed = 0;
    for (const task of tasks) {
        const p = task().then(() => { running.delete(p); processed++; });
        running.add(p);
        if (processed > 0 && processed % 200 === 0) {
            console.log(`  ${processed}/${rows.length} processed — patched=${patched}`);
        }
        if (running.size >= CONCURRENCY) {
            await Promise.race(running);
        }
    }
    await Promise.all(running);

    console.log('---');
    console.log(`Rows examined:   ${rows.length}`);
    console.log(`Resolvable URL:  ${resolved}`);
    console.log(`No source img:   ${noSource}`);
    if (!DRY_RUN) {
        console.log(`Downloaded:      ${downloaded}`);
        console.log(`DB rows patched: ${patched}`);
        console.log(`Download failed: ${failed}`);
    }
    process.exit(0);
}

main().catch(err => {
    console.error('Backfill failed:', err);
    process.exit(1);
});
