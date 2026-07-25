/**
 * Shared helpers for the room `REQUIRE_DISCORD_LOGIN` setting's 3-value
 * domain (v2.35.0, Google login):
 *   - 'false'   — guests allowed, no login required.
 *   - 'true'    — any logged-in provider accepted (Discord OR Google).
 *   - 'discord' — provider must be Discord specifically.
 *
 * Every FE site that previously did `config.REQUIRE_DISCORD_LOGIN === 'true'`
 * to decide "does this room require login" must also treat 'discord' as
 * requiring login — these two tiny helpers centralize that so no call site
 * silently regresses when a room switches to Discord-only mode.
 */

/** True when the room requires SOME login (either 'true' or 'discord'). */
export function requiresAnyLogin(value: string | undefined | null): boolean {
    return value === 'true' || value === 'discord';
}

/** True when the room requires Discord login SPECIFICALLY (not just any provider). */
export function requiresDiscordOnly(value: string | undefined | null): boolean {
    return value === 'discord';
}
