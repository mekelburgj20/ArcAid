import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, isAuthenticated } from '../lib/api';

export type ThemeId = 'arcade' | 'dark' | 'light';

export const THEMES: Record<ThemeId, { label: string; description: string }> = {
  arcade: { label: 'Arcade (Original)', description: 'Neon-on-dark arcade cabinet theme with CRT scanlines' },
  dark: { label: 'Dark', description: 'Deep indigo dark theme with softer accent colors' },
  light: { label: 'Light', description: 'Clean light theme for daytime use' },
};

interface ThemeContextType {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
  globalTheme: ThemeId;
  setGlobalTheme: (theme: ThemeId) => void;
  userTheme: ThemeId | null;
  setUserTheme: (theme: ThemeId | null) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const STORAGE_KEY = 'arcaid-theme';
const STORAGE_GLOBAL_KEY = 'arcaid-theme-global';

function applyThemeClass(theme: ThemeId) {
  const root = document.documentElement;
  root.classList.remove('theme-dark', 'theme-light');
  if (theme !== 'arcade') {
    root.classList.add(`theme-${theme}`);
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Initialize from localStorage for instant rendering (no flash)
  const [globalTheme, setGlobalThemeState] = useState<ThemeId>(() => {
    const stored = localStorage.getItem(STORAGE_GLOBAL_KEY);
    return (stored as ThemeId) || 'arcade';
  });
  const [userTheme, setUserThemeState] = useState<ThemeId | null>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? (stored as ThemeId) : null;
  });

  // The effective theme: user override > global default
  const theme = userTheme || globalTheme;

  // Apply theme class whenever effective theme changes
  useEffect(() => {
    applyThemeClass(theme);
  }, [theme]);

  // Hydrate from API on mount (updates if server state differs from localStorage)
  useEffect(() => {
    const hydrate = async () => {
      try {
        // Always fetch global theme from portal (public endpoint)
        const portalRes = await fetch('/api/portal');
        if (portalRes.ok) {
          const portal = await portalRes.json();
          if (portal.ui_theme && portal.ui_theme !== globalTheme) {
            setGlobalThemeState(portal.ui_theme);
            localStorage.setItem(STORAGE_GLOBAL_KEY, portal.ui_theme);
          }
        }

        // Fetch user preference if authenticated
        if (isAuthenticated()) {
          const prefs = await api.get<{ ui_theme: ThemeId | null }>('/me/preferences');
          if (prefs.ui_theme !== userTheme) {
            setUserThemeState(prefs.ui_theme);
            if (prefs.ui_theme) {
              localStorage.setItem(STORAGE_KEY, prefs.ui_theme);
            } else {
              localStorage.removeItem(STORAGE_KEY);
            }
          }
        }
      } catch {
        // Ignore — localStorage values are good enough
      }
    };

    hydrate();
  }, []);

  const setGlobalTheme = (newTheme: ThemeId) => {
    setGlobalThemeState(newTheme);
    localStorage.setItem(STORAGE_GLOBAL_KEY, newTheme);
  };

  const setUserTheme = (newTheme: ThemeId | null) => {
    setUserThemeState(newTheme);
    if (newTheme) {
      localStorage.setItem(STORAGE_KEY, newTheme);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  };

  const setTheme = (newTheme: ThemeId) => {
    // Convenience method — sets user theme
    setUserTheme(newTheme);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme, globalTheme, setGlobalTheme, userTheme, setUserTheme }}>
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
