import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { logInfo, logError, logWarn, logDebug } from '../utils/logger.js';
import { getTerminology } from '../utils/terminology.js';
import { Game } from '../types/index.js';
import fs from 'fs';
import path from 'path';

export interface IScoredGame {
    id: string;
    name: string;
    isHidden: boolean;
    isLocked: boolean;
    tags?: string[];
}

/**
 * Retries an async operation with exponential backoff.
 * Delays: 2s, 4s, 8s (for default maxAttempts=3).
 */
async function withRetry<T>(fn: () => Promise<T>, label: string, maxAttempts: number = 3): Promise<T> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt === maxAttempts) throw err;
            const delay = Math.pow(2, attempt) * 1000;
            logWarn(`iScored operation "${label}" failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw new Error('Unreachable');
}

const SCREENSHOT_DIR = path.join(process.cwd(), 'data', 'playwright-errors');

export class IScoredClient {
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private page: Page | null = null;

    private readonly LOGIN_URL = 'https://iscored.info/';
    private readonly SETTINGS_URL = 'https://iscored.info/settings.php';

    /** Tracks the last known DOM hash of the lineup for change detection. */
    private static lastLineupHash: string | null = null;

    constructor() {}

    /**
     * Saves a screenshot on failure for debugging. Returns the path or null.
     */
    private async saveErrorScreenshot(context: string): Promise<string | null> {
        if (!this.page) return null;
        try {
            if (!fs.existsSync(SCREENSHOT_DIR)) {
                fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
            }
            const safeName = context.replace(/[^a-zA-Z0-9_-]/g, '_');
            const screenshotPath = path.join(SCREENSHOT_DIR, `${Date.now()}_${safeName}.png`);
            await this.page.screenshot({ path: screenshotPath, fullPage: true });
            logError(`Screenshot saved: ${screenshotPath}`);
            return screenshotPath;
        } catch (e) {
            logError('Failed to save error screenshot:', e);
            return null;
        }
    }

    /**
     * Wraps an operation with screenshot-on-failure and retry logic.
     */
    private async withScreenshotOnFailure<T>(label: string, fn: () => Promise<T>, retries: number = 3): Promise<T> {
        return withRetry(async () => {
            try {
                return await fn();
            } catch (err) {
                await this.saveErrorScreenshot(label);
                throw err;
            }
        }, label, retries);
    }

    /**
     * Checks if the current browser session is still alive and logged in.
     */
    public async isSessionAlive(): Promise<boolean> {
        if (!this.page || !this.browser) return false;
        try {
            // Check if the browser process is still running
            if (!this.browser.isConnected()) return false;
            // Navigate to home page and check for login state
            await this.page.goto(this.LOGIN_URL, { timeout: 10000 });
            const mainFrame = this.page.frameLocator('#main');
            const userDropdown = mainFrame.locator('#userDropdown');
            const count = await userDropdown.count();
            return count > 0;
        } catch {
            return false;
        }
    }

    /**
     * Initializes the browser and logs into iScored.
     * Uses persistent session — reconnects only if the session is dead.
     */
    public async connect(): Promise<void> {
        // Check if existing session is still alive
        if (this.page && this.browser) {
            if (await this.isSessionAlive()) {
                logDebug('Reusing existing iScored session.');
                return;
            }
            logInfo('Existing iScored session expired, reconnecting...');
            await this.disconnect();
        }

        logInfo(`Connecting to iScored as ${process.env.ISCORED_USERNAME}...`);

        await this.withScreenshotOnFailure('connect', async () => {
            this.browser = await chromium.launch({ headless: true });
            this.context = await this.browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
                viewport: { width: 1920, height: 1080 }
            });

            this.page = await this.context.newPage();

            // Handle iScored's potential Wake Lock errors
            await this.page.addInitScript(() => {
                Object.defineProperty(navigator, 'wakeLock', {
                    get: () => ({ request: () => Promise.resolve() }),
                    configurable: true
                });
            });

            await this.page.goto(this.LOGIN_URL);

            // Handle cookie consent if it appears
            try {
                const cookieBtn = this.page.locator('button:has-text("I agree")');
                if (await cookieBtn.count() > 0) {
                    await cookieBtn.click({ timeout: 3000 });
                }
            } catch (e) {
                logDebug('Cookie consent not found or already dismissed.');
            }

            const mainFrame = this.page.frameLocator('#main');

            await mainFrame.getByRole('textbox', { name: 'Username' }).fill(process.env.ISCORED_USERNAME!);
            await mainFrame.getByRole('textbox', { name: 'Password', exact: true }).fill(process.env.ISCORED_PASSWORD!);
            await mainFrame.getByRole('button', { name: 'Log In' }).click();

            // Wait for successful login (user dropdown appears inside the main iframe)
            await mainFrame.locator('#userDropdown').waitFor({ state: 'attached', timeout: 15000 });

            logInfo('Successfully logged into iScored.');
        }, 2); // Only retry connect twice (initial + 1 retry)
    }

    /**
     * Closes the browser session.
     */
    public async disconnect(): Promise<void> {
        if (this.browser) {
            try {
                await this.browser.close();
            } catch {
                // Browser may already be closed
            }
            this.browser = null;
            this.context = null;
            this.page = null;
            logInfo('Disconnected from iScored.');
        }
    }

    /**
     * Navigates to the Lineup tab in iScored settings.
     * Uses deterministic waits instead of hardcoded timeouts.
     */
    private async navigateToLineup(): Promise<void> {
        if (!this.page) throw new Error('Client not connected. Call connect() first.');

        logDebug('Ensuring we are on settings page...');

        // Directly navigate to settings.php
        if (!this.page.url().includes('settings.php')) {
            await this.page.goto(this.SETTINGS_URL);
            await this.page.locator('ul.nav.nav-tabs.settingsTabs').waitFor({ state: 'visible', timeout: 10000 });
        }

        const lineupTab = this.page.locator('a[href="#order"]');
        await lineupTab.click();

        // Wait for the specific list container
        const list = this.page.locator('ul#orderGameUL');
        await list.waitFor({ state: 'attached', timeout: 10000 });

        // Wait for AJAX to populate the list by watching for child elements
        // instead of a hardcoded waitForTimeout
        try {
            await this.page.locator('ul#orderGameUL > li').first().waitFor({ state: 'attached', timeout: 5000 });
        } catch {
            logDebug('No list items appeared in lineup (may be empty).');
        }
    }

    /**
     * Computes a simple hash of the lineup DOM structure for change detection.
     */
    private async computeLineupHash(): Promise<string> {
        if (!this.page) return '';
        const structure = await this.page.evaluate(() => {
            const ul = document.getElementById('orderGameUL');
            if (!ul) return '';
            return Array.from(ul.querySelectorAll('li.list-group-item')).map(li => {
                const id = li.getAttribute('id') || '';
                const classes = li.className;
                const childSelectors = Array.from(li.querySelectorAll('input, span, label')).map(
                    el => `${el.tagName}#${el.id || ''}.${el.className}`
                ).join('|');
                return `${id}:${classes}:${childSelectors}`;
            }).join('\n');
        });
        // Simple string hash
        let hash = 0;
        for (let i = 0; i < structure.length; i++) {
            const chr = structure.charCodeAt(i);
            hash = ((hash << 5) - hash) + chr;
            hash |= 0;
        }
        return hash.toString(16);
    }

    /**
     * Checks if the iScored lineup DOM structure has changed since last successful scrape.
     * Logs a warning if a change is detected.
     */
    private async checkForDomChanges(): Promise<void> {
        const currentHash = await this.computeLineupHash();
        if (!currentHash) return;

        if (IScoredClient.lastLineupHash !== null && IScoredClient.lastLineupHash !== currentHash) {
            logWarn('iScored DOM structure change detected! The lineup page layout may have been updated. Review screenshot-on-failure captures if scraping errors follow.');
        }
        IScoredClient.lastLineupHash = currentHash;
    }

    /**
     * Gets all games currently in the iScored lineup.
     */
    public async getAllGames(): Promise<IScoredGame[]> {
        return this.withScreenshotOnFailure('getAllGames', async () => {
            await this.navigateToLineup();
            await this.checkForDomChanges();

            // Wait for at least one row to appear if we expect games
            try {
                await this.page!.locator('li.list-group-item').first().waitFor({ state: 'attached', timeout: 5000 });
            } catch (e) {
                logWarn('   -> No games found in lineup (Timeout waiting for first row).');
            }

            const rows = await this.page!.locator('li.list-group-item').all();
            logDebug(`   -> Scraper found ${rows.length} rows in the DOM.`);

            const games: IScoredGame[] = [];
            for (const row of rows) {
                const id = (await row.getAttribute('id')) || '';
                const nameElement = row.locator('span.dragHandle');
                if (await nameElement.count() === 0) continue;

                const name = (await nameElement.innerText()).trim();
                const isHidden = await row.locator(`#hide${id}`).isChecked();
                const isLocked = await row.locator(`#lock${id}`).isChecked();

                // Extract tags
                const tagValue = await row.locator(`input[name="tagInput${id}"]`).getAttribute('value');
                let tags: string[] = [];
                try {
                    if (tagValue && tagValue.startsWith('[')) {
                        tags = JSON.parse(tagValue).map((t: any) => t.value);
                    }
                } catch (e) {}

                games.push({ id, name, isHidden, isLocked, tags });
            }
            return games;
        });
    }

    /**
     * Sets the visibility and lock status of a game.
     * Uses waitForLoadState instead of hardcoded timeouts.
     */
    public async setGameStatus(gameId: string, status: { hidden?: boolean, locked?: boolean }): Promise<void> {
        await this.withScreenshotOnFailure('setGameStatus', async () => {
            await this.navigateToLineup();

            if (status.locked !== undefined) {
                const lockCheckbox = this.page!.locator(`#lock${gameId}`);
                if (status.locked) await lockCheckbox.check({ force: true });
                else await lockCheckbox.uncheck({ force: true });
                // Wait for the network call triggered by the checkbox
                await this.page!.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
            }

            if (status.hidden !== undefined) {
                const hideCheckbox = this.page!.locator(`#hide${gameId}`);
                if (status.hidden) await hideCheckbox.check({ force: true });
                else await hideCheckbox.uncheck({ force: true });
                await this.page!.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
            }

            logInfo(`Updated status for game ID ${gameId}: ${JSON.stringify(status)}`);
        });
    }

    /**
     * Adds a tag to a game using the Tagify input.
     */
    public async setGameTags(gameId: string, tag: string): Promise<void> {
        await this.withScreenshotOnFailure('setGameTags', async () => {
            await this.navigateToLineup();

            logInfo(`Adding tag '${tag}' to game ID: ${gameId}`);
            const gameRow = this.page!.locator(`li[id="${gameId}"]`);
            const tagifyInput = gameRow.locator('.tagify__input').first();

            const isVisible = await tagifyInput.isVisible();
            if (isVisible) {
                await tagifyInput.click({ force: true });
                await this.page!.keyboard.type(tag);
                await this.page!.keyboard.press('Enter');
                await this.page!.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
                logInfo(`Tag '${tag}' added.`);
            } else {
                logWarn(`Could not find tag input for game ${gameId}.`);
            }
        });
    }

    /**
     * Creates a new game on iScored.
     */
    public async createGame(gameName: string, styleId?: string): Promise<string> {
        return this.withScreenshotOnFailure('createGame', async () => {
            if (!this.page) throw new Error('Client not connected.');

            logInfo(`Creating new ${getTerminology().game}: ${gameName}${styleId ? ` (Style ID: ${styleId})` : ''}`);

            // Navigate to settings.php
            if (!this.page.url().includes('settings.php')) {
                await this.page.goto(this.SETTINGS_URL);
                await this.page.locator('ul.nav.nav-tabs.settingsTabs').waitFor({ state: 'visible', timeout: 10000 });
            }
            await this.page.locator('a[href="#games"]').click();

            await this.page.locator('button:has-text("Add New Game")').click();
            const searchInput = this.page.locator('input[type="search"][aria-controls="stylesTable"]');

            if (styleId) {
                // Apply style via JS
                await this.page.locator(':root').evaluate((el, id) => {
                    if (typeof (window as any).loadStylePreview === 'function') {
                        (window as any).loadStylePreview(id);
                    }
                }, styleId);
                await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

                await searchInput.fill(gameName);
                const createBtn = this.page.locator('button:has-text("Create Game Using Selected Style")');
                await createBtn.evaluate(el => (el as HTMLElement).click());
            } else {
                await searchInput.fill(gameName);
                await this.page.locator('button:has-text("Create Blank Game")').click();
            }

            // Wait for creation redirect — use page navigation wait instead of hardcoded timeout
            await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

            // Find the new game ID from the lineup
            const games = await this.getAllGames();
            const newGame = games.find(g => g.name.toUpperCase() === gameName.toUpperCase());

            if (!newGame) throw new Error(`Failed to find newly created ${getTerminology().game} in lineup.`);

            logInfo(`${getTerminology().game} created successfully with ID: ${newGame.id}`);
            return newGame.id;
        }, 2); // Only 2 attempts for create (side effects)
    }

    /**
     * Submits a score to iScored.
     */
    public async submitScore(gameId: string, username: string, score: number, photoPath?: string): Promise<void> {
        await this.withScreenshotOnFailure('submitScore', async () => {
            if (!this.page) throw new Error('Client not connected.');

            logInfo(`Submitting score for ${username}: ${score} to game ${gameId}`);

            const mainFrame = this.page.frameLocator('#main');

            // Navigate to dashboard
            await this.page.goto(this.LOGIN_URL);
            await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

            const scoreEntryActivator = mainFrame.locator(`#a${gameId}Scores`);
            await scoreEntryActivator.click();
            await mainFrame.locator('#scoreEntryDiv').waitFor({ state: 'visible', timeout: 10000 });

            // Fill via JS for reliability
            await mainFrame.locator('#newInitials').evaluate((el, val) => {
                (el as HTMLInputElement).value = val;
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }, username);

            await mainFrame.locator('#newScore').evaluate((el, val) => {
                (el as HTMLInputElement).value = val;
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }, score.toString());

            if (photoPath) {
                const fileChooserPromise = this.page.waitForEvent('filechooser');
                await mainFrame.locator('#takePhoto').click();
                const fileChooser = await fileChooserPromise;
                await fileChooser.setFiles(photoPath);
                await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
            }

            await mainFrame.getByRole('button', { name: 'Post Your Score!' }).click();

            try {
                const confirmButton = mainFrame.getByRole('button', { name: 'Yes Please.' });
                await confirmButton.click({ timeout: 2000 });
            } catch (e) {}

            await mainFrame.locator('#scoreEntryDiv').waitFor({ state: 'hidden', timeout: 10000 });
            logInfo(`Score submitted for ${username}.`);
        }, 2); // Only 2 attempts for submit (side effects)
    }

    /**
     * Repositions games in the Lineup tab based on a provided order of iScored IDs.
     */
    public async repositionLineup(orderedIds: string[]): Promise<void> {
        await this.withScreenshotOnFailure('repositionLineup', async () => {
            await this.navigateToLineup();
            const mainFrame = this.page!.frameLocator('#main');

            logInfo('Repositioning iScored Lineup (DOM-based)...');

            const result = await mainFrame.locator(':root').evaluate((el, targetIds) => {
                const lineupUl = document.getElementById('orderGameUL');
                const saveFn = (window as any).saveSetting;

                if (!lineupUl || !saveFn) return { success: false };

                const currentIds = Array.from(lineupUl.children).map(c => c.getAttribute('id'));
                const validTargetIds = targetIds.filter(id => currentIds.includes(id));

                // Prepend in reverse to put them at the top in correct order
                for (let i = validTargetIds.length - 1; i >= 0; i--) {
                    const id = validTargetIds[i];
                    if (!id) continue;
                    const li = document.getElementById(id);
                    if (li) lineupUl.prepend(li);
                }

                const finalOrderIds = Array.from(lineupUl.children).map(child => child.getAttribute('id'));
                saveFn("gameOrder", finalOrderIds.join(","));

                return { success: true, count: validTargetIds.length };
            }, orderedIds);

            if (result.success) {
                logInfo(`Lineup repositioned (${result.count} games moved to top).`);
                await this.page!.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
            }
        });
    }

    /**
     * Scrapes style details (CSS) for a specific game from the iScored editor.
     */
    public async syncStyle(gameId: string): Promise<any> {
        return this.withScreenshotOnFailure('syncStyle', async () => {
            if (!this.page) throw new Error('Client not connected.');

            const mainFrame = this.page.frameLocator('#main');

            // Navigate to Games tab
            await mainFrame.locator('a[href="#games"]').click();
            const selectGame = mainFrame.locator('#selectGame');
            await selectGame.selectOption(gameId);
            await selectGame.dispatchEvent('change');

            // Wait for game editor to load instead of hardcoded timeout
            await mainFrame.locator('#CSSTitle').waitFor({ state: 'visible', timeout: 10000 });

            const style = {
                css_title: await mainFrame.locator('#CSSTitle').inputValue(),
                css_initials: await mainFrame.locator('#CSSInitials').inputValue(),
                css_scores: await mainFrame.locator('#CSSScores').inputValue(),
                css_box: await mainFrame.locator('#CSSBox').inputValue(),
                bg_color: await mainFrame.locator('#gameBackgroundColor').inputValue(),
                score_type: await mainFrame.locator('#ScoreType').inputValue(),
                sort_ascending: (await mainFrame.locator('#SortAscending').isChecked()) ? 1 : 0
            };

            logInfo(`Style captured for game ID: ${gameId}`);
            return style;
        });
    }

    /**
     * Scrapes current scores and photo URLs from the public leaderboard page.
     */
    public async scrapePublicScores(publicUrl: string, gameId: string): Promise<any[]> {
        return this.withScreenshotOnFailure('scrapePublicScores', async () => {
            if (!this.page) throw new Error('Client not connected.');

            logInfo(`Scraping public scores from ${publicUrl} for game ${gameId}...`);
            await this.page.goto(publicUrl);

            // Wait for the main frame content to load instead of hardcoded timeout
            const mainFrame = this.page.frameLocator('#main');
            await mainFrame.locator('.game').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {
                logDebug('No game cards found on page (may be empty).');
            });

            const gameCard = mainFrame.locator(`div.game#a${gameId}`);

            if (!(await gameCard.isVisible())) {
                logWarn(`Game card #a${gameId} not found on public page.`);
                return [];
            }

            const scoreboxes = await gameCard.locator('.scorebox').all();
            const results: any[] = [];

            for (const box of scoreboxes) {
                const name = (await box.locator('.name').innerText()).trim();
                const score = (await box.locator('.score:not([id])').innerText()).trim();

                const link = box.locator('a[href*="/uploads/"], a[href*=".jpg"], a[href*=".png"]');
                let photoUrl = null;

                if (await link.count() > 0) {
                    const rawUrl = await link.first().getAttribute('href');
                    if (rawUrl) {
                        photoUrl = rawUrl.startsWith('http') ? rawUrl : new URL(rawUrl, new URL(publicUrl).origin).toString();
                    }
                }

                results.push({ name, score, photoUrl });
            }

            return results;
        });
    }
}
