import {
    UNKNOWN,
    getDeviceDisplay,
    getEngineCategoryLabel,
    getEngineDisplay,
    isDeviceInformative,
    normalizeProvenanceToken,
} from './scoreProvenance';

/**
 * Display-layer helpers for per-score provenance (ADR 0016, P3).
 *
 * Separate from `scoreProvenance.ts` because that file is a byte-for-byte
 * mirror of `src/utils/scoreProvenance.ts` guarded by a parity test — anything
 * frontend-only has to live outside it. Separate from `ProvenanceTags.tsx`
 * because these are pure functions, and co-locating them with a component
 * breaks React Fast Refresh.
 */

export interface ScoreProvenance {
    engine?: string | null;
    device?: string | null;
    /** @deprecated v2.58.0 — read only as a marker of an unmigrated payload. */
    platform?: string | null;
}

/**
 * Resolve the (engine, device) pair to render for a score row.
 *
 * Returns null only when the payload carries NEITHER provenance key — an
 * endpoint or cached blob that predates P3. Those surfaces render nothing
 * rather than an "Unspecified" the server never actually claimed; the legacy
 * `platform` field is deliberately NOT consulted, because deriving provenance
 * from it client-side is precisely the guesswork ADR 0016 removes.
 */
export function resolveProvenance(entry: ScoreProvenance): { engine: string; device: string } | null {
    const engine = normalizeProvenanceToken(entry.engine);
    const device = normalizeProvenanceToken(entry.device);
    if (engine || device) return { engine: engine || UNKNOWN, device: device || UNKNOWN };
    return null;
}

/**
 * Full-sentence description for tooltips and screen readers — "Visual Pinball X
 * on AtGames Cabinet (Simulation)".
 *
 * The fidelity category rides here rather than in a third visible chip: it is
 * derived from the engine, so showing it would restate what the engine tag
 * already says at triple the visual weight. An engine with no category
 * contributes no parenthetical at all rather than "(Unknown)".
 *
 * v2.65.0 — the same reasoning now also drops a parenthetical that is LITERALLY
 * the engine's own name. Renaming the `real` band's label to "Real Machine"
 * (the id stays `real`) collided it with the `real` engine's display name, and
 * the sentence came out "Real Machine (Real Machine)". A category that adds no
 * word the reader hasn't already read is not worth the parentheses. Written as
 * a general comparison rather than a `real` special-case: any future engine
 * whose name matches its band gets the same treatment for free.
 */
export function describeProvenance(engine: string, device: string): string {
    const engineLabel = getEngineDisplay(engine);
    const parts = [engineLabel];
    if (isDeviceInformative(engine, device)) parts.push(`on ${getDeviceDisplay(device)}`);
    const category = getEngineCategoryLabel(engine);
    if (category && category !== engineLabel) parts.push(`(${category})`);
    return parts.join(' ');
}
