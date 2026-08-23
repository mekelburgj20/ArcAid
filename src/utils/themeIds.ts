/**
 * Theme identity — BACKEND copy.
 *
 * Mirrored BYTE-IDENTICALLY below this header in
 * `admin-ui/src/lib/themeIds.ts` (frontend), locked by
 * `src/__tests__/themeIds-parity.test.ts`. Same contract as the
 * `scoreProvenance.ts` pair: extend, never fork. The module is deliberately
 * dependency-free so the two copies can be literally identical.
 */
// ─── MIRRORED REGION BEGINS ────────────────────────────────────────────────

/**
 * Every theme the app ships, in PICKER order: darks first, lights last.
 * `dark` is the no-class default (its values are the `@theme` block in
 * admin-ui/src/index.css); the other fourteen are `.theme-<id>` classes.
 */
export const THEME_IDS = [
    'dark',
    'midnight',
    'graphite',
    'nordic',
    'plasma',
    'synthwave',
    'ember',
    'forest',
    'backglass',
    'retro',
    'silverball',
    'contrast',
    'light',
    'arctic',
    'paper',
    'speegle',
] as const;

export type ThemeId = typeof THEME_IDS[number];

/**
 * The eleven ids retired in v2.133.0, each pointing at the survivor closest to
 * what it actually rendered.
 *
 * Stored theme ids live in four places — `game_room_settings.UI_THEME`,
 * `user_preferences.ui_theme`, the `roomThemes` map inside
 * `user_preferences.scoreboard_prefs`, and a handful of localStorage mirrors —
 * and migration 162 rewrites the first three. The map still has to exist at
 * RUNTIME because localStorage is not migratable: a viewer whose browser holds
 * `arcaid-theme-personal=cyberpunk` must land on Synthwave rather than on a
 * `.theme-cyberpunk` class no stylesheet defines any more (which paints the
 * default dark and silently loses their choice).
 *
 * Rationale for the pairings, in one line each:
 *   coffee    -> paper      the warm off-white light theme, redrawn
 *   crt-green -> retro      both are the phosphor-green terminal; retro is nicer
 *   marquee   -> dark       a white-glow near-black; the default is the same idea
 *   cabinet   -> dark       primary accents on black; the default, less crude
 *   ocean     -> midnight   cool blues on deep navy
 *   invaders  -> forest     green-accented black
 *   playfield -> forest     the "green felt" theme was green-on-black anyway
 *   wizard    -> plasma     purple-violet with magenta accents
 *   cyberpunk -> synthwave  hot pink on violet-black, done properly
 *   sunset    -> ember      warm orange/amber on a dark warm ground
 *   minimal   -> graphite   neutral monochrome with one cool accent
 */
export const LEGACY_THEME_MAP: Record<string, ThemeId> = {
    coffee: 'paper',
    'crt-green': 'retro',
    marquee: 'dark',
    cabinet: 'dark',
    ocean: 'midnight',
    invaders: 'forest',
    playfield: 'forest',
    wizard: 'plasma',
    cyberpunk: 'synthwave',
    sunset: 'ember',
    minimal: 'graphite',
};

/** True for a live theme id. Retired ids are NOT theme ids — they map. */
export function isThemeId(value: unknown): value is ThemeId {
    return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value);
}

/**
 * The ONE read-time shim. Every place a theme id is read back from storage
 * (localStorage mirrors, `/me/preferences`, the portal, the roomThemes map,
 * a room's `UI_THEME`) must funnel through this, or a stale id reaches
 * `<html>` as a class that no longer exists.
 *
 * Returns `null` for absent/unknown values so callers can tell "no choice"
 * from "a choice"; `normalizeThemeIdOr` supplies a fallback where the caller
 * needs a concrete theme.
 */
export function normalizeThemeId(raw: unknown): ThemeId | null {
    if (typeof raw !== 'string') return null;
    const id = raw.trim();
    if (isThemeId(id)) return id;
    return LEGACY_THEME_MAP[id] ?? null;
}

/** `normalizeThemeId` with a fallback, for the slots that must resolve. */
export function normalizeThemeIdOr(raw: unknown, fallback: ThemeId = 'dark'): ThemeId {
    return normalizeThemeId(raw) ?? fallback;
}

// ─── MIRRORED REGION ENDS ──────────────────────────────────────────────────
