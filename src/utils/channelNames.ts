/**
 * G16 (owner 2026-11-07): Discord channel ids read as names in the activity
 * log. `DiscordClient` registers a gateway-cache lookup at construction, the
 * same way `registerGatewayChannelTypeLookup` works, so this module never
 * imports discord.js and code that never builds a client (tests, scripts)
 * simply gets the id back.
 */
let lookup: ((channelId: string) => string | null) | null = null;

export function registerGatewayChannelNameLookup(fn: ((channelId: string) => string | null) | null): void {
    lookup = fn;
}

const SNOWFLAKE = /^\d{15,22}$/;

/** `#name` when the bot can see the channel, otherwise the value unchanged. */
export function channelDisplayName(value: string): string {
    if (!SNOWFLAKE.test(value)) return value;
    try {
        const name = lookup?.(value) ?? null;
        return name ? `#${name}` : value;
    } catch {
        return value;
    }
}
