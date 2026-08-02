/**
 * "What a player may pick" — the ONE derivation over `GET /api/submit/platforms`.
 *
 * Two surfaces answer the same question and must never disagree:
 *   - `SubmissionSheet` builds the engine + device pickers a submitter uses.
 *   - `GameInfoPopup`'s "What's allowed" section tells a player what those
 *     pickers WOULD offer, so they can decide whether to play at all without
 *     opening the submit sheet (the whole reason the section exists).
 *
 * If those two ever derived independently, the popup would advertise an option
 * the picker refuses (or hide one it offers), which is worse than not showing
 * the section. So the derivation lives here once and both import it — parity by
 * construction, not by review.
 *
 * Deliberately NOT added to `lib/scoreProvenance.ts`: that file is a
 * byte-identical mirror of the backend module, locked by
 * `scoreProvenance-parity.test.ts`. This is frontend-only response plumbing
 * layered on top of it.
 *
 * Semantics come straight from ADR 0006/0009 (kept by ADR 0016 P2's two axes):
 * `excluded` is the submission-level filter and is the ONLY axis applied here;
 * `required` is game-level eligibility and deliberately plays no part in what a
 * qualifying game's picker offers.
 */

import {
    enginesFromLegacyPlatforms,
    devicesForEngineAndPlatforms,
} from './scoreProvenance';

/** The `excluded` half of each axis — the only half that narrows a picker. */
export interface ProvenanceExclusions {
    engines: string[];
    devices: string[];
}

/** Normalized `GET /api/submit/platforms` payload. */
export interface SubmitPlatformsResolution {
    /** The game's effective platform set, before tournament rules. */
    platforms: string[];
    /** What the player may actually pick from (platforms − excluded). */
    submittable: string[];
    /** `global_games.features` — the device half of the catalogue fold. */
    features: string[];
    exclusions: ProvenanceExclusions;
    /**
     * True when the response carried a `tournamentRules` object at all, i.e.
     * an ACTIVE tournament governs this game. `null` there means "no active
     * tournament", which the endpoint keeps distinct from "a tournament with
     * empty rules" — the popup's heading depends on the difference.
     */
    hasTournament: boolean;
    /**
     * The admin's own wording of the restriction, when the response carries it.
     *
     * Read defensively because as of v2.62.0 `GET /api/submit/platforms`
     * deliberately strips it ("server-side; it is the rejection message, not
     * picker input" — `src/api/routes/global.ts`). Reading it here costs
     * nothing and means the popup starts showing it the day the endpoint
     * starts shipping it, with no frontend change.
     */
    restrictedText: string | null;
}

const asStringArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Parse the resolver response into the shape both surfaces consume. */
export function parseSubmitPlatformsResponse(data: unknown): SubmitPlatformsResolution {
    const d = (data ?? {}) as Record<string, unknown>;
    const rules = d.tournamentRules as
        | { engines?: { excluded?: unknown }; devices?: { excluded?: unknown }; restrictedText?: unknown }
        | null
        | undefined;
    const restrictedText = typeof rules?.restrictedText === 'string' && rules.restrictedText.trim()
        ? rules.restrictedText.trim()
        : null;
    return {
        platforms: asStringArray(d.platforms),
        submittable: asStringArray(d.submittable),
        features: asStringArray(d.features),
        exclusions: {
            engines: asStringArray(rules?.engines?.excluded),
            devices: asStringArray(rules?.devices?.excluded),
        },
        hasTournament: !!rules,
        restrictedText,
    };
}

/**
 * The engine options a submitter would be offered.
 *
 * `enginesFromLegacyPlatforms` over the SUBMITTABLE set (not the full platform
 * set), minus engine-axis exclusions — byte-for-byte what `SubmissionSheet`'s
 * `engineOptions` is.
 */
export function allowedEngines(submittable: string[], excludedEngines: string[]): string[] {
    return enginesFromLegacyPlatforms(submittable).filter(e => !excludedEngines.includes(e));
}

/** The device options a submitter would be offered once they pick `engine`. */
export function allowedDevicesForEngine(
    engine: string,
    submittable: string[],
    features: string[],
    excludedDevices: string[],
): string[] {
    return devicesForEngineAndPlatforms(engine, submittable, features)
        .filter(d => !excludedDevices.includes(d));
}

/**
 * Union of the device options across every allowed engine, in first-seen order.
 *
 * The submit picker only ever shows one engine's devices at a time; a player
 * reading the card hasn't chosen an engine yet, so the honest answer to "what
 * hardware counts here" is the union over the engines they could choose.
 */
export function allowedDevicesForEngines(
    engines: string[],
    submittable: string[],
    features: string[],
    excludedDevices: string[],
): string[] {
    const out: string[] = [];
    for (const engine of engines) {
        for (const device of allowedDevicesForEngine(engine, submittable, features, excludedDevices)) {
            if (!out.includes(device)) out.push(device);
        }
    }
    return out;
}
