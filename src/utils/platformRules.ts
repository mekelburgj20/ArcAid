import { logWarn } from './logger.js';
import { normalizePlatform } from './platformMapping.js';
import { catalogueTypeMatchesTournamentMode } from './tournamentMode.js';
import {
    CANONICAL_ENGINES,
    DEVICE_AVAILABILITY_FEATURES,
    ENGINE_VR_AVAILABILITY,
    ENGINE_VR_EVIDENCE_FEATURE,
    LEGACY_PLATFORM_MAP,
    UNKNOWN,
    foldCataloguePlatforms,
    isCanonicalEngine,
    normalizeProvenanceToken,
} from './scoreProvenance.js';

/**
 * One axis's rules. ADR 0009's orthogonality, unchanged and now applied twice:
 *
 *   `required` — GAME-LEVEL eligibility only. Does the game have at least one
 *                of these? Never restricts the picker.
 *   `excluded` — SUBMISSION-LEVEL filter only. Strips picker options and is
 *                re-validated server-side. Never affects eligibility.
 */
export interface AxisRules {
    required: string[];
    excluded: string[];
}

/**
 * The parsed shape of `tournaments.platform_rules` (ADR 0016 P2 Section 2).
 *
 * Two axes — engine ("what produced the score") and device ("what it ran on")
 * — each carrying ADR 0009's pair. The two axes are evaluated INDEPENDENTLY and
 * combined with AND: a game qualifies when it satisfies the engine `required`
 * *and* the device `required`; a platform stays in the picker when it is
 * excluded by neither axis.
 *
 * The stored blob may still be the pre-0016 flat shape
 * (`{ required, excluded }` over legacy platform ids) — ~200 live rooms have
 * one. `parseTournamentRules` lifts it at READ time; see
 * `liftLegacyPlatformIds`. Nothing migrates the rows; a row is upgraded only
 * when an admin next saves that tournament.
 */
export interface TournamentRules {
    engines: AxisRules;
    devices: AxisRules;
    restrictedText?: string;
}

/**
 * Either the tournament row itself (anything carrying `platform_rules`, and
 * ideally `id` so a warning can name it) or the raw JSON string.
 */
export type TournamentRulesSource =
    | string
    | null
    | undefined
    | { id?: string | null; platform_rules?: string | null };

function emptyAxis(): AxisRules {
    return { required: [], excluded: [] };
}

/** The "restricts nothing" value. Exported so call sites don't hand-roll it. */
export function emptyTournamentRules(): TournamentRules {
    return { engines: emptyAxis(), devices: emptyAxis() };
}

/** True when the rules restrict anything at all, on either axis. */
export function hasAnyPlatformRules(rules: TournamentRules | null | undefined): boolean {
    if (!rules) return false;
    return (
        (rules.engines?.required?.length ?? 0) > 0 ||
        (rules.engines?.excluded?.length ?? 0) > 0 ||
        (rules.devices?.required?.length ?? 0) > 0 ||
        (rules.devices?.excluded?.length ?? 0) > 0
    );
}

/** True when the rules gate GAME eligibility (i.e. either axis has `required`). */
export function hasGameLevelPlatformRules(rules: TournamentRules | null | undefined): boolean {
    if (!rules) return false;
    return (rules.engines?.required?.length ?? 0) > 0 || (rules.devices?.required?.length ?? 0) > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerce a rules field to a de-duplicated, lower-cased token array.
 *
 * Defensive on purpose: a stored `"required": "vpx"` used to reach
 * `passesplatformRules` as a string and throw on `.some`. Lower-casing here is
 * what keeps the pre-0016 case-insensitive comparison behaviour — engine and
 * device ids are canonically lower-case, legacy stored data was not.
 */
function asTokenArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const v of value) {
        if (typeof v !== 'string') continue;
        const token = normalizeProvenanceToken(v);
        if (token && !out.includes(token)) out.push(token);
    }
    return out;
}

/**
 * THE read-time shim (ADR 0016 P2 §2, "The shim is mandatory, not optional").
 *
 * Lifts a flat list of legacy platform ids onto the two axes using
 * `LEGACY_PLATFORM_MAP` — the same table P1 uses to classify a score, so a rule
 * and a score are read against one taxonomy rather than two that can drift.
 *
 * Three cases:
 *   - id maps to an engine only (`vpx`, `pinball_fx`, every console id) → engine axis.
 *   - id maps to a device only (`atgames`, `vr` — engine genuinely unknowable) → device axis.
 *   - id maps to BOTH (`vpxs` → vpx + atgames; every `*_vr` id → engine +
 *     vr_headset; `real` → real + real_cabinet) → **both axes**. Dropping the
 *     device half would quietly widen an existing restriction, which is the one
 *     failure mode this shim exists to prevent.
 *
 * An id the taxonomy does not recognise is kept VERBATIM on the engine axis
 * rather than dropped. Rooms can tag games with arbitrary platform strings
 * (`GET /:roomId/platforms/available` unions `room_game_tags` and passes
 * unknown ids through `normalizePlatform` unchanged), so those strings can
 * reach `platform_rules`. `legacyPlatformsForEngine` falls back to the literal
 * token, which reproduces the pre-0016 exact-string match exactly. Dropping it
 * instead would silently turn a restriction into "restricts nothing".
 */
export function liftLegacyPlatformIds(ids: string[]): { engines: string[]; devices: string[] } {
    const engines: string[] = [];
    const devices: string[] = [];
    const pushEngine = (v: string) => { if (v && !engines.includes(v)) engines.push(v); };
    const pushDevice = (v: string) => { if (v && !devices.includes(v)) devices.push(v); };

    for (const raw of ids) {
        const token = normalizeProvenanceToken(raw);
        if (!token) continue;
        const prov = LEGACY_PLATFORM_MAP[token];
        if (!prov || (prov.engine === UNKNOWN && prov.device === UNKNOWN)) {
            pushEngine(token);
            continue;
        }
        if (prov.engine !== UNKNOWN) pushEngine(prov.engine);
        if (prov.device !== UNKNOWN) pushDevice(prov.device);
    }
    return { engines, devices };
}

/**
 * Normalise any already-decoded rules value to `TournamentRules`, lifting the
 * legacy flat shape when that is what it is.
 *
 * Shared by `parseTournamentRules` (read path) and the Zod schema (write path)
 * so a stale browser tab POSTing the old shape is upgraded rather than rejected,
 * and so **every** writer persists the new shape.
 *
 * Legacy detection is by the presence of an `engines`/`devices` object — not by
 * the absence of `required`/`excluded`, because the new shape has neither at the
 * top level and `{}` is ambiguous (and identical either way).
 */
export function normalizeTournamentRulesInput(value: unknown): TournamentRules {
    if (!isPlainObject(value)) return emptyTournamentRules();

    const isTwoAxis = isPlainObject(value.engines) || isPlainObject(value.devices);
    let rules: TournamentRules;

    if (isTwoAxis) {
        const e = isPlainObject(value.engines) ? value.engines : {};
        const d = isPlainObject(value.devices) ? value.devices : {};
        rules = {
            engines: { required: asTokenArray(e.required), excluded: asTokenArray(e.excluded) },
            devices: { required: asTokenArray(d.required), excluded: asTokenArray(d.excluded) },
        };
    } else {
        const req = liftLegacyPlatformIds(asTokenArray(value.required));
        const exc = liftLegacyPlatformIds(asTokenArray(value.excluded));
        rules = {
            engines: { required: req.engines, excluded: exc.engines },
            devices: { required: req.devices, excluded: exc.devices },
        };
    }

    if (typeof value.restrictedText === 'string') rules.restrictedText = value.restrictedText;
    return rules;
}

/**
 * Guarantee an expansion set contains the canonical id it expands.
 *
 * A rule token is matched against a game's platform list by exact membership
 * over its expansion set, so an id missing from its OWN set silently matches
 * nothing. On the engine axis this now falls out of the identity mappings in
 * `LEGACY_PLATFORM_MAP` (ADR 0016 catalogue phase §1) and this is belt-and-
 * braces; on the DEVICE axis it does not — `real_cabinet` and `vr_headset` are
 * device ids with no legacy spelling of their own, so their sets were built
 * entirely out of OTHER tokens (`real`, `irl`, …). Adding the id itself is
 * additive: no catalogue row or room tag has ever carried a device id, so no
 * game that matched before stops matching, and none starts.
 *
 * Mirrors what `equivalentLegacyPlatforms` already does in `scoreProvenance.ts`.
 */
function withCanonicalSelf(key: string, tokens: string[]): string[] {
    if (tokens.length === 0) return [key];
    return tokens.includes(key) ? tokens : [key, ...tokens];
}

/**
 * Every legacy platform id that denotes `engineId`.
 *
 * `vpx` → `['vpx', 'visual pinball x', 'vpxs', 'vpx standalone', 'vpxs_manual', …]`
 * because ADR 0016 rules those the same engine. A game's catalogue platforms are
 * still legacy ids (converting `global_games.platforms` to engines is a later
 * phase), so an axis rule is compared against the catalogue by expanding the
 * rule token to the id set it covers.
 *
 * An unrecognised token expands to itself — see `liftLegacyPlatformIds`.
 * `'unknown'` expands to nothing: it is the explicit no-claim value and must
 * never behave as a rule.
 */
export function legacyPlatformsForEngine(engineId: string): string[] {
    const key = normalizeProvenanceToken(engineId);
    if (!key || key === UNKNOWN) return [];
    const out = Object.entries(LEGACY_PLATFORM_MAP)
        .filter(([, prov]) => prov.engine === key)
        .map(([token]) => token);
    return withCanonicalSelf(key, out);
}

/**
 * Every legacy platform id that denotes `deviceId` — the device-axis twin of
 * `legacyPlatformsForEngine`. `atgames` → `['atgames', 'vpxs', 'vpx standalone',
 * 'vpxs_manual', …]`, because VPX Standalone *is* the AtGames device.
 */
export function legacyPlatformsForDevice(deviceId: string): string[] {
    const key = normalizeProvenanceToken(deviceId);
    if (!key || key === UNKNOWN) return [];
    const out = Object.entries(LEGACY_PLATFORM_MAP)
        .filter(([, prov]) => prov.device === key)
        .map(([token]) => token);
    return withCanonicalSelf(key, out);
}

function matchesAny(gamePlatforms: string[], tokens: string[]): boolean {
    if (tokens.length === 0) return false;
    const have = new Set(gamePlatforms.map(p => normalizeProvenanceToken(p)));
    return tokens.some(t => have.has(t));
}

/**
 * Devices decided on the ENGINE axis: the engines whose presence in a game's
 * platform list means the game is available on that device.
 *
 * The counterpart of `DEVICE_AVAILABILITY_FEATURES` (the devices decided on the
 * FEATURE axis — `atgames`, `vr_headset`). A device appears in exactly one of
 * the two, or in neither.
 *
 * `real_cabinet` and `pc` reproduce today's behaviour EXACTLY:
 * `legacyPlatformsForDevice('real_cabinet')` is `{real, irl, real machine,
 * physical}` and `legacyPlatformsForEngine('real')` is the same set, likewise
 * for `pc`. `console` and `arcade_cabinet` are a deliberate, narrow widening:
 * NO legacy id maps to either device, so `legacyPlatformsForDevice` returned
 * only the literal token and a `devices.required: ['console']` rule matched
 * zero games — vacuous, in a rule shape only reachable from the new two-axis
 * admin UI (P2's legacy shim can never produce it). Making it mean "this game
 * exists on a console engine" cannot regress any rule that works today, because
 * no such rule works today.
 *
 * `standalone_other` is in neither map on purpose: nothing in the catalogue
 * says a table is available on a Raspberry Pi rather than any other standalone
 * target, and inventing a match would be asserting something the data does not
 * know. It falls through to the legacy-token path and matches nothing — exactly
 * as it does today.
 */
export const DEVICE_MATCH_ENGINES: Record<string, string[]> = {
    real_cabinet:   ['real'],
    pc:             ['pc'],
    arcade_cabinet: ['arcade'],
    // Every video engine that is a console — i.e. the `video` category minus
    // the two that have their own device (`pc`, `arcade`). Derived rather than
    // listed so a newly added console engine is covered without an edit here.
    console: Object.values(CANONICAL_ENGINES)
        .filter(e => e.category === 'video' && e.id !== 'pc' && e.id !== 'arcade')
        .map(e => e.id),
};

/**
 * What a device-axis rule token matches against, on both axes at once.
 *
 * `platforms` — legacy platform ids AND canonical engine ids. Covers a
 *   pre-migration catalogue row (`vpxs`, `pinball_fx_vr`, `real`) and a folded
 *   one (`vpx`, `fx`, `real`) with one token set, because
 *   `legacyPlatformsForEngine` includes the engine's own id (catalogue §1).
 * `features` — the availability facts the fold moves out of `platforms`.
 *
 * A game matches if EITHER set intersects. That is what makes the migration
 * gating-neutral: every platform token in the first set folds to a feature in
 * the second (or to an engine still in the first), so the same game answers the
 * same way before and after — asserted directly by the equivalence tests.
 */
export function deviceMatchTokens(deviceId: string): { platforms: string[]; features: string[] } {
    const key = normalizeProvenanceToken(deviceId);
    if (!key || key === UNKNOWN) return { platforms: [], features: [] };

    const engines = DEVICE_MATCH_ENGINES[key];
    const platforms = engines
        ? Array.from(new Set(engines.flatMap(e => legacyPlatformsForEngine(e))))
        : legacyPlatformsForDevice(key);
    const features = DEVICE_AVAILABILITY_FEATURES[key] ?? [];

    if (key !== 'vr_headset') return { platforms, features };

    // ADR 0019 — `vr_headset`'s AUTHORITY moved to `vrHeadsetMatchesGame`
    // (engine-scoped: wholesale 'always' engines + per-table evidence
    // features), so this function is no longer the source of truth for it —
    // it is used ONLY as the SQL pre-filter's candidate superset ("SQL is a
    // PRE-filter; passesplatformRules below is the authority", rooms.ts). A
    // wholesale-engine game (e.g. a plain `vpx` row carrying no `vr` feature
    // at all) must still survive the SQL pass so the JS gate gets a chance to
    // admit it, so this widens rather than narrows: union in every legacy id
    // for every `always` engine, and every per-table evidence feature. This
    // deliberately makes `deviceMatchesGame('vr_headset', …)` a SUPERSET of
    // `vrHeadsetMatchesGame` — see the "SQL twin" test in
    // catalogue-engine-readers.test.ts for the exact new contract.
    const platformSet = new Set(platforms);
    for (const [engine, mode] of Object.entries(ENGINE_VR_AVAILABILITY)) {
        if (mode !== 'always') continue;
        for (const token of legacyPlatformsForEngine(engine)) platformSet.add(token);
    }
    const featureSet = new Set(features);
    for (const evidenceFeature of Object.values(ENGINE_VR_EVIDENCE_FEATURE)) featureSet.add(evidenceFeature);

    return { platforms: [...platformSet], features: [...featureSet] };
}

/**
 * Does this game satisfy a device-axis `required` rule?
 *
 * **⚠ FLAGGED PRODUCT CALL #2** (contract §4, orchestrator 2026-07-31):
 * device-required matches on **explicit availability only**, never on
 * `ENGINE_DEVICE_COMPAT`. The compat map is deliberately permissive — it exists
 * so a picker does not block a real score, and it says `vpx` runs on `atgames`
 * for EVERY VPX table. Gating through it would make `required: ['atgames']`
 * admit the entire VPX catalogue, where today it admits only the games actually
 * tagged as available there. That is the single most common production rule;
 * silently widening it is not a migration, it is a different tournament.
 *
 * The final device→match table, as implemented:
 *
 *   | device           | matches when                                              |
 *   |------------------|-----------------------------------------------------------|
 *   | `atgames`        | features ∋ {atgames, vpxs, vpxs_manual} — or, pre-fold,    |
 *   |                  | platforms ∋ {atgames, vpxs, vpx standalone, vpxs_manual, …}|
 *   | `vr_headset`     | features ∋ vr — or, pre-fold, platforms ∋ any `*_vr` id.   |
 *   |                  | **This row describes `deviceMatchesGame` itself, which as  |
 *   |                  | of ADR 0019 is used ONLY as the SQL pre-filter's superset — |
 *   |                  | `passesplatformRules` routes `vr_headset` through the      |
 *   |                  | engine-scoped `vrHeadsetMatchesGame` instead.**             |
 *   | `real_cabinet`   | engine `real`                                             |
 *   | `pc`             | engine `pc` (the video engine — NOT "runs on a PC")        |
 *   | `console`        | any console video engine                                  |
 *   | `arcade_cabinet` | engine `arcade`                                           |
 *   | `standalone_other` | nothing — the catalogue does not record it              |
 *
 * `vpxs_manual` is in the `atgames` feature set even though contract §4 wrote
 * the set as `{atgames, vpxs}`: `LEGACY_PLATFORM_MAP['vpxs_manual'].device` is
 * `atgames`, so a manual-install title matches `required: ['atgames']` today,
 * and omitting it would quietly stop admitting those games.
 */
export function deviceMatchesGame(
    deviceId: string,
    gamePlatforms: string[],
    gameFeatures: string[] = [],
): boolean {
    const tokens = deviceMatchTokens(deviceId);
    return matchesAny(gamePlatforms, tokens.platforms)
        || matchesAny(gameFeatures, tokens.features);
}

/**
 * ADR 0019 — the ONE authority for the `vr_headset` REQUIRED-device rule.
 * Replaces the flat `deviceMatchesGame('vr_headset', …)` check inside
 * `passesplatformRules` (every other device is unchanged; `excluded` is
 * untouched — see that function's doc).
 *
 * VR availability is an ENGINE property (`ENGINE_VR_AVAILABILITY`), not the
 * generic `vr` feature: the fix for the Banzai Run false-positive class
 * (`engines.required=[…,fx]` + `devices.required=[vr_headset]` wrongly
 * admitting a game whose `fx` platform and `vr` feature came from different
 * products — a VPX VR-room mod, not Pinball FX VR). An engine E "qualifies"
 * for VR when:
 *   - `ENGINE_VR_AVAILABILITY[E] === 'always'` and the game carries engine E
 *     (wholesale — e.g. every VPX table, owner ruling 2026-08-27), OR
 *   - `ENGINE_VR_AVAILABILITY[E] === 'per_table'` and the game carries
 *     `ENGINE_VR_EVIDENCE_FEATURE[E]` in its features (post-refold evidence,
 *     stamped by the FX VR / FX Classic VR importers) OR a legacy `*_vr`
 *     platform token whose `LEGACY_PLATFORM_MAP` entry names engine E
 *     (pre-refold row evidence — a row that was never re-synced still works).
 *
 * With `requiredEngines` non-empty: satisfied iff SOME required engine
 * qualifies (tokens are normalized the same way rule tokens are elsewhere).
 * With `requiredEngines` empty: satisfied iff ANY engine on the game
 * qualifies; and if the game carries NO recognizable engine-scoped signal at
 * all (no folded engine, no legacy `*_vr` evidence token), falls back to the
 * legacy generic check (`features ∋ 'vr'`, or a legacy `*_vr`/`vr` platform
 * token) so engine-less legacy rows keep matching engine-less VR rules
 * exactly as before this ADR. A game that DOES carry a known non-VR-eligible
 * engine does NOT fall back to the generic `vr` feature — that is precisely
 * the Banzai Run shape this ADR closes, and it applies whether or not the
 * tournament names any required engine.
 */
export function vrHeadsetMatchesGame(
    gamePlatforms: string[],
    gameFeatures: string[],
    requiredEngines: string[],
): boolean {
    const gameEngines = new Set(foldCataloguePlatforms(gamePlatforms).engines);
    const featureSet = new Set(gameFeatures.map(f => normalizeProvenanceToken(f)));

    // Legacy `*_vr` platform tokens still sitting in `platforms` (a row never
    // re-synced through the FX VR importer post-refold) count as per-table
    // evidence for the engine they name.
    const legacyVrEvidenceEngines = new Set<string>();
    for (const raw of gamePlatforms) {
        const token = normalizeProvenanceToken(raw);
        if (!token) continue;
        const prov = LEGACY_PLATFORM_MAP[token];
        if (prov && prov.device === 'vr_headset' && prov.engine !== UNKNOWN) {
            legacyVrEvidenceEngines.add(prov.engine);
        }
    }

    const qualifies = (engine: string): boolean => {
        const mode = ENGINE_VR_AVAILABILITY[engine];
        if (!mode) return false;
        if (mode === 'always') return gameEngines.has(engine);
        const evidenceFeature = ENGINE_VR_EVIDENCE_FEATURE[engine];
        return (!!evidenceFeature && featureSet.has(evidenceFeature)) || legacyVrEvidenceEngines.has(engine);
    };

    const normalizedRequired = requiredEngines
        .map(e => normalizeProvenanceToken(e))
        .filter((e): e is string => !!e);

    if (normalizedRequired.length > 0) {
        return normalizedRequired.some(qualifies);
    }

    const candidateEngines = new Set<string>([...gameEngines, ...legacyVrEvidenceEngines]);
    if (candidateEngines.size === 0) {
        // No engine-scoped signal at all — legacy fallback so engine-less
        // rows keep matching engine-less VR rules exactly as before.
        if (featureSet.has('vr')) return true;
        return gamePlatforms.some(raw => {
            const token = normalizeProvenanceToken(raw);
            const prov = token ? LEGACY_PLATFORM_MAP[token] : undefined;
            return !!prov && prov.device === 'vr_headset';
        });
    }

    for (const engine of candidateEngines) {
        if (qualifies(engine)) return true;
    }
    return false;
}

/**
 * The catalogue tokens a requested platform filter should match (hazard H-D).
 *
 * ONE helper for both catalogue filter paths, which had drifted:
 * `GlobalGameService.search` post-filtered with a raw `includes(p)` while
 * `GlobalLeaderboardService.buildCatalogueFilters` alias-folded through
 * `equivalentLegacyPlatforms`, so the same chip returned different games
 * depending on which surface asked.
 *
 * Resolves a request in EITHER vocabulary — a legacy id from a stale client
 * (`atgames`, `pinball_fx_vr`) or an engine id from a current one
 * (`atgames_native`, `fx`) — by folding it and expanding the resulting engines.
 * So `atgames` matches both the pre-migration rows (platform `atgames`) and the
 * post-migration ones (engine `atgames_native`), and neither client has to know
 * which era the row was written in.
 *
 * Matches `platforms` only, never `features`: "show me AtGames games" is a
 * catalogue-membership question, and answering it with every VPX table that
 * happens to have a standalone build is a different, much larger answer than
 * the chip promises. Device-axis tournament RULES are where availability
 * matters, and they have `deviceMatchesGame`.
 *
 * Expansion goes through the FOLD in both directions rather than through
 * `legacyPlatformsForEngine`, and `atgames` is why. `atgames` maps to engine
 * `unknown` on the score axis (correctly — the cabinet runs four engines), so
 * `legacyPlatformsForEngine('atgames_native')` returns only `atgames_native`
 * and a client asking in the new vocabulary would miss every pre-fold row. The
 * fold is the one place that knows `atgames` and `atgames_native` are the same
 * catalogue fact, so the reverse index is built from it.
 */
export function catalogueMatchTokens(requested: string | null | undefined): string[] {
    const token = normalizeProvenanceToken(requested);
    if (!token) return [];
    const out = new Set<string>([token]);

    const engines = new Set(foldCataloguePlatforms([token]).engines);
    if (engines.size === 0) return [...out];

    // A token with no engine (`vr`, a free-form room tag) matches only itself:
    // expanding it along the availability axis would widen the filter, which is
    // a rule-semantics decision and not a filter's to make.
    for (const candidate of Object.keys(LEGACY_PLATFORM_MAP)) {
        if (foldCataloguePlatforms([candidate]).engines.some(e => engines.has(e))) out.add(candidate);
    }
    return [...out];
}

/**
 * THE parser for `tournaments.platform_rules`. Every runtime read goes through
 * here (ADR 0016 P2, Section 1).
 *
 * Before this existed the blob was parsed at ten independent sites, eight of
 * which swallowed a malformed value into `{}` — and `{}` means *a tournament
 * that restricts nothing*. So a shape change that tripped any one site degraded
 * that path to wide-open, in production, with nothing in the logs. Degrading is
 * still the right behaviour (a bad rules blob must not take a tournament down);
 * degrading *invisibly* is not, hence the warning.
 *
 * Malformed input — unparseable JSON, or valid JSON that isn't an object —
 * logs a WARN naming the tournament and returns empty rules. A missing/empty
 * blob is the normal "no rules" case and is silent. Rule fields coerce to
 * string arrays defensively: a stored `"required": "vpx"` used to reach
 * `passesplatformRules` as a string and throw on `.some`.
 *
 * It is ALSO the read-time shim for the pre-0016 flat shape (Section 2). A row
 * stored as `{ required: ['atgames'] }` comes back as
 * `{ engines: {…}, devices: { required: ['atgames'], … } }`. No row is
 * migrated; a row is rewritten only when an admin next saves that tournament.
 *
 * NOTE — this is for RUNTIME reads only. Migrations that rewrite stored rows
 * (database.ts's 101, platformTaxonomyExpansion's 083/089) deliberately keep
 * their own raw `JSON.parse`: a migration must be a frozen transform of the
 * shape that existed when it was written, and must not change what it persists
 * when this parser evolves.
 */
export function parseTournamentRules(
    source: TournamentRulesSource,
    tournamentId?: string | null,
): TournamentRules {
    const row = typeof source === 'object' && source !== null ? source : null;
    const raw = row ? row.platform_rules ?? null : typeof source === 'string' ? source : null;
    const id: string = tournamentId || row?.id || '(unknown)';

    if (!raw) return emptyTournamentRules();

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        logWarn(
            `platform_rules is not valid JSON for tournament ${id} — degrading to no rules ` +
            `(this tournament will restrict nothing until the value is fixed).`,
        );
        return emptyTournamentRules();
    }

    if (!isPlainObject(parsed)) {
        logWarn(
            `platform_rules is not a JSON object for tournament ${id} — degrading to no rules ` +
            `(this tournament will restrict nothing until the value is fixed).`,
        );
        return emptyTournamentRules();
    }

    return normalizeTournamentRulesInput(parsed);
}

/**
 * Fold one CATALOGUE token (a `global_games.platforms` entry or a free-form
 * `room_game_tags` tag) to the id client surfaces should see.
 *
 * Exists because the OLD taxonomy's `normalizePlatform` is an alias table over
 * LEGACY platform ids, and one of its aliases collides head-on with the new
 * engine namespace: `PLATFORM_ALIASES['fx'] = 'pinball_fx'`. Once the catalogue
 * stores engine ids (ADR 0016 §"Catalogue describes engines, not devices"), a
 * row carrying `fx` would be silently re-legacied to `pinball_fx` before the
 * rules engine or the submit picker ever saw it — the engine id would never
 * reach the client that is being taught to speak engines.
 *
 * So: a canonical ENGINE id passes through untouched; everything else
 * normalizes exactly as it did before. For every id in today's data the two
 * branches agree — every canonical engine id that is also a legacy platform id
 * (`real`, `vpx`, `vp9`, `fp`, `zaccaria`, `pc`, every console id) already
 * normalized to itself — so this is a no-op on the current catalogue and only
 * changes what happens to values the catalogue does not yet contain.
 *
 * Deliberately NOT placed in `scoreProvenance.ts`: that file is mirrored
 * byte-for-byte to the frontend and must stay dependency-free, and this one
 * bridges the two taxonomies.
 */
export function normalizeCataloguePlatformId(raw: string | null | undefined): string {
    const token = normalizeProvenanceToken(raw);
    if (!token) return '';
    if (isCanonicalEngine(token)) return token;
    return normalizePlatform(token);
}

/**
 * Parses a platforms value (JSON array or comma-separated string) into a string array.
 * Shared between all platform-reading code paths.
 */
export function parsePlatformsList(raw: string): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.filter(Boolean);
    } catch {}
    return raw.split(',').map(p => p.trim()).filter(Boolean);
}

/**
 * v2.4.0: returns the effective platforms for a game in a room as the union of
 * the shared library platforms and the per-room custom platforms (stored on
 * `game_room_game_library.custom_platforms`). De-duplicated case-insensitively
 * while preserving the first-seen casing. Use this instead of
 * `parsePlatformsList` wherever a room context is available.
 */
export function mergeEffectivePlatforms(
    libraryRaw: string | null | undefined,
    roomCustomRaw: string | null | undefined,
): string[] {
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const raw of [libraryRaw, roomCustomRaw]) {
        if (!raw) continue;
        for (const p of parsePlatformsList(raw)) {
            const key = p.toUpperCase();
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(p);
        }
    }
    return merged;
}

/**
 * Returns the subset of `gamePlatforms` a player can pick from when submitting
 * a score. Used by the SubmissionSheet picker and re-validated server-side at
 * every submit handler.
 *
 * Rules (ADR 0009's orthogonal-axes semantics, now on two axes):
 *   - If `tournamentRules` is undefined (freeplay / global submit / no active
 *     tournament for this game), return all of `gamePlatforms` unchanged.
 *   - Strip any platform whose ENGINE is in `engines.excluded` **or** whose
 *     DEVICE is in `devices.excluded` ("Not allowed on", per axis). The two
 *     axes are independent; a platform survives only if neither excludes it.
 *   - `required` on EITHER axis is INTENTIONALLY ignored here. Required is a
 *     *game-level* eligibility gate enforced by `passesplatformRules` — it
 *     decides which games qualify for a tournament, not which platforms can
 *     score in one. A game admitted under a Must rule is fully scorable on any
 *     of its catalogue platforms (modulo NotAllowed). E.g. WHO dunnit is on
 *     [vpx, vpxs, real, fx, fx_vr, atgames]; a tournament requiring the
 *     `atgames` device still accepts vpx submissions for it.
 *
 * Comparison is case-insensitive so legacy stored mixed-case data still works.
 */
export function resolveSubmittablePlatforms(
    gamePlatforms: string[],
    tournamentRules?: TournamentRules | null,
): string[] {
    if (!tournamentRules) return gamePlatforms;
    const blocked = new Set<string>();
    for (const engineId of tournamentRules.engines?.excluded ?? []) {
        for (const token of legacyPlatformsForEngine(engineId)) blocked.add(token);
    }
    for (const deviceId of tournamentRules.devices?.excluded ?? []) {
        for (const token of legacyPlatformsForDevice(deviceId)) blocked.add(token);
    }
    if (blocked.size === 0) return gamePlatforms;
    return gamePlatforms.filter(p => !blocked.has(normalizeProvenanceToken(p)));
}

/**
 * Game-level gate for tournament platform rules — decides whether a game
 * qualifies for a tournament. (Submission-level filtering is the job of
 * `resolveSubmittablePlatforms`.)
 *
 * Two rule kinds on two rule axes:
 *   - `required` ("Must be available on") is checked here, ON BOTH AXES and
 *     combined with AND: the game must list at least one platform denoting a
 *     required engine, AND at least one denoting a required device. An empty
 *     `required` on an axis means that axis admits everything.
 *   - `excluded` ("Not allowed on") is INTENTIONALLY ignored here, on both
 *     axes — see ADR 0009 + the JSDoc on `resolveSubmittablePlatforms`.
 *
 * The device axis genuinely participates in eligibility even though "a game has
 * no device": while the catalogue is still a list of legacy ids, a device is
 * exactly what ids like `atgames` and `vpxs` carry. Ignoring the device axis
 * here would turn the single most common production rule — the legacy
 * `required: ['atgames']`, whose engine is unknowable and which therefore lifts
 * to the device axis alone — into a tournament that restricts nothing.
 *
 * Example: WHO dunnit is on [vpx, vpxs, real, atgames]. Legacy rule
 * `required = [atgames], excluded = [real]` lifts to
 * `devices.required = [atgames]`, `engines.excluded = [real]`,
 * `devices.excluded = [real_cabinet]`:
 *   - `passesplatformRules`: TRUE (game has atgames → admissible)
 *   - `resolveSubmittablePlatforms`: [vpx, vpxs, atgames] (real stripped)
 *
 * `gameFeatures` is the game's `global_games.features` array and is what keeps
 * the device axis working once availability leaves `platforms` (ADR 0016
 * catalogue phase §4, hazard H-C). It defaults to `[]` so a pre-fold catalogue
 * row — and any caller not yet passing it — behaves exactly as before: the
 * legacy platform ids are still in the platform list and still match. Once the
 * row is folded the same fact lives in `features` and matches there instead.
 * Every eligibility call site passes it; the default exists for the legacy
 * shape, not as a licence to omit it.
 */
export function passesplatformRules(
    gamePlatforms: string[],
    rules: TournamentRules,
    gameFeatures: string[] = [],
): boolean {
    const requiredEngines = rules.engines?.required ?? [];
    const requiredDevices = rules.devices?.required ?? [];

    const engineOk = requiredEngines.length === 0 ||
        requiredEngines.some(e => matchesAny(gamePlatforms, legacyPlatformsForEngine(e)));
    if (!engineOk) return false;

    return requiredDevices.length === 0 ||
        requiredDevices.some(d => d === 'vr_headset'
            // ADR 0019 — vr_headset is engine-scoped; every other device is
            // unchanged.
            ? vrHeadsetMatchesGame(gamePlatforms, gameFeatures, requiredEngines)
            : deviceMatchesGame(d, gamePlatforms, gameFeatures));
}

/**
 * One catalogue row's identity-independent fields — everything
 * `variantQualifies` needs to judge a SINGLE row on its own merits.
 */
export interface QualificationVariant {
    /** `global_games.type` for this row, or the catalogue-row `mode` field. */
    mode?: string | null;
    platforms: string[];
    features: string[];
}

/**
 * v2.144.1 — the anti-cross-mix fix.
 *
 * The catalogue can hold several APPROVED rows with the same `name` (genuinely
 * different games/variants that happen to share a title — e.g. an "Original"
 * VPX fan table and a "Zen Studios" FX Classic release both named "The
 * Walking Dead"). Four eligibility readers used to collapse those rows with a
 * `GROUP BY LOWER(name)` + `MIN()`-per-column SQL query. `MIN()` is evaluated
 * per COLUMN, independently and lexicographically, so the "collapsed" row
 * could carry one variant's `platforms` paired with a DIFFERENT variant's
 * `features` — a chimera neither actual row has. That silently hid a fully
 * qualifying variant (the Walking Dead miss, live prod 2026-08-28:
 * `MIN(platforms)` and `MIN(features)` landed on two different rows, so the
 * resulting group had the FX Classic row's platforms with no evidence
 * feature attached, and a VR tournament's eligibility check found no VR
 * signal even though the Zen Studios variant alone fully qualifies) and
 * could equally FALSELY qualify a group where no single row satisfies the
 * rule.
 *
 * The fix: never mix columns across rows. A name-group qualifies iff at
 * least ONE variant qualifies on its OWN platforms + features. `tags`
 * (`room_game_tags`, keyed by name) are a room fact about the NAME, not
 * about one catalogue row, so they apply to every variant equally.
 *
 * `requireSubmittable` mirrors the v2.102.2 no-submittable-platform hide: a
 * platform-less variant still qualifies (nothing for `excluded` to remove),
 * but a variant whose every submittable platform the rules excluded does
 * not. Pass it only where that hide already applied before this fix
 * (game-availability, the Discord autocomplete) — omit it where it never
 * applied (autopick).
 */
export function variantQualifies(
    variant: QualificationVariant,
    tournamentMode: string | null | undefined,
    rules: TournamentRules,
    tags: string[] = [],
    opts: { requireSubmittable?: boolean } = {},
): boolean {
    if (!catalogueTypeMatchesTournamentMode(variant.mode ?? null, tournamentMode)) return false;
    const gamePlatforms = [...variant.platforms, ...tags];
    if (!passesplatformRules(gamePlatforms, rules, variant.features)) return false;
    if (opts.requireSubmittable) {
        return gamePlatforms.length === 0 || resolveSubmittablePlatforms(gamePlatforms, rules).length > 0;
    }
    return true;
}

/**
 * The any-variant-qualifies gate for a whole name-group: the first variant
 * (input order) that satisfies `variantQualifies`, or `null` when none does.
 * See `variantQualifies` for the doctrine.
 */
export function firstQualifyingVariant<T extends QualificationVariant>(
    variants: T[],
    tournamentMode: string | null | undefined,
    rules: TournamentRules,
    tags: string[] = [],
    opts: { requireSubmittable?: boolean } = {},
): T | null {
    for (const variant of variants) {
        if (variantQualifies(variant, tournamentMode, rules, tags, opts)) return variant;
    }
    return null;
}
