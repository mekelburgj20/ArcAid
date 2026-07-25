/**
 * Identity-provider helpers for the two-IdP model (Discord + Google).
 *
 * Google users are namespaced as `google:<sub>` (OIDC subject claim) and flow
 * through every existing `discord_user_id`-shaped column/claim unchanged —
 * same precedent as the `iscored:<username>` synthetic IDs used elsewhere.
 * Discord user IDs remain bare snowflakes (17-20 digit strings), matching
 * every existing regex check in the codebase.
 *
 * ABSENT provider information (e.g. a JWT with no `provider` claim, minted
 * before Google login existed) means legacy = discord. Callers deriving a
 * provider from a bare user-id string should treat anything that isn't
 * `google:`-prefixed as discord (see `providerOfUserId`).
 */

export type IdentityProvider = 'discord' | 'google';

const DISCORD_ID_RE = /^\d{17,20}$/;
const GOOGLE_ID_PREFIX = 'google:';

/** True for a bare Discord snowflake (17-20 digits). */
export function isDiscordUserId(id: string): boolean {
    return typeof id === 'string' && DISCORD_ID_RE.test(id);
}

/** True for a namespaced Google subject id (`google:<sub>`). */
export function isGoogleUserId(id: string): boolean {
    return typeof id === 'string' && id.startsWith(GOOGLE_ID_PREFIX);
}

/**
 * True when `id` looks like an identity key (Discord snowflake OR
 * `google:<sub>`) rather than a username/handle that needs resolving.
 * Used at dispatch sites that branch on "is this already an ID".
 */
export function isProviderUserId(id: string): boolean {
    return isDiscordUserId(id) || isGoogleUserId(id);
}

/**
 * Prefix-based provider derivation for a raw user-id string. Defaults to
 * 'discord' for anything not `google:`-prefixed — this is the "absent =
 * legacy = discord" rule applied to bare ids (as opposed to JWT payloads,
 * which carry their own `provider` claim).
 */
export function providerOfUserId(id: string): IdentityProvider {
    return isGoogleUserId(id) ? 'google' : 'discord';
}
