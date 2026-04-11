import { GlobalGameService, GlobalGameInput } from './GlobalGameService.js';
import { SyncLogService } from './SyncLogService.js';
import { IGDB_PLATFORM_MAP, IGDB_TARGET_PLATFORMS } from '../utils/platformMapping.js';
import { logInfo, logError } from '../utils/logger.js';
import { getDatabase } from '../database/database.js';
import fs from 'fs';
import path from 'path';

/** Twitch OAuth token response */
interface TwitchToken {
    access_token: string;
    expires_in: number;
    token_type: string;
}

/** IGDB game response */
interface IGDBGame {
    id: number;
    name: string;
    slug?: string;
    url?: string;
    summary?: string;
    first_release_date?: number;
    category?: number;
    platforms?: number[];
    genres?: number[];
    themes?: number[];
    game_modes?: number[];
    cover?: { image_id: string };
    involved_companies?: Array<{ company: { name: string }; developer: boolean }>;
    rating?: number;
    total_rating?: number;
    videos?: Array<{ video_id: string; name?: string }>;
    [key: string]: any;
}

/** IGDB genre/theme lookup */
interface IGDBMeta {
    id: number;
    name: string;
}

const IGDB_API = 'https://api.igdb.com/v4';
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const BATCH_SIZE = 500;
const RATE_LIMIT_DELAY_MS = 260; // ~4 req/sec

/**
 * Downloads an IGDB cover image to local disk.
 */
async function downloadCover(imageId: string, gameId: number): Promise<string | undefined> {
    try {
        const url = `https://images.igdb.com/igdb/image/upload/t_cover_big/${imageId}.jpg`;
        const dir = path.join(process.cwd(), 'data', 'catalogue-images', 'igdb');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const resp = await fetch(url);
        if (!resp.ok) return undefined;

        const buffer = Buffer.from(await resp.arrayBuffer());
        const filePath = path.join(dir, `${gameId}.jpg`);
        fs.writeFileSync(filePath, buffer);
        return `data/catalogue-images/igdb/${gameId}.jpg`;
    } catch {
        return undefined;
    }
}

/**
 * Delays execution for rate limiting.
 */
function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class IGDBImportService {
    /**
     * Gets or refreshes the Twitch OAuth token for IGDB API access.
     * Stores token in settings table for persistence.
     */
    static async getAccessToken(): Promise<string> {
        const clientId = process.env.TWITCH_CLIENT_ID;
        const clientSecret = process.env.TWITCH_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
            throw new Error('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must be configured for IGDB import.');
        }

        // Check for cached token
        const db = await getDatabase();
        const tokenRow = await db.get("SELECT value FROM settings WHERE key = 'TWITCH_ACCESS_TOKEN'");
        const expiryRow = await db.get("SELECT value FROM settings WHERE key = 'TWITCH_TOKEN_EXPIRES_AT'");

        if (tokenRow && expiryRow) {
            const expiresAt = new Date(expiryRow.value);
            const oneHourFromNow = new Date(Date.now() + 3600000);
            if (expiresAt > oneHourFromNow) {
                return tokenRow.value;
            }
        }

        // Refresh token
        logInfo('IGDB: refreshing Twitch OAuth token...');
        const resp = await fetch(TWITCH_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'client_credentials',
            }),
        });

        if (!resp.ok) {
            throw new Error(`Twitch token refresh failed: ${resp.status} ${await resp.text()}`);
        }

        const token: TwitchToken = await resp.json();
        const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();

        // Store in settings
        await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('TWITCH_ACCESS_TOKEN', ?)", token.access_token);
        await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('TWITCH_TOKEN_EXPIRES_AT', ?)", expiresAt);

        logInfo('IGDB: Twitch token refreshed, expires at ' + expiresAt);
        return token.access_token;
    }

    /**
     * Makes an IGDB API request with Apicalypse query body.
     */
    private static async igdbRequest<T>(endpoint: string, query: string): Promise<T[]> {
        const accessToken = await this.getAccessToken();
        const clientId = process.env.TWITCH_CLIENT_ID!;

        const resp = await fetch(`${IGDB_API}/${endpoint}`, {
            method: 'POST',
            headers: {
                'Client-ID': clientId,
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'text/plain',
            },
            body: query,
        });

        if (resp.status === 401) {
            // Token expired — clear cache and retry once
            const db = await getDatabase();
            await db.run("DELETE FROM settings WHERE key = 'TWITCH_ACCESS_TOKEN'");
            await db.run("DELETE FROM settings WHERE key = 'TWITCH_TOKEN_EXPIRES_AT'");
            return this.igdbRequest(endpoint, query);
        }

        if (!resp.ok) {
            throw new Error(`IGDB API ${endpoint} returned ${resp.status}: ${await resp.text()}`);
        }

        return resp.json();
    }

    /**
     * Fetches genre names from IGDB.
     */
    private static async fetchGenres(): Promise<Map<number, string>> {
        const genres = await this.igdbRequest<IGDBMeta>('genres', 'fields id, name; limit 500;');
        await delay(RATE_LIMIT_DELAY_MS);
        return new Map(genres.map(g => [g.id, g.name]));
    }

    /**
     * Fetches theme names from IGDB.
     */
    private static async fetchThemes(): Promise<Map<number, string>> {
        const themes = await this.igdbRequest<IGDBMeta>('themes', 'fields id, name; limit 500;');
        await delay(RATE_LIMIT_DELAY_MS);
        return new Map(themes.map(t => [t.id, t.name]));
    }

    /**
     * Fetches game mode names from IGDB.
     */
    private static async fetchGameModes(): Promise<Map<number, string>> {
        const modes = await this.igdbRequest<IGDBMeta>('game_modes', 'fields id, name; limit 500;');
        await delay(RATE_LIMIT_DELAY_MS);
        return new Map(modes.map(m => [m.id, m.name]));
    }

    /**
     * Bulk seeds the global catalogue from IGDB for arcade + retro console platforms.
     * Batched in pages of 500, rate-limited to 4 req/sec.
     */
    static async importFromIGDB(): Promise<{
        imported: number;
        updated: number;
        skipped: number;
        total: number;
    }> {
        const syncLogId = await SyncLogService.start('igdb');
        const errors: string[] = [];

        try {
            logInfo('IGDB Import: starting bulk seed...');

            // Pre-fetch lookup tables
            const genreMap = await this.fetchGenres();
            const themeMap = await this.fetchThemes();
            const gameModeMap = await this.fetchGameModes();

            const platformIds = IGDB_TARGET_PLATFORMS.join(',');
            let offset = 0;
            let inserted = 0;
            let updated = 0;
            let skipped = 0;
            let totalFetched = 0;

            while (true) {
                // Apicalypse operators on array fields (verified via live API testing):
                //   `platforms = (x,y,z)` means "contains ANY of x, y, z" (what we want)
                //   `platforms = [x,y,z]` means "contains ALL of x AND y AND z" (impossible)
                // Omitting `status = 0` because IGDB leaves status NULL for most released
                // games — filtering would exclude ~99% of results.
                // IGDB deprecated `category` in favour of `game_type`. Most released games
                // now have `category` NULL, so `where category = 0` returned zero rows.
                // game_type = 0 means "main_game" (excludes DLC, expansions, bundles, mods).
                const query = `
                    fields name, slug, url, summary, first_release_date, game_type, platforms,
                           genres, themes, game_modes, cover.image_id,
                           involved_companies.company.name, involved_companies.developer,
                           rating, total_rating, videos.video_id, videos.name;
                    where platforms = (${platformIds})
                        & game_type = 0;
                    sort id asc;
                    limit ${BATCH_SIZE};
                    offset ${offset};
                `;

                const games = await this.igdbRequest<IGDBGame>('games', query);
                await delay(RATE_LIMIT_DELAY_MS);

                if (games.length === 0) break;
                totalFetched += games.length;
                logInfo(`IGDB Import: processing batch at offset ${offset} (${games.length} games)`);

                for (const game of games) {
                    try {
                        // Map IGDB platforms to canonical IDs
                        const platforms = (game.platforms || [])
                            .map(pid => IGDB_PLATFORM_MAP[pid])
                            .filter((p): p is string => !!p);

                        if (platforms.length === 0) {
                            skipped++;
                            continue;
                        }

                        // Determine game type
                        const isArcade = game.platforms?.includes(52);
                        const type = isArcade ? 'arcade' : 'video_game';
                        const subtype = isArcade ? 'arcade' : (game.platforms?.includes(6) ? 'pc' : 'console');

                        // Map genres and themes to names
                        const gameThemes: string[] = [];
                        if (game.genres) {
                            for (const gid of game.genres) {
                                const name = genreMap.get(gid);
                                if (name) gameThemes.push(name);
                            }
                        }
                        if (game.themes) {
                            for (const tid of game.themes) {
                                const name = themeMap.get(tid);
                                if (name && !gameThemes.includes(name)) gameThemes.push(name);
                            }
                        }

                        // Map game modes to features
                        const features: string[] = [];
                        if (game.game_modes) {
                            for (const mid of game.game_modes) {
                                const name = gameModeMap.get(mid);
                                if (name) features.push(name.toLowerCase().replace(/\s+/g, '_'));
                            }
                        }

                        // Extract developers
                        const designers: string[] = [];
                        if (game.involved_companies) {
                            for (const ic of game.involved_companies) {
                                if (ic.developer && ic.company?.name) {
                                    designers.push(ic.company.name);
                                }
                            }
                        }

                        // Parse year from Unix timestamp
                        let year: number | undefined;
                        if (game.first_release_date) {
                            year = new Date(game.first_release_date * 1000).getFullYear();
                        }

                        // Tutorial videos from IGDB
                        const tutorialUrls = (game.videos || []).map(v => ({
                            title: v.name,
                            youtubeId: v.video_id,
                        }));

                        const input: GlobalGameInput = {
                            name: game.name,
                            year,
                            type,
                            subtype,
                            platforms,
                            themes: gameThemes,
                            designers,
                            features,
                            igdb_id: game.id,
                            external_url: game.url,
                            description: game.summary,
                            source_rating: game.total_rating || game.rating,
                            tutorial_urls: tutorialUrls.length > 0 ? tutorialUrls : undefined,
                            imported_from: 'igdb',
                        };

                        // Download cover art
                        if (game.cover?.image_id) {
                            const localPath = await downloadCover(game.cover.image_id, game.id);
                            if (localPath) input.local_image_path = localPath;
                        }

                        const result = await GlobalGameService.upsert(input);
                        if (result.action === 'inserted') inserted++;
                        else if (result.action === 'updated') updated++;
                        else skipped++;
                    } catch (err) {
                        const msg = `Failed to import IGDB game "${game.name}" (${game.id}): ${err}`;
                        logError(msg);
                        errors.push(msg);
                        skipped++;
                    }
                }

                offset += BATCH_SIZE;

                // Safety: if we got fewer than BATCH_SIZE, we've reached the end
                if (games.length < BATCH_SIZE) break;
            }

            logInfo(`IGDB Import: inserted ${inserted}, updated ${updated}, skipped ${skipped}, total fetched ${totalFetched}`);

            await SyncLogService.complete(syncLogId, {
                status: errors.length > 0 ? 'partial' : 'success',
                records_imported: inserted,
                records_updated: updated,
                records_skipped: skipped,
                errors: errors.length > 0 ? errors : undefined,
            });

            return { imported: inserted, updated, skipped, total: totalFetched };
        } catch (err) {
            logError('IGDB Import failed:', err);
            await SyncLogService.complete(syncLogId, {
                status: 'error',
                errors: [String(err)],
            });
            throw err;
        }
    }

    /**
     * On-demand search: queries IGDB for a game by name, auto-inserts if found.
     * Used when a user searches for a game not in the catalogue.
     */
    static async searchAndImport(query: string): Promise<{
        found: number;
        imported: number;
    }> {
        const games = await this.igdbRequest<IGDBGame>('games', `
            fields name, slug, url, summary, first_release_date, platforms,
                   genres, themes, cover.image_id, rating, total_rating;
            search "${query.replace(/"/g, '')}";
            where platforms = (${IGDB_TARGET_PLATFORMS.join(',')})
                & game_type = 0;
            limit 10;
        `);

        let imported = 0;
        for (const game of games) {
            const platforms = (game.platforms || [])
                .map((pid: number) => IGDB_PLATFORM_MAP[pid])
                .filter((p): p is string => !!p);

            if (platforms.length === 0) continue;

            const isArcade = game.platforms?.includes(52);
            const input: GlobalGameInput = {
                name: game.name,
                type: isArcade ? 'arcade' : 'video_game',
                platforms,
                igdb_id: game.id,
                external_url: game.url,
                description: game.summary,
                source_rating: game.total_rating || game.rating,
                imported_from: 'igdb',
                status: 'approved', // Auto-approved since authoritative source
            };

            const result = await GlobalGameService.upsert(input);
            if (result.action === 'inserted') imported++;
        }

        return { found: games.length, imported };
    }
}
