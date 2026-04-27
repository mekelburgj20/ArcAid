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
    atgames:       'AtGames',
    atgames_hd:    'AtGames HD',
    atgames_4k:    'AtGames 4K',
    atgames_micro: 'AtGames Micro',
    atgames_hdp:   'AtGames HDP',
    atgames_alu:   'AtGames ALU',
    atgames_mini:  'AtGames Mini',
    atgames_gamer: 'AtGames Gamer',
    atgames_core:  'AtGames Core',

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
