import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { logInfo, logError, logWarn, logDebug } from '../utils/logger.js';
import { getTerminology } from '../utils/terminology.js';
import { Game } from '../types/index.js';

export interface IScoredGame {
    id: string;
    name: string;
    isHidden: boolean;
    isLocked: boolean;
    tags?: string[];
}

export class IScoredClient {
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private page: Page | null = null;

    private readonly LOGIN_URL = 'https://iscored.info/';
    private readonly SETTINGS_URL = 'https://iscored.info/settings.php';

    constructor() {}

    /**
     * Initializes the browser and logs into iScored.
     */
    public async connect(): Promise<void> {
        if (this.page) return;

        logInfo(`🚀 Connecting to iScored as ${process.env.ISCORED_USERNAME}...`);

        try {
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
                await this.page.click('button:has-text("I agree")', { timeout: 3000 });
            } catch (e) {
                logDebug('Cookie consent not found or already dismissed.');
            }

            const mainFrame = this.page.frameLocator('#main');
            
            await mainFrame.getByRole('textbox', { name: 'Username' }).fill(process.env.ISCORED_USERNAME!);
            await mainFrame.getByRole('textbox', { name: 'Password', exact: true }).fill(process.env.ISCORED_PASSWORD!);
            await mainFrame.getByRole('button', { name: 'Log In' }).click();

            // Wait for successful login (user dropdown appears)
            await mainFrame.locator('#userDropdown').waitFor({ state: 'visible', timeout: 15000 });
            
            logInfo('✅ Successfully logged into iScored.');
        } catch (error) {
            logError('❌ Failed to connect to iScored.', error);
            await this.disconnect();
            throw error;
        }
    }

    /**
     * Closes the browser session.
     */
    public async disconnect(): Promise<void> {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.context = null;
            this.page = null;
            logInfo('🔌 Disconnected from iScored.');
        }
    }

    /**
     * Navigates to the Lineup tab in iScored settings.
     */
    private async navigateToLineup(): Promise<void> {
        if (!this.page) throw new Error('Client not connected. Call connect() first.');

        const mainFrame = this.page.frameLocator('#main');
        
        // Check if already there
        if (await mainFrame.locator('ul#orderGameUL').isVisible()) return;

        logDebug('Navigating to Lineup tab...');
        
        // Go to settings first if needed
        if (!this.page.url().includes('settings.php')) {
            const userDropdown = mainFrame.locator('#userDropdown').getByRole('link');
            await userDropdown.click();
            const settingsLink = mainFrame.locator('a[href="/settings.php"]').filter({ hasText: 'Settings' });
            await settingsLink.click();
            await mainFrame.locator('ul.nav.nav-tabs.settingsTabs').waitFor({ state: 'visible' });
        }

        const lineupTab = mainFrame.locator('a[href="#order"]');
        await lineupTab.click();
        await mainFrame.locator('ul#orderGameUL').waitFor({ state: 'attached' });
    }

    /**
     * Gets all games currently in the iScored lineup.
     */
    public async getAllGames(): Promise<IScoredGame[]> {
        await this.navigateToLineup();
        const mainFrame = this.page!.frameLocator('#main');
        const rows = await mainFrame.locator('li.list-group-item').all();
        
        const games: IScoredGame[] = [];
        for (const row of rows) {
            const id = (await row.getAttribute('id')) || '';
            const name = (await row.locator('span.dragHandle').innerText()).trim();
            const isHidden = await row.locator(`#hide${id}`).isChecked();
            const isLocked = await row.locator(`#lock${id}`).isChecked();
            
            // Extract tags (simplified for now)
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
    }

    /**
     * Creates a new game on iScored.
     */
    public async createGame(gameName: string, styleId?: string): Promise<string> {
        if (!this.page) throw new Error('Client not connected.');

        logInfo(`✨ Creating new ${getTerminology().game}: ${gameName}${styleId ? ` (Style ID: ${styleId})` : ''}`);

        const mainFrame = this.page.frameLocator('#main');
        
        // Navigate to Games tab
        const userDropdown = mainFrame.locator('#userDropdown').getByRole('link');
        await userDropdown.click();
        const settingsLink = mainFrame.locator('a[href="/settings.php"]').filter({ hasText: 'Settings' });
        await settingsLink.click();
        await mainFrame.locator('a[href="#games"]').click();
        
        await mainFrame.locator('button:has-text("Add New Game")').click();
        const searchInput = mainFrame.locator('input[type="search"][aria-controls="stylesTable"]');

        if (styleId) {
            // Apply style via JS
            await mainFrame.locator(':root').evaluate((el, id) => {
                if (typeof (window as any).loadStylePreview === 'function') {
                    (window as any).loadStylePreview(id);
                }
            }, styleId);
            await this.page.waitForTimeout(1000);
            
            await searchInput.fill(gameName);
            const createBtn = mainFrame.locator('button:has-text("Create Game Using Selected Style")');
            await createBtn.evaluate(el => (el as HTMLElement).click());
        } else {
            await searchInput.fill(gameName);
            await mainFrame.locator('button:has-text("Create Blank Game")').click();
        }

        await this.page.waitForTimeout(3000); // Wait for creation redirect
        
        // Find the new game ID from the lineup
        const games = await this.getAllGames();
        const newGame = games.find(g => g.name.toUpperCase() === gameName.toUpperCase());
        
        if (!newGame) throw new Error(`Failed to find newly created ${getTerminology().game} in lineup.`);
        
        logInfo(`✅ ${getTerminology().game} created successfully with ID: ${newGame.id}`);
        return newGame.id;
    }

    /**
     * Submits a score to iScored.
     */
    public async submitScore(gameId: string, username: string, score: number, photoPath?: string): Promise<void> {
        if (!this.page) throw new Error('Client not connected.');

        logInfo(`🚀 Submitting score for ${username}: ${score} to game ${gameId}`);
        
        const mainFrame = this.page.frameLocator('#main');
        
        // Navigate to dashboard
        await this.page.goto(this.LOGIN_URL);
        
        const scoreEntryActivator = mainFrame.locator(`#a${gameId}Scores`);
        await scoreEntryActivator.click();
        await mainFrame.locator('#scoreEntryDiv').waitFor({ state: 'visible' });

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
            await this.page.waitForTimeout(1000);
        }

        await mainFrame.getByRole('button', { name: 'Post Your Score!' }).click();
        
        try {
            const confirmButton = mainFrame.getByRole('button', { name: 'Yes Please.' });
            await confirmButton.click({ timeout: 2000 });
        } catch (e) {}

        await mainFrame.locator('#scoreEntryDiv').waitFor({ state: 'hidden' });
        logInfo(`✅ Score submitted for ${username}.`);
    }
}
