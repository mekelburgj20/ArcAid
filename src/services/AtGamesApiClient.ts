import axios from 'axios';
import { logInfo, logWarn } from '../utils/logger.js';

/**
 * AtGames public catalogue API (atgames.net) — unauthenticated JSON.
 *
 * Replaces the community Google Sheet the AtGames importer used to read. The
 * sheet was a hand-maintained list of names; this is AtGames' own catalogue,
 * and it carries a STABLE GAME ID, which is the whole point: with an id the
 * importer deduplicates on hierarchy step 1 (external id) instead of step 4
 * (fuzzy name), and a re-sync lands on the row it created last time.
 *
 * Contract, reverse-engineered from an owner-captured HAR and re-verified live
 * 2026-08-16:
 *
 *   GET /api/leaderboards/games
 *       ?catalog=titles&keyword=&order=&prefix=&rule=&table=&table_rule=
 *       &after=<cursor>
 *   → { games: [ …8 rows… ], nextAfter: "<game_id>" }
 *
 * Pagination is CURSOR-based: feed `nextAfter` back as `after=`, starting
 * empty. `limit`, `page` and `offset` are silently ignored — the page size is
 * fixed at 8, so a full walk is ~50 requests for the current 404-row
 * catalogue. `catalog`, `rule`, `table` and `table_rule` are ALSO ignored
 * (tested: `catalog=pinball` returns the identical first page as
 * `catalog=titles`); they are sent only because the site sends them. `keyword`
 * and `prefix` do work, and are the only real filters.
 */

const API_BASE = 'https://atgames.net';
const GAMES_PATH = '/api/leaderboards/games';
const HARDWARE_PATH = '/api/arcadenet/d2d/arcade/v2/hardware_models';

/**
 * Pinball-only cabinet model codes.
 *
 * The feed mixes pinball tables and arcade ROMs — its first row is "8 Eyes" —
 * and NOTHING in a row says which it is. `hardware_models` gets there because
 * these four cabinets are pinball machines that run nothing else, whereas the
 * shared codes are useless as a discriminator (an arcade ROM lists HA8819
 * "Legends Pinball" too, since the pinball cabinet also plays arcade games).
 *
 * Verified against the full 404-row catalogue: 283 classified pinball, 121
 * arcade, no arcade row containing a pinball-ish title and no pinball row in
 * the arcade set. The API's own naming corroborates it — it disambiguates
 * collisions as "Arkanoid (Pinball)" vs "Asteroids® (Arcade)".
 *
 * If AtGames ships a new pinball cabinet, ADD ITS CODE HERE or its exclusive
 * tables silently stop importing. `fetchHardwareModels` logs unknown codes on
 * every sync so the omission surfaces rather than rotting.
 */
const PINBALL_ONLY_MODELS = new Set([
    'RK9920',   // Legends Pinball 4K
    'HA9919',   // Legends Pinball HDP
    'HA8818',   // Legends Pinball Micro
    'HA8819C',  // Legends Pinball ES
]);

/**
 * Cabinet model code → the catalogue `features` tag for that variant.
 *
 * This replaces the hand-maintained columns H/I/J/K of the retired sheet, which
 * encoded the same availability by hand and drifted. Availability stays in
 * `features` (a catalogue fact), NOT in `platforms` — it isn't a player
 * eligibility distinction, so it must not reach the tournament rule picker.
 */
const CABINET_FEATURE_BY_MODEL: Record<string, string> = {
    HA8819: 'atgames_hd',       // Legends Pinball (2020)
    HA8819C: 'atgames_hd',      // Legends Pinball ES
    HA8818: 'atgames_micro',    // Legends Pinball Micro
    RK9920: 'atgames_4k',       // Legends Pinball 4K
    HA9919: 'atgames_hdp',      // Legends Pinball HDP
    HA8800: 'atgames_alu',      // Legends Ultimate
    HA8801: 'atgames_alu',      // Legends Ultimate v1.1
    RK9900: 'atgames_alu',      // Legends Ultimate 4K
    HA8810: 'atgames_mini',     // Legends Ultimate Mini
    HA2802: 'atgames_gamer',    // Legends Gamer Pro
    HA2812: 'atgames_gamer',    // Legends Gamer Mini
    HA2811: 'atgames_core',     // Legends Core
    HA2819: 'atgames_core',     // Legends Core Max
    HAB800: 'atgames_core',     // Legends Connect
};

export interface AtGamesGame {
    game_id: number;
    name: string;
    hardware_models: string[];
    internal_number: string | null;
    boxart: string | null;
    boxart_480w: string | null;
}

interface GamesResponse {
    games: AtGamesGame[];
    nextAfter?: string | null;
}

interface HardwareModel {
    name: string;
    display_name: string;
    series_name: string | null;
}

export class AtGamesApiClient {
    /**
     * Walks the whole catalogue via the cursor.
     *
     * `maxRequests` is a runaway guard, not a limit anyone should hit: the
     * catalogue is ~50 pages today and the walk stops on an empty page or a
     * missing cursor. It also de-duplicates by `game_id`, because a cursor that
     * ever repeats itself would otherwise loop forever.
     */
    static async fetchAllGames(opts?: { maxRequests?: number }): Promise<AtGamesGame[]> {
        const maxRequests = opts?.maxRequests ?? 400;
        const games: AtGamesGame[] = [];
        const seen = new Set<number>();
        let after = '';
        let requests = 0;

        while (requests < maxRequests) {
            const res = await axios.get<GamesResponse>(`${API_BASE}${GAMES_PATH}`, {
                params: {
                    catalog: 'titles', keyword: '', order: '', prefix: '',
                    rule: '', table: '', table_rule: '', after,
                },
                timeout: 30000,
            });
            requests++;

            const batch = res.data?.games ?? [];
            if (batch.length === 0) break;

            let fresh = 0;
            for (const g of batch) {
                if (seen.has(g.game_id)) continue;
                seen.add(g.game_id);
                games.push(g);
                fresh++;
            }
            // A page that adds nothing new means the cursor stopped advancing.
            // Bail rather than spin until maxRequests.
            if (fresh === 0) break;

            const next = res.data?.nextAfter;
            if (!next) break;
            after = String(next);
        }

        if (requests >= maxRequests) {
            logWarn(`AtGames API: stopped at the ${maxRequests}-request guard with ${games.length} games — the catalogue may be truncated`);
        }
        logInfo(`AtGames API: ${games.length} games in ${requests} requests`);
        return games;
    }

    /**
     * Fetches the cabinet model table and warns about codes this file doesn't
     * know. Purely diagnostic — the mapping used at import time is the static
     * one above — but it is what turns "AtGames shipped a new cabinet" from a
     * silent coverage hole into a log line.
     */
    static async fetchHardwareModels(): Promise<HardwareModel[]> {
        try {
            const res = await axios.get<HardwareModel[]>(`${API_BASE}${HARDWARE_PATH}`, { timeout: 30000 });
            const models = res.data ?? [];
            const unknown = models
                .map(m => m.name)
                .filter(n => n && n !== 'STREAMING' && n !== 'FB8660' && !(n in CABINET_FEATURE_BY_MODEL));
            if (unknown.length > 0) {
                logWarn(
                    `AtGames API: unmapped cabinet model(s) ${unknown.join(', ')} — ` +
                    `add them to CABINET_FEATURE_BY_MODEL (and PINBALL_ONLY_MODELS if pinball-exclusive) in AtGamesApiClient.ts`,
                );
            }
            return models;
        } catch (err) {
            logWarn(`AtGames API: hardware model fetch failed (${err instanceof Error ? err.message : String(err)}) — cabinet mapping falls back to the static table`);
            return [];
        }
    }

    /** True when the row's cabinets identify it as a pinball table. */
    static isPinball(game: AtGamesGame): boolean {
        return (game.hardware_models || []).some(m => PINBALL_ONLY_MODELS.has(m));
    }

    /** Cabinet availability features for a row, deduplicated. */
    static cabinetFeatures(game: AtGamesGame): string[] {
        const out = new Set<string>();
        for (const model of game.hardware_models || []) {
            const feature = CABINET_FEATURE_BY_MODEL[model];
            if (feature) out.add(feature);
        }
        return [...out];
    }
}
