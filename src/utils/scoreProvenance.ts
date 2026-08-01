/**
 * Engine + Device score provenance — backend source of truth (ADR 0016).
 *
 * A score's `platform` conflated two questions: *what produced it* (the engine)
 * and *what it ran on* (the device). AtGames made that undeniable — one cabinet
 * runs VPX, Zen FX, Zaccaria and AtGames-native tables, so `atgames` says
 * nothing about comparability. ADR 0016 splits the two axes:
 *
 *   engine → comparability (leaderboard grouping, fidelity categories)
 *   device → provenance / flavour (displayed, filterable, never a boundary)
 *
 * IMPORTANT — this file is mirrored verbatim at
 * `admin-ui/src/lib/scoreProvenance.ts`. The mirror is guarded by a parity test
 * (`src/__tests__/scoreProvenance-parity.test.ts`) that deep-compares engine
 * ids, device ids, display labels, the compat map and the legacy map, and FAILS
 * on any drift. The predecessor mirror (`platformMapping.ts` ↔
 * `admin-ui/src/lib/platforms.ts`) had no such test and silently drifted to 22
 * of 53 aliases — do not repeat that. Keep this file dependency-free so the two
 * copies can stay byte-identical below the header comment.
 *
 * Phase 1 (v2.53.0) writes both columns on every score-write path. Read paths
 * still use the legacy `platform` column, so writers also derive a legacy
 * platform id from (engine, device) — see `deriveLegacyPlatform`.
 */

// ─── Engines ────────────────────────────────────────────────────────────────

/**
 * Fidelity category, derived from the ENGINE alone (ADR 0016). `video` sits
 * outside the pinball fidelity axis entirely.
 */
export type EngineCategory = 'real' | 'simulation' | 'arcade_style' | 'video';

export interface EngineInfo {
    id: string;
    displayName: string;
    /**
     * Dense-UI label (card pills, leaderboard row tags). `displayName` is the
     * prose form; this is what fits in a 9px uppercase chip.
     */
    shortLabel: string;
    category: EngineCategory;
}

/**
 * Canonical engines. Absorbs the conflated ids from the old platform list:
 * `vpxs`/`vpxs_manual` → `vpx` (ports of VPX tables; physics and rulesets are
 * unchanged so the scores are comparable), `bam` → `fp` (BAM is a table
 * requirement, not an engine), and every `*_vr` id loses its device half.
 *
 * Engine ids and device ids live in SEPARATE namespaces — `pc` is both a video
 * engine ("a PC game") and a device. Never look one up in the other's map.
 */
export const CANONICAL_ENGINES: Record<string, EngineInfo> = {
    // Physical
    real:           { id: 'real',           displayName: 'Real Machine',        shortLabel: 'Real',           category: 'real' },

    // Simulation
    vpx:            { id: 'vpx',            displayName: 'Visual Pinball X',    shortLabel: 'VPX',            category: 'simulation' },
    vp9:            { id: 'vp9',            displayName: 'Visual Pinball 9',    shortLabel: 'VP9',            category: 'simulation' },
    fp:             { id: 'fp',             displayName: 'Future Pinball',      shortLabel: 'Future Pinball', category: 'simulation' },

    // Arcade-style
    fx:             { id: 'fx',             displayName: 'Pinball FX',          shortLabel: 'FX',             category: 'arcade_style' },
    fx_classic:     { id: 'fx_classic',     displayName: 'Pinball FX Classic',  shortLabel: 'FX Classic',     category: 'arcade_style' },
    fx_midnight:    { id: 'fx_midnight',    displayName: 'Pinball M',           shortLabel: 'Pinball M',      category: 'arcade_style' },
    zaccaria:       { id: 'zaccaria',       displayName: 'Zaccaria',            shortLabel: 'Zaccaria',       category: 'arcade_style' },
    star_wars:      { id: 'star_wars',      displayName: 'Star Wars Pinball',   shortLabel: 'SW Pinball',     category: 'arcade_style' },
    atgames_native: { id: 'atgames_native', displayName: 'AtGames Native',      shortLabel: 'AtGames Native', category: 'arcade_style' },

    // Video games — unchanged from the legacy platform ids (ADR 0016).
    arcade:      { id: 'arcade',      displayName: 'Arcade',             shortLabel: 'Arcade',      category: 'video' },
    nes:         { id: 'nes',         displayName: 'NES',                shortLabel: 'NES',         category: 'video' },
    snes:        { id: 'snes',        displayName: 'SNES',               shortLabel: 'SNES',        category: 'video' },
    genesis:     { id: 'genesis',     displayName: 'Sega Genesis',       shortLabel: 'Genesis',     category: 'video' },
    saturn:      { id: 'saturn',      displayName: 'Sega Saturn',        shortLabel: 'Saturn',      category: 'video' },
    n64:         { id: 'n64',         displayName: 'Nintendo 64',        shortLabel: 'N64',         category: 'video' },
    ps1:         { id: 'ps1',         displayName: 'PlayStation',        shortLabel: 'PS1',         category: 'video' },
    ps2:         { id: 'ps2',         displayName: 'PlayStation 2',      shortLabel: 'PS2',         category: 'video' },
    dreamcast:   { id: 'dreamcast',   displayName: 'Dreamcast',          shortLabel: 'Dreamcast',   category: 'video' },
    gba:         { id: 'gba',         displayName: 'Game Boy Advance',   shortLabel: 'GBA',         category: 'video' },
    gb:          { id: 'gb',          displayName: 'Game Boy',           shortLabel: 'Game Boy',    category: 'video' },
    gbc:         { id: 'gbc',         displayName: 'Game Boy Color',     shortLabel: 'GBC',         category: 'video' },
    sms:         { id: 'sms',         displayName: 'Sega Master System', shortLabel: 'SMS',         category: 'video' },
    sega_cd:     { id: 'sega_cd',     displayName: 'Sega CD',            shortLabel: 'Sega CD',     category: 'video' },
    game_gear:   { id: 'game_gear',   displayName: 'Sega Game Gear',     shortLabel: 'Game Gear',   category: 'video' },
    tg16:        { id: 'tg16',        displayName: 'TurboGrafx-16',      shortLabel: 'TG-16',       category: 'video' },
    atari_2600:  { id: 'atari_2600',  displayName: 'Atari 2600',         shortLabel: 'Atari 2600',  category: 'video' },
    atari_7800:  { id: 'atari_7800',  displayName: 'Atari 7800',         shortLabel: 'Atari 7800',  category: 'video' },
    jaguar:      { id: 'jaguar',      displayName: 'Atari Jaguar',       shortLabel: 'Jaguar',      category: 'video' },
    '3do':       { id: '3do',         displayName: '3DO',                shortLabel: '3DO',         category: 'video' },
    switch:      { id: 'switch',      displayName: 'Nintendo Switch',    shortLabel: 'Switch',      category: 'video' },
    wii:         { id: 'wii',         displayName: 'Wii',                shortLabel: 'Wii',         category: 'video' },
    pc:          { id: 'pc',          displayName: 'PC',                 shortLabel: 'PC',          category: 'video' },
};

/**
 * Human labels for the fidelity categories (ADR 0016 §"Fidelity categories
 * derive from engine only").
 *
 * "Arcade-Style" and "Video Games" are settled naming, not placeholders: the
 * pinball band could not be called "Arcade" because `arcade` is a live engine
 * id for arcade video cabinets, and the old platform group label "Arcade &
 * Video" collided with it for the same reason.
 *
 * There is deliberately NO entry for the unknown engine. `unknown` yields no
 * category at all (`getEngineCategory` → null), because 63 of ~120 production
 * score rows are the irreducible AtGames ambiguity and filing them under
 * Simulation or Arcade-Style would assert something the data cannot support.
 */
export const ENGINE_CATEGORY_LABELS: Record<EngineCategory, string> = {
    real:         'Real Machine',
    simulation:   'Simulation',
    arcade_style: 'Arcade-Style',
    video:        'Video Games',
};

/**
 * The bucket that holds scores whose engine yields NO fidelity category
 * (`'unknown'`, or a token nothing recognises) — v2.59.0, ADR 0016 P4.
 *
 * It is deliberately NOT a member of `EngineCategory`: it makes no claim about
 * comparability and must never be presented as a peer of the three real bands.
 * It exists because 38 of 67 production global scores carry `engine='unknown'`,
 * and a card model that only builds cards for the known bands would drop the
 * MAJORITY of the site's scores off the page. A visibly-neutral bucket that
 * says "nobody recorded this" is the only honest way to keep them reachable.
 */
export const UNSPECIFIED_CATEGORY = 'unspecified';

/**
 * Every category a scoreboard card can carry, in display order — the three
 * fidelity bands, the video-game axis, then the no-claim bucket last.
 *
 * `null` is a FOURTH state and is deliberately absent from this list: it means
 * "this card has no scores at all", which is a property of the game, not a
 * category a player can filter on.
 */
export const CARD_CATEGORY_ORDER: string[] = [
    'real', 'simulation', 'arcade_style', 'video', UNSPECIFIED_CATEGORY,
];

// ─── Devices ────────────────────────────────────────────────────────────────

export interface DeviceInfo {
    id: string;
    displayName: string;
    /** Dense-UI label — the secondary tag next to a score's engine. */
    shortLabel: string;
}

/**
 * Canonical devices. The VR ids from the old taxonomy dissolve into
 * `vr_headset`: FX-on-Quest is `engine=fx, device=vr_headset`.
 */
export const CANONICAL_DEVICES: Record<string, DeviceInfo> = {
    pc:               { id: 'pc',               displayName: 'PC',               shortLabel: 'PC' },
    atgames:          { id: 'atgames',          displayName: 'AtGames Cabinet',  shortLabel: 'AtGames' },
    vr_headset:       { id: 'vr_headset',       displayName: 'VR Headset',       shortLabel: 'VR' },
    real_cabinet:     { id: 'real_cabinet',     displayName: 'Real Cabinet',     shortLabel: 'Cabinet' },
    standalone_other: { id: 'standalone_other', displayName: 'Other Standalone', shortLabel: 'Standalone' },
    console:          { id: 'console',          displayName: 'Console',          shortLabel: 'Console' },
    arcade_cabinet:   { id: 'arcade_cabinet',   displayName: 'Arcade Cabinet',   shortLabel: 'Arcade Cab' },
};

/**
 * Sub-values of the `atgames` device. These already exist as `features` on
 * `global_games` (migration 101) — reused verbatim, not reinvented. Not written
 * to score rows in P1; listed so the compat/UI layers have one authority.
 */
export const ATGAMES_DEVICE_VARIANTS: string[] = [
    'atgames_hd', 'atgames_4k', 'atgames_micro', 'atgames_hdp',
    'atgames_alu', 'atgames_mini', 'atgames_gamer', 'atgames_core',
];

/**
 * `'unknown'` is a first-class value on BOTH axes and is NEVER stored as NULL.
 * Scores carrying it render without a fidelity category and are excluded from
 * engine-filtered leaderboards (P3).
 */
export const UNKNOWN = 'unknown';

// ─── Engine → Device compatibility ──────────────────────────────────────────

/**
 * Which devices can run which engine. Drives the submission picker (device list
 * is filtered by the chosen engine) and P2's tournament-rule validation.
 *
 * Authored deliberately PERMISSIVE where genuinely unsure: a wrong restriction
 * blocks a real score, a missing restriction only fails to help. `vr_headset`
 * is listed for PC-tethered engines (VPX/FP VR rigs) as well as standalone
 * headsets — P1 does not try to distinguish PCVR from standalone VR.
 */
export const ENGINE_DEVICE_COMPAT: Record<string, string[]> = {
    real:           ['real_cabinet'],

    vpx:            ['pc', 'atgames', 'standalone_other', 'vr_headset'],
    vp9:            ['pc'],
    fp:             ['pc', 'vr_headset'],

    fx:             ['pc', 'atgames', 'console', 'vr_headset'],
    fx_classic:     ['pc', 'console', 'vr_headset'],
    fx_midnight:    ['pc', 'console', 'vr_headset'],
    zaccaria:       ['pc', 'atgames', 'console', 'vr_headset'],
    star_wars:      ['vr_headset'],
    atgames_native: ['atgames'],

    // Video engines: emulated or original hardware, plus AtGames' arcade line.
    arcade:      ['arcade_cabinet', 'pc', 'atgames', 'console', 'standalone_other'],
    nes:         ['console', 'pc', 'atgames', 'standalone_other'],
    snes:        ['console', 'pc', 'atgames', 'standalone_other'],
    genesis:     ['console', 'pc', 'atgames', 'standalone_other'],
    saturn:      ['console', 'pc', 'standalone_other'],
    n64:         ['console', 'pc', 'standalone_other'],
    ps1:         ['console', 'pc', 'standalone_other'],
    ps2:         ['console', 'pc', 'standalone_other'],
    dreamcast:   ['console', 'pc', 'standalone_other'],
    gba:         ['console', 'pc', 'standalone_other'],
    gb:          ['console', 'pc', 'standalone_other'],
    gbc:         ['console', 'pc', 'standalone_other'],
    sms:         ['console', 'pc', 'standalone_other'],
    sega_cd:     ['console', 'pc', 'standalone_other'],
    game_gear:   ['console', 'pc', 'standalone_other'],
    tg16:        ['console', 'pc', 'standalone_other'],
    atari_2600:  ['console', 'pc', 'atgames', 'standalone_other'],
    atari_7800:  ['console', 'pc', 'atgames', 'standalone_other'],
    jaguar:      ['console', 'pc', 'standalone_other'],
    '3do':       ['console', 'pc', 'standalone_other'],
    switch:      ['console'],
    wii:         ['console'],
    pc:          ['pc'],
};

// ─── Legacy platform → (engine, device) ─────────────────────────────────────

export interface Provenance {
    engine: string;
    device: string;
}

/**
 * Every id in the pre-0016 `CANONICAL_PLATFORMS`, plus the alias spellings and
 * legacy tokens observed in production data (`ATGAMES`, `VPX`, `VPXS` — matched
 * case-insensitively; `VR` and `IRL` from the original `PLATFORMS` seed).
 *
 * Mapping rules from ADR 0016:
 *   - `atgames` → engine UNKNOWN (could be any of four engines), device atgames.
 *   - `vpxs` / `vpxs_manual` → vpx + atgames (standalone builds ship on AtGames).
 *   - every `*_vr` id → its engine + vr_headset.
 *   - `real` → real + real_cabinet.
 *   - `bam` → fp (BAM is a table requirement, not an engine).
 *   - everything else → that engine, device unknown. Video ids deliberately map
 *     to device `unknown` rather than `console`: a NES score may be original
 *     hardware or an emulator, and inventing provenance is worse than admitting
 *     we don't have it.
 */
export const LEGACY_PLATFORM_MAP: Record<string, Provenance> = {
    // Physical
    real:                  { engine: 'real',        device: 'real_cabinet' },
    irl:                   { engine: 'real',        device: 'real_cabinet' },
    'real machine':        { engine: 'real',        device: 'real_cabinet' },
    physical:              { engine: 'real',        device: 'real_cabinet' },
    atgames:               { engine: UNKNOWN,       device: 'atgames' },

    // Virtual pinball
    vpx:                   { engine: 'vpx',         device: UNKNOWN },
    'visual pinball x':    { engine: 'vpx',         device: UNKNOWN },
    vp9:                   { engine: 'vp9',         device: UNKNOWN },
    'visual pinball 9':    { engine: 'vp9',         device: UNKNOWN },
    vpxs:                  { engine: 'vpx',         device: 'atgames' },
    'vpx standalone':      { engine: 'vpx',         device: 'atgames' },
    vpxs_manual:           { engine: 'vpx',         device: 'atgames' },
    'vpxs-manual':         { engine: 'vpx',         device: 'atgames' },
    'vpx standalone (manual install)': { engine: 'vpx', device: 'atgames' },
    fp:                    { engine: 'fp',          device: UNKNOWN },
    'future pinball':      { engine: 'fp',          device: UNKNOWN },
    bam:                   { engine: 'fp',          device: UNKNOWN },

    // Zen Studios family
    pinball_fx:            { engine: 'fx',          device: UNKNOWN },
    fx:                    { engine: 'fx',          device: UNKNOWN },
    'pinball fx':          { engine: 'fx',          device: UNKNOWN },
    pinball_fx_classic:    { engine: 'fx_classic',  device: UNKNOWN },
    fx3:                   { engine: 'fx_classic',  device: UNKNOWN },
    pinball_fx3:           { engine: 'fx_classic',  device: UNKNOWN },
    'pinball fx3':         { engine: 'fx_classic',  device: UNKNOWN },
    // The FX2 era is the same engine as FX3 — Zen rebranded the line to
    // "Pinball FX Classic" and both generations' tables sit under it. The map
    // already said so for the VR spellings ('pinball fx2 vr' → fx_classic +
    // vr_headset); the flat spellings were simply missing, so a catalogue row
    // carrying `fx2` read as unknown/unknown. Found by rehearsing migration 129
    // against a copy of production, where `fx2` was the ONLY unrecognised token
    // (5 rows) and dropping it would have left "Plants vs. Zombies" and
    // "Ms. Splosion Man" — both FX2-era Zen tables — with no engine at all.
    fx2:                   { engine: 'fx_classic',  device: UNKNOWN },
    pinball_fx2:           { engine: 'fx_classic',  device: UNKNOWN },
    'pinball fx2':         { engine: 'fx_classic',  device: UNKNOWN },
    'pinball fx classic':  { engine: 'fx_classic',  device: UNKNOWN },
    pinball_fx_classic_vr: { engine: 'fx_classic',  device: 'vr_headset' },
    'pinball fx classic vr': { engine: 'fx_classic', device: 'vr_headset' },
    'pinball fx 2 vr':     { engine: 'fx_classic',  device: 'vr_headset' },
    'pinball fx2 vr':      { engine: 'fx_classic',  device: 'vr_headset' },
    'fx 2 vr':             { engine: 'fx_classic',  device: 'vr_headset' },
    pinball_fx_midnight:   { engine: 'fx_midnight', device: UNKNOWN },
    'pinball fx midnight': { engine: 'fx_midnight', device: UNKNOWN },
    'pinball m':           { engine: 'fx_midnight', device: UNKNOWN },
    pinball_m:             { engine: 'fx_midnight', device: UNKNOWN },
    pinball_fx_vr:         { engine: 'fx',          device: 'vr_headset' },
    'pinball fx vr':       { engine: 'fx',          device: 'vr_headset' },
    star_wars_pinball_vr:  { engine: 'star_wars',   device: 'vr_headset' },
    'star wars pinball vr': { engine: 'star_wars',  device: 'vr_headset' },

    // Zaccaria
    zaccaria:              { engine: 'zaccaria',    device: UNKNOWN },
    'zaccaria pinball':    { engine: 'zaccaria',    device: UNKNOWN },
    zaccaria_vr:           { engine: 'zaccaria',    device: 'vr_headset' },
    'zaccaria vr':         { engine: 'zaccaria',    device: 'vr_headset' },
    'zaccaria pinball vr': { engine: 'zaccaria',    device: 'vr_headset' },

    // Bare device token from the original `PLATFORMS` seed
    // (['AtGames','VPXS','VR','IRL']) — engine unknowable, device is the point.
    vr:                    { engine: UNKNOWN,       device: 'vr_headset' },

    // ── Canonical ENGINE ids, mapped to themselves ──────────────────────────
    //
    // `global_games.platforms` becomes an engine list (ADR 0016 §"Catalogue
    // describes engines, not devices"). Every read path that classifies a
    // catalogue value goes through THIS map, so an engine id that is not a key
    // here reads as unknown/unknown: `enginesFromLegacyPlatforms` would yield
    // `['unknown']` and auto-lock the submit picker to Unspecified, and
    // `legacyPlatformsForEngine(e)` would return a set NOT containing `e`, so
    // tournament eligibility would match zero games.
    //
    // Most engine ids are already keys above because the legacy id and the
    // engine id are the same string (`real`, `vpx`, `vp9`, `fp`, `fx`,
    // `zaccaria`, `pc`, every console id). These four exist only in the new
    // taxonomy; their legacy spellings (`pinball_fx_classic`,
    // `pinball_fx_midnight`, `star_wars_pinball_vr`, `atgames`) stay above,
    // unchanged, and keep mapping exactly as they did.
    //
    // Device is UNKNOWN by construction: an engine id names what PRODUCED a
    // score and asserts nothing about the hardware it ran on. Purely additive —
    // no token that resolved before resolves differently now.
    fx_classic:            { engine: 'fx_classic',  device: UNKNOWN },
    fx_midnight:           { engine: 'fx_midnight', device: UNKNOWN },
    star_wars:             { engine: 'star_wars',   device: UNKNOWN },
    atgames_native:        { engine: 'atgames_native', device: UNKNOWN },

    // Arcade & video games — engine keeps its id, device stays unknown.
    arcade:      { engine: 'arcade',      device: UNKNOWN },
    nes:         { engine: 'nes',         device: UNKNOWN },
    snes:        { engine: 'snes',        device: UNKNOWN },
    genesis:     { engine: 'genesis',     device: UNKNOWN },
    'sega genesis': { engine: 'genesis',  device: UNKNOWN },
    saturn:      { engine: 'saturn',      device: UNKNOWN },
    'sega saturn': { engine: 'saturn',    device: UNKNOWN },
    n64:         { engine: 'n64',         device: UNKNOWN },
    'nintendo 64': { engine: 'n64',       device: UNKNOWN },
    ps1:         { engine: 'ps1',         device: UNKNOWN },
    playstation: { engine: 'ps1',         device: UNKNOWN },
    ps2:         { engine: 'ps2',         device: UNKNOWN },
    'playstation 2': { engine: 'ps2',     device: UNKNOWN },
    dreamcast:   { engine: 'dreamcast',   device: UNKNOWN },
    gba:         { engine: 'gba',         device: UNKNOWN },
    'game boy advance': { engine: 'gba',  device: UNKNOWN },
    gb:          { engine: 'gb',          device: UNKNOWN },
    'game boy':  { engine: 'gb',          device: UNKNOWN },
    gbc:         { engine: 'gbc',         device: UNKNOWN },
    'game boy color': { engine: 'gbc',    device: UNKNOWN },
    sms:         { engine: 'sms',         device: UNKNOWN },
    'sega master system': { engine: 'sms', device: UNKNOWN },
    sega_cd:     { engine: 'sega_cd',     device: UNKNOWN },
    'sega cd':   { engine: 'sega_cd',     device: UNKNOWN },
    game_gear:   { engine: 'game_gear',   device: UNKNOWN },
    'sega game gear': { engine: 'game_gear', device: UNKNOWN },
    tg16:        { engine: 'tg16',        device: UNKNOWN },
    'turbografx-16': { engine: 'tg16',    device: UNKNOWN },
    turbografx16: { engine: 'tg16',       device: UNKNOWN },
    atari_2600:  { engine: 'atari_2600',  device: UNKNOWN },
    'atari 2600': { engine: 'atari_2600', device: UNKNOWN },
    atari_7800:  { engine: 'atari_7800',  device: UNKNOWN },
    'atari 7800': { engine: 'atari_7800', device: UNKNOWN },
    jaguar:      { engine: 'jaguar',      device: UNKNOWN },
    'atari jaguar': { engine: 'jaguar',   device: UNKNOWN },
    '3do':       { engine: '3do',         device: UNKNOWN },
    switch:      { engine: 'switch',      device: UNKNOWN },
    'nintendo switch': { engine: 'switch', device: UNKNOWN },
    wii:         { engine: 'wii',         device: UNKNOWN },
    pc:          { engine: 'pc',          device: 'pc' },
};

/**
 * Engine → the legacy platform id that best represents it when no device-specific
 * override applies. Used to keep the `platform` column populated for read paths,
 * which still consume it exclusively through P1/P2 (see ADR 0016 phase plan).
 */
export const ENGINE_PRIMARY_PLATFORM: Record<string, string> = {
    real:           'real',
    vpx:            'vpx',
    vp9:            'vp9',
    fp:             'fp',
    fx:             'pinball_fx',
    fx_classic:     'pinball_fx_classic',
    fx_midnight:    'pinball_fx_midnight',
    zaccaria:       'zaccaria',
    star_wars:      'star_wars_pinball_vr',
    atgames_native: 'atgames',
    arcade: 'arcade', nes: 'nes', snes: 'snes', genesis: 'genesis', saturn: 'saturn',
    n64: 'n64', ps1: 'ps1', ps2: 'ps2', dreamcast: 'dreamcast', gba: 'gba',
    gb: 'gb', gbc: 'gbc', sms: 'sms', sega_cd: 'sega_cd', game_gear: 'game_gear',
    tg16: 'tg16', atari_2600: 'atari_2600', atari_7800: 'atari_7800',
    jaguar: 'jaguar', '3do': '3do', switch: 'switch', wii: 'wii', pc: 'pc',
};

/**
 * (engine, device) pairs that map back to a MORE specific legacy platform id
 * than `ENGINE_PRIMARY_PLATFORM` would give. Keyed `${engine}|${device}`.
 */
export const PROVENANCE_PLATFORM_OVERRIDES: Record<string, string> = {
    'vpx|atgames':          'vpxs',
    'fx|vr_headset':        'pinball_fx_vr',
    'fx_classic|vr_headset': 'pinball_fx_classic_vr',
    'zaccaria|vr_headset':  'zaccaria_vr',
    'star_wars|vr_headset': 'star_wars_pinball_vr',
    'atgames_native|atgames': 'atgames',
};

/**
 * Devices that themselves correspond to a legacy platform id. Used as the last
 * derivation fallback (engine unknown) and to keep tournament `excluded`
 * platform rules enforceable on the device axis during P1.
 */
export const DEVICE_LEGACY_PLATFORM: Record<string, string> = {
    atgames:      'atgames',
    real_cabinet: 'real',
    pc:           'pc',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Lowercase+trim a raw token for map lookup. Returns '' for nullish input. */
export function normalizeProvenanceToken(raw: string | null | undefined): string {
    if (!raw) return '';
    return String(raw).trim().toLowerCase();
}

/** True when `id` is a known canonical engine (NOT counting `'unknown'`). */
export function isCanonicalEngine(id: string | null | undefined): boolean {
    const key = normalizeProvenanceToken(id);
    return !!key && Object.prototype.hasOwnProperty.call(CANONICAL_ENGINES, key);
}

/** True when `id` is a known canonical device (NOT counting `'unknown'`). */
export function isCanonicalDevice(id: string | null | undefined): boolean {
    const key = normalizeProvenanceToken(id);
    return !!key && Object.prototype.hasOwnProperty.call(CANONICAL_DEVICES, key);
}

/**
 * What an `'unknown'` value on either axis renders as.
 *
 * "Unspecified", not "Unknown" and never blank: 63 of ~120 production score
 * rows carry `engine='unknown'` (the AtGames rows whose engine is genuinely
 * unknowable — ADR 0016 §"No backfill"). A blank tag would read as a rendering
 * bug; "Unspecified" says truthfully that nobody recorded it.
 */
export const UNSPECIFIED_LABEL = 'Unspecified';

/** Display label for an engine id; `'unknown'` renders as "Unspecified". */
export function getEngineDisplay(id: string | null | undefined): string {
    const key = normalizeProvenanceToken(id);
    if (!key || key === UNKNOWN) return UNSPECIFIED_LABEL;
    return CANONICAL_ENGINES[key]?.displayName ?? key.toUpperCase();
}

/** Display label for a device id; `'unknown'` renders as "Unspecified". */
export function getDeviceDisplay(id: string | null | undefined): string {
    const key = normalizeProvenanceToken(id);
    if (!key || key === UNKNOWN) return UNSPECIFIED_LABEL;
    return CANONICAL_DEVICES[key]?.displayName ?? key.toUpperCase();
}

/** Dense-UI label for an engine id; `'unknown'` renders as "Unspecified". */
export function getEngineShortLabel(id: string | null | undefined): string {
    const key = normalizeProvenanceToken(id);
    if (!key || key === UNKNOWN) return UNSPECIFIED_LABEL;
    return CANONICAL_ENGINES[key]?.shortLabel ?? key.toUpperCase();
}

/** Dense-UI label for a device id; `'unknown'` renders as "Unspecified". */
export function getDeviceShortLabel(id: string | null | undefined): string {
    const key = normalizeProvenanceToken(id);
    if (!key || key === UNKNOWN) return UNSPECIFIED_LABEL;
    return CANONICAL_DEVICES[key]?.shortLabel ?? key.toUpperCase();
}

/** Fidelity category for an engine id, or null for unknown/unrecognised. */
export function getEngineCategory(id: string | null | undefined): EngineCategory | null {
    const key = normalizeProvenanceToken(id);
    if (!key || key === UNKNOWN) return null;
    return CANONICAL_ENGINES[key]?.category ?? null;
}

/**
 * Human fidelity-band label for an engine id — "Real Machine" / "Simulation" /
 * "Arcade-Style" / "Video Games" — or **null** when the engine is `'unknown'`
 * or unrecognised.
 *
 * Null is the whole point of this helper existing rather than call sites
 * re-deriving: a nullable return forces every caller to decide what an
 * uncategorised score looks like, instead of quietly defaulting one into a
 * band it does not belong to. Device is never consulted — an AtGames cabinet
 * running a VPX table is a Simulation score (ADR 0016).
 */
export function getEngineCategoryLabel(id: string | null | undefined): string | null {
    const category = getEngineCategory(id);
    return category ? ENGINE_CATEGORY_LABELS[category] : null;
}

/**
 * The card bucket an engine belongs to — like `getEngineCategory`, except an
 * engine with no fidelity band lands in `UNSPECIFIED_CATEGORY` instead of null
 * (v2.59.0, ADR 0016 P4).
 *
 * The two helpers coexist on purpose. `getEngineCategory` returning null is
 * what stops a display surface from ASSERTING a band it can't support;
 * `engineCardCategory` never returns null because a card model must put every
 * score somewhere or it silently loses it. Same taxonomy, two different duties.
 */
export function engineCardCategory(id: string | null | undefined): string {
    return getEngineCategory(id) ?? UNSPECIFIED_CATEGORY;
}

/**
 * Human label for a CARD category id, including the `unspecified` bucket.
 *
 * Returns null for `null` — the zero-score card, which carries no category at
 * all and must render no chip rather than a misleading "Unspecified" (that
 * would claim the game has scores of unrecorded provenance when it has none).
 */
export function getCardCategoryLabel(id: string | null | undefined): string | null {
    if (id == null || id === '') return null;
    if (id === UNSPECIFIED_CATEGORY) return UNSPECIFIED_LABEL;
    return ENGINE_CATEGORY_LABELS[id as EngineCategory] ?? null;
}

/**
 * Does naming this device tell a reader anything they couldn't infer?
 *
 * False when the engine runs on exactly one device (`real` → `real_cabinet`,
 * `star_wars` → `vr_headset`, `atgames_native` → `atgames`, …) or when the
 * device is unknown. Display surfaces use this to drop a secondary tag that
 * would be pure noise — "Real · Cabinet" says nothing "Real" didn't — while
 * keeping the informative pairs that ADR 0016 exists for ("VPX · AtGames").
 */
export function isDeviceInformative(
    engine: string | null | undefined,
    device: string | null | undefined,
): boolean {
    const d = normalizeProvenanceToken(device);
    if (!d || d === UNKNOWN) return false;
    const e = normalizeProvenanceToken(engine);
    if (!e || e === UNKNOWN) return true;
    const compat = ENGINE_DEVICE_COMPAT[e];
    return !compat || compat.length > 1;
}

/**
 * Label a LEGACY catalogue platform id in engine/device vocabulary.
 *
 * `global_games.platforms` is still a legacy id list (ADR 0016 turns it into an
 * engine list, but that is a catalogue migration, not this phase). This folds
 * one id to the name the rest of the UI now uses: its engine where it has one
 * (`vpxs` → "VPX", `pinball_fx_vr` → "FX"), else its device (`atgames` →
 * "AtGames", `vr` → "VR"), else the raw token uppercased.
 *
 * Deliberately never returns "Unspecified": a catalogue entry that maps to
 * neither axis is a taxonomy gap to surface, not a score with missing
 * provenance.
 */
export function getLegacyPlatformLabel(raw: string | null | undefined, short = true): string {
    const key = normalizeProvenanceToken(raw);
    if (!key) return '';
    const { engine, device } = mapLegacyPlatform(key);
    if (engine !== UNKNOWN) {
        return short ? getEngineShortLabel(engine) : getEngineDisplay(engine);
    }
    if (device !== UNKNOWN) {
        return short ? getDeviceShortLabel(device) : getDeviceDisplay(device);
    }
    return key.toUpperCase();
}

/**
 * Map a legacy platform token (canonical id, alias, or mixed-case prod value)
 * to its (engine, device) pair. Unrecognised tokens → unknown/unknown, never
 * null and never NULL.
 */
export function mapLegacyPlatform(raw: string | null | undefined): Provenance {
    const key = normalizeProvenanceToken(raw);
    if (!key) return { engine: UNKNOWN, device: UNKNOWN };
    return LEGACY_PLATFORM_MAP[key] ?? { engine: UNKNOWN, device: UNKNOWN };
}

/**
 * Every legacy platform token that denotes the SAME engine as `raw`.
 *
 * `vpx` → `['vpx', 'visual pinball x', 'vpxs', 'vpx standalone', 'vpxs_manual', …]`
 * because ADR 0016 rules those the same engine: VPX Standalone tables are ports
 * with graphical concessions, and identical physics means comparable scores.
 *
 * Used by the catalogue availability filter, which previously matched
 * `gg.platforms LIKE '%vpx%'` — raw substring matching against a JSON array, so
 * `'%pinball_fx%'` silently swept in `pinball_fx_classic`, `pinball_fx_midnight`
 * and `pinball_fx_classic_vr`. Exact membership over this set removes those
 * accidental hits while KEEPING every genuinely engine-equivalent one, so no
 * game that qualifies today stops qualifying.
 *
 * A token with no engine (`atgames`, `vr` — device-only) returns just itself:
 * expanding it along the device axis would WIDEN the filter, and widening is a
 * rule-semantics decision that belongs to the tournament-rules phase, not here.
 */
export function equivalentLegacyPlatforms(raw: string | null | undefined): string[] {
    const key = normalizeProvenanceToken(raw);
    if (!key) return [];
    const { engine } = mapLegacyPlatform(key);
    if (engine === UNKNOWN) return [key];
    const out = Object.entries(LEGACY_PLATFORM_MAP)
        .filter(([, prov]) => prov.engine === engine)
        .map(([token]) => token);
    return out.includes(key) ? out : [key, ...out];
}

/** Devices that can run `engine`. `'unknown'` engine → every canonical device. */
export function devicesForEngine(engine: string | null | undefined): string[] {
    const key = normalizeProvenanceToken(engine);
    if (!key || key === UNKNOWN) return Object.keys(CANONICAL_DEVICES);
    return ENGINE_DEVICE_COMPAT[key] ?? Object.keys(CANONICAL_DEVICES);
}

/**
 * Compatibility predicate. `'unknown'` on either axis is always compatible —
 * it is the explicit "no claim" value, not a claim that happens to be wrong.
 */
export function isEngineDeviceCompatible(
    engine: string | null | undefined,
    device: string | null | undefined,
): boolean {
    const e = normalizeProvenanceToken(engine);
    const d = normalizeProvenanceToken(device);
    if (!e || !d) return false;
    if (e === UNKNOWN || d === UNKNOWN) return true;
    if (!isCanonicalEngine(e) || !isCanonicalDevice(d)) return false;
    return (ENGINE_DEVICE_COMPAT[e] ?? []).includes(d);
}

/**
 * Collapse a list of legacy platform ids (a game's catalogue platforms ∪ room
 * tags) into the engine options a player may choose from.
 *
 * `'unknown'` contributions (i.e. `atgames`, whose engine is unknowable) are
 * dropped so the picker isn't cluttered with a "not sure" option next to real
 * choices. If EVERY contribution was unknown — an AtGames-only game — the
 * result is `['unknown']` so the field auto-locks rather than blocking.
 */
export function enginesFromLegacyPlatforms(platforms: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of platforms) {
        const { engine } = mapLegacyPlatform(p);
        if (engine === UNKNOWN || seen.has(engine)) continue;
        seen.add(engine);
        out.push(engine);
    }
    if (out.length === 0 && platforms.length > 0) return [UNKNOWN];
    return out;
}

/**
 * Device options for `engine`, narrowed to what the game's platform list and
 * availability features make plausible. The union of the engine's compat list
 * is intersected with nothing (P1 stays permissive), but devices explicitly
 * implied by the game are guaranteed present.
 *
 * `features` carries the half of that implication the catalogue fold moved out
 * of `platforms` (ADR 0016 catalogue phase §2). Pre-fold, a `vpxs` platform id
 * mapped to device `atgames` and put AtGames in the list; post-fold the row
 * says `platforms: ['vpx'], features: ['vpxs']` and the same guarantee has to
 * come from the feature. It defaults to `[]` so a caller that has not been
 * given features yet behaves exactly as it did.
 */
export function devicesForEngineAndPlatforms(
    engine: string,
    platforms: string[],
    features: string[] = [],
): string[] {
    const base = devicesForEngine(engine);
    const out = [...base];
    for (const p of platforms) {
        const { device } = mapLegacyPlatform(p);
        if (device !== UNKNOWN && !out.includes(device)) out.push(device);
    }
    const have = new Set(features.map(f => normalizeProvenanceToken(f)));
    for (const [device, tokens] of Object.entries(DEVICE_AVAILABILITY_FEATURES)) {
        if (out.includes(device)) continue;
        if (tokens.some(t => have.has(t))) out.push(device);
    }
    return out;
}

// ─── Catalogue fold: legacy platform ids → engines + availability ───────────

/**
 * The availability FACT a legacy catalogue platform id carries, once its engine
 * half has been taken out of it (ADR 0016 §"Catalogue describes engines, not
 * devices", contract §2).
 *
 * `global_games.platforms` mixed two things: what a table was authored FOR
 * (`vpx`, `pinball_fx`) and what it happens to be AVAILABLE on (`vpxs` = also
 * ships as a standalone build, `zaccaria_vr` = a VR edition exists). The first
 * is the engine and belongs in `platforms`; the second is a per-game fact and
 * belongs in `features`, where the 8 AtGames cabinet variants already live
 * (migration 101 established the move).
 *
 * Keyed by the SAME tokens as `LEGACY_PLATFORM_MAP` — including the alias
 * spellings — because a catalogue row or a room tag can carry any of them. A
 * token absent here simply contributes no feature; it is not junk.
 */
export const CATALOGUE_PLATFORM_FEATURE: Record<string, string> = {
    // VPX Standalone: the VPX engine on standalone hardware. `vpxs` is the
    // AtGames-capable build; `vpxs_manual` differs only by install effort,
    // which ADR 0016 rules a catalogue property, not a property of a score.
    vpxs:                              'vpxs',
    'vpx standalone':                  'vpxs',
    vpxs_manual:                       'vpxs_manual',
    'vpxs-manual':                     'vpxs_manual',
    'vpx standalone (manual install)': 'vpxs_manual',

    // "This table requires BAM" is availability, not an engine — a BAM table
    // is the `fp` engine (ADR 0016 §"BAM is not an engine").
    bam: 'bam',

    // Every `*_vr` id decomposes: the engine keeps the score, the headset is
    // an availability fact ("a VR edition of this table exists").
    pinball_fx_vr:           'vr',
    'pinball fx vr':         'vr',
    pinball_fx_classic_vr:   'vr',
    'pinball fx classic vr': 'vr',
    'pinball fx 2 vr':       'vr',
    'pinball fx2 vr':        'vr',
    'fx 2 vr':               'vr',
    star_wars_pinball_vr:    'vr',
    'star wars pinball vr':  'vr',
    zaccaria_vr:             'vr',
    'zaccaria vr':           'vr',
    'zaccaria pinball vr':   'vr',
    // The bare device token from the original `PLATFORMS` seed. No engine at
    // all, but it still states availability, so it is folded, not dropped.
    vr:                      'vr',

    // AtGames availability. Distinct from the ENGINE below: "you can play this
    // on an AtGames cabinet" is true of VPX, Zen and Zaccaria tables too.
    atgames: 'atgames',
};

/**
 * Engine for legacy ids whose engine `LEGACY_PLATFORM_MAP` cannot supply.
 *
 * Exactly one entry, and it is a product call (contract §2, FLAGGED PRODUCT
 * CALL #1, orchestrator 2026-07-31). `LEGACY_PLATFORM_MAP['atgames']` is
 * `unknown`/`atgames` and must STAY that way: on the SCORE axis an `atgames`
 * value really is unknowable (the cabinet runs four engines), and pretending
 * otherwise would fabricate provenance.
 *
 * On the CATALOGUE axis the same token means something different and knowable:
 * a game reached the catalogue via the AtGames sheet, i.e. it runs on the
 * machine's own software. `atgames_native` is ADR 0016's engine for exactly
 * that, and it is what ends the auto-lock — an AtGames-only game currently
 * derives NO engine, so its submit picker locks to Unspecified.
 *
 * Known imprecision: Zen/FarSight-ported titles arguably carry their porter's
 * engine. The sheet's column-A fill colour knows the studio; the CSV export
 * path cannot read colours (ROADMAP "Studio attribution"). If the product owner
 * overrules, this is one line.
 */
export const CATALOGUE_PLATFORM_ENGINE_OVERRIDE: Record<string, string> = {
    atgames: 'atgames_native',
};

/** Result of folding a legacy catalogue platform list (contract §2). */
export interface CatalogueFold {
    /** Canonical engine ids, first-seen order, deduped. Becomes `platforms`. */
    engines: string[];
    /** Availability facts, deduped. Union-merged into `features`. */
    features: string[];
    /**
     * Tokens that yielded NEITHER an engine nor a feature — `fx2`, a typo, an
     * unmapped VPS `tableFormat`. Returned rather than discarded so the caller
     * decides: the migration LOGS them with the row id, the VPS importer keeps
     * them verbatim on the engine axis (its historical behaviour).
     */
    dropped: string[];
}

/**
 * THE fold (ADR 0016 catalogue phase, contract §2). One helper, used by the
 * migration and by all seven importers, so the data written today and the data
 * written by tomorrow's sync cannot disagree.
 *
 * `real`→`real`; `vpxs`→`vpx` + feature `vpxs`; `bam`→`fp` + feature `bam`;
 * `pinball_fx_vr`→`fx` + feature `vr`; `atgames`→`atgames_native` + feature
 * `atgames`; console/arcade/pc ids unchanged; junk → `dropped`.
 *
 * **Idempotent on the engine axis, by construction.** Every canonical engine id
 * is a `LEGACY_PLATFORM_MAP` key mapping to itself (catalogue phase §1), so
 * folding an already-folded list returns the same engines, no features and no
 * dropped tokens. That is what makes the migration safe to re-run and what lets
 * an importer fold unconditionally without checking whether a row was migrated.
 * Feature tokens are not platform ids and are not expected on input; a token
 * that is both (`vpxs`) still folds to its engine, so a half-migrated row
 * converges rather than degrading.
 *
 * Order is the source list's first occurrence of each engine — several legacy
 * ids collapse to one engine (`vpx`, `vpxs`, `vpxs_manual` → `vpx`), and the
 * winner is whichever appeared first. Display surfaces treat `engines[0]` as
 * the primary chip, so this rule IS the primary-chip rule (contract H-E).
 */
export function foldCataloguePlatforms(legacyIds: string[]): CatalogueFold {
    const engines: string[] = [];
    const features: string[] = [];
    const dropped: string[] = [];
    const push = (list: string[], value: string): void => {
        if (value && !list.includes(value)) list.push(value);
    };

    for (const raw of legacyIds ?? []) {
        const token = normalizeProvenanceToken(raw);
        if (!token) continue;

        const feature = CATALOGUE_PLATFORM_FEATURE[token] ?? null;
        const mapped = mapLegacyPlatform(token).engine;
        const engine = CATALOGUE_PLATFORM_ENGINE_OVERRIDE[token]
            ?? (mapped === UNKNOWN ? null : mapped);

        if (!engine && !feature) {
            push(dropped, token);
            continue;
        }
        if (engine) push(engines, engine);
        if (feature) push(features, feature);
    }

    return { engines, features, dropped };
}

/**
 * Every availability feature that means "this game is playable on `device`".
 *
 * The device-axis half of the fold, and the reason a device-`required`
 * tournament rule keeps working once availability leaves `platforms` (contract
 * §4 / hazard H-C). `atgames` lists all three VPX-Standalone-or-AtGames
 * features because all three denoted the `atgames` device before the fold —
 * dropping `vpxs_manual` would quietly stop admitting manual-install titles a
 * `required: ['atgames']` tournament admits today.
 *
 * Devices absent here (`pc`, `console`, `arcade_cabinet`, `real_cabinet`) are
 * decided on the ENGINE axis instead; see `deviceMatchesGame` in
 * `platformRules.ts`.
 */
export const DEVICE_AVAILABILITY_FEATURES: Record<string, string[]> = {
    atgames:    ['atgames', 'vpxs', 'vpxs_manual'],
    vr_headset: ['vr'],
};

/**
 * Derive the legacy `platform` id for a (engine, device) pair, preferring an id
 * the game actually carries so the existing `?platform=` leaderboard tabs keep
 * matching. Read paths still consume `platform` exclusively in P1, so every
 * write path calls this.
 *
 * Returns null only when nothing sensible can be derived (engine and device both
 * unknown) — the column is nullable and legacy rows are already null there.
 */
export function deriveLegacyPlatform(
    engine: string,
    device: string,
    effectivePlatforms: string[] = [],
): string | null {
    const e = normalizeProvenanceToken(engine);
    const d = normalizeProvenanceToken(device);

    const candidates: string[] = [];
    const push = (v: string | undefined) => {
        if (v && !candidates.includes(v)) candidates.push(v);
    };
    push(PROVENANCE_PLATFORM_OVERRIDES[`${e}|${d}`]);
    if (e !== UNKNOWN) push(ENGINE_PRIMARY_PLATFORM[e]);
    push(DEVICE_LEGACY_PLATFORM[d]);

    if (candidates.length === 0) return null;

    const have = new Set(effectivePlatforms.map(p => normalizeProvenanceToken(p)));
    for (const c of candidates) {
        if (have.has(c)) return c;
    }
    return candidates[0] ?? null;
}

// ─── RetroAchievements consoles → engines ───────────────────────────────────

/**
 * RetroAchievements console id → canonical engine id (RA on-demand import,
 * contract §1).
 *
 * RA's console ids come from `rc_consoles.h` in rcheevos and are stable public
 * identifiers. This map is deliberately PARTIAL: it lists only consoles whose
 * engine ALREADY exists in `CANONICAL_ENGINES`, because the engine id is what
 * a score's comparability is decided by (ADR 0016) and minting one here would
 * create a fidelity band nothing else in the system knows about. A console
 * absent from this map is never synced into the RA master list, so it can
 * never be imported — widening later costs one entry here (or one new engine
 * plus one entry), and nothing else.
 *
 * RA's pseudo-consoles (100 Hubs, 101 Events, 102 Standalone) are deliberately
 * absent: they are not hardware and carry no comparable engine.
 */
export const RA_CONSOLE_ENGINE_MAP: Record<number, string> = {
    1:  'genesis',
    2:  'n64',
    3:  'snes',
    4:  'gb',
    5:  'gba',
    6:  'gbc',
    7:  'nes',
    8:  'tg16',
    9:  'sega_cd',
    11: 'sms',
    12: 'ps1',
    15: 'game_gear',
    17: 'jaguar',
    21: 'ps2',
    25: 'atari_2600',
    27: 'arcade',
    39: 'saturn',
    40: 'dreamcast',
    43: '3do',
    51: 'atari_7800',
};

/**
 * The catalogue `type`/`subtype` an RA console implies, or null when the
 * console is not mapped.
 *
 * RA console 27 is Arcade (it also carries Neo Geo) → `type='arcade'`, the
 * same value the IGDB importer writes for arcade cabinets, so both sources
 * land in one catalogue band. Every other mapped console is home hardware →
 * `type='video_game'`, `subtype='console'`.
 *
 * Null rather than a default for unmapped consoles: a caller must not be able
 * to file a console this taxonomy has never ruled on under a fallback type.
 */
export function raCatalogueType(consoleId: number): { type: string; subtype: string } | null {
    const engine = RA_CONSOLE_ENGINE_MAP[consoleId];
    if (!engine) return null;
    return engine === 'arcade'
        ? { type: 'arcade', subtype: 'arcade' }
        : { type: 'video_game', subtype: 'console' };
}
