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
