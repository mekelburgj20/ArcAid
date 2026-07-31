import {
    UNKNOWN,
    getDeviceShortLabel,
    getEngineShortLabel,
    isDeviceInformative,
} from '../lib/scoreProvenance';
import {
    describeProvenance,
    resolveProvenance,
    type ScoreProvenance,
} from '../lib/provenanceDisplay';

/**
 * Per-score provenance tags (ADR 0016, P3).
 *
 * A score is "VPX" *on* "AtGames" — two facts, not one. Collapsing them into a
 * single "platform" chip is the conflation ADR 0016 exists to end, so this
 * renders the engine prominently and the device as a quieter secondary tag.
 *
 * Three rules no call site should re-derive:
 *
 *  1. **`unknown` engine renders "Unspecified", never blank and never omitted.**
 *     63 of ~120 production score rows are the irreducible AtGames ambiguity.
 *     Dropping the tag would make a real data state look like a rendering bug,
 *     and inventing a category for it would assert something the data cannot
 *     support — so it renders, visibly uncategorised.
 *  2. **`unknown` device renders nothing.** "Unspecified · Unspecified" is
 *     noise, not information.
 *  3. **A device carrying no information is dropped** — `isDeviceInformative`
 *     suppresses it when the engine has exactly one possible device, so a real
 *     machine reads "Real", not "Real · Cabinet".
 */

const ENGINE_CHIP =
    'text-[10px] px-1.5 py-0.5 rounded bg-neon-cyan/10 text-neon-cyan font-display tracking-wide whitespace-nowrap';
const DEVICE_CHIP =
    'text-[10px] px-1.5 py-0.5 rounded bg-raised text-muted font-display tracking-wide whitespace-nowrap';
/**
 * The unspecified engine is deliberately styled DOWN, not out: muted rather
 * than accent, so a page of AtGames-era scores doesn't read as a wall of
 * highlighted chips claiming provenance nobody recorded.
 */
const UNSPECIFIED_CHIP =
    'text-[10px] px-1.5 py-0.5 rounded bg-raised text-faint font-display tracking-wide whitespace-nowrap';

export default function ProvenanceTags({ entry, omitEngine = false, className = '' }: {
    entry: ScoreProvenance;
    /**
     * Drop the engine chip and keep only the device.
     *
     * For use inside an engine-filtered view, where every row shares the engine
     * named by the active tab: repeating it on each line is pure redundancy,
     * while the device still varies row to row and is the only half that
     * carries information there.
     */
    omitEngine?: boolean;
    className?: string;
}) {
    const resolved = resolveProvenance(entry);
    if (!resolved) return null;
    const { engine, device } = resolved;
    const showDevice = isDeviceInformative(engine, device);
    if (omitEngine && !showDevice) return null;

    return (
        <span
            className={`inline-flex items-center gap-1 flex-shrink-0 ${className}`}
            title={describeProvenance(engine, device)}
        >
            {!omitEngine && (
                <span className={engine === UNKNOWN ? UNSPECIFIED_CHIP : ENGINE_CHIP}>
                    {getEngineShortLabel(engine)}
                </span>
            )}
            {showDevice && (
                <span className={DEVICE_CHIP}>{getDeviceShortLabel(device)}</span>
            )}
        </span>
    );
}
