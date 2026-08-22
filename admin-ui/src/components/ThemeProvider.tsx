import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { api, isAuthenticated } from '../lib/api';
import { getPortal } from '../lib/portal';

export type ThemeId = 'dark' | 'light' | 'retro' | 'cyberpunk' | 'ocean' | 'sunset' | 'minimal' | 'invaders' | 'coffee' | 'backglass' | 'crt-green' | 'plasma' | 'cabinet' | 'silverball' | 'wizard' | 'playfield' | 'marquee';

export const THEMES: Record<ThemeId, { label: string; description: string }> = {
  dark: { label: 'Dark', description: 'Deep indigo dark theme with accent colors' },
  light: { label: 'Light', description: 'Clean light theme for daytime use' },
  retro: { label: 'Retro', description: 'Green-on-black CRT terminal aesthetic' },
  cyberpunk: { label: 'Cyberpunk', description: 'Hot pink and yellow on deep purple' },
  ocean: { label: 'Ocean', description: 'Cool teal tones on deep navy' },
  sunset: { label: 'Sunset', description: 'Warm orange and amber on dark brown' },
  minimal: { label: 'Minimal', description: 'Monochrome with a single accent color' },
  invaders: { label: 'Space Invaders', description: 'Classic arcade black with alien silhouettes' },
  coffee: { label: 'Coffee', description: 'Warm cream and brown light theme' },
  backglass: { label: 'Backglass', description: 'Warm amber pinball backglass translite feel' },
  'crt-green': { label: 'CRT Green', description: 'Phosphor green monochrome CRT monitor' },
  plasma: { label: 'Plasma', description: 'Hot pink and electric blue plasma ball energy' },
  cabinet: { label: 'Cabinet', description: 'Classic black arcade cabinet with primary colors' },
  silverball: { label: 'Silverball', description: 'Chrome and steel pinball machine aesthetic' },
  wizard: { label: 'Wizard', description: 'Mystical indigo fantasy pinball atmosphere' },
  playfield: { label: 'Playfield', description: 'Dark green felt pinball playing surface' },
  marquee: { label: 'Marquee', description: 'Illuminated arcade marquee with bright glow' },
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
  /** The admin's underlying theme pick, BEFORE any appearance override. */
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

/** Fire-and-forget write of the appearance for whichever identity is present. */
async function persistUserAppearance(appearance: Appearance): Promise<void> {
  if (isAuthenticated()) {
    await api.post('/me/preferences', { appearance }).catch(() => { /* localStorage still holds it */ });
    return;
  }
  const playerToken = localStorage.getItem(PLAYER_TOKEN_KEY);
  if (!playerToken) return;
  try {
    await fetch('/api/me/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${playerToken}` },
      body: JSON.stringify({ appearance }),
    });
  } catch { /* guests and offline viewers keep the localStorage value */ }
}

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

function isAdminPath(pathname: string): boolean {
  // /admin/* = super admin, /:slug/admin/* = room admin
  const parts = pathname.split('/').filter(Boolean);
  return parts[0] === 'admin' || parts[1] === 'admin';
}

const GLOBAL_PAGE_PREFIXES = ['/scoreboard', '/catalogue', '/games/'];

function isGlobalPath(pathname: string): boolean {
  return pathname === '/' || GLOBAL_PAGE_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

// s20: top-level path segments that are reserved global/utility routes, never
// a room slug. Without this guard, e.g. /friends or /my-rooms would be
// (mis)treated as a room whose slug is "friends"/"my-rooms" — fetching and
// writing that "room"'s public theme. See App.tsx's route table.
const RESERVED_TOP_SEGMENTS = new Set([
  'admin', 'login', 'auth', 'invite', 'privacy', 'terms',
  'friends', 'account', 'my-rooms', 'scoreboard', 'games',
]);

/** Room slug for a room-scoped PUBLIC route only. Returns null for admin
 *  routes, global pages, and other reserved top-level paths. */
function getRoomSlug(pathname: string): string | null {
  if (isAdminPath(pathname) || isGlobalPath(pathname)) return null;
  const first = pathname.split('/').filter(Boolean)[0];
  if (!first || RESERVED_TOP_SEGMENTS.has(first)) return null;
  return first;
}

const ALL_THEME_CLASSES = ['theme-light', 'theme-retro', 'theme-cyberpunk', 'theme-ocean', 'theme-sunset', 'theme-minimal', 'theme-invaders', 'theme-coffee', 'theme-backglass', 'theme-crt-green', 'theme-plasma', 'theme-cabinet', 'theme-silverball', 'theme-wizard', 'theme-playfield', 'theme-marquee'];

/**
 * v2.130.0 — which polarity each theme actually renders at.
 *
 * The source of truth is `color-scheme` in admin-ui/src/index.css: exactly two
 * theme blocks declare `color-scheme: light` (`.theme-light`, `.theme-coffee`)
 * and `html` declares `color-scheme: dark` for everything else. Note the trap:
 * `.theme-minimal` is a DARK monochrome theme despite the name (its
 * `--color-deep` is oklch(14%)), and `.theme-silverball`/`.theme-marquee`
 * read "bright" but are dark-surfaced too. Add a theme to `THEMES` and
 * `appearancePolarity.test.ts` fails until it is classified here.
 */
export const THEME_POLARITY: Record<ThemeId, GlobalPagePolarity> = {
  dark: 'dark',
  light: 'light',
  retro: 'dark',
  cyberpunk: 'dark',
  ocean: 'dark',
  sunset: 'dark',
  minimal: 'dark',
  invaders: 'dark',
  coffee: 'light',
  backglass: 'dark',
  'crt-green': 'dark',
  plasma: 'dark',
  cabinet: 'dark',
  silverball: 'dark',
  wizard: 'dark',
  playfield: 'dark',
  marquee: 'dark',
};

/**
 * The LAST step of theme resolution (v2.130.0), shared by every route class.
 *
 * `auto` changes nothing. Otherwise the resolved theme is kept when it already
 * renders at the requested polarity — a room already on `coffee` stays on ITS
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
    if (!isAdminPath(initialPath) && isGlobalPath(initialPath)) {
      const initialAppearance = readAppearance();
      return initialAppearance === 'auto' ? readOsPolarity() : initialAppearance;
    }
    const initialSlug = getRoomSlug(initialPath);
    const stored = (initialSlug && localStorage.getItem(publicSlugKey(initialSlug)))
      || localStorage.getItem(STORAGE_PUBLIC_KEY)
      || localStorage.getItem(STORAGE_GLOBAL_KEY);
    return (stored as ThemeId) || 'dark';
  });
  // Admin theme is per-admin (stored in user preferences + localStorage)
  const [adminThemeState, setAdminThemeState] = useState<ThemeId>(() => {
    const stored = localStorage.getItem(STORAGE_ADMIN_KEY);
    return (stored as ThemeId) || 'dark';
  });

  // Effective theme depends on route: admin routes use per-admin theme, public
  // uses room theme (global pages having already been folded into
  // publicThemeState by the effect below) — and then, v2.130.0, the viewer's
  // appearance override has the final word on all three.
  const baseTheme = adminRoute ? adminThemeState : publicThemeState;
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

  // v2.50.0 (A1) — drive the applied theme from the resolved polarity whenever
  // we're on a global page. Separate from the room effect below, which
  // early-returns on global paths (getRoomSlug returns null for them).
  useEffect(() => {
    if (!globalPage) return;
    setPublicThemeState(globalPageTheme);
  }, [globalPage, globalPageTheme]);

  // Re-resolve the per-slug local theme immediately on entering a different
  // room's public route (room A -> room B must not keep A's theme). Runs
  // before the async hydrate effect below, so this is the instant/no-flash
  // value; the network hydrate may still overwrite it with the room's
  // configured theme once that resolves.
  useEffect(() => {
    if (adminRoute || !roomSlug) return;
    // Resolution order: per-slug key -> legacy un-suffixed key -> default.
    // Always set (rather than only when something is found) so navigating
    // from a room WITH a saved theme to one WITHOUT doesn't keep showing the
    // previous room's theme.
    const stored = localStorage.getItem(publicSlugKey(roomSlug))
      || localStorage.getItem(STORAGE_PUBLIC_KEY)
      || localStorage.getItem(STORAGE_GLOBAL_KEY);
    setPublicThemeState((stored as ThemeId) || 'dark');
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
            const serverPublicTheme = portal.public_theme || portal.ui_theme;
            if (serverPublicTheme) {
              setPublicThemeState(serverPublicTheme as ThemeId);
              localStorage.setItem(STORAGE_PUBLIC_KEY, serverPublicTheme);
            }
          }
        }

        // Hydrate admin theme + appearance from user preferences (per-user,
        // not a room setting). v2.130.0: this runs for PLAYER tokens too, so
        // a viewer who set Light on their phone gets Light on the desktop.
        const prefs = await fetchUserPreferences();
        if (prefs) {
          if (prefs.ui_theme && prefs.ui_theme !== adminThemeState) {
            setAdminThemeState(prefs.ui_theme);
            localStorage.setItem(STORAGE_ADMIN_KEY, prefs.ui_theme);
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

  const setAdminTheme = (newTheme: ThemeId) => {
    setAdminThemeState(newTheme);
    localStorage.setItem(STORAGE_ADMIN_KEY, newTheme);
  };

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
    <ThemeContext.Provider value={{ theme, setTheme, globalTheme, setGlobalTheme, publicTheme: publicThemeState, setPublicTheme, adminTheme: adminThemeState, setAdminTheme, globalPageTheme, appearance, setAppearance }}>
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
