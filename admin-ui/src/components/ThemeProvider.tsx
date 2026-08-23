/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE THEME MODEL (v2.132.0) — one resolution order, written down once.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There are exactly THREE stored theme choices plus one polarity switch, and
 * they combine in this order (first non-null wins), by route class:
 *
 *   ROOM PUBLIC PAGE (`/:slug/*`)
 *     1. this-room override   — `scoreboard_prefs.roomThemes[roomId]` ("theme
 *                               for this room only", set in Display settings
 *                               → This room). Keyed by ROOM, not by device.
 *     2. personal theme       — `/me/preferences.ui_theme` ("my theme
 *                               everywhere"; NULL = "use each room's default")
 *     3. room default         — `game_room_settings.UI_THEME` (room admin's
 *                               single "Room default theme" field)
 *     4. `dark`
 *
 *   ADMIN PAGE (`/admin/*`, `/:slug/admin/*`)
 *     1. personal theme  2. `dark`
 *
 *   GLOBAL PAGE (`/`, `/scoreboard`, `/catalogue`, `/games/*`)
 *     polarity only — appearance → prefers-color-scheme → dark. Unchanged.
 *
 *   OTHER non-room, non-admin pages (`/account/settings`, `/friends`, …)
 *     personal theme → last-resolved room theme → `dark`.
 *
 * Then, ALWAYS LAST on every route class: `resolveAppearance(base, appearance)`
 * — the viewer's Dark / Light / Auto switch (v2.130.0) has the final word.
 *
 * What changed in v2.132.0:
 *
 *  - The personal theme used to be the ADMIN theme (a field misfiled under
 *    room settings, applying only to `/admin/*`). It now outranks the room
 *    default on the room's PUBLIC pages too, which is what makes one picker
 *    in Display settings enough — and is why the room settings page no longer
 *    carries an "Admin Theme" field at all. Guests are unchanged: no personal
 *    theme, so room default → appearance.
 *  - Layer 1 became genuinely per-ROOM. It was `scoreboard_prefs[device]
 *    .UI_THEME`: one control labelled "this room" that actually applied to
 *    EVERY room, on ONE device. It now lives in `scoreboard_prefs.roomThemes`,
 *    a `roomId -> ThemeId` map beside (not inside) the per-device blobs, so
 *    room A's choice cannot follow you into room B and does follow you onto
 *    your other devices.
 *
 * No-flash: every layer is mirrored into localStorage and read synchronously
 * on first paint — `arcaid-theme-personal` (personal), `arcaid-theme-public-
 * <slug>` (room default), `arcaid-theme-room-<slug>` (this-room override),
 * `arcaid-appearance` (polarity). The server values overwrite them on hydrate.
 *
 * The override mirror is a SEPARATE per-slug key from the room-default mirror
 * on purpose: `setPublicTheme` writes `arcaid-theme-public-<slug>` from the
 * admin Settings page, so reusing it would turn "an admin changed the room's
 * default" into "that admin now has a personal override in that room" — which
 * would silently outrank their own personal theme there.
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { api, isAuthenticated } from '../lib/api';
import { getPortal } from '../lib/portal';
import { isAdminPath, isGlobalPath, getRoomSlugForPath } from '../lib/routeClass';
import { fetchRoomThemes } from '../lib/roomThemes';
// v2.133.0 — the id list, the legacy fold and the `ThemeId` type live in
// `lib/themeIds.ts` (mirrored byte-identically in `src/utils/themeIds.ts` on
// the backend). Deliberately NOT re-exported from here: this file is a
// component module, and re-exports cost it fast refresh.
import { THEME_IDS, normalizeThemeId, type ThemeId } from '../lib/themeIds';

/**
 * The picker list (v2.133.0). Order is DARKS first, LIGHTS last — the same
 * order as `THEME_IDS` in `lib/themeIds.ts`, which this object is keyed by.
 *
 * Every description states what the theme RENDERS: background tone, ink,
 * accent colours. No metaphors — the previous set had a "Playfield" theme
 * described as "dark green felt pinball playing surface", which is a pool
 * table, and a "Minimal" that was neither minimal nor light. Check any new
 * entry against its `.theme-<id>` block in index.css before writing the copy.
 */
export const THEMES: Record<ThemeId, { label: string; description: string }> = {
  dark: { label: 'Arcaid default', description: 'Dark navy slate, white text, cyan + magenta neon' },
  midnight: { label: 'Midnight', description: 'Deep navy, crisp white text, electric blue + amber' },
  graphite: { label: 'Graphite', description: 'Neutral charcoal with a single teal accent' },
  nordic: { label: 'Nordic', description: 'Muted blue-grey, soft pastel accents, low glare' },
  plasma: { label: 'Plasma', description: 'Purple-black with hot pink and electric blue' },
  synthwave: { label: 'Synthwave', description: 'Violet-black, hot pink + cyan neon, horizon glow' },
  ember: { label: 'Ember', description: 'Warm charcoal with orange and amber accents' },
  forest: { label: 'Forest', description: 'Deep green-black with mint and gold accents' },
  backglass: { label: 'Backglass', description: 'Warm brown-black with amber glow and gold accents' },
  retro: { label: 'Retro terminal', description: 'Black with green phosphor text and glow' },
  silverball: { label: 'Silverball', description: 'Gunmetal greys with chrome edges and cool accents' },
  contrast: { label: 'High contrast', description: 'Pure black, white text, no glow — top legibility' },
  light: { label: 'Light', description: 'Pale grey page, white cards, dark text, deep neon' },
  arctic: { label: 'Arctic', description: 'Cool blue-white light theme with navy text' },
  paper: { label: 'Paper', description: 'Warm off-white light theme, ink text, copper' },
  speegle: { label: 'Speegle', description: 'LEGO yellow page, pale-yellow cards, LEGO blue text' },
};

/** v2.50.0 (A1) — global pages are light/dark only, never a named theme. */
export type GlobalPagePolarity = 'light' | 'dark';

/**
 * v2.130.0 — the ONE viewer-level light/dark switch, applying to every page
 * class (room public, room/super admin, global). `'auto'` is the historical
 * behaviour verbatim; `'light'`/`'dark'` is a POLARITY OVERRIDE applied as the
 * LAST step of theme resolution (see `resolveAppearance`).
 */
export type Appearance = 'dark' | 'light' | 'auto';

interface ThemeContextType {
  /** The theme actually applied to <html> — i.e. post-appearance-override. */
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
  globalTheme: ThemeId;
  setGlobalTheme: (theme: ThemeId) => void;
  /** The room's underlying theme pick, BEFORE any appearance override. */
  publicTheme: ThemeId;
  setPublicTheme: (theme: ThemeId) => void;
  /**
   * The viewer's own theme ("my theme everywhere"), or null for "use each
   * room's default". Persisted to `/me/preferences.ui_theme`.
   */
  personalTheme: ThemeId | null;
  setPersonalTheme: (theme: ThemeId | null) => void;
  /**
   * The "theme for this room only" override for the room currently on screen
   * (`scoreboard_prefs.roomThemes[roomId]`), or null off-room. The provider
   * fetches it; the Display settings sheet writes it through
   * `setRoomThemeOverride` after its own PUT.
   */
  roomThemeOverride: ThemeId | null;
  setRoomThemeOverride: (theme: ThemeId | null) => void;
  /**
   * @deprecated v2.132.0 aliases of `personalTheme` — the "admin theme" is
   * just the personal theme, and applies far beyond admin pages now. Kept so
   * older call sites keep compiling; `adminTheme` reads `dark` for null.
   */
  adminTheme: ThemeId;
  setAdminTheme: (theme: ThemeId) => void;
  /** Resolved light/dark for global pages (appearance -> OS -> dark). */
  globalPageTheme: GlobalPagePolarity;
  /** The viewer's Dark/Light/Auto choice. */
  appearance: Appearance;
  /** Records the choice: localStorage now, server too when signed in. */
  setAppearance: (appearance: Appearance) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const STORAGE_GLOBAL_KEY = 'arcaid-theme-global';
const STORAGE_PUBLIC_KEY = 'arcaid-theme-public';
/**
 * v2.132.0 — the viewer's personal theme mirror. `STORAGE_ADMIN_KEY` held
 * exactly this value under its old "admin theme" name, so it is still read
 * (as a seed) and still written (so a rolled-back build finds it), but the
 * new key is the one that means "no personal theme" by being ABSENT.
 */
export const STORAGE_PERSONAL_KEY = 'arcaid-theme-personal';
const STORAGE_ADMIN_KEY = 'arcaid-theme-admin';
/**
 * v2.50.0 (A1) — the visitor's explicit light/dark choice for global pages.
 * SUPERSEDED in v2.130.0 by `STORAGE_APPEARANCE_KEY`: it is read exactly once,
 * to migrate an existing visitor's choice forward, and never written again.
 */
export const STORAGE_GLOBAL_PAGE_KEY = 'arcaid-global-theme';
/** v2.130.0 — the single Dark/Light/Auto preference, for every page class. */
export const STORAGE_APPEARANCE_KEY = 'arcaid-appearance';
const publicSlugKey = (slug: string) => `arcaid-theme-public-${slug}`;
/**
 * v2.132.0 — per-slug mirror of `scoreboard_prefs.roomThemes[roomId]`.
 *
 * Slug-keyed rather than id-keyed because the first paint has the URL and
 * nothing else; the server map is id-keyed and reconciled on hydrate. See the
 * model block at the top for why this is not the `publicSlugKey` value.
 */
const roomOverrideSlugKey = (slug: string) => `arcaid-theme-room-${slug}`;

/**
 * The stored appearance, defaulting to 'auto'.
 *
 * One-time legacy migration: a visitor who ever used the v2.50.0 global-page
 * sun/moon toggle has `arcaid-global-theme` set. That was a global-pages-only
 * choice; the same person now gets it as their whole-site appearance, which is
 * the strictly closer reading of "I want light mode". The legacy key is left
 * in place (harmless) but never read again once the new key exists.
 */
function readAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(STORAGE_APPEARANCE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'auto') return raw;
    const legacy = localStorage.getItem(STORAGE_GLOBAL_PAGE_KEY);
    if (legacy === 'light' || legacy === 'dark') {
      localStorage.setItem(STORAGE_APPEARANCE_KEY, legacy);
      return legacy;
    }
    return 'auto';
  } catch {
    return 'auto';
  }
}

const PLAYER_TOKEN_KEY = 'arcaid_player_token';

interface ServerPreferences {
  ui_theme: ThemeId | null;
  appearance: Appearance | null;
}

/**
 * `/api/me/preferences` for whichever identity this browser holds.
 *
 * `requireAuth` on that route accepts ANY valid JWT, but `lib/api.ts` only
 * ever sends the ADMIN token — so a signed-in player (whose token lives in
 * `arcaid_player_token`, and who never has an admin token) would silently get
 * no server-side appearance at all. Same raw-fetch-with-the-player-token
 * shape `ScoreboardPreferencesModal` already uses for its own prefs calls.
 * ThemeProvider wraps ViewerAuthProvider (App.tsx), so the token is read from
 * localStorage rather than through `useViewerAuth`.
 */
async function fetchUserPreferences(): Promise<ServerPreferences | null> {
  if (isAuthenticated()) {
    return api.get<ServerPreferences>('/me/preferences').catch(() => null);
  }
  const playerToken = localStorage.getItem(PLAYER_TOKEN_KEY);
  if (!playerToken) return null;
  try {
    const res = await fetch('/api/me/preferences', {
      headers: { Authorization: `Bearer ${playerToken}` },
    });
    return res.ok ? ((await res.json()) as ServerPreferences) : null;
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget write to `/me/preferences` for whichever identity is
 * present. `/me/preferences` writes only the fields it is sent (v2.130.0), so
 * `{appearance}` and `{ui_theme}` never clobber one another.
 */
async function persistUserPreference(body: { appearance?: Appearance; ui_theme?: ThemeId | null }): Promise<void> {
  if (isAuthenticated()) {
    await api.post('/me/preferences', body).catch(() => { /* localStorage still holds it */ });
    return;
  }
  const playerToken = localStorage.getItem(PLAYER_TOKEN_KEY);
  if (!playerToken) return;
  try {
    await fetch('/api/me/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${playerToken}` },
      body: JSON.stringify(body),
    });
  } catch { /* guests and offline viewers keep the localStorage value */ }
}

const persistUserAppearance = (appearance: Appearance) => persistUserPreference({ appearance });

const PREFERS_LIGHT = '(prefers-color-scheme: light)';

/** OS preference, defaulting to dark when matchMedia is unavailable (jsdom). */
function readOsPolarity(): GlobalPagePolarity {
  try {
    if (typeof window.matchMedia !== 'function') return 'dark';
    return window.matchMedia(PREFERS_LIGHT).matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

// v2.132.0 — route classification moved to `lib/routeClass.ts` so
// `DisplaySettingsHost` can share it (see that file's header). Same rules,
// same reserved-segment list, one definition.
const getRoomSlug = getRoomSlugForPath;

/**
 * Every class `applyThemeClass` may have to strip. Derived from `THEME_IDS`
 * rather than hand-listed (the hand-list had already drifted once), minus
 * `dark`, which is the no-class default. Module-private: the ONE thing that
 * must not drift is that it covers every theme, and deriving it from the same
 * list the picker uses makes that true by construction rather than by test.
 */
const ALL_THEME_CLASSES = THEME_IDS.filter(id => id !== 'dark').map(id => `theme-${id}`);

/**
 * v2.130.0 — which polarity each theme actually renders at.
 *
 * The source of truth is `color-scheme` in admin-ui/src/index.css: exactly
 * three theme blocks declare `color-scheme: light` (`.theme-light`,
 * `.theme-arctic`, `.theme-paper`) and `html` declares `color-scheme: dark`
 * for everything else. Note the traps: `graphite` and `silverball` are
 * neutral/pale-sounding but dark-surfaced, and `contrast` is pure black.
 * Add a theme to `THEMES` and `appearancePolarity.test.ts` fails until it is
 * classified here.
 */
export const THEME_POLARITY: Record<ThemeId, GlobalPagePolarity> = {
  dark: 'dark',
  midnight: 'dark',
  graphite: 'dark',
  nordic: 'dark',
  plasma: 'dark',
  synthwave: 'dark',
  ember: 'dark',
  forest: 'dark',
  backglass: 'dark',
  retro: 'dark',
  silverball: 'dark',
  contrast: 'dark',
  light: 'light',
  arctic: 'light',
  paper: 'light',
  speegle: 'light',
};

/**
 * The LAST step of theme resolution (v2.130.0), shared by every route class.
 *
 * `auto` changes nothing. Otherwise the resolved theme is kept when it already
 * renders at the requested polarity — a room already on `paper` stays on ITS
 * light theme under appearance=light rather than being flattened to the
 * generic `light` — and is swapped for the canonical theme of that polarity
 * when it does not.
 */
export function resolveAppearance(base: ThemeId, appearance: Appearance): ThemeId {
  if (appearance === 'auto') return base;
  if (THEME_POLARITY[base] === appearance) return base;
  return appearance === 'light' ? 'light' : 'dark';
}

function applyThemeClass(theme: ThemeId) {
  const root = document.documentElement;
  ALL_THEME_CLASSES.forEach(cls => root.classList.remove(cls));
  if (theme !== 'dark') {
    root.classList.add(`theme-${theme}`);
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // s20: ThemeProvider mounts inside BrowserRouter (see main.tsx/App.tsx), so
  // useLocation() is available and re-renders this component on every
  // navigation — the root-cause fix for the no-re-theme bug (globalTheme used
  // to read window.location.pathname directly, which nothing re-rendered on).
  const location = useLocation();
  const pathname = location.pathname;
  const adminRoute = isAdminPath(pathname);
  const roomSlug = getRoomSlug(pathname);
  const globalPage = !adminRoute && isGlobalPath(pathname);

  // v2.130.0 — the viewer's Dark/Light/Auto choice. Read synchronously from
  // localStorage so the first paint is already correct (no flash), then
  // overwritten by the server value on hydrate for signed-in users.
  const [appearance, setAppearanceState] = useState<Appearance>(readAppearance);

  // v2.50.0 (A1) — global pages (/, /scoreboard, /catalogue, /games/*) follow
  // the VISITOR, not the admin-set GLOBAL_PAGE_THEME (that setting is now
  // deprecated; the server field still exists but nothing reads it here).
  // Precedence as of v2.130.0: appearance -> prefers-color-scheme -> dark.
  const [osPolarity, setOsPolarity] = useState<GlobalPagePolarity>(readOsPolarity);
  const globalPageTheme: GlobalPagePolarity = appearance === 'auto' ? osPolarity : appearance;

  // Initialize from localStorage for instant rendering (no flash). Per-slug
  // key takes priority over the legacy un-suffixed key when the initial URL
  // is already a room's public route.
  const [publicThemeState, setPublicThemeState] = useState<ThemeId>(() => {
    const initialPath = window.location.pathname;
    const initialSlug = getRoomSlug(initialPath);
    const stored = (initialSlug && localStorage.getItem(publicSlugKey(initialSlug)))
      || localStorage.getItem(STORAGE_PUBLIC_KEY)
      || localStorage.getItem(STORAGE_GLOBAL_KEY);
    // v2.133.0 — a mirror written before the theme cull can name a retired
    // theme; `normalizeThemeId` maps it forward so no dead class is painted.
    return normalizeThemeId(stored) || 'dark';
  });
  // v2.132.0 — the viewer's own theme, or null for "use each room's default".
  // Seeded from the legacy admin-theme key (same value, older name); ABSENCE
  // is meaningful here, so there is no 'dark' fallback at this layer.
  const [personalThemeState, setPersonalThemeState] = useState<ThemeId | null>(() => {
    const stored = localStorage.getItem(STORAGE_PERSONAL_KEY) || localStorage.getItem(STORAGE_ADMIN_KEY);
    return normalizeThemeId(stored);
  });
  // v2.132.0 — this room's override, seeded per SLUG so room A's choice never
  // paints in room B. Null off-room and for any room the viewer hasn't set.
  const [roomThemeOverrideState, setRoomThemeOverrideState] = useState<ThemeId | null>(() => {
    const initialSlug = getRoomSlug(window.location.pathname);
    if (!initialSlug) return null;
    return normalizeThemeId(localStorage.getItem(roomOverrideSlugKey(initialSlug)));
  });

  // The room on screen RIGHT NOW, for async callbacks. Read from the router
  // (not `window.location`, which `MemoryRouter` never updates) so the guard
  // below behaves the same in tests as in the app.
  const currentRoomSlugRef = useRef<string | null>(roomSlug);
  useEffect(() => { currentRoomSlugRef.current = roomSlug; }, [roomSlug]);

  /**
   * Record a room's override: mirror always, paint only if that room is still
   * the one on screen. The hydrate that calls this is async, so the viewer
   * may already have navigated to a different room by the time it resolves —
   * writing the mirror for the room it belongs to is right either way, but
   * painting it would be room A's theme on room B.
   */
  const applyRoomOverride = (slug: string, theme: ThemeId | null) => {
    try {
      if (theme) localStorage.setItem(roomOverrideSlugKey(slug), theme);
      else localStorage.removeItem(roomOverrideSlugKey(slug));
    } catch { /* private mode */ }
    if (currentRoomSlugRef.current === slug) setRoomThemeOverrideState(theme);
  };

  // ── Resolution (see the model block at the top of this file) ──────────────
  // Global pages are polarity-only. Admin pages take the personal theme. Room
  // pages take this-room override -> personal -> room default. Non-room,
  // non-admin utility pages (/account/settings, /friends, …) get the personal
  // theme but never a room-scoped override. Appearance is applied LAST, on
  // every branch, by `resolveAppearance`.
  const baseTheme: ThemeId = adminRoute
    ? (personalThemeState ?? 'dark')
    : globalPage
      ? globalPageTheme
      : roomSlug
        ? (roomThemeOverrideState ?? personalThemeState ?? publicThemeState)
        : (personalThemeState ?? publicThemeState);
  const globalTheme = resolveAppearance(baseTheme, appearance);
  const theme = globalTheme;

  // Apply theme class whenever effective theme changes
  useEffect(() => {
    applyThemeClass(theme);
  }, [theme]);

  // v2.50.0 (A1) — track the OS preference while mounted, but ONLY while the
  // visitor has made no explicit choice. Once they've chosen, their choice is
  // sticky and an OS flip must not override it. Deps on `appearance` so
  // choosing detaches (and returning to Auto re-attaches) the listener.
  useEffect(() => {
    if (appearance !== 'auto') return;
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(PREFERS_LIGHT);
    const onChange = (e: MediaQueryListEvent) => setOsPolarity(e.matches ? 'light' : 'dark');
    mq.addEventListener('change', onChange);
    // Re-sync on (re)attach in case the preference moved while detached.
    setOsPolarity(mq.matches ? 'light' : 'dark');
    return () => mq.removeEventListener('change', onChange);
  }, [appearance]);

  // v2.132.0 — global pages no longer FOLD their polarity into
  // `publicThemeState`; `baseTheme` branches on `globalPage` directly. The
  // old fold overwrote the room-theme slot on every global-page visit, which
  // is harmless today only because the room effect below re-resolves on
  // entry — but it made `publicTheme` lie about the room whenever a viewer
  // was standing on /scoreboard, and it hid the room default from the new
  // personal-theme fallback chain.

  // Re-resolve the per-slug local theme immediately on entering a different
  // room's public route (room A -> room B must not keep A's theme). Runs
  // before the async hydrate effect below, so this is the instant/no-flash
  // value; the network hydrate may still overwrite it with the room's
  // configured theme once that resolves.
  useEffect(() => {
    if (adminRoute || !roomSlug) {
      // v2.132.0 — off-room the per-room override must go, even though the
      // room DEFAULT deliberately lingers (it is the fallback for
      // /account/settings & friends). Leaving it set would let room A's
      // override paint over room B's theme for a frame on the way in.
      setRoomThemeOverrideState(null);
      return;
    }
    // Resolution order: per-slug key -> legacy un-suffixed key -> default.
    // Always set (rather than only when something is found) so navigating
    // from a room WITH a saved theme to one WITHOUT doesn't keep showing the
    // previous room's theme.
    const stored = localStorage.getItem(publicSlugKey(roomSlug))
      || localStorage.getItem(STORAGE_PUBLIC_KEY)
      || localStorage.getItem(STORAGE_GLOBAL_KEY);
    setPublicThemeState(normalizeThemeId(stored) || 'dark');
    setRoomThemeOverrideState(normalizeThemeId(localStorage.getItem(roomOverrideSlugKey(roomSlug))));
  }, [adminRoute, roomSlug]);

  // Hydrate from API on mount and whenever the route's admin/public-slug
  // classification changes (was `[]` — only ran once, so navigating between
  // rooms or admin<->public never re-fetched the theme for the new context).
  useEffect(() => {
    const hydrate = async () => {
      try {
        // v2.50.0 (A1): global pages no longer hydrate a theme from
        // /api/global/config. The admin-set GLOBAL_PAGE_THEME is deprecated —
        // global pages follow each visitor's light/dark preference, resolved
        // in the effects above. The server field and the (deprecated) admin
        // control both survive this release; nothing reads them here.
        if (isGlobalPath(pathname)) {
          /* no-op */
        } else if (roomSlug) {
          // Room pages use room-specific theme
          const portal = await getPortal(roomSlug).catch(() => null);
          if (portal) {
            const serverPublicTheme = normalizeThemeId(portal.public_theme || portal.ui_theme);
            if (serverPublicTheme) {
              setPublicThemeState(serverPublicTheme);
              localStorage.setItem(STORAGE_PUBLIC_KEY, serverPublicTheme);
            }
            // v2.132.0 — this room's personal override. Needs the ROOM ID,
            // which is why it waits on the portal. Passing `roomId` also opts
            // into the server's one-shot lift of a pre-v2.132 per-device
            // `UI_THEME` override onto this room (see PreferencesService).
            // A null map means "not signed in / request failed" — the
            // localStorage mirror stands. An EMPTY map is authoritative: it
            // clears an override removed on another device.
            if (portal.roomId) {
              const map = await fetchRoomThemes(portal.roomId);
              if (map) applyRoomOverride(roomSlug, normalizeThemeId(map[portal.roomId]));
            }
          }
        }

        // Hydrate the personal theme + appearance from user preferences
        // (per-user, not a room setting). v2.130.0: this runs for PLAYER
        // tokens too, so a viewer who set Light on their phone gets Light on
        // the desktop. v2.132.0: `ui_theme` is now the PERSONAL theme for
        // every route class, and the server is authoritative in BOTH
        // directions — a NULL column clears the localStorage mirror, because
        // NULL is a real choice here ("use each room's default") rather than
        // the absence of one.
        const prefs = await fetchUserPreferences();
        if (prefs) {
          const serverPersonal = normalizeThemeId(prefs.ui_theme);
          if (serverPersonal) {
            if (serverPersonal !== personalThemeState) setPersonalThemeState(serverPersonal);
            localStorage.setItem(STORAGE_PERSONAL_KEY, serverPersonal);
            localStorage.setItem(STORAGE_ADMIN_KEY, serverPersonal);
          } else {
            if (personalThemeState !== null) setPersonalThemeState(null);
            localStorage.removeItem(STORAGE_PERSONAL_KEY);
            localStorage.removeItem(STORAGE_ADMIN_KEY);
          }
          // The server value wins over localStorage and is mirrored back to
          // it — but only when there IS one. A NULL column means this account
          // has never chosen, so a preference set on this device before
          // signing in is adopted upward rather than being wiped by a value
          // that was never really a choice.
          if (prefs.appearance) {
            setAppearanceState(prefs.appearance);
            try { localStorage.setItem(STORAGE_APPEARANCE_KEY, prefs.appearance); } catch { /* private mode */ }
          } else if (readAppearance() !== 'auto') {
            void persistUserAppearance(readAppearance());
          }
        }
      } catch {
        // Ignore — localStorage values are good enough
      }
    };

    hydrate();
    // s20 M1 fix: deps are [adminRoute, roomSlug], NOT [pathname, roomSlug].
    // `pathname` is still read inside (for isGlobalPath), but must not be a
    // dep — otherwise every same-room navigation (e.g. scoreboard -> lobby)
    // re-fires this effect and setPublicThemeState(serverPublicTheme)
    // clobbers a viewer's just-set personal theme back to the room's
    // configured theme (visible flicker). Global sub-pages intentionally
    // share one theme, so not re-hydrating between them is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminRoute, roomSlug]);

  const setPublicTheme = (newTheme: ThemeId) => {
    setPublicThemeState(newTheme);
    // Store per-slug so changing one room's theme doesn't affect others.
    // Legacy un-suffixed key is also kept for back-compat (older sessions /
    // global-page fallback still read it).
    if (roomSlug) {
      localStorage.setItem(publicSlugKey(roomSlug), newTheme);
    }
    localStorage.setItem(STORAGE_PUBLIC_KEY, newTheme);
    localStorage.setItem(STORAGE_GLOBAL_KEY, newTheme);
  };

  /**
   * v2.132.0 — the ONE personal-theme writer. `null` means "use each room's
   * default": state goes null and BOTH mirrors are removed (an empty string
   * would read back as a truthy-ish stored value on the next boot). The
   * server write is fire-and-forget on top, exactly like `setAppearance`.
   */
  const setPersonalTheme = (newTheme: ThemeId | null) => {
    setPersonalThemeState(newTheme);
    try {
      if (newTheme) {
        localStorage.setItem(STORAGE_PERSONAL_KEY, newTheme);
        localStorage.setItem(STORAGE_ADMIN_KEY, newTheme);
      } else {
        localStorage.removeItem(STORAGE_PERSONAL_KEY);
        localStorage.removeItem(STORAGE_ADMIN_KEY);
      }
    } catch { /* private mode — the choice still applies for this session */ }
    void persistUserPreference({ ui_theme: newTheme });
  };

  /**
   * v2.132.0 — the this-room override, for the room currently on screen.
   *
   * NOT persisted to the server from here: it lives in
   * `scoreboard_prefs.roomThemes[roomId]`, and the Display settings sheet
   * PUTs it (it is the side that knows the room ID). This setter exists so
   * the applied theme and the per-slug mirror track that value immediately.
   * Off-room it is a no-op — there is no room for the override to be "only".
   */
  const setRoomThemeOverride = (newTheme: ThemeId | null) => {
    if (!roomSlug) return;
    applyRoomOverride(roomSlug, newTheme);
  };

  /** @deprecated v2.132.0 — alias kept for older call sites. */
  const setAdminTheme = (newTheme: ThemeId) => setPersonalTheme(newTheme);

  const setGlobalTheme = (newTheme: ThemeId) => {
    if (adminRoute) {
      setAdminTheme(newTheme);
    } else {
      setPublicTheme(newTheme);
    }
  };

  const setTheme = (newTheme: ThemeId) => {
    setGlobalTheme(newTheme);
  };

  // v2.130.0 — persist the viewer's Dark/Light/Auto choice. localStorage is
  // written synchronously (instant, no-flash, and the only store a guest
  // gets); the server write is best-effort on top for signed-in users.
  // Anything other than 'auto' is also what detaches the OS listener.
  const setAppearance = (next: Appearance) => {
    setAppearanceState(next);
    try {
      localStorage.setItem(STORAGE_APPEARANCE_KEY, next);
    } catch { /* private mode — the choice still applies for this session */ }
    void persistUserAppearance(next);
  };

  return (
    <ThemeContext.Provider value={{
      theme, setTheme, globalTheme, setGlobalTheme,
      publicTheme: publicThemeState, setPublicTheme,
      personalTheme: personalThemeState, setPersonalTheme,
      roomThemeOverride: roomThemeOverrideState, setRoomThemeOverride,
      adminTheme: personalThemeState ?? 'dark', setAdminTheme,
      globalPageTheme, appearance, setAppearance,
    }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
