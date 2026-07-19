/**
 * v2.5.1 — FE-side mirror of `src/utils/platformMapping.ts`.
 *
 * Kept manually in sync with the backend canonical platform map so UI code
 * can render `displayName` for any raw platform id it receives from the API.
 * Aliases let us normalize legacy mixed-case data (`VPX` / `vpx` / `FX3`)
 * without forcing a DB migration.
 *
 * Source of truth is the backend file. When you add or rename a platform
 * there, mirror the change here.
 */

const DISPLAY_NAMES: Record<string, string> = {
    real:          'Real Machine',
    // v2.13.6: AtGames cabinet variants moved to features (see backend
    // migration 101). Only the umbrella `atgames` remains a canonical platform.
    atgames:       'AtGames',

    vpx:         'Visual Pinball X',
    vp9:         'Visual Pinball 9',
    vpxs:        'VPX Standalone',
    vpxs_manual: 'VPX Standalone (Manual Install)',
    fp:          'Future Pinball',
    bam:         'BAM (FP Mod)',

    pinball_fx:            'FX',
    pinball_fx_classic:    'FX Classic',
    pinball_fx_classic_vr: 'FX Classic VR',
    pinball_fx_midnight:   'FX Midnight',
    pinball_fx_vr:         'FX VR',
    star_wars_pinball_vr:  'SW Pinball VR',
    zaccaria:              'Zaccaria',
    zaccaria_vr:           'Zaccaria VR',

    arcade:      'Arcade',
    nes:         'NES',
    snes:        'SNES',
    genesis:     'Sega Genesis',
    saturn:      'Sega Saturn',
    n64:         'Nintendo 64',
    ps1:         'PlayStation',
    ps2:         'PlayStation 2',
    dreamcast:   'Dreamcast',
    gba:         'Game Boy Advance',
    gb:          'Game Boy',
    gbc:         'Game Boy Color',
    sms:         'Sega Master System',
    sega_cd:     'Sega CD',
    game_gear:   'Sega Game Gear',
    tg16:        'TurboGrafx-16',
    atari_2600:  'Atari 2600',
    atari_7800:  'Atari 7800',
    jaguar:      'Atari Jaguar',
    '3do':       '3DO',
    switch:      'Nintendo Switch',
    wii:         'Wii',
    pc:          'PC',
};

/**
 * Maps known non-canonical names (case-insensitive) → canonical IDs.
 * Mirrors the backend `PLATFORM_ALIASES`. Used to fold legacy mixed-case
 * data (`VPX`, `FX3`, `Pinball FX3`) onto canonical IDs at render time.
 */
const ALIASES: Record<string, string> = {
    'fx3':                    'pinball_fx_classic',
    'pinball fx3':            'pinball_fx_classic',
    'pinball_fx3':            'pinball_fx_classic',
    'fx':                     'pinball_fx',
    'pinball fx':             'pinball_fx',
    'pinball fx classic':     'pinball_fx_classic',
    'pinball fx classic vr':  'pinball_fx_classic_vr',
    'pinball fx 2 vr':        'pinball_fx_classic_vr',
    'pinball fx2 vr':         'pinball_fx_classic_vr',
    'fx 2 vr':                'pinball_fx_classic_vr',
    'pinball fx midnight':    'pinball_fx_midnight',
    'pinball m':              'pinball_fx_midnight',
    'pinball_m':              'pinball_fx_midnight',
    'pinball fx vr':          'pinball_fx_vr',
    'star wars pinball vr':   'star_wars_pinball_vr',
    'zaccaria':               'zaccaria',
    'zaccaria pinball':       'zaccaria',
    'zaccaria vr':            'zaccaria_vr',
    'zaccaria pinball vr':    'zaccaria_vr',
    'irl':                    'real',
    'real machine':           'real',
    'physical':               'real',
};

/**
 * Map any raw platform string (canonical id, alias, mixed case) to its
 * canonical id. Unknown values lowercase through.
 */
export function normalizePlatform(raw: string): string {
    if (!raw) return '';
    const lower = raw.trim().toLowerCase();
    return ALIASES[lower] || (DISPLAY_NAMES[lower] ? lower : lower);
}

/**
 * Display name for a canonical id (or any alias). Known canonicals render
 * with their curated label (e.g. "Visual Pinball X"). Unknown / legacy
 * tokens (`fx2`, `vr`, etc.) fall back to an uppercased form so chips read
 * "FX2" / "VR" rather than the raw lowercase id.
 */
export function getPlatformDisplay(raw: string | null | undefined): string {
    if (!raw) return '';
    const id = normalizePlatform(raw);
    return DISPLAY_NAMES[id] || raw.toUpperCase();
}

/**
 * S17 — short chip labels ("VPX", "FX Classic") for dense UI, complementing
 * the long `DISPLAY_NAMES` ("Visual Pinball X"). Previously GlobalScoreboard
 * kept its own third copy of the taxonomy; these exports retire it.
 */
const SHORT_LABELS: Record<string, string> = {
    real: 'Real', atgames: 'AtGames',
    vpx: 'VPX', vp9: 'VP9', vpxs: 'VPXS', vpxs_manual: 'VPXS Manual',
    fp: 'Future Pinball', bam: 'BAM',
    pinball_fx: 'FX', pinball_fx_classic: 'FX Classic',
    pinball_fx_classic_vr: 'FX Classic VR', pinball_fx_midnight: 'FX Midnight',
    pinball_fx_vr: 'FX VR', star_wars_pinball_vr: 'SW Pinball VR',
    zaccaria: 'Zaccaria', zaccaria_vr: 'Zaccaria VR',
    arcade: 'Arcade', nes: 'NES', snes: 'SNES', genesis: 'Genesis', saturn: 'Saturn',
    n64: 'N64', ps1: 'PS1', ps2: 'PS2', dreamcast: 'Dreamcast',
    gba: 'GBA', gb: 'Game Boy', gbc: 'GBC', sms: 'SMS', sega_cd: 'Sega CD',
    game_gear: 'Game Gear', tg16: 'TG-16', atari_2600: 'Atari 2600', atari_7800: 'Atari 7800',
    jaguar: 'Jaguar', '3do': '3DO', switch: 'Switch', wii: 'Wii', pc: 'PC',
};

/** Short chip label for any raw platform token (alias-folded; unknown → uppercased). */
export function getPlatformShortLabel(raw: string | null | undefined): string {
    if (!raw) return '';
    const id = normalizePlatform(raw);
    return SHORT_LABELS[id] || getPlatformDisplay(raw);
}

/**
 * S17 — canonical platform grouping for filters, mirroring the backend's
 * category taxonomy (physical / virtual_pinball / arcade_video — see
 * `src/utils/platformMapping.ts`). Keys keep GlobalScoreboard's historical
 * names so its filter URLs/state stay stable. Membership is the CURRENT
 * canonical id set — the retired local copy predated the FX-family split and
 * silently failed to match `pinball_fx_classic`-era ids. Match against
 * `normalizePlatform`-folded ids.
 */
export const PLATFORM_GROUPS: Record<string, { label: string; platforms: string[] }> = {
    physical: { label: 'Physical', platforms: ['real', 'atgames'] },
    vpin: {
        label: 'Virtual Pinball',
        platforms: [
            'vpx', 'vp9', 'vpxs', 'vpxs_manual', 'fp', 'bam',
            'pinball_fx', 'pinball_fx_classic', 'pinball_fx_classic_vr',
            'pinball_fx_midnight', 'pinball_fx_vr', 'star_wars_pinball_vr',
            'zaccaria', 'zaccaria_vr',
        ],
    },
    video: {
        label: 'Arcade & Video',
        platforms: [
            'arcade', 'nes', 'snes', 'genesis', 'saturn', 'n64', 'ps1', 'ps2',
            'dreamcast', 'gba', 'gb', 'gbc', 'sms', 'sega_cd', 'game_gear',
            'tg16', 'atari_2600', 'atari_7800', 'jaguar', '3do', 'switch', 'wii', 'pc',
        ],
    },
};

/**
 * Normalize an array of raw platform strings: alias-fold, drop blanks,
 * dedupe on canonical id (preserving first-seen order). Returns the
 * canonical id list — pair with `getPlatformDisplay` for rendering.
 */
export function normalizePlatformList(raw: string[] | null | undefined): string[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of raw) {
        const id = normalizePlatform(p);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}
