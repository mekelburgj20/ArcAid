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
    real:        { id: 'real',        displayName: 'Real Machine',       category: 'physical' },
    atgames:     { id: 'atgames',     displayName: 'AtGames Legends',    category: 'physical' },
    atgames_hd:  { id: 'atgames_hd',  displayName: 'AtGames Legends HD', category: 'physical' },
    atgames_4k:  { id: 'atgames_4k',  displayName: 'AtGames Legends 4K', category: 'physical' },

    // Virtual pinball
    vpx:         { id: 'vpx',         displayName: 'Visual Pinball X',   category: 'virtual_pinball' },
    vp9:         { id: 'vp9',         displayName: 'Visual Pinball 9',   category: 'virtual_pinball' },
    vpxs:        { id: 'vpxs',        displayName: 'VPX Standalone',     category: 'virtual_pinball' },
    fp:          { id: 'fp',          displayName: 'Future Pinball',     category: 'virtual_pinball' },
    bam:         { id: 'bam',         displayName: 'BAM (FP Mod)',       category: 'virtual_pinball' },
    pinball_fx:  { id: 'pinball_fx',  displayName: 'Pinball FX',         category: 'virtual_pinball' },
    pinball_fx3: { id: 'pinball_fx3', displayName: 'Pinball FX3',        category: 'virtual_pinball' },
    vr:          { id: 'vr',          displayName: 'VR Pinball',         category: 'virtual_pinball' },

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
    'vr': 'vr',
    'irl': 'real',
    // VPS tableFormat values
    'vpx': 'vpx',
    'vp9': 'vp9',
    'fp': 'fp',
    'fx': 'pinball_fx',
    'fx3': 'pinball_fx3',
    'bam': 'bam',
    // Common variations
    'visual pinball x': 'vpx',
    'visual pinball 9': 'vp9',
    'vpx standalone': 'vpxs',
    'future pinball': 'fp',
    'pinball fx': 'pinball_fx',
    'pinball fx3': 'pinball_fx3',
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
    'FX3': 'pinball_fx3',
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
        platforms: ['vpx', 'vp9', 'vpxs', 'fp', 'bam', 'pinball_fx', 'pinball_fx3', 'vr'],
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
