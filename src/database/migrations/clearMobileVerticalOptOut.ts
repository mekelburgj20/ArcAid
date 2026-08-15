import type { Database } from 'sqlite';

/**
 * Migration 145 — retire the stored `SCOREBOARD_MOBILE_VERTICAL = 'false'`
 * opt-outs so every room falls back to the ON default.
 *
 * Owner call, 2026-08-15: "'Mobile Vertical Scroll' should be enabled by
 * default on all game rooms and display settings (even players personal
 * settings)." The renderer has always defaulted it on (`!== 'false'` in
 * `deriveScoreboardConfig`), so the DEFAULT needed no change — but a room that
 * had the value written as `'false'` at some point stayed opted out, which is
 * what the owner was looking at when they reported it as not defaulting on.
 *
 * WHY DELETE RATHER THAN SET 'true': absence is the state that tracks the
 * product default. Writing `'true'` would pin these rooms to today's answer
 * and silently strand them if the default ever moves again.
 *
 * This DOES discard an explicit admin choice, which is normally not something
 * a migration should do — it is here because the owner asked for the setting
 * to be on everywhere, and because the choice is one toggle to restore. Rooms
 * that genuinely want the desktop layout on phones can turn it straight back
 * off; the next run of this migration will not touch them, because migrations
 * run once by name.
 *
 * Viewer-level overrides live in `user_preferences.scoreboard_prefs` (a JSON
 * blob, not a key/value row) and are deliberately NOT rewritten here: a
 * viewer preference is that person's own choice about their own device, not
 * room configuration. The preferences UI drew the switch in the wrong position
 * for these keys until 2026-08-15, and that FE fix is what makes a viewer's
 * stored value trustworthy from here on.
 */
export async function clearMobileVerticalOptOut(db: Database): Promise<number> {
    const result = await db.run(
        `DELETE FROM game_room_settings
         WHERE key = 'SCOREBOARD_MOBILE_VERTICAL' AND LOWER(value) = 'false'`,
    );
    return result.changes ?? 0;
}
