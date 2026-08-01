import { logWarn } from './logger.js';

/**
 * The parsed shape of `tournaments.platform_rules`.
 *
 * Flat, single-namespace (legacy platform ids) as of ADR 0016 P2 Section 1 —
 * the two-axis engine/device shape arrives in Section 2, and lands HERE, once,
 * rather than at ten call sites.
 */
export interface TournamentRules {
    required: string[];
    excluded: string[];
    restrictedText?: string;
}

/**
 * Either the tournament row itself (anything carrying `platform_rules`, and
 * ideally `id` so a warning can name it) or the raw JSON string.
 */
export type TournamentRulesSource =
    | string
    | null
    | undefined
    | { id?: string | null; platform_rules?: string | null };

function emptyRules(): TournamentRules {
    return { required: [], excluded: [] };
}

function asStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * THE parser for `tournaments.platform_rules`. Every runtime read goes through
 * here (ADR 0016 P2, Section 1).
 *
 * Before this existed the blob was parsed at ten independent sites, eight of
 * which swallowed a malformed value into `{}` — and `{}` means *a tournament
 * that restricts nothing*. So a shape change that tripped any one site degraded
 * that path to wide-open, in production, with nothing in the logs. Degrading is
 * still the right behaviour (a bad rules blob must not take a tournament down);
 * degrading *invisibly* is not, hence the warning.
 *
 * Malformed input — unparseable JSON, or valid JSON that isn't an object —
 * logs a WARN naming the tournament and returns empty rules. A missing/empty
 * blob is the normal "no rules" case and is silent. `required`/`excluded`
 * coerce to string arrays defensively: a stored `"required": "vpx"` used to
 * reach `passesplatformRules` as a string and throw on `.some`.
 *
 * NOTE — this is for RUNTIME reads only. Migrations that rewrite stored rows
 * (database.ts's 101, platformTaxonomyExpansion's 083/089) deliberately keep
 * their own raw `JSON.parse`: a migration must be a frozen transform of the
 * shape that existed when it was written, and must not change what it persists
 * when this parser evolves.
 */
export function parseTournamentRules(
    source: TournamentRulesSource,
    tournamentId?: string | null,
): TournamentRules {
    const row = typeof source === 'object' && source !== null ? source : null;
    const raw = row ? row.platform_rules ?? null : typeof source === 'string' ? source : null;
    const id: string = tournamentId || row?.id || '(unknown)';

    if (!raw) return emptyRules();

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        logWarn(
            `platform_rules is not valid JSON for tournament ${id} — degrading to no rules ` +
            `(this tournament will restrict nothing until the value is fixed).`,
        );
        return emptyRules();
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        logWarn(
            `platform_rules is not a JSON object for tournament ${id} — degrading to no rules ` +
            `(this tournament will restrict nothing until the value is fixed).`,
        );
        return emptyRules();
    }

    const obj = parsed as Record<string, unknown>;
    const rules: TournamentRules = {
        required: asStringArray(obj.required),
        excluded: asStringArray(obj.excluded),
    };
    if (typeof obj.restrictedText === 'string') rules.restrictedText = obj.restrictedText;
    return rules;
}

/**
 * Parses a platforms value (JSON array or comma-separated string) into a string array.
 * Shared between all platform-reading code paths.
 */
export function parsePlatformsList(raw: string): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.filter(Boolean);
    } catch {}
    return raw.split(',').map(p => p.trim()).filter(Boolean);
}

/**
 * v2.4.0: returns the effective platforms for a game in a room as the union of
 * the shared library platforms and the per-room custom platforms (stored on
 * `game_room_game_library.custom_platforms`). De-duplicated case-insensitively
 * while preserving the first-seen casing. Use this instead of
 * `parsePlatformsList` wherever a room context is available.
 */
export function mergeEffectivePlatforms(
    libraryRaw: string | null | undefined,
    roomCustomRaw: string | null | undefined,
): string[] {
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const raw of [libraryRaw, roomCustomRaw]) {
        if (!raw) continue;
        for (const p of parsePlatformsList(raw)) {
            const key = p.toUpperCase();
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(p);
        }
    }
    return merged;
}

/**
 * Returns the subset of `gamePlatforms` a player can pick from when submitting
 * a score. Used by the SubmissionSheet picker and re-validated server-side at
 * every submit handler.
 *
 * Rules (as of v2.7.x — orthogonal-axes semantics):
 *   - If `tournamentRules` is undefined (freeplay / global submit / no active
 *     tournament for this game), return all of `gamePlatforms` unchanged.
 *   - Strip anything in `tournamentRules.excluded` ("Not allowed on" — the
 *     submission-level filter).
 *   - `tournamentRules.required` ("Must be available on") is INTENTIONALLY
 *     ignored here. Required is a *game-level* eligibility gate enforced by
 *     `passesplatformRules` — it decides which games qualify for a tournament,
 *     not which platforms can score in one. A game admitted under a Must rule
 *     is fully scorable on any of its catalogue platforms (modulo NotAllowed).
 *     E.g. WHO dunnit is on [vpx, vpxs, real, fx, fx_vr, atgames]; a tournament
 *     with Must=[atgames] still accepts vpx submissions for it.
 *
 * Comparison is case-insensitive so legacy stored mixed-case data still works.
 */
export function resolveSubmittablePlatforms(
    gamePlatforms: string[],
    tournamentRules?: { required: string[]; excluded: string[] } | null,
): string[] {
    if (!tournamentRules) return gamePlatforms;
    const excluded = tournamentRules.excluded ?? [];
    if (excluded.length === 0) return gamePlatforms;
    const excUpper = new Set(excluded.map(p => p.toUpperCase()));
    return gamePlatforms.filter(p => !excUpper.has(p.toUpperCase()));
}

/**
 * Game-level gate for tournament platform rules — decides whether a game
 * qualifies for a tournament. (Submission-level filtering is the job of
 * `resolveSubmittablePlatforms`.)
 *
 * Two orthogonal axes:
 *   - `required` ("Must be available on") is checked here: game must list at
 *     least one required platform. Empty `required` means any game qualifies.
 *   - `excluded` ("Not allowed on") is INTENTIONALLY ignored here — see ADR
 *     0006 + the JSDoc on `resolveSubmittablePlatforms` for rationale.
 *
 * Example: WHO dunnit is on [vpx, vpxs, real, atgames]. Tournament rule
 * `required = [atgames], excluded = [real]`:
 *   - `passesplatformRules`: TRUE (game has atgames → admissible)
 *   - `resolveSubmittablePlatforms`: [vpx, vpxs, atgames] (real stripped)
 */
export function passesplatformRules(
    gamePlatforms: string[],
    rules: { required: string[]; excluded: string[] }
): boolean {
    if (rules.required.length === 0) return true;
    const upper = gamePlatforms.map(p => p.toUpperCase());
    return rules.required.some(rp => upper.includes(rp.toUpperCase()));
}
