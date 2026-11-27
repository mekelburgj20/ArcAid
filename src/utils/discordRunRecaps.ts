/**
 * Discord posts for run recaps (B31.5).
 *
 * One `game_room_settings` key, edited on Room Settings -> Discord -> "Post run
 * recaps to Discord" (`components/DiscordRunRecapPosts.tsx`):
 *
 *   DISCORD_RUN_RECAPS_ENABLED  'true' = on; absent / anything else = off
 *
 * Read ONLY through `parseRunRecapsEnabled`.
 */

export const DISCORD_RUN_RECAPS_ENABLED_KEY = 'DISCORD_RUN_RECAPS_ENABLED';

/** Absent = off: existing rooms stay quiet until an admin opts in. */
export function parseRunRecapsEnabled(raw: string | null | undefined): boolean {
    return typeof raw === 'string' && raw.trim().toLowerCase() === 'true';
}
