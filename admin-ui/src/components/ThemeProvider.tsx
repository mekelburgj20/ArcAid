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

interface ThemeContextType {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
  globalTheme: ThemeId;
  setGlobalTheme: (theme: ThemeId) => void;
  publicTheme: ThemeId;
  setPublicTheme: (theme: ThemeId) => void;
  adminTheme: ThemeId;
  setAdminTheme: (theme: ThemeId) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const STORAGE_GLOBAL_KEY = 'arcaid-theme-global';
const STORAGE_PUBLIC_KEY = 'arcaid-theme-public';
const STORAGE_ADMIN_KEY = 'arcaid-theme-admin';
const publicSlugKey = (slug: string) => `arcaid-theme-public-${slug}`;

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

  // Initialize from localStorage for instant rendering (no flash). Per-slug
  // key takes priority over the legacy un-suffixed key when the initial URL
  // is already a room's public route.
  const [publicThemeState, setPublicThemeState] = useState<ThemeId>(() => {
    const initialSlug = getRoomSlug(window.location.pathname);
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

  // Effective theme depends on route: admin routes use per-admin theme, public uses room theme
  const globalTheme = adminRoute ? adminThemeState : publicThemeState;
  const theme = globalTheme;

  // Apply theme class whenever effective theme changes
  useEffect(() => {
    applyThemeClass(theme);
  }, [theme]);

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
        // Global pages (/, /scoreboard, /catalogue, /games/*) use global page theme
        if (isGlobalPath(pathname)) {
          try {
            const configRes = await fetch('/api/global/config');
            if (configRes.ok) {
              const config = await configRes.json();
              if (config.theme) {
                setPublicThemeState(config.theme);
                localStorage.setItem(STORAGE_PUBLIC_KEY, config.theme);
              }
            }
          } catch { /* fall through to room theme */ }
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

        // Hydrate admin theme from user preferences (per-admin, not room setting)
        if (isAuthenticated()) {
          const prefs = await api.get<{ ui_theme: ThemeId | null }>('/me/preferences');
          if (prefs.ui_theme && prefs.ui_theme !== adminThemeState) {
            setAdminThemeState(prefs.ui_theme);
            localStorage.setItem(STORAGE_ADMIN_KEY, prefs.ui_theme);
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

  return (
    <ThemeContext.Provider value={{ theme, setTheme, globalTheme, setGlobalTheme, publicTheme: publicThemeState, setPublicTheme, adminTheme: adminThemeState, setAdminTheme }}>
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
