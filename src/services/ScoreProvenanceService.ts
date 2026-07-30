import { getDatabase } from '../database/database.js';
import { parsePlatformsList, resolveSubmittablePlatforms } from '../utils/platformRules.js';
import { RoomGameTagsService } from './RoomGameTagsService.js';
import {
    UNKNOWN,
    deriveLegacyPlatform,
    devicesForEngineAndPlatforms,
    enginesFromLegacyPlatforms,
    isCanonicalDevice,
    isCanonicalEngine,
    isEngineDeviceCompatible,
    normalizeProvenanceToken,
    getEngineDisplay,
    getDeviceDisplay,
    DEVICE_LEGACY_PLATFORM,
} from '../utils/scoreProvenance.js';

/**
 * ADR 0016 Phase 1 — the ONE server-side authority for "may this score claim
 * this (engine, device) pair?".
 *
 * Replaces `rooms.ts`'s `ensurePlatformAllowed`, which returned `null` to mean
 * "allowed". That shape made a partially-validated result indistinguishable
 * from success: any early return added later would silently pass. The result
 * here is a discriminated union — an unvalidated axis cannot fall through as
 * success because callers can only reach the values via `ok: true`.
 *
 * P1 keeps the catalogue on legacy platform ids (converting it is a later
 * phase), so the allowed ENGINE set is derived from the game's submittable
 * platform list and the allowed DEVICE set from the engine's compatibility map.
 * The resolved legacy `platform` is returned alongside because every read path
 * still consumes that column.
 */

export interface ProvenanceScope {
    /** Game's effective platforms: catalogue ∪ room tags (pre-rule). */
    effective: string[];
    /** effective − tournament `excluded` (ADR 0009's submission-level filter). */
    submittable: string[];
    rules: { required: string[]; excluded: string[] } | null;
}

export type ProvenanceValidation =
    | { ok: true; engine: string; device: string; platform: string | null }
    | { ok: false; error: string };

export class ScoreProvenanceService {
    /**
     * Room-scoped resolution (tournament submit + freeplay). Effective set =
     * catalogue platforms ∪ per-room tags (ADR 0008); an ACTIVE tournament for
     * the game narrows it via `platform_rules`.
     */
    static async resolveForRoomGame(roomId: string, gameName: string): Promise<ProvenanceScope> {
        const db = await getDatabase();
        const gg = await db.get(
            'SELECT platforms FROM global_games WHERE LOWER(name) = LOWER(?) AND status = ? LIMIT 1',
            gameName, 'approved',
        );
        const cataloguePlatforms = gg ? parsePlatformsList(gg.platforms || '[]') : [];
        const roomTags = await RoomGameTagsService.getTagsForGameName(roomId, gameName);
        const effective = Array.from(new Set([...cataloguePlatforms, ...roomTags]));

        const activeGame = await db.get(`
            SELECT t.platform_rules FROM games g
            JOIN tournaments t ON t.id = g.tournament_id
            WHERE LOWER(g.name) = LOWER(?) AND t.game_room_id = ? AND g.status = 'ACTIVE'
            LIMIT 1
        `, gameName, roomId) as { platform_rules: string | null } | undefined;

        const rules = ScoreProvenanceService.parseRules(activeGame?.platform_rules ?? null);
        return { effective, submittable: resolveSubmittablePlatforms(effective, rules), rules };
    }

    /** Global-submit resolution — catalogue platforms verbatim, no rules. */
    static async resolveForGlobalGame(globalGameId: string): Promise<ProvenanceScope | null> {
        const db = await getDatabase();
        const game = await db.get(
            'SELECT platforms FROM global_games WHERE id = ? AND status = ? LIMIT 1',
            globalGameId, 'approved',
        );
        if (!game) return null;
        const effective = parsePlatformsList(game.platforms || '[]');
        return { effective, submittable: effective, rules: null };
    }

    /**
     * Resolution for a tournament game addressed by tournament id (the Discord
     * `/submit-score` shape). Unions room tags — pre-v2.53.0 the Discord path
     * read `global_games.platforms` alone while the web path unioned tags, so a
     * room-tagged platform was submittable on web and rejected in Discord.
     */
    static async resolveForTournamentGame(tournamentId: string, gameName: string): Promise<ProvenanceScope> {
        const db = await getDatabase();
        const tournament = await db.get(
            'SELECT game_room_id, platform_rules FROM tournaments WHERE id = ?',
            tournamentId,
        ) as { game_room_id: string | null; platform_rules: string | null } | undefined;

        const gg = await db.get(
            'SELECT platforms FROM global_games WHERE LOWER(name) = LOWER(?) AND status = ? LIMIT 1',
            gameName, 'approved',
        );
        const cataloguePlatforms = gg ? parsePlatformsList(gg.platforms || '[]') : [];
        const roomTags = tournament?.game_room_id
            ? await RoomGameTagsService.getTagsForGameName(tournament.game_room_id, gameName)
            : [];
        const effective = Array.from(new Set([...cataloguePlatforms, ...roomTags]));
        const rules = ScoreProvenanceService.parseRules(tournament?.platform_rules ?? null);
        return { effective, submittable: resolveSubmittablePlatforms(effective, rules), rules };
    }

    /** Engine options a player may choose from for this scope. */
    static enginesFor(scope: ProvenanceScope): string[] {
        return enginesFromLegacyPlatforms(scope.submittable);
    }

    /** Device options for a chosen engine within this scope. */
    static devicesFor(scope: ProvenanceScope, engine: string): string[] {
        return devicesForEngineAndPlatforms(engine, scope.submittable);
    }

    /**
     * Validate a submitted (engine, device) pair against a resolved scope.
     *
     * Both axes are checked explicitly; there is no path that returns `ok: true`
     * without having decided on BOTH. `'unknown'` is accepted on either axis —
     * it is the explicit "no claim" value that sync writers use, and refusing it
     * would make the column lie rather than admit ignorance.
     */
    static validate(scope: ProvenanceScope, rawEngine: unknown, rawDevice: unknown): ProvenanceValidation {
        const engine = normalizeProvenanceToken(typeof rawEngine === 'string' ? rawEngine : '');
        const device = normalizeProvenanceToken(typeof rawDevice === 'string' ? rawDevice : '');

        if (!engine) return { ok: false, error: 'engine is required.' };
        if (!device) return { ok: false, error: 'device is required.' };

        // --- Engine axis ---
        if (engine !== UNKNOWN) {
            if (!isCanonicalEngine(engine)) {
                return { ok: false, error: `Unknown engine "${engine}".` };
            }
            const allowedEngines = ScoreProvenanceService.enginesFor(scope);
            if (allowedEngines.length === 0) {
                return { ok: false, error: 'No engines are configured for this game.' };
            }
            if (!allowedEngines.includes(engine)) {
                return {
                    ok: false,
                    error: `${getEngineDisplay(engine)} is not available for this game/tournament. Allowed: ${allowedEngines.map(getEngineDisplay).join(', ')}`,
                };
            }
        } else if (scope.submittable.length === 0) {
            return { ok: false, error: 'No engines are configured for this game.' };
        }

        // --- Device axis ---
        if (device !== UNKNOWN) {
            if (!isCanonicalDevice(device)) {
                return { ok: false, error: `Unknown device "${device}".` };
            }
            if (!isEngineDeviceCompatible(engine, device)) {
                return {
                    ok: false,
                    error: `${getDeviceDisplay(device)} can't run ${getEngineDisplay(engine)}.`,
                };
            }
            // P1 keeps ADR 0009's `excluded` enforcement alive on the device
            // axis: a tournament that excludes the `atgames` platform must still
            // refuse an AtGames-device score. Real device rules arrive in P2.
            const deviceLegacy = DEVICE_LEGACY_PLATFORM[device];
            const excluded = (scope.rules?.excluded ?? []).map(p => normalizeProvenanceToken(p));
            if (deviceLegacy && excluded.includes(deviceLegacy)) {
                return {
                    ok: false,
                    error: `${getDeviceDisplay(device)} is not allowed for this tournament.`,
                };
            }
        }

        // --- Legacy platform, for the read paths that still use it ---
        const platform = deriveLegacyPlatform(engine, device, scope.effective);
        if (platform) {
            const submittableLower = scope.submittable.map(p => normalizeProvenanceToken(p));
            const excluded = (scope.rules?.excluded ?? []).map(p => normalizeProvenanceToken(p));
            if (excluded.includes(platform) && !submittableLower.includes(platform)) {
                return {
                    ok: false,
                    error: `${getEngineDisplay(engine)} is not allowed for this tournament.`,
                };
            }
        }

        return { ok: true, engine, device, platform };
    }

    /** Convenience: resolve a room-scoped scope and validate in one call. */
    static async validateForRoomGame(
        roomId: string, gameName: string, engine: unknown, device: unknown,
    ): Promise<ProvenanceValidation> {
        const scope = await ScoreProvenanceService.resolveForRoomGame(roomId, gameName);
        if (scope.effective.length === 0) {
            return { ok: false, error: 'No platforms are configured for this game.' };
        }
        return ScoreProvenanceService.validate(scope, engine, device);
    }

    /** Convenience: resolve a global-catalogue scope and validate in one call. */
    static async validateForGlobalGame(
        globalGameId: string, engine: unknown, device: unknown,
    ): Promise<ProvenanceValidation> {
        const scope = await ScoreProvenanceService.resolveForGlobalGame(globalGameId);
        if (!scope) return { ok: false, error: 'Game not found' };
        if (scope.effective.length === 0) {
            return { ok: false, error: 'No platforms are configured for this game.' };
        }
        return ScoreProvenanceService.validate(scope, engine, device);
    }

    private static parseRules(raw: string | null): { required: string[]; excluded: string[] } | null {
        if (!raw) return null;
        try {
            const parsed = JSON.parse(raw);
            return {
                required: Array.isArray(parsed.required) ? parsed.required : [],
                excluded: Array.isArray(parsed.excluded) ? parsed.excluded : [],
            };
        } catch {
            return null;
        }
    }
}
