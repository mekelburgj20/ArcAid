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
 * admin-ui/src/index.css, shown in the picker as "Arcaid"); the other ten are
 * `.theme-<id>` classes. v2.263.0 (G29) cut the list from sixteen to eleven.
 */
export const THEME_IDS = [
    'dark',
    'synthwave',
    'backglass',
    'forest',
    'nordic',
    'graphite',
    'retro',
    'contrast',
    'light',
    'paper',
    'speegle',
] as const;

export type ThemeId = typeof THEME_IDS[number];

/**
 * The sixteen retired ids, each pointing at the survivor closest to what it
 * actually rendered: eleven retired in v2.133.0 and five in v2.263.0 (G29).
 *
 * Stored theme ids live in four places — `game_room_settings.UI_THEME`,
 * `user_preferences.ui_theme`, the `roomThemes` map inside
 * `user_preferences.scoreboard_prefs`, and a handful of localStorage mirrors —
 * and migrations 162 (v2.133.0) and 220 (v2.263.0) rewrite the first three.
 * The map still has to exist at RUNTIME because localStorage is not
 * migratable: a viewer whose browser holds
 * `arcaid-theme-personal=cyberpunk` must land on Synthwave rather than on a
 * `.theme-cyberpunk` class no stylesheet defines any more (which paints the
 * default dark and silently loses their choice).
 *
 * Each retired id, the survivor it maps to, and why. Retired in v2.133.0:
 *   coffee      paper      the warm off-white light theme, redrawn
 *   crt-green   retro      both are the phosphor-green terminal; retro is nicer
 *   marquee     dark       a white-glow near-black; the default is the same idea
 *   cabinet     dark       primary accents on black; the default, less crude
 *   ocean       dark       cool blues on deep navy, which the default is now
 *   invaders    forest     green-accented black
 *   playfield   forest     the "green felt" theme was green-on-black anyway
 *   wizard      synthwave  purple-violet with magenta accents
 *   cyberpunk   synthwave  hot pink on violet-black, done properly
 *   sunset      backglass  warm orange and amber on a dark warm ground
 *   minimal     graphite   neutral monochrome with one cool accent
 * Retired in v2.263.0 (ocean, wizard and sunset pointed at three of these
 * until then, so they moved on with them):
 *   midnight    dark       deep navy with white ink, which the default is now
 *   silverball  dark       cool grey with cool accents; the default is closest
 *   plasma      synthwave  hot pink on purple; Synthwave is the violet theme
 *   ember       backglass  orange on warm charcoal; Backglass is the warm one
 *   arctic      light      a cool pale page with navy ink, which Light is now
 */
export const LEGACY_THEME_MAP: Record<string, ThemeId> = {
    coffee: 'paper',
    'crt-green': 'retro',
    marquee: 'dark',
    cabinet: 'dark',
    ocean: 'dark',
    invaders: 'forest',
    playfield: 'forest',
    wizard: 'synthwave',
    cyberpunk: 'synthwave',
    sunset: 'backglass',
    minimal: 'graphite',
    midnight: 'dark',
    silverball: 'dark',
    plasma: 'synthwave',
    ember: 'backglass',
    arctic: 'light',
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
