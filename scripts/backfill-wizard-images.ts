/**
 * Backfill Wizard Images Script
 *
 * Wizard catalogue rows originally imported with no image_url. This script:
 *   1. Fetches the /images/ folder listing from the LegendsUnchained repo
 *   2. For every global_games row with imported_from='wizard' and image_url IS NULL:
 *        a. Derives the slug from external_url (e.g. `vpx-samba`)
 *        b. Tries /images/{slug}.{ext} or /images/{slug}-preview.{ext}
 *        c. Falls back to /external/{slug}/launcher.png
 *   3. Downloads to data/catalogue-images/wizard/ (skips if already present)
 *   4. Patches image_url + local_image_path on the DB row
 *
 * Idempotent. Safe to re-run. Only touches rows with missing images.
 *
 * Usage:
 *   npx tsx scripts/backfill-wizard-images.ts             # run backfill
 *   npx tsx scripts/backfill-wizard-images.ts --dry-run   # report counts only
 */

import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { initDatabase, getDatabase } from '../src/database/database.js';

const RAW_BASE = 'https://raw.githubusercontent.com/LegendsUnchained/vpx-standalone-alp4k/main';
const IMAGES_API = 'https://api.github.com/repos/LegendsUnchained/vpx-standalone-alp4k/contents/images';

async function fetchImageMap(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const resp = await fetch(IMAGES_API);
    if (!resp.ok) throw new Error(`GitHub contents API: ${resp.status}`);
    const files: Array<{ name: string }> = await resp.json();
    for (const f of files) {
        const m = f.name.match(/^(.+?)(-preview)?\.(webp|png|jpg|jpeg)$/i);
        if (!m?.[1]) continue;
        const slug = m[1];
        const existing = map.get(slug);
        // Prefer non-preview files over -preview when both exist.
        if (!existing || !m[2]) map.set(slug, f.name);
    }
    return map;
}

function extractSlugFromExternalUrl(url: string | null): string | null {
    if (!url) return null;
    // external_url is like: https://github.com/.../tree/main/external/vpx-samba
    const m = url.match(/\/([^/]+)\/?$/);
    return m ? m[1] || null : null;
}

function resolveImageUrl(slug: string, imageMap: Map<string, string>): string {
    const mapped = imageMap.get(slug);
    if (mapped) return `${RAW_BASE}/images/${mapped}`;
    return `${RAW_BASE}/external/${slug}/launcher.png`;
}

async function downloadImage(url: string, slug: string): Promise<string | undefined> {
    try {
        const dir = path.join(process.cwd(), 'data', 'catalogue-images', 'wizard');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const ext = path.extname(url.split('?')[0] || '') || '.png';
        const safe = slug.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
        const filePath = path.join(dir, `${safe}${ext}`);
        const relPath = `data/catalogue-images/wizard/${safe}${ext}`;

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
    console.log(`Backfill wizard images${DRY_RUN ? ' (DRY RUN)' : ''}`);

    await initDatabase();
    const db = await getDatabase();

    console.log('Fetching /images/ listing from GitHub...');
    const imageMap = await fetchImageMap();
    console.log(`Image map: ${imageMap.size} unique slugs`);

    const rows = await db.all<Array<{ id: string; name: string; external_url: string | null }>>(
        `SELECT id, name, external_url FROM global_games
         WHERE imported_from = 'wizard'
           AND (image_url IS NULL OR local_image_path IS NULL)`
    );
    console.log(`Found ${rows.length} wizard rows to backfill`);

    let fromImages = 0;
    let fromLauncher = 0;
    let downloaded = 0;
    let patched = 0;
    let noSlug = 0;
    let failed = 0;
    const CONCURRENCY = 8;

    const tasks = rows.map(row => async () => {
        const slug = extractSlugFromExternalUrl(row.external_url);
        if (!slug) { noSlug++; return; }

        const mapped = imageMap.get(slug);
        const url = mapped
            ? `${RAW_BASE}/images/${mapped}`
            : `${RAW_BASE}/external/${slug}/launcher.png`;

        if (DRY_RUN) {
            if (mapped) fromImages++; else fromLauncher++;
            return;
        }

        const localPath = await downloadImage(url, slug);
        if (!localPath) { failed++; return; }
        downloaded++;
        if (mapped) fromImages++; else fromLauncher++;

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
        if (processed > 0 && processed % 100 === 0) {
            console.log(`  ${processed}/${rows.length} processed — patched=${patched}, failed=${failed}`);
        }
        if (running.size >= CONCURRENCY) {
            await Promise.race(running);
        }
    }
    await Promise.all(running);

    console.log('---');
    console.log(`Rows examined:      ${rows.length}`);
    console.log(`From /images/:      ${fromImages}`);
    console.log(`From launcher.png:  ${fromLauncher}`);
    console.log(`No slug derivable:  ${noSlug}`);
    if (!DRY_RUN) {
        console.log(`Downloaded:         ${downloaded}`);
        console.log(`DB rows patched:    ${patched}`);
        console.log(`Download failed:    ${failed}`);
    }
    process.exit(0);
}

main().catch(err => {
    console.error('Backfill failed:', err);
    process.exit(1);
});
