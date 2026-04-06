import type { ComponentType } from 'react';

export type PodiumVariant = 'pyramid' | 'chip';

export interface ShowcaseThemeConfig {
  id: string;
  name: string;
  description: string;
  googleFontsUrl: string;
  fontFamily: string;
  monoFontFamily: string;

  // Card shell
  cardBg: string;
  cardBorder: string;
  cardBorderRadius: string;
  cardShadow: string;
  backdropFilter?: string;

  // Accent bar at top of card
  accentBar?: string;
  accentBarShadow?: string;

  // Title area
  titleColor: string;
  titleTextShadow?: string;
  badgeBg: string;
  badgeBorder?: string;
  badgeColor: string;
  timerColor: string;
  dividerBg: string;

  // Podium
  podiumVariant: PodiumVariant;
  podiumGold: { bg: string; border: string; textColor: string; scoreColor: string; rankColor: string };
  podiumSilver: { bg: string; border: string; textColor: string; scoreColor: string; rankColor: string };
  podiumBronze: { bg: string; border: string; textColor: string; scoreColor: string; rankColor: string };

  // Score list (ranks 4+)
  rowZebraStripe: string;
  rowHoverBorder?: string;
  rankColor: string;
  nameColor: string;
  scoreColor: string;
  avatarBg: string;
  avatarBorder?: string;
  avatarColor: string;

  // Footer
  footerBorder: string;
  linkColor: string;
  linkLetterSpacing?: string;
  metaColor: string;

  // Optional background decoration component (e.g. circuit board SVG)
  BackgroundDecoration?: ComponentType;
  // Optional scanline overlay
  hasScanlines?: boolean;
  // Optional animated glow nodes
  GlowNodes?: ComponentType;
  // Podium SVG background (neon-circuit chip layout)
  PodiumBackground?: ComponentType;
}

// ═══════════════════════════════════════════
// Glass Deck Theme
// ═══════════════════════════════════════════

const glassDeck: ShowcaseThemeConfig = {
  id: 'glass-deck',
  name: 'Glass Deck',
  description: 'Frosted glass panels, pyramid podium',
  googleFontsUrl: 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap',
  fontFamily: "'DM Sans', sans-serif",
  monoFontFamily: "'DM Mono', monospace",

  cardBg: 'rgba(18,18,24,0.9)',
  cardBorder: '1px solid rgba(255,255,255,0.06)',
  cardBorderRadius: '20px',
  cardShadow: 'none',
  backdropFilter: 'blur(24px)',

  // Thin accent line at top
  accentBar: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent)',

  titleColor: '#ffffff',
  badgeBg: 'rgba(99,210,151,0.1)',
  badgeColor: '#63d297',
  timerColor: 'rgba(255,255,255,0.5)',
  dividerBg: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent)',

  podiumVariant: 'pyramid',
  podiumGold: {
    bg: 'linear-gradient(135deg, rgba(255,215,0,0.1), rgba(255,215,0,0.03))',
    border: '1px solid rgba(255,215,0,0.15)',
    textColor: '#ffffff',
    scoreColor: '#ffd700',
    rankColor: '#ffd700',
  },
  podiumSilver: {
    bg: 'linear-gradient(135deg, rgba(192,192,192,0.08), rgba(192,192,192,0.02))',
    border: '1px solid rgba(192,192,192,0.15)',
    textColor: 'rgba(255,255,255,0.85)',
    scoreColor: '#c0c0c0',
    rankColor: '#a8b4c0',
  },
  podiumBronze: {
    bg: 'linear-gradient(135deg, rgba(205,127,50,0.08), rgba(205,127,50,0.02))',
    border: '1px solid rgba(205,127,50,0.15)',
    textColor: 'rgba(255,255,255,0.85)',
    scoreColor: '#cd7f32',
    rankColor: '#9a7b4f',
  },

  rowZebraStripe: 'rgba(255,255,255,0.03)',
  rankColor: 'rgba(255,255,255,0.5)',
  nameColor: 'rgba(255,255,255,0.85)',
  scoreColor: 'rgba(255,255,255,0.7)',
  avatarBg: 'rgba(255,255,255,0.08)',
  avatarColor: 'rgba(255,255,255,0.5)',

  footerBorder: 'rgba(255,255,255,0.08)',
  linkColor: 'rgba(99,210,151,0.8)',
  metaColor: 'rgba(255,255,255,0.4)',
};

// ═══════════════════════════════════════════
// Neon Circuit Theme
// ═══════════════════════════════════════════

const neonCircuit: ShowcaseThemeConfig = {
  id: 'neon-circuit',
  name: 'Neon Circuit',
  description: 'Circuit board aesthetic, chip podium',
  googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;600;700;900&family=Share+Tech+Mono&display=swap',
  fontFamily: "'Orbitron', sans-serif",
  monoFontFamily: "'Share Tech Mono', monospace",

  cardBg: 'linear-gradient(180deg, #080818 0%, #0a0520 50%, #080818 100%)',
  cardBorder: '1px solid rgba(120,0,255,0.25)',
  cardBorderRadius: '16px',
  cardShadow: '0 0 50px rgba(120,0,255,0.1), 0 0 100px rgba(255,0,200,0.04)',

  accentBar: 'linear-gradient(90deg, #7b00ff, #ff00c8, #00e0ff, #ff00c8, #7b00ff)',
  accentBarShadow: '0 0 15px rgba(255,0,200,0.4), 0 2px 20px rgba(120,0,255,0.3)',

  titleColor: '#ffffff',
  titleTextShadow: '0 0 12px rgba(255,0,200,0.25)',
  badgeBg: 'rgba(120,0,255,0.15)',
  badgeBorder: '1px solid rgba(120,0,255,0.3)',
  badgeColor: '#c77dff',
  timerColor: 'rgba(255,255,255,0.5)',
  dividerBg: 'linear-gradient(90deg, transparent, rgba(120,0,255,0.2), rgba(0,224,255,0.12), rgba(255,0,200,0.2), transparent)',

  podiumVariant: 'chip',
  podiumGold: {
    bg: 'transparent',
    border: 'none',
    textColor: '#ffffff',
    scoreColor: '#ff69d6',
    rankColor: '#ffd700',
  },
  podiumSilver: {
    bg: 'transparent',
    border: 'none',
    textColor: 'rgba(255,255,255,0.85)',
    scoreColor: '#c0c0c0',
    rankColor: '#c0c0c0',
  },
  podiumBronze: {
    bg: 'transparent',
    border: 'none',
    textColor: 'rgba(255,255,255,0.85)',
    scoreColor: '#cd7f32',
    rankColor: '#cd7f32',
  },

  rowZebraStripe: 'rgba(120,0,255,0.04)',
  rowHoverBorder: 'rgba(255,0,200,0.35)',
  rankColor: 'rgba(255,255,255,0.55)',
  nameColor: 'rgba(255,255,255,0.85)',
  scoreColor: 'rgba(255,255,255,0.7)',
  avatarBg: 'rgba(120,0,255,0.1)',
  avatarBorder: '1px solid rgba(120,0,255,0.2)',
  avatarColor: 'rgba(255,255,255,0.6)',

  footerBorder: 'rgba(120,0,255,0.15)',
  linkColor: '#c77dff',
  linkLetterSpacing: '1px',
  metaColor: 'rgba(255,255,255,0.15)',

  hasScanlines: true,
};

// ═══════════════════════════════════════════
// Registry
// ═══════════════════════════════════════════

export const SHOWCASE_THEMES: Record<string, ShowcaseThemeConfig> = {
  'glass-deck': glassDeck,
  'neon-circuit': neonCircuit,
};

export const DEFAULT_SHOWCASE_THEME = 'glass-deck';

export type ScoreboardStyle = 'banner' | 'showcase' | 'minimal';

export const STYLE_WIDTHS: Record<ScoreboardStyle, number> = {
  banner: 280,
  showcase: 380,
  minimal: 380,
};

export const STYLE_LABELS: Record<ScoreboardStyle, { label: string; description: string }> = {
  banner: { label: 'Banner', description: 'iScored-compatible cards with background images' },
  showcase: { label: 'Showcase', description: 'Premium art-forward cards with podium' },
  minimal: { label: 'Minimal', description: 'Clean typography, no images' },
};
