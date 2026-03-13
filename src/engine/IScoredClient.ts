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
        const list = this.page.locator('ul#orderGameUL');

        // Retry tab click if list doesn't appear (iScored transition lag)
        for (let i = 0; i < 3; i++) {
            await lineupTab.click();
            logDebug(`Clicked Lineup tab (attempt ${i + 1}). Waiting for list...`);

            try {
                await list.waitFor({ state: 'attached', timeout: 10000 });

                // Force visibility via JS to bypass iScored's CSS transition lag
                await list.evaluate((el) => {
                    (el as HTMLElement).style.display = 'block';
                    (el as HTMLElement).style.visibility = 'visible';
                    (el as HTMLElement).style.opacity = '1';
                });

                await list.waitFor({ state: 'visible', timeout: 5000 });

                if (await list.isVisible()) {
                    // Wait for AJAX to populate the list
                    try {
                        await this.page.locator('ul#orderGameUL > li').first().waitFor({ state: 'attached', timeout: 5000 });
                    } catch {
                        logDebug('No list items appeared in lineup (may be empty).');
                    }
                    return;
                }
            } catch {
                logDebug(`List not visible after attempt ${i + 1}.`);
            }
        }

        throw new Error('Failed to load Lineup list after 3 attempts.');
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

                // Extract tags — read from tagify DOM elements (hidden input may be empty)
                let tags: string[] = [];
                try {
                    const tagElements = row.locator('tag.tagify__tag');
                    const tagCount = await tagElements.count();
                    for (let t = 0; t < tagCount; t++) {
                        const val = await tagElements.nth(t).getAttribute('value');
                        if (val) tags.push(val);
                    }
                    // Fallback: try hidden input if no DOM tags found
                    if (tags.length === 0) {
                        const tagValue = await row.locator(`input[name="tagInput${id}"]`).getAttribute('value');
                        if (tagValue && tagValue.startsWith('[')) {
                            tags = JSON.parse(tagValue).map((t: any) => t.value);
                        }
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

            // Wait for game row to be visible
            await gameRow.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

            // Wait for tagify to initialize — the .tagify__input is dynamically injected
            const tagifyInput = gameRow.locator('.tagify__input').first();
            try {
                await tagifyInput.waitFor({ state: 'visible', timeout: 5000 });
            } catch {
                // Tagify may use a different container — try the tags input wrapper
                const tagifyWrapper = gameRow.locator('tags.tagify').first();
                const wrapperExists = await tagifyWrapper.count() > 0;
                if (wrapperExists) {
                    await tagifyWrapper.click({ force: true });
                    await this.page!.waitForTimeout(300);
                } else {
                    logWarn(`Could not find tag input for game ${gameId}. Tagify may not be loaded.`);
                    return;
                }
            }

            await tagifyInput.click({ force: true });
            await this.page!.waitForTimeout(200);
            await this.page!.keyboard.type(tag);
            await this.page!.keyboard.press('Enter');
            await this.page!.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
            logInfo(`Tag '${tag}' added.`);
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

            // Find the new game ID from the lineup (use last match — newest is at the end)
            const games = await this.getAllGames();
            const newGame = [...games].reverse().find(g => g.name.toUpperCase() === gameName.toUpperCase());

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

            // Fill via native input methods for iScored compatibility
            const initialsInput = mainFrame.locator('#newInitials');
            await initialsInput.click();
            await initialsInput.fill(username);

            const scoreInput = mainFrame.locator('#newScore');
            await scoreInput.click();
            await scoreInput.fill(score.toString());

            if (photoPath) {
                const fileChooserPromise = this.page.waitForEvent('filechooser');
                await mainFrame.locator('#takePhoto').click();
                const fileChooser = await fileChooserPromise;
                await fileChooser.setFiles(photoPath);
                await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
            }

            await mainFrame.getByRole('button', { name: 'Post Your Score!' }).click();

            // Handle "Invalid score" error dialog
            try {
                const gotItButton = mainFrame.getByRole('button', { name: 'Got it' });
                await gotItButton.waitFor({ state: 'visible', timeout: 2000 });
                const errorText = await mainFrame.locator('.bootbox-body').textContent().catch(() => 'Unknown validation error');
                await gotItButton.click();
                throw new Error(`iScored rejected score: ${errorText}`);
            } catch (e: any) {
                if (e.message?.includes('iScored rejected')) throw e;
                // No error dialog — continue
            }

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

            logInfo('Repositioning iScored Lineup (DOM-based)...');

            // Force the lineup list visible (iScored transition lag)
            const list = this.page!.locator('ul#orderGameUL');
            await list.evaluate((el) => {
                (el as HTMLElement).style.display = 'block';
                (el as HTMLElement).style.visibility = 'visible';
                (el as HTMLElement).style.opacity = '1';
            });

            const result = await this.page!.evaluate((targetIds) => {
                const lineupUl = document.getElementById('orderGameUL');
                const saveFn = (window as any).saveSetting;

                if (!lineupUl || !saveFn) {
                    return { success: false, error: `lineupUl: ${!!lineupUl}, saveFn: ${!!saveFn}` };
                }

                const currentIds = Array.from(lineupUl.children).map(c => c.getAttribute('id'));
                const validTargetIds = targetIds.filter((id: string) => currentIds.includes(id));

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
            } else {
                logError(`Failed to reposition lineup: ${(result as any).error}`);
            }
        });
    }

    /**
     * Navigates to the Games tab on the settings page.
     */
    private async navigateToGamesTab(): Promise<void> {
        if (!this.page) throw new Error('Client not connected.');
        if (!this.page.url().includes('settings.php')) {
            await this.page.goto(this.SETTINGS_URL);
            await this.page.locator('ul.nav.nav-tabs.settingsTabs').waitFor({ state: 'visible', timeout: 10000 });
        }
        await this.page.locator('a[href="#games"]').click();
    }

    /**
     * Scrapes style details (CSS) for a specific game from the iScored editor.
     * Also extracts the community style ID from the preview element if present.
     */
    public async syncStyle(gameId: string): Promise<any> {
        return this.withScreenshotOnFailure('syncStyle', async () => {
            if (!this.page) throw new Error('Client not connected.');

            await this.navigateToGamesTab();

            const selectGame = this.page.locator('#selectGame');
            await selectGame.selectOption(gameId);
            await selectGame.dispatchEvent('change');

            // Wait for game editor to load
            await this.page.locator('#CSSTitle').waitFor({ state: 'visible', timeout: 10000 });

            const style = {
                css_title: await this.page.locator('#CSSTitle').inputValue(),
                css_initials: await this.page.locator('#CSSInitials').inputValue(),
                css_scores: await this.page.locator('#CSSScores').inputValue(),
                css_box: await this.page.locator('#CSSBox').inputValue(),
                bg_color: await this.page.locator('#gameBackgroundColor').inputValue(),
                score_type: await this.page.locator('#ScoreType').inputValue(),
                sort_ascending: (await this.page.locator('#SortAscending').isChecked()) ? 1 : 0,
                style_id: null as string | null,
            };

            // Extract community style ID from preview background-image
            try {
                const testGame = this.page.locator('#testGame');
                const bgImageStyle = await testGame.getAttribute('style') || '';
                const match = bgImageStyle.match(/\/community\/images\/backgrounds\/gameBg(\d+)/);
                if (match?.[1]) {
                    style.style_id = match[1];
                    logDebug(`   -> Detected Community Style ID: ${style.style_id}`);
                }
            } catch {
                // Preview element may not be visible — non-fatal
            }

            logInfo(`Style captured for game ID: ${gameId}`);
            return style;
        });
    }

    /**
     * Applies saved CSS style fields to the currently selected game in the iScored editor.
     * Call after createGame() while still on the Games tab with the new game selected.
     */
    public async applyStyle(gameId: string, style: {
        css_title?: string; css_initials?: string; css_scores?: string;
        css_box?: string; bg_color?: string;
    }): Promise<void> {
        await this.withScreenshotOnFailure('applyStyle', async () => {
            if (!this.page) throw new Error('Client not connected.');

            await this.navigateToGamesTab();

            // Select the game
            const selectGame = this.page.locator('#selectGame');
            await selectGame.selectOption(gameId);
            await selectGame.dispatchEvent('change');
            await this.page.locator('#CSSTitle').waitFor({ state: 'visible', timeout: 10000 });

            logInfo(`Applying saved styles to game ID: ${gameId}`);

            if (style.css_title) await this.page.locator('#CSSTitle').fill(style.css_title);
            if (style.css_initials) await this.page.locator('#CSSInitials').fill(style.css_initials);
            if (style.css_scores) await this.page.locator('#CSSScores').fill(style.css_scores);
            if (style.css_box) await this.page.locator('#CSSBox').fill(style.css_box);
            if (style.bg_color) await this.page.locator('#gameBackgroundColor').fill(style.bg_color);

            // Trigger change event to persist
            await this.page.locator('#CSSTitle').dispatchEvent('change');
            await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

            logInfo(`Styles applied to game ID: ${gameId}`);
        }, 2);
    }

    /**
     * Deletes a game from iScored via the Games tab.
     * Selects the game, clicks Delete, confirms the modal.
     */
    public async deleteGame(gameId: string, gameName?: string): Promise<void> {
        await this.withScreenshotOnFailure('deleteGame', async () => {
            if (!this.page) throw new Error('Client not connected.');

            await this.navigateToGamesTab();

            const selectGame = this.page.locator('#selectGame');

            // Verify the game exists in the dropdown
            const optionCount = await selectGame.locator(`option[value="${gameId}"]`).count();
            if (optionCount === 0) {
                logWarn(`Game '${gameName || gameId}' not found in dropdown. Skipping delete.`);
                return;
            }

            await selectGame.selectOption(gameId);
            await selectGame.dispatchEvent('change');

            // Call editGame() to load the game editor panel
            try {
                await this.page.evaluate(() => {
                    if (typeof (window as any).editGame === 'function') {
                        (window as any).editGame();
                    }
                });
            } catch {}

            // Force #gameCustomizations visible (iScored transition lag)
            const customizations = this.page.locator('#gameCustomizations');
            await customizations.waitFor({ state: 'attached', timeout: 5000 });
            await customizations.evaluate((el) => {
                (el as HTMLElement).style.display = 'block';
                (el as HTMLElement).style.visibility = 'visible';
                (el as HTMLElement).style.opacity = '1';
            });

            // Wait for busy modal to clear
            await this.waitForBusyModal();

            // Click Delete Game button
            const deleteButton = this.page.locator('#deleteSelectedGameButton');
            await deleteButton.waitFor({ state: 'attached', timeout: 5000 });
            await deleteButton.evaluate(el => (el as HTMLElement).click());

            // Wait for confirmation modal
            const modal = this.page.locator('#deleteGameModal');
            await modal.waitFor({ state: 'visible', timeout: 5000 });

            await this.waitForBusyModal();

            // Click the confirm button
            try {
                const confirmButton = modal.locator('.modal-footer button.btn-danger').first();
                await confirmButton.evaluate(el => (el as HTMLElement).click());
            } catch {
                const confirmByText = modal.getByRole('button', { name: "Yes I'm definitely sure.", exact: false });
                await confirmByText.evaluate(el => (el as HTMLElement).click());
            }

            // Wait for modal to close
            await modal.waitFor({ state: 'hidden', timeout: 10000 });
            await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

            logInfo(`Game '${gameName || gameId}' deleted from iScored.`);
        }, 2);
    }

    /**
     * Waits for the iScored busy/loading modal to disappear.
     */
    private async waitForBusyModal(): Promise<void> {
        if (!this.page) return;
        try {
            const busyModal = this.page.locator('#busyModal');
            if (await busyModal.isVisible()) {
                await busyModal.waitFor({ state: 'hidden', timeout: 15000 });
            }
        } catch {
            // Proceed if modal doesn't hide in time
        }
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
