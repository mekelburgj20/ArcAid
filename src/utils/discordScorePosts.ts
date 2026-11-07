/**
 * Discord posts for top-N scores (v2.225.0, E13).
 *
 * Two `game_room_settings` keys, edited on Room Settings -> Discord ->
 * "Post top scores to Discord" (`components/DiscordScorePosts.tsx`):
 *
 *   DISCORD_SCORE_POSTS_ENABLED  'true' = on; absent / anything else = off
 *   DISCORD_SCORE_POSTS_TOP_N    integer 1-50; absent / invalid = 10
 *
 * Both are read ONLY through the parsers below (the settings POST
 * re-serializes the top-N value through `serializeScorePostsTopN`).
 */

export const DISCORD_SCORE_POSTS_ENABLED_KEY = 'DISCORD_SCORE_POSTS_ENABLED';
export const DISCORD_SCORE_POSTS_TOP_N_KEY = 'DISCORD_SCORE_POSTS_TOP_N';

export const SCORE_POSTS_TOP_N_DEFAULT = 10;
export const SCORE_POSTS_TOP_N_MIN = 1;
export const SCORE_POSTS_TOP_N_MAX = 50;

/** Absent = off: existing rooms stay quiet until an admin opts in. */
export function parseScorePostsEnabled(raw: string | null | undefined): boolean {
    return typeof raw === 'string' && raw.trim().toLowerCase() === 'true';
}

/**
 * The top-N cutoff: a whole number clamped to 1-50; absent, empty or
 * non-numeric is the default 10. Never throws.
 */
export function parseScorePostsTopN(raw: string | number | null | undefined): number {
    if (raw === null || raw === undefined) return SCORE_POSTS_TOP_N_DEFAULT;
    const text = String(raw).trim();
    if (text === '') return SCORE_POSTS_TOP_N_DEFAULT;
    const n = Number(text);
    if (!Number.isFinite(n)) return SCORE_POSTS_TOP_N_DEFAULT;
    return Math.min(SCORE_POSTS_TOP_N_MAX, Math.max(SCORE_POSTS_TOP_N_MIN, Math.floor(n)));
}

/** What the settings POST stores: '' (row removed) for blank, else the parsed value. */
export function serializeScorePostsTopN(raw: string | null | undefined): string {
    if (raw === null || raw === undefined || String(raw).trim() === '') return '';
    return String(parseScorePostsTopN(raw));
}
