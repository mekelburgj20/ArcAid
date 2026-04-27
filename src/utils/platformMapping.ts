/**
 * Canonical platform mapping for ArcAid global catalogue.
 * All data sources (VPS, OPDB, IGDB, Wizard, existing ArcAid) normalize
 * to these canonical IDs before storage.
 */

export interface PlatformInfo {
    id: string;
    displayName: string;
    category: 'physical' | 'virtual_pinball' | 'arcade_video';
}

/** Full canonical platform registry */
export const CANONICAL_PLATFORMS: Record<string, PlatformInfo> = {
    // Physical pinball
    real:           { id: 'real',           displayName: 'Real Machine',    category: 'physical' },
    atgames:        { id: 'atgames',        displayName: 'AtGames',         category: 'physical' },
    atgames_hd:     { id: 'atgames_hd',     displayName: 'AtGames HD',      category: 'physical' },
    atgames_4k:     { id: 'atgames_4k',     displayName: 'AtGames 4K',      category: 'physical' },
    atgames_micro:  { id: 'atgames_micro',  displayName: 'AtGames Micro',   category: 'physical' },
    atgames_hdp:    { id: 'atgames_hdp',    displayName: 'AtGames HDP',     category: 'physical' },
    atgames_alu:    { id: 'atgames_alu',    displayName: 'AtGames ALU',     category: 'physical' },
    atgames_mini:   { id: 'atgames_mini',   displayName: 'AtGames Mini',    category: 'physical' },
    atgames_gamer:  { id: 'atgames_gamer',  displayName: 'AtGames Gamer',   category: 'physical' },
    atgames_core:   { id: 'atgames_core',   displayName: 'AtGames Core',    category: 'physical' },

    // Virtual pinball
    vpx:         { id: 'vpx',         displayName: 'Visual Pinball X',   category: 'virtual_pinball' },
    vp9:         { id: 'vp9',         displayName: 'Visual Pinball 9',   category: 'virtual_pinball' },
    vpxs:        { id: 'vpxs',        displayName: 'VPX Standalone',     category: 'virtual_pinball' },
    // v2.4.13: tables from VPX Wizard's "Manual Install" README section.
    // Verified to LOAD on AtGames standalone but often hit-or-miss on
    // performance (low fps, tweaking required). Tagged separately from
    // `vpxs` so tournaments requiring verified-ready standalone tables
    // can exclude them.
    vpxs_manual: { id: 'vpxs_manual', displayName: 'VPX Standalone (Manual Install)', category: 'virtual_pinball' },
    fp:          { id: 'fp',          displayName: 'Future Pinball',     category: 'virtual_pinball' },
    bam:         { id: 'bam',         displayName: 'BAM (FP Mod)',       category: 'virtual_pinball' },
    // Zen Studios — Steam DLC-driven catalogue (April 2026 rebrand).
    // pinball_fx3 was renamed to pinball_fx_classic on Steam; pinball_fx_classic_vr
    // was previously Pinball FX 2 VR; pinball_fx_midnight was Pinball M.
    // Quest-only Pinball FX VR has no DLC API; tables curated manually.
    pinball_fx:             { id: 'pinball_fx',             displayName: 'FX',            category: 'virtual_pinball' },
    pinball_fx_classic:     { id: 'pinball_fx_classic',     displayName: 'FX Classic',    category: 'virtual_pinball' },
    pinball_fx_classic_vr:  { id: 'pinball_fx_classic_vr',  displayName: 'FX Classic VR', category: 'virtual_pinball' },
    pinball_fx_midnight:    { id: 'pinball_fx_midnight',    displayName: 'FX Midnight',   category: 'virtual_pinball' },
    pinball_fx_vr:          { id: 'pinball_fx_vr',          displayName: 'FX VR',         category: 'virtual_pinball' },
    star_wars_pinball_vr:   { id: 'star_wars_pinball_vr',   displayName: 'SW Pinball VR', category: 'virtual_pinball' },
    zaccaria:               { id: 'zaccaria',               displayName: 'Zaccaria',      category: 'virtual_pinball' },
    zaccaria_vr:            { id: 'zaccaria_vr',            displayName: 'Zaccaria VR',   category: 'virtual_pinball' },

    // Arcade & video games
    arcade:      { id: 'arcade',      displayName: 'Arcade',             category: 'arcade_video' },
    nes:         { id: 'nes',         displayName: 'NES',                category: 'arcade_video' },
    snes:        { id: 'snes',        displayName: 'SNES',               category: 'arcade_video' },
    genesis:     { id: 'genesis',     displayName: 'Sega Genesis',       category: 'arcade_video' },
    saturn:      { id: 'saturn',      displayName: 'Sega Saturn',        category: 'arcade_video' },
    n64:         { id: 'n64',         displayName: 'Nintendo 64',        category: 'arcade_video' },
    ps1:         { id: 'ps1',         displayName: 'PlayStation',        category: 'arcade_video' },
    ps2:         { id: 'ps2',         displayName: 'PlayStation 2',      category: 'arcade_video' },
    dreamcast:   { id: 'dreamcast',   displayName: 'Dreamcast',          category: 'arcade_video' },
    gba:         { id: 'gba',         displayName: 'Game Boy Advance',   category: 'arcade_video' },
    gb:          { id: 'gb',          displayName: 'Game Boy',           category: 'arcade_video' },
    gbc:         { id: 'gbc',         displayName: 'Game Boy Color',     category: 'arcade_video' },
    sms:         { id: 'sms',         displayName: 'Sega Master System', category: 'arcade_video' },
    sega_cd:     { id: 'sega_cd',     displayName: 'Sega CD',            category: 'arcade_video' },
    game_gear:   { id: 'game_gear',   displayName: 'Sega Game Gear',     category: 'arcade_video' },
    tg16:        { id: 'tg16',        displayName: 'TurboGrafx-16',      category: 'arcade_video' },
    atari_2600:  { id: 'atari_2600',  displayName: 'Atari 2600',         category: 'arcade_video' },
    atari_7800:  { id: 'atari_7800',  displayName: 'Atari 7800',         category: 'arcade_video' },
    jaguar:      { id: 'jaguar',      displayName: 'Atari Jaguar',       category: 'arcade_video' },
    '3do':       { id: '3do',         displayName: '3DO',                category: 'arcade_video' },
    switch:      { id: 'switch',      displayName: 'Nintendo Switch',    category: 'arcade_video' },
    wii:         { id: 'wii',         displayName: 'Wii',                category: 'arcade_video' },
    pc:          { id: 'pc',          displayName: 'PC',                 category: 'arcade_video' },
};

/** Alias map: known non-canonical names → canonical IDs (case-insensitive lookup) */
const PLATFORM_ALIASES: Record<string, string> = {
    // Current ArcAid values
    'atgames': 'atgames',
    'vpxs': 'vpxs',
    'vpxs_manual': 'vpxs_manual',
    'vpxs-manual': 'vpxs_manual',
    'vpx standalone (manual install)': 'vpxs_manual',
    'irl': 'real',
    // VPS tableFormat values
    'vpx': 'vpx',
    'vp9': 'vp9',
    'fp': 'fp',
    'fx': 'pinball_fx',
    // FX3 → FX Classic rename (Zen rebrand, April 2026). VPS still emits "FX3";
    // pre-rename storage may have 'pinball_fx3' too. Both fold forward.
    'fx3': 'pinball_fx_classic',
    'pinball fx3': 'pinball_fx_classic',
    'pinball_fx3': 'pinball_fx_classic',
    'bam': 'bam',
    // Common variations
    'visual pinball x': 'vpx',
    'visual pinball 9': 'vp9',
    'vpx standalone': 'vpxs',
    'future pinball': 'fp',
    'pinball fx': 'pinball_fx',
    // Zen Steam pinball products (current + historical names)
    'pinball fx classic': 'pinball_fx_classic',
    'pinball fx classic vr': 'pinball_fx_classic_vr',
    'pinball fx 2 vr': 'pinball_fx_classic_vr',
    'pinball fx2 vr': 'pinball_fx_classic_vr',
    'fx 2 vr': 'pinball_fx_classic_vr',
    'pinball fx midnight': 'pinball_fx_midnight',
    'pinball m': 'pinball_fx_midnight',
    'pinball_m': 'pinball_fx_midnight',
    'pinball fx vr': 'pinball_fx_vr',
    'star wars pinball vr': 'star_wars_pinball_vr',
    // Zaccaria
    'zaccaria': 'zaccaria',
    'zaccaria pinball': 'zaccaria',
    'zaccaria vr': 'zaccaria_vr',
    'zaccaria pinball vr': 'zaccaria_vr',
    'real machine': 'real',
    'physical': 'real',
    'playstation': 'ps1',
    'playstation 2': 'ps2',
    'game boy advance': 'gba',
    'game boy': 'gb',
    'game boy color': 'gbc',
    'sega genesis': 'genesis',
    'sega saturn': 'saturn',
    'sega master system': 'sms',
    'sega cd': 'sega_cd',
    'sega game gear': 'game_gear',
    'nintendo 64': 'n64',
    'nintendo switch': 'switch',
    'turbografx-16': 'tg16',
    'turbografx16': 'tg16',
    'atari 2600': 'atari_2600',
    'atari 7800': 'atari_7800',
    'atari jaguar': 'jaguar',
    '3do': '3do',
};

/**
 * Maps any known platform name/alias to its canonical ID.
 * Case-insensitive. Unknown values pass through as lowercase.
 */
export function normalizePlatform(raw: string): string {
    if (!raw) return '';
    const lower = raw.trim().toLowerCase();
    return PLATFORM_ALIASES[lower] || (CANONICAL_PLATFORMS[lower] ? lower : lower);
}

/**
 * Returns the display name for a canonical platform ID.
 * Falls back to the ID itself if unknown.
 */
export function getPlatformDisplay(canonicalId: string): string {
    return CANONICAL_PLATFORMS[canonicalId]?.displayName || canonicalId;
}

/** IGDB numeric platform ID → canonical platform ID */
export const IGDB_PLATFORM_MAP: Record<number, string> = {
    52: 'arcade',
    18: 'nes',
    19: 'snes',
    29: 'genesis',
    32: 'saturn',
    4:  'n64',
    7:  'ps1',
    8:  'ps2',
    23: 'dreamcast',
    24: 'gba',
    33: 'gb',
    22: 'gbc',
    64: 'sms',
    78: 'sega_cd',
    35: 'game_gear',
    51: 'tg16',
    59: 'atari_2600',
    60: 'atari_7800',
    67: 'jaguar',
    87: '3do',
    130: 'switch',
    5:  'wii',
    6:  'pc',
};

/** VPS tableFormat string → canonical platform ID */
export const VPS_FORMAT_MAP: Record<string, string> = {
    'VPX': 'vpx',
    'VP9': 'vp9',
    'FP':  'fp',
    'FX':  'pinball_fx',
    // FX3 was renamed to Pinball FX Classic on Steam (Zen rebrand, April 2026).
    // VPS still emits "FX3"; we normalize forward at import time.
    'FX3': 'pinball_fx_classic',
    'BAM': 'bam',
};

/** Platform groups for UI filter display */
export const PLATFORM_GROUPS = [
    {
        label: 'Physical',
        platforms: ['real', 'atgames', 'atgames_hd', 'atgames_4k'],
    },
    {
        label: 'Virtual Pinball',
        platforms: [
            'vpx', 'vp9', 'vpxs', 'vpxs_manual', 'fp', 'bam',
            'pinball_fx', 'pinball_fx_classic', 'pinball_fx_classic_vr',
            'pinball_fx_midnight', 'pinball_fx_vr', 'star_wars_pinball_vr',
            'zaccaria', 'zaccaria_vr',
        ],
    },
    {
        // VR is a sub-grouping of Virtual Pinball — same IDs may also appear
        // in the Virtual Pinball group for non-VR-aware filter UI.
        label: 'VR',
        platforms: ['pinball_fx_vr', 'pinball_fx_classic_vr', 'star_wars_pinball_vr', 'zaccaria_vr'],
    },
    {
        label: 'Arcade & Video Games',
        platforms: [
            'arcade', 'nes', 'snes', 'genesis', 'saturn', 'n64',
            'ps1', 'ps2', 'dreamcast', 'gba', 'gb', 'gbc',
            'sms', 'sega_cd', 'game_gear', 'tg16',
            'atari_2600', 'atari_7800', 'jaguar', '3do',
            'switch', 'wii', 'pc',
        ],
    },
] as const;

/** All IGDB platform IDs we import from (used in bulk seed query) */
export const IGDB_TARGET_PLATFORMS = Object.keys(IGDB_PLATFORM_MAP).map(Number);
