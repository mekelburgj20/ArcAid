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
