import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, isAuthenticated } from '../lib/api';

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

function isAdminRoute(): boolean {
  const path = window.location.pathname;
  // /admin/* = super admin, /:slug/admin/* = room admin
  const parts = path.split('/').filter(Boolean);
  return parts[0] === 'admin' || parts[1] === 'admin';
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
  // Initialize from localStorage for instant rendering (no flash)
  const [publicThemeState, setPublicThemeState] = useState<ThemeId>(() => {
    const stored = localStorage.getItem(STORAGE_PUBLIC_KEY) || localStorage.getItem(STORAGE_GLOBAL_KEY);
    return (stored as ThemeId) || 'dark';
  });
  // Admin theme is per-admin (stored in user preferences + localStorage)
  const [adminThemeState, setAdminThemeState] = useState<ThemeId>(() => {
    const stored = localStorage.getItem(STORAGE_ADMIN_KEY);
    return (stored as ThemeId) || 'dark';
  });

  // Effective theme depends on route: admin routes use per-admin theme, public uses room theme
  const globalTheme = isAdminRoute() ? adminThemeState : publicThemeState;
  const theme = globalTheme;

  // Apply theme class whenever effective theme changes
  useEffect(() => {
    applyThemeClass(theme);
  }, [theme]);

  // Hydrate from API on mount and when slug changes
  useEffect(() => {
    const hydrate = async () => {
      try {
        const pathSlug = window.location.pathname.split('/').filter(Boolean)[0] || '';
        const portalRes = pathSlug && pathSlug !== 'admin'
          ? await fetch(`/api/portal?slug=${encodeURIComponent(pathSlug)}`)
          : null;
        if (portalRes?.ok) {
          const portal = await portalRes.json();
          const serverPublicTheme = portal.public_theme || portal.ui_theme;
          if (serverPublicTheme) {
            setPublicThemeState(serverPublicTheme);
            localStorage.setItem(STORAGE_PUBLIC_KEY, serverPublicTheme);
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
  }, []);

  const setPublicTheme = (newTheme: ThemeId) => {
    setPublicThemeState(newTheme);
    // Store per-slug so changing one room's theme doesn't affect others
    const pathSlug = window.location.pathname.split('/').filter(Boolean)[0] || '';
    if (pathSlug && pathSlug !== 'admin') {
      localStorage.setItem(`arcaid-theme-public-${pathSlug}`, newTheme);
    }
    localStorage.setItem(STORAGE_PUBLIC_KEY, newTheme);
    localStorage.setItem(STORAGE_GLOBAL_KEY, newTheme);
  };

  const setAdminTheme = (newTheme: ThemeId) => {
    setAdminThemeState(newTheme);
    localStorage.setItem(STORAGE_ADMIN_KEY, newTheme);
  };

  const setGlobalTheme = (newTheme: ThemeId) => {
    if (isAdminRoute()) {
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
