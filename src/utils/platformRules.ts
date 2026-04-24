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
 * Checks if a game's platforms satisfy a tournament's platform rules.
 * Shared between Discord commands and API endpoints.
 */
export function passesplatformRules(
    gamePlatforms: string[],
    rules: { required: string[]; excluded: string[] }
): boolean {
    const upper = gamePlatforms.map(p => p.toUpperCase());

    if (rules.required.length > 0) {
        const hasRequired = rules.required.some(rp => upper.includes(rp.toUpperCase()));
        if (!hasRequired) return false;
    }

    if (rules.excluded.length > 0) {
        const hasExcluded = rules.excluded.some(ep => upper.includes(ep.toUpperCase()));
        if (hasExcluded) return false;
    }

    return true;
}
