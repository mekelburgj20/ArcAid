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
    real:           { id: 'real',           displayName: 'Real Machine',        category: 'real' },

    // Simulation
    vpx:            { id: 'vpx',            displayName: 'Visual Pinball X',    category: 'simulation' },
    vp9:            { id: 'vp9',            displayName: 'Visual Pinball 9',    category: 'simulation' },
    fp:             { id: 'fp',             displayName: 'Future Pinball',      category: 'simulation' },

    // Arcade-style
    fx:             { id: 'fx',             displayName: 'Pinball FX',          category: 'arcade_style' },
    fx_classic:     { id: 'fx_classic',     displayName: 'Pinball FX Classic',  category: 'arcade_style' },
    fx_midnight:    { id: 'fx_midnight',    displayName: 'Pinball M',           category: 'arcade_style' },
    zaccaria:       { id: 'zaccaria',       displayName: 'Zaccaria',            category: 'arcade_style' },
    star_wars:      { id: 'star_wars',      displayName: 'Star Wars Pinball',   category: 'arcade_style' },
    atgames_native: { id: 'atgames_native', displayName: 'AtGames Native',      category: 'arcade_style' },

    // Video games — unchanged from the legacy platform ids (ADR 0016).
    arcade:      { id: 'arcade',      displayName: 'Arcade',             category: 'video' },
    nes:         { id: 'nes',         displayName: 'NES',                category: 'video' },
    snes:        { id: 'snes',        displayName: 'SNES',               category: 'video' },
    genesis:     { id: 'genesis',     displayName: 'Sega Genesis',       category: 'video' },
    saturn:      { id: 'saturn',      displayName: 'Sega Saturn',        category: 'video' },
    n64:         { id: 'n64',         displayName: 'Nintendo 64',        category: 'video' },
    ps1:         { id: 'ps1',         displayName: 'PlayStation',        category: 'video' },
    ps2:         { id: 'ps2',         displayName: 'PlayStation 2',      category: 'video' },
    dreamcast:   { id: 'dreamcast',   displayName: 'Dreamcast',          category: 'video' },
    gba:         { id: 'gba',         displayName: 'Game Boy Advance',   category: 'video' },
    gb:          { id: 'gb',          displayName: 'Game Boy',           category: 'video' },
    gbc:         { id: 'gbc',         displayName: 'Game Boy Color',     category: 'video' },
    sms:         { id: 'sms',         displayName: 'Sega Master System', category: 'video' },
    sega_cd:     { id: 'sega_cd',     displayName: 'Sega CD',            category: 'video' },
    game_gear:   { id: 'game_gear',   displayName: 'Sega Game Gear',     category: 'video' },
    tg16:        { id: 'tg16',        displayName: 'TurboGrafx-16',      category: 'video' },
    atari_2600:  { id: 'atari_2600',  displayName: 'Atari 2600',         category: 'video' },
    atari_7800:  { id: 'atari_7800',  displayName: 'Atari 7800',         category: 'video' },
    jaguar:      { id: 'jaguar',      displayName: 'Atari Jaguar',       category: 'video' },
    '3do':       { id: '3do',         displayName: '3DO',                category: 'video' },
    switch:      { id: 'switch',      displayName: 'Nintendo Switch',    category: 'video' },
    wii:         { id: 'wii',         displayName: 'Wii',                category: 'video' },
    pc:          { id: 'pc',          displayName: 'PC',                 category: 'video' },
};

// ─── Devices ────────────────────────────────────────────────────────────────

export interface DeviceInfo {
    id: string;
    displayName: string;
}

/**
 * Canonical devices. The VR ids from the old taxonomy dissolve into
 * `vr_headset`: FX-on-Quest is `engine=fx, device=vr_headset`.
 */
export const CANONICAL_DEVICES: Record<string, DeviceInfo> = {
    pc:               { id: 'pc',               displayName: 'PC' },
    atgames:          { id: 'atgames',          displayName: 'AtGames Cabinet' },
    vr_headset:       { id: 'vr_headset',       displayName: 'VR Headset' },
    real_cabinet:     { id: 'real_cabinet',     displayName: 'Real Cabinet' },
    standalone_other: { id: 'standalone_other', displayName: 'Other Standalone' },
    console:          { id: 'console',          displayName: 'Console' },
    arcade_cabinet:   { id: 'arcade_cabinet',   displayName: 'Arcade Cabinet' },
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

/** Display label for an engine id; `'unknown'` renders as "Unknown". */
export function getEngineDisplay(id: string | null | undefined): string {
    const key = normalizeProvenanceToken(id);
    if (!key || key === UNKNOWN) return 'Unknown';
    return CANONICAL_ENGINES[key]?.displayName ?? key.toUpperCase();
}

/** Display label for a device id; `'unknown'` renders as "Unknown". */
export function getDeviceDisplay(id: string | null | undefined): string {
    const key = normalizeProvenanceToken(id);
    if (!key || key === UNKNOWN) return 'Unknown';
    return CANONICAL_DEVICES[key]?.displayName ?? key.toUpperCase();
}

/** Fidelity category for an engine id, or null for unknown/unrecognised. */
export function getEngineCategory(id: string | null | undefined): EngineCategory | null {
    const key = normalizeProvenanceToken(id);
    if (!key || key === UNKNOWN) return null;
    return CANONICAL_ENGINES[key]?.category ?? null;
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
 * Device options for `engine`, narrowed to what the game's legacy platform list
 * makes plausible. The union of the engine's compat list is intersected with
 * nothing (P1 stays permissive), but devices explicitly implied by the game's
 * platforms (e.g. `atgames` → `atgames`) are guaranteed present.
 */
export function devicesForEngineAndPlatforms(engine: string, platforms: string[]): string[] {
    const base = devicesForEngine(engine);
    const out = [...base];
    for (const p of platforms) {
        const { device } = mapLegacyPlatform(p);
        if (device !== UNKNOWN && !out.includes(device)) out.push(device);
    }
    return out;
}

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
