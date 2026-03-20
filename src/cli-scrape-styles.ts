import 'dotenv/config';
import { chromium, Browser, Page, BrowserContext } from 'playwright';
import fs from 'fs';
import path from 'path';

// ─── Config ────────────────────────────────────────────────────────────────────
const BASE_URL = 'https://iscored.info';
const COMMUNITY_URL = `${BASE_URL}/community.php`;
const OUTPUT_DIR = path.join(process.cwd(), 'data', 'iscored-styles');
const BG_DIR = path.join(OUTPUT_DIR, 'backgrounds');
const HEADER_DIR = path.join(OUTPUT_DIR, 'headers');
const METADATA_FILE = path.join(OUTPUT_DIR, 'styles.json');
const GAMES_INDEX_FILE = path.join(OUTPUT_DIR, 'games-index.json');

// Rate limiting: pause between image downloads to be respectful
const DOWNLOAD_DELAY_MS = 200;
// Batch size for progress logging
const LOG_BATCH_SIZE = 50;

interface StyleEntry {
    styleId: number;
    styleName: string;
    notes: string;
    author: string;
    hasBackground: boolean;
    hasHeaderImage: boolean;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function ensureDir(dir: string) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Browser Setup & Login ─────────────────────────────────────────────────────
async function launchAndLogin(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
    const username = process.env.ISCORED_USERNAME;
    const password = process.env.ISCORED_PASSWORD;

    if (!username || !password) {
        console.error('Error: ISCORED_USERNAME and ISCORED_PASSWORD must be set in .env');
        process.exit(1);
    }

    console.log(`Launching browser and logging into iScored as ${username}...`);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 }
    });

    const page = await context.newPage();

    // Handle iScored's Wake Lock errors
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'wakeLock', {
            get: () => ({ request: () => Promise.resolve() }),
            configurable: true
        });
    });

    await page.goto(BASE_URL);

    // Cookie consent
    try {
        const cookieBtn = page.locator('button:has-text("I agree")');
        if (await cookieBtn.count() > 0) {
            await cookieBtn.click({ timeout: 3000 });
        }
    } catch {
        // Already dismissed or not present
    }

    // Login via iframe
    const mainFrame = page.frameLocator('#main');
    await mainFrame.getByRole('textbox', { name: 'Username' }).fill(username);
    await mainFrame.getByRole('textbox', { name: 'Password', exact: true }).fill(password);
    await mainFrame.getByRole('button', { name: 'Log In' }).click();
    await mainFrame.locator('#userDropdown').waitFor({ state: 'attached', timeout: 15000 });

    console.log('Logged in successfully.');
    return { browser, context, page };
}

// ─── Scrape Style Table ────────────────────────────────────────────────────────
async function scrapeStyleTable(page: Page): Promise<StyleEntry[]> {
    console.log('Navigating to community page...');
    await page.goto(COMMUNITY_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // Debug: screenshot the page and check where the table lives
    ensureDir(path.join(process.cwd(), 'data', 'playwright-errors'));
    await page.screenshot({ path: path.join(process.cwd(), 'data', 'playwright-errors', 'community-debug.png'), fullPage: true });
    console.log('Saved debug screenshot to data/playwright-errors/community-debug.png');

    // Check if stylesTable is on the main page or in the #main iframe
    const mainPageTable = await page.locator('#stylesTable').count();
    console.log(`stylesTable on main page: ${mainPageTable}`);

    const mainFrame = page.frameLocator('#main');
    const iframeTable = await mainFrame.locator('#stylesTable').count();
    console.log(`stylesTable in #main iframe: ${iframeTable}`);

    // Determine if table is in iframe or main page, and use a helper to get locators
    const useIframe = iframeTable > 0;

    if (mainPageTable === 0 && iframeTable === 0) {
        // Debug: check for iframes
        const iframes = await page.locator('iframe').all();
        console.log(`Found ${iframes.length} iframes on page:`);
        for (const iframe of iframes) {
            const src = await iframe.getAttribute('src');
            const id = await iframe.getAttribute('id');
            console.log(`  iframe id="${id}" src="${src}"`);
        }
        throw new Error('Could not find #stylesTable on community page');
    }

    // Helper to get locator from the correct frame
    const loc = (selector: string) =>
        useIframe ? mainFrame.locator(selector) : page.locator(selector);

    // Set DataTable to show 100 entries per page to reduce pagination clicks
    console.log('Setting table to show 100 entries per page...');
    await loc('#stylesTable_length select').selectOption('100');
    await sleep(2000); // Wait for table to re-render

    const styles: StyleEntry[] = [];
    let pageNum = 1;
    let hasNextPage = true;

    while (hasNextPage) {
        // Extract rows from current page
        const rows = await loc('#stylesTable tbody tr').all();

        for (const row of rows) {
            const onclick = await row.getAttribute('onclick');
            if (!onclick) continue;

            const match = onclick.match(/loadStylePreview\((\d+)\)/);
            if (!match) continue;

            const styleId = parseInt(match[1] as string, 10);
            const cells = await row.locator('td').all();

            const styleName = cells.length > 0 ? (await cells[0]!.textContent() || '').trim() : '';
            const notes = cells.length > 1 ? (await cells[1]!.textContent() || '').trim() : '';
            const author = cells.length > 2 ? (await cells[2]!.textContent() || '').trim() : '';

            styles.push({
                styleId,
                styleName,
                notes,
                author,
                hasBackground: false,
                hasHeaderImage: false
            });
        }

        console.log(`  Page ${pageNum}: scraped ${rows.length} rows (${styles.length} total so far)`);

        // Check if there's a next page
        const nextBtn = loc('#stylesTable_next');
        const nextClass = await nextBtn.getAttribute('class') || '';
        if (nextClass.includes('disabled')) {
            hasNextPage = false;
        } else {
            await nextBtn.locator('a').click();
            await sleep(1000); // Wait for table to update
            pageNum++;
        }
    }

    console.log(`Scraped ${styles.length} styles from ${pageNum} pages.`);
    return styles;
}

// ─── Download Images ───────────────────────────────────────────────────────────
async function downloadImages(context: BrowserContext, styles: StyleEntry[]): Promise<void> {
    console.log(`\nDownloading images for ${styles.length} styles...`);
    console.log(`  Background dir: ${BG_DIR}`);
    console.log(`  Header dir: ${HEADER_DIR}`);

    ensureDir(BG_DIR);
    ensureDir(HEADER_DIR);

    let bgDownloaded = 0;
    let headerDownloaded = 0;
    let bgFailed = 0;
    let headerFailed = 0;
    let bgSkipped = 0;
    let headerSkipped = 0;

    for (let i = 0; i < styles.length; i++) {
        const style = styles[i]!;
        const { styleId } = style;

        // Progress logging
        if ((i + 1) % LOG_BATCH_SIZE === 0 || i === 0) {
            console.log(`  Processing ${i + 1}/${styles.length} (bg: ${bgDownloaded} ok, ${bgFailed} fail | header: ${headerDownloaded} ok, ${headerFailed} fail)...`);
        }

        // Download background image
        const bgPath = path.join(BG_DIR, `gameBg${styleId}.png`);
        if (!fs.existsSync(bgPath)) {
            try {
                const bgUrl = `${BASE_URL}/community/images/backgrounds/gameBg${styleId}`;
                const response = await context.request.get(bgUrl);
                if (response.ok()) {
                    const body = await response.body();
                    if (body.length > 0) {
                        fs.writeFileSync(bgPath, body);
                        style.hasBackground = true;
                        bgDownloaded++;
                    } else {
                        bgFailed++;
                    }
                } else {
                    bgFailed++;
                }
            } catch {
                bgFailed++;
            }
        } else {
            style.hasBackground = true;
            bgSkipped++;
        }

        // Download header/game image
        const headerPath = path.join(HEADER_DIR, `game${styleId}.png`);
        if (!fs.existsSync(headerPath)) {
            try {
                const headerUrl = `${BASE_URL}/community/images/games/game${styleId}`;
                const response = await context.request.get(headerUrl);
                if (response.ok()) {
                    const body = await response.body();
                    if (body.length > 0) {
                        fs.writeFileSync(headerPath, body);
                        style.hasHeaderImage = true;
                        headerDownloaded++;
                    } else {
                        // No header image for this style (empty response = no image)
                        headerFailed++;
                    }
                } else {
                    // 404 or similar — style has no header image
                    headerFailed++;
                }
            } catch {
                headerFailed++;
            }
        } else {
            style.hasHeaderImage = true;
            headerSkipped++;
        }

        // Rate limiting
        if ((i + 1) % 10 === 0) {
            await sleep(DOWNLOAD_DELAY_MS);
        }

        // Periodic metadata save every 500 styles (crash recovery)
        if ((i + 1) % 500 === 0) {
            fs.writeFileSync(METADATA_FILE, JSON.stringify(styles, null, 2));
            console.log(`  [checkpoint] Saved metadata at ${i + 1}/${styles.length}`);
        }
    }

    console.log(`\nDownload complete:`);
    console.log(`  Backgrounds: ${bgDownloaded} downloaded, ${bgSkipped} skipped (existing), ${bgFailed} failed/missing`);
    console.log(`  Headers:     ${headerDownloaded} downloaded, ${headerSkipped} skipped (existing), ${headerFailed} failed/missing`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    const resumeFlag = process.argv.includes('--resume');

    ensureDir(OUTPUT_DIR);

    let styles: StyleEntry[];
    let browser: Browser | undefined;

    // If --resume and we already have styles.json, skip the scraping step
    if (resumeFlag && fs.existsSync(METADATA_FILE)) {
        console.log('Resuming from existing styles.json...');
        styles = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'));
        console.log(`Loaded ${styles.length} styles from metadata.`);
    } else {
        // Full scrape
        const session = await launchAndLogin();
        browser = session.browser;

        try {
            styles = await scrapeStyleTable(session.page);

            // Save metadata immediately after scraping
            fs.writeFileSync(METADATA_FILE, JSON.stringify(styles, null, 2));
            console.log(`Saved style metadata to ${METADATA_FILE}`);

            // Download images using the authenticated context
            await downloadImages(session.context, styles);
        } finally {
            await browser.close();
        }

        // Save updated metadata with hasBackground/hasHeaderImage flags
        fs.writeFileSync(METADATA_FILE, JSON.stringify(styles, null, 2));
        console.log(`Updated metadata saved to ${METADATA_FILE}`);
        printSummary(styles);
        return;
    }

    // Resume mode: just download missing images
    const session = await launchAndLogin();
    browser = session.browser;
    try {
        await downloadImages(session.context, styles);
    } finally {
        await browser.close();
    }

    fs.writeFileSync(METADATA_FILE, JSON.stringify(styles, null, 2));
    console.log(`Updated metadata saved to ${METADATA_FILE}`);
    printSummary(styles);
}

function buildGamesIndex(styles: StyleEntry[]): Record<string, { styleId: number; author: string; notes: string; hasBackground: boolean; hasHeaderImage: boolean }[]> {
    const index: Record<string, { styleId: number; author: string; notes: string; hasBackground: boolean; hasHeaderImage: boolean }[]> = {};
    for (const s of styles) {
        if (!index[s.styleName]) {
            index[s.styleName] = [];
        }
        index[s.styleName]!.push({
            styleId: s.styleId,
            author: s.author,
            notes: s.notes,
            hasBackground: s.hasBackground,
            hasHeaderImage: s.hasHeaderImage
        });
    }
    return index;
}

function printSummary(styles: StyleEntry[]) {
    const withBg = styles.filter(s => s.hasBackground).length;
    const withHeader = styles.filter(s => s.hasHeaderImage).length;

    // Build and save games index (game name → array of style variants)
    const gamesIndex = buildGamesIndex(styles);
    const uniqueNames = Object.keys(gamesIndex).length;
    fs.writeFileSync(GAMES_INDEX_FILE, JSON.stringify(gamesIndex, null, 2));

    console.log(`\n=== Summary ===`);
    console.log(`Total styles:       ${styles.length}`);
    console.log(`Unique game names:  ${uniqueNames}`);
    console.log(`With background:    ${withBg}`);
    console.log(`With header image:  ${withHeader}`);
    console.log(`Games index saved:  ${GAMES_INDEX_FILE}`);

    // Show some examples of games with multiple styles
    const multiStyleGames = Object.entries(gamesIndex)
        .filter(([, variants]) => variants.length > 1)
        .slice(0, 5);
    if (multiStyleGames.length > 0) {
        console.log(`\nExample games with multiple styles:`);
        for (const [name, variants] of multiStyleGames) {
            console.log(`  "${name}" — ${variants.length} styles (IDs: ${variants.map(v => v.styleId).join(', ')})`);
        }
    }

    // Estimate storage
    let totalSize = 0;
    const countFiles = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const file of fs.readdirSync(dir)) {
            totalSize += fs.statSync(path.join(dir, file)).size;
        }
    };
    countFiles(BG_DIR);
    countFiles(HEADER_DIR);

    console.log(`\nTotal storage used: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
