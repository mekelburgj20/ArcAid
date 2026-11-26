import { createContext } from 'react';
import { deriveScoreboardConfig, type ScoreboardConfig } from '../../lib/scoreboardConfig';
import { SHOWCASE_THEMES } from '../../lib/scoreboardThemes';
import type { DisplayPrefsDevice } from '../../lib/displaySettingsLive';

/**
 * G34a - what the Display settings panel knows about the viewer's card
 * settings: the keys it saves, how a row reads its value, and the choices.
 * Not a component module (react-refresh), so the panel's files import it.
 */

/**
 * Every key the panel posts, exactly as the old sheet's Save did: each one
 * with its value or `null`, which the server deletes (it leaves an absent key
 * alone, so a bare `{}` would clear nothing). `UI_THEME` is always `null`: the
 * retired per-device room theme (v2.132.0), swept out on every save.
 */
export const SAVED_KEYS = [
  'UI_THEME',
  'SCOREBOARD_STYLE',
  'SCOREBOARD_THEME',
  'SCOREBOARD_HIDE_EMPTY',
  'SCOREBOARD_TITLE_HIDDEN',
  'SCOREBOARD_LOGO_ENABLED',
  'SCOREBOARD_CARD_BG_FILL',
  'SCOREBOARD_GAME_HEADER_ENABLED',
  'SCOREBOARD_RANKINGS_STICKY',
  'SCOREBOARD_SHOW_TIMER',
  'SCOREBOARD_LAYOUT',
  'SCOREBOARD_QR_MODE',
  'SCOREBOARD_RANKINGS_POSITION',
  'SCOREBOARD_RANKINGS_STYLE',
  'SCOREBOARD_QR_POSITION',
  'SCOREBOARD_GAME_TITLE_STYLE',
  'SCOREBOARD_MAX_SCORES',
  'SCOREBOARD_MIN_SCORES',
  'SCOREBOARD_CARD_SPACING',
  'SCOREBOARD_TITLE_FONT_SIZE',
  'SCOREBOARD_QR_SIZE',
  'SCOREBOARD_QR_OFFSET_PX',
  'SCOREBOARD_MOBILE_VERTICAL',
  'SCOREBOARD_MOBILE_SCALE',
  'SCOREBOARD_ZOOM',
] as const;

/** The keys a viewer can set here (every saved key but the retired one). */
export const CARD_KEYS: readonly string[] = SAVED_KEYS.filter(k => k !== 'UI_THEME');

export type Prefs = Record<string, string>;

/** The POST body: every saved key, `null` where unset. */
export function buildPayload(prefs: Prefs): Record<string, string | null> {
  const payload: Record<string, string | null> = {};
  for (const key of SAVED_KEYS) payload[key] = key === 'UI_THEME' ? null : (prefs[key] ?? null);
  return payload;
}

/** True when the viewer has any card setting of their own on this device. */
export function hasCardSettings(prefs: Prefs): boolean {
  return CARD_KEYS.some(k => prefs[k] != null && prefs[k] !== '');
}

/** The map without the viewer's card settings ("Room defaults"); other stored keys stay. */
export function withoutCardSettings(prefs: Prefs): Prefs {
  const next: Prefs = { ...prefs };
  for (const key of CARD_KEYS) delete next[key];
  return next;
}

/** `changes`' values set, its `null`s removed. */
export function applyChanges(prefs: Prefs, changes: Record<string, string | null>): Prefs {
  const next: Prefs = { ...prefs };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

export function samePrefs(a: Prefs, b: Prefs): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every(k => a[k] === b[k]);
}

/** Everything a section needs to draw the card settings. */
export interface CardModel {
  device: DisplayPrefsDevice;
  prefs: Prefs;
  /** The room's settings with the viewer's over them, and the room's alone. */
  mineRaw: Prefs;
  roomRaw: Prefs;
  /** The same, as the scoreboard reads them (the code's own defaults filled in). */
  mine: ScoreboardConfig;
  room: ScoreboardConfig;
}

/** Change keys (`null` clears one): live on the page at once, saved shortly after. */
export type CardSetter = (changes: Record<string, string | null>) => void;

/** The panel's `CardSetter`, for every row (a context: a callback, never part of the drawn data). */
export const CardSetContext = createContext<CardSetter>(() => {});

export function cardModel(device: DisplayPrefsDevice, prefs: Prefs, roomRaw: Prefs): CardModel {
  const mineRaw = { ...roomRaw, ...prefs };
  return { device, prefs, mineRaw, roomRaw, mine: deriveScoreboardConfig(mineRaw), room: deriveScoreboardConfig(roomRaw) };
}

/** What More holds, as its collapsed row lists it. */
export function moreSummary(device: DisplayPrefsDevice): string {
  return device === 'desktop'
    ? 'room title and logo, empty games, countdown, title style, spacing, card height, title size, rankings, QR codes'
    : 'room title and logo, empty games, countdown, title style, spacing, card height, title size, rankings';
}

/**
 * A row is marked as the viewer's own (the lit dot, Reset, "Room: ...") when
 * they stored one of its keys AND what they see differs from the room's. A
 * value that only follows another setting (the card height following scores
 * per card) is not theirs to reset.
 */
export function rowChanged(prefs: Prefs, keys: readonly string[], mine: string, room: string): boolean {
  return keys.some(k => prefs[k] != null) && mine !== room;
}

export interface Choice {
  value: string;
  label: string;
}

export function labelOf(choices: readonly Choice[], value: string): string {
  return choices.find(c => c.value === value)?.label ?? value;
}

// Style-system revamp Phase 1: Arcade leads, as in the admin picker. This list
// is a SECOND hardcoded copy of the style set (the admin one lives in
// StyleThemePicker); a style missing here is silently unavailable to viewers.
export const STYLE_CHOICES: readonly (Choice & { caption: string })[] = [
  { value: 'arcade', label: 'Arcade', caption: 'Neon art cards with a podium' },
  { value: 'banner', label: 'Banner', caption: 'Background images' },
  { value: 'showcase', label: 'Showcase', caption: 'Art-forward with podium' },
  { value: 'minimal', label: 'Minimal', caption: 'Typography only' },
];

export const SHOWCASE_CHOICES: readonly (Choice & { caption: string })[] = Object.entries(SHOWCASE_THEMES).map(([id, cfg]) => ({
  value: id,
  label: cfg.name || id,
  caption: cfg.description || '',
}));

/**
 * Game art: one choice for the two switches it takes (G34a). The art fills
 * the card only while `SCOREBOARD_CARD_BG_FILL` is on, whatever the header
 * says, so a stored fill-on / header-off reads as Full card. Minimal draws no
 * header art at all: there Header and None look the same.
 */
export const ART_CHOICES: readonly Choice[] = [
  { value: 'full', label: 'Full card' },
  { value: 'header', label: 'Header' },
  { value: 'none', label: 'None' },
];
export const ART_KEYS = ['SCOREBOARD_CARD_BG_FILL', 'SCOREBOARD_GAME_HEADER_ENABLED'] as const;

export function artOf(c: ScoreboardConfig): string {
  if (c.cardBgFill) return 'full';
  return c.gameHeaderEnabled ? 'header' : 'none';
}

export function artWrite(value: string): Record<string, string> {
  if (value === 'full') return { SCOREBOARD_CARD_BG_FILL: 'true', SCOREBOARD_GAME_HEADER_ENABLED: 'true' };
  if (value === 'header') return { SCOREBOARD_CARD_BG_FILL: 'false', SCOREBOARD_GAME_HEADER_ENABLED: 'true' };
  return { SCOREBOARD_CARD_BG_FILL: 'false', SCOREBOARD_GAME_HEADER_ENABLED: 'false' };
}

export const DESKTOP_LAYOUT_CHOICES: readonly Choice[] = [
  { value: 'scroll', label: 'Side-scroll' },
  { value: 'vertical', label: 'Stacked' },
  { value: 'grid', label: 'Grid' },
];

/** The phone's layout is `SCOREBOARD_MOBILE_VERTICAL` (on unless stored off). */
export const MOBILE_LAYOUT_CHOICES: readonly Choice[] = [
  { value: 'true', label: 'Stacked' },
  { value: 'false', label: 'Side-scroll' },
];

export const SHOWN_CHOICES: readonly Choice[] = [
  { value: 'shown', label: 'Shown' },
  { value: 'hidden', label: 'Hidden' },
];

export const ON_OFF_CHOICES: readonly Choice[] = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

export const QR_POSITION_CHOICES: readonly Choice[] = [
  { value: 'top-center', label: 'Top' },
  { value: 'bottom-center', label: 'Bottom' },
];

export const RANKINGS_POSITION_CHOICES: readonly Choice[] = [
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
  { value: 'top', label: 'Top' },
  { value: 'bottom', label: 'Bottom' },
  { value: 'hidden', label: 'Hidden' },
];

export const RANKINGS_STYLE_CHOICES: readonly Choice[] = [
  { value: 'match', label: 'Match the cards' },
  { value: 'plaque', label: 'Plaque' },
  { value: 'compact', label: 'Compact list' },
  { value: 'sidebar', label: 'Sidebar block' },
  { value: 'ticker', label: 'Scrolling ticker' },
];

export const TITLE_STYLE_CHOICES: readonly Choice[] = [
  { value: 'default', label: 'Default' },
  { value: 'glow', label: 'Neon Cyan' },
  { value: 'neon-magenta', label: 'Neon Magenta' },
  { value: 'chrome', label: 'Chrome' },
  { value: 'fire', label: 'Fire' },
  { value: 'plasma', label: 'Plasma' },
  { value: 'backglass', label: 'Backglass' },
  { value: 'marquee', label: 'Marquee' },
  { value: 'retro', label: 'Retro' },
  { value: 'pixel', label: 'Pixel' },
  { value: 'shadow', label: 'Shadow' },
  { value: 'arcade-red', label: 'Arcade Red' },
  { value: 'arcade-cyan', label: 'Arcade Cyan' },
  { value: 'arcade-amber', label: 'Arcade Amber' },
  { value: 'arcade-green', label: 'Arcade Green' },
  { value: 'holo', label: 'Holo Sweep' },
  { value: 'outlined', label: 'Outlined' },
];

/** The number ranges: today's sheet's, so no value it could store is out of reach. */
export const RANGES = {
  maxScores: { min: 1, max: 50, step: 1 },
  minScores: { min: 1, max: 50, step: 1 },
  cardSpacing: { min: 0, max: 100, step: 4 },
  titleFontSize: { min: 0, max: 72, step: 2 },
  qrSize: { min: 16, max: 200, step: 2 },
  qrOffset: { min: -200, max: 200, step: 2 },
  zoom: { min: 50, max: 150, step: 5 },
  mobileScale: { min: 0.3, max: 1, step: 0.05 },
} as const;

/** `SCOREBOARD_LOGO_ENABLED` shows the logo unless it is stored as `false`. */
export function logoShown(raw: Prefs): boolean {
  return raw.SCOREBOARD_LOGO_ENABLED !== 'false';
}

/** QR codes on this page: only `all` shows them; a stored `kiosk-only` is off here. */
export function qrOn(c: ScoreboardConfig): boolean {
  return c.qrMode === 'all';
}

export function percent(n: number): string {
  return `${Math.round(n)}%`;
}
