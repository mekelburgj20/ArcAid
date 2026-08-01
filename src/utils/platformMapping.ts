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
    // v2.13.6: AtGames cabinet variants (HD/4K/Micro/HDP/ALU/Mini/Gamer/Core)
    // moved off the canonical platform list and into `global_games.features`.
    // Tournament eligibility doesn't care which specific AtGames cabinet a
    // table is available on — the umbrella `atgames` is the player-meaningful
    // distinction. Cabinet-availability still lives in `features` for a
    // future "filter by my cabinet" catalogue UX (see migration 101).
    atgames:        { id: 'atgames',        displayName: 'AtGames',         category: 'physical' },

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

/**
 * IGDB numeric platform ID → canonical platform ID (TRANSLATION map).
 *
 * This is the "what does IGDB id N mean" table. It is deliberately WIDER than
 * the fetch filter (`IGDB_TARGET_PLATFORMS` below): a retro game that also
 * shipped on PC/Switch/Wii should still carry those canonical ids on its
 * catalogue row, even though we don't crawl IGDB *for* PC/Switch/Wii titles.
 *
 * igdb-import-hardening (2026-08): three ids were flat-out wrong against
 * IGDB's documented platform list and were silently mislabelling every game
 * they touched. Corrections, with the ids IGDB actually uses:
 *   - 51 was mapped to `tg16` — 51 is **Famicom Disk System**. TurboGrafx-16
 *     is 86. Removed rather than remapped: FDS is a niche Japan-only add-on
 *     and folding it into `nes` would mislabel the rows.
 *   - 67 was mapped to `jaguar` — 67 is **Intellivision**. Jaguar is 62.
 *     Intellivision has no canonical engine, so it is dropped entirely.
 *   - 87 was mapped to `3do` — 87 is **Virtual Boy**. 3DO is 50. Virtual Boy
 *     has no canonical engine, so it is dropped entirely.
 *
 * When adding an id, add its IGDB-documented name to `IGDB_PLATFORM_NAMES`
 * too — the importer verifies the pair against the live API at run start.
 */
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
    86: 'tg16',
    59: 'atari_2600',
    60: 'atari_7800',
    62: 'jaguar',
    50: '3do',
    130: 'switch',
    5:  'wii',
    6:  'pc',
};

/**
 * IGDB's own `name` for each mapped platform id, as documented on its
 * `/platforms` endpoint. Used ONLY by the importer's start-of-run verification
 * pass, which fetches the live `/platforms` rows and WARNs on any mismatch —
 * cheap insurance against a repeat of the 51/67/87 mislabelling above.
 * Not used for translation; a mismatch never aborts the import.
 */
export const IGDB_PLATFORM_NAMES: Record<number, string> = {
    52: 'Arcade',
    18: 'Nintendo Entertainment System',
    19: 'Super Nintendo Entertainment System',
    29: 'Sega Mega Drive/Genesis',
    32: 'Sega Saturn',
    4:  'Nintendo 64',
    7:  'PlayStation',
    8:  'PlayStation 2',
    23: 'Dreamcast',
    24: 'Game Boy Advance',
    33: 'Game Boy',
    22: 'Game Boy Color',
    64: 'Sega Master System/Mark III',
    78: 'Sega CD',
    35: 'Sega Game Gear',
    86: 'TurboGrafx-16/PC Engine',
    59: 'Atari 2600',
    60: 'Atari 7800',
    62: 'Atari Jaguar',
    50: '3DO Interactive Multiplayer',
    130: 'Nintendo Switch',
    5:  'Wii',
    6:  'PC (Microsoft Windows)',
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
        platforms: ['real', 'atgames'],
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
        // v2.58.0 (ADR 0016): renamed from "Arcade & Video Games" to match the
        // FE label, which had already drifted to "Arcade & Video". `arcade` is
        // a live platform id, so the word could not stay in the group name.
        label: 'Video Games',
        platforms: [
            'arcade', 'nes', 'snes', 'genesis', 'saturn', 'n64',
            'ps1', 'ps2', 'dreamcast', 'gba', 'gb', 'gbc',
            'sms', 'sega_cd', 'game_gear', 'tg16',
            'atari_2600', 'atari_7800', 'jaguar', '3do',
            'switch', 'wii', 'pc',
        ],
    },
] as const;

/**
 * IGDB platform ids EXCLUDED from the bulk-import fetch filter.
 *
 * igdb-import-hardening (2026-08): fetch scope and translation scope are now
 * separate concerns. These three are the modern general-purpose platforms —
 * crawling them would pull tens of thousands of non-retro titles that nobody
 * is setting an arcade high score on, and they are the reason a full bulk run
 * was never going to finish. They stay in `IGDB_PLATFORM_MAP` so a retro game
 * that ALSO shipped on them keeps the tag on its catalogue row.
 *
 * **This is the one-line knob for import scope.** Widening the crawl (e.g.
 * "we do want Switch after all") means deleting an entry here — nothing else.
 */
const IGDB_NON_TARGET_PLATFORMS: readonly number[] = [
    6,   // PC (Microsoft Windows)
    130, // Nintendo Switch
    5,   // Wii
];

/**
 * IGDB platform ids the bulk seed actually crawls (the `where platforms = (...)`
 * filter). Derived: every translated platform minus the non-targets above —
 * retro consoles + arcade only.
 */
export const IGDB_TARGET_PLATFORMS = Object.keys(IGDB_PLATFORM_MAP)
    .map(Number)
    .filter(id => !IGDB_NON_TARGET_PLATFORMS.includes(id));
