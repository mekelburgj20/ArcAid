import fs from 'fs';
import path from 'path';
import { GlobalGameService, GlobalGame, GlobalGameInput } from './GlobalGameService.js';
import { RAApiClient, RA_GAME_URL_BASE, scrubRaSecrets } from './RAApiClient.js';
import { RA_CONSOLE_ENGINE_MAP, raCatalogueType } from '../utils/scoreProvenance.js';
import { classifyGame, ScoreEligibility } from '../utils/raClassifier.js';
import { logInfo, logWarn } from '../utils/logger.js';

/**
 * One-game realtime import from RetroAchievements (contract §3).
 *
 * The demand-driven half of the catalogue strategy: a room admin, a
 * super-admin or a player selects a game from the RA master-list search, and
 * that selection IS the approval gate. The row lands `status='approved'` and
 * is immediately usable — the library/add-game flows read approved catalogue
 * rows directly (ADR 0007) and the Global Scoreboard's prospective-category
 * logic gives it a claim card straight away.
 *
 * Synchronous by design. One game is 2-4 API calls plus 2 image fetches, well
 * inside a request timeout, and a player waiting to post a score wants the
 * game NOW — a 202-and-poll would be worse UX for no benefit.
 *
 * All three endpoints share this one path. Divergence between "the admin
 * import" and "the player import" is not possible because there is only one.
 */

/** Where rehosted RA artwork lands, relative to the repo root. */
const RA_IMAGE_DIR = ['data', 'catalogue-images', 'ra'];

/** Per-image timeout. A slow icon must never fail a game's import. */
const IMAGE_TIMEOUT_MS = 20_000;

export interface RAImportResult {
    action: 'inserted' | 'updated' | 'skipped';
    game: GlobalGame;
    raGameId: number;
    scoreEligibility: ScoreEligibility;
    leaderboardCount: number;
}

export class RAImportService {
    /**
     * In-flight imports, keyed by RA game id.
     *
     * Double-clicking Import fires two requests a few ms apart. Without this
     * they both miss the `ra_id` lookup (neither has committed yet) and race
     * to INSERT, where the partial-UNIQUE index makes one of them fail with a
     * constraint error the user sees as "import failed" — for an import that
     * in fact succeeded. Sharing the promise makes the second click a no-op
     * that returns the first click's answer.
     */
    private static inFlight = new Map<number, Promise<RAImportResult>>();

    static async importGame(
        raGameId: number,
        opts?: { importedBy?: string | null },
    ): Promise<RAImportResult> {
        const existing = RAImportService.inFlight.get(raGameId);
        if (existing) return existing;

        const run = RAImportService.runImport(raGameId, opts?.importedBy ?? null)
            .finally(() => { RAImportService.inFlight.delete(raGameId); });
        RAImportService.inFlight.set(raGameId, run);
        return run;
    }

    private static async runImport(
        raGameId: number,
        importedBy: string | null,
    ): Promise<RAImportResult> {
        const client = new RAApiClient();

        const game = await client.getGameExtended(raGameId);
        if (!game) {
            throw new RAGameNotFoundError(`RetroAchievements has no game with id ${raGameId}.`);
        }

        const engine = RA_CONSOLE_ENGINE_MAP[game.ConsoleID];
        const catalogueType = raCatalogueType(game.ConsoleID);
        if (!engine || !catalogueType) {
            // Reachable only if RA re-files a game onto a console we don't map
            // (the master list only ever offers mapped consoles). Refuse
            // rather than invent an engine — see RA_CONSOLE_ENGINE_MAP.
            throw new RAUnsupportedConsoleError(
                `RetroAchievements console ${game.ConsoleID} ` +
                `(${game.ConsoleName ?? 'unknown'}) is not mapped to an Arcaid engine, ` +
                `so "${game.Title}" cannot be imported.`,
            );
        }

        // Boards drive the eligibility verdict only. A failure here must not
        // fail the import: "we could not ask RA about leaderboards" and "RA
        // has no leaderboards" both land on `unknown`, which is explicitly not
        // a "no" (see raClassifier).
        let boards: Awaited<ReturnType<RAApiClient['getGameLeaderboards']>> = [];
        try {
            boards = await client.getGameLeaderboards(raGameId);
        } catch (err) {
            logWarn(
                `RA import: leaderboard lookup failed for "${game.Title}" (${raGameId}); ` +
                `eligibility will be recorded as unknown.`,
                scrubRaSecrets(String(err)),
            );
        }
        const scoreEligibility = classifyGame(boards);

        // Artwork, rehosted. Both are optional — a missing image is a cosmetic
        // gap, never a reason to refuse a game.
        const iconPath = await RAImportService.downloadImage(game.ImageIcon, raGameId, 'icon');
        const boxPath = await RAImportService.downloadImage(game.ImageBoxArt, raGameId, 'box');

        const input: GlobalGameInput = {
            name: game.Title,
            // Publisher first, Developer as the fallback — RA documents both
            // as frequently EMPTY, and `RAApiClient` already turned '' into
            // null, so an absent value stays a genuine NULL rather than
            // becoming an empty-string manufacturer that the dedup walk would
            // then treat as a populated field.
            manufacturer: game.Publisher ?? game.Developer ?? null,
            year: RAImportService.parseYear(game.Released),
            type: catalogueType.type,
            subtype: catalogueType.subtype,
            // Post-v2.62 `platforms` is an ENGINE list. It still goes through
            // `upsert`'s fold like every other importer's does — the fold is
            // idempotent on engine ids, so this is a no-op that keeps RA from
            // being the one importer that bypasses the single chokepoint.
            platforms: [engine],
            themes: game.Genre ? [game.Genre] : [],
            external_url: `${RA_GAME_URL_BASE}/${raGameId}`,
            image_url: RAApiClient.mediaUrl(game.ImageBoxArt ?? game.ImageIcon),
            local_image_path: boxPath ?? iconPath ?? null,
            wheel_image_path: iconPath ?? null,
            ra_id: raGameId,
            score_eligibility: scoreEligibility,
            ra_leaderboard_count: boards.length,
            ra_imported_by: importedBy,
            imported_from: 'ra',
            // Demand IS approval (contract §3). A bulk crawl is a proposal and
            // lands `pending`; a human picking this exact game out of a search
            // is the review step, so there is nothing left to queue.
            status: 'approved',
        };

        const result = await GlobalGameService.upsert(input);
        const row = await GlobalGameService.getById(result.id);
        if (!row) {
            throw new Error(`RA import: catalogue row ${result.id} vanished immediately after upsert.`);
        }

        logInfo(
            `RA import: "${game.Title}" (ra:${raGameId}, console ${game.ConsoleID} → ${engine}) ` +
            `${result.action}, ${boards.length} board(s), eligibility=${scoreEligibility}` +
            `${importedBy ? `, by ${importedBy}` : ''}.`,
        );

        return {
            action: result.action,
            game: row,
            raGameId,
            scoreEligibility,
            leaderboardCount: boards.length,
        };
    }

    /**
     * RA's `Released` is loose — '1986-06-01', '1986', 'June 1986' all occur.
     * Take the first plausible 4-digit year and ignore the rest; a wrong year
     * participates in the dedup walk's concrete-match tier, so guessing is
     * worse than leaving it null.
     */
    private static parseYear(released: string | null | undefined): number | null {
        const match = (released ?? '').match(/\b(1[89]\d{2}|20\d{2})\b/);
        if (!match) return null;
        const year = Number(match[1]);
        return Number.isFinite(year) ? year : null;
    }

    /**
     * Downloads one RA image into `data/catalogue-images/ra/`, returning the
     * repo-relative path or undefined.
     *
     * Mirrors the v2.65 image helpers: `existsSync` skip so a re-import costs
     * nothing, an `AbortSignal.timeout` so a stalled CDN cannot hold a
     * synchronous import open, and a logged (not swallowed) failure — a bare
     * `catch { return undefined }` is how a systematically broken image pass
     * produces zero artwork and not one line explaining why.
     */
    private static async downloadImage(
        imagePath: string | null | undefined,
        raGameId: number,
        kind: 'icon' | 'box',
    ): Promise<string | undefined> {
        const url = RAApiClient.mediaUrl(imagePath);
        if (!url) return undefined;

        const ext = (url.match(/\.(png|jpg|jpeg|webp|gif)(?:\?|$)/i)?.[1] ?? 'png').toLowerCase();
        const fileName = `${raGameId}-${kind}.${ext}`;
        const relPath = `${RA_IMAGE_DIR.join('/')}/${fileName}`;

        try {
            const dir = path.join(process.cwd(), ...RA_IMAGE_DIR);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            const filePath = path.join(dir, fileName);
            if (fs.existsSync(filePath)) return relPath;

            const resp = await fetch(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
            if (!resp.ok) {
                logWarn(`RA image download (${kind}) for game ${raGameId} returned ${resp.status}.`);
                return undefined;
            }

            fs.writeFileSync(filePath, Buffer.from(await resp.arrayBuffer()));
            return relPath;
        } catch (err) {
            logWarn(`RA image download (${kind}) failed for game ${raGameId}:`, err);
            return undefined;
        }
    }
}

/** RA has no such game — the caller answers 404, not 500. */
export class RAGameNotFoundError extends Error {}

/** The game's console has no Arcaid engine — the caller answers 422. */
export class RAUnsupportedConsoleError extends Error {}
