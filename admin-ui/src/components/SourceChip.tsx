import { ShieldCheck } from 'lucide-react';
import { isWitnessedScore } from '../lib/provenanceDisplay';

/**
 * The per-score SOURCE chip on a player's history rows.
 *
 * v2.155.0: `'vpx'` and `'atgames'` mean a paired cabinet reported the score
 * with nobody typing it, so they render as the WITNESSED badge rather than as a
 * raw lowercase word. Without this they printed literally as "vpx", which reads
 * like a debug leak in the one place a player inspects their own scores.
 *
 * Every history-row renderer MUST use this chip. v2.155.0 fixed two of
 * GameDetail's three and left `ScoreHistoryRow` (the This-tournament /
 * All-time split) printing the raw word — which is exactly the surface the
 * round-8 tester was told to look at for the AW shield (2026-09-06).
 *
 * v2.157.0: moved out of `pages/GameDetail.tsx` (which still re-exports it) so
 * the Global game page's per-player history can share it rather than copy it.
 *
 * A null source renders nothing: on a Global row that predates the column we
 * cannot say how the score reached us, and an empty chip would claim otherwise.
 */
export function SourceChip({ source }: { source: string | null | undefined }) {
    if (isWitnessedScore({ source })) {
        return (
            <span
                className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400"
                title="Witnessed — reported by this player's paired Arcaid Witness cabinet, not entered by hand"
            >
                <ShieldCheck size={10} aria-hidden="true" /> AW
            </span>
        );
    }
    if (!source) return null;
    return (
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${
            source === 'tournament' ? 'bg-neon-cyan/10 text-neon-cyan' :
            source === 'sync' ? 'bg-neon-purple/10 text-neon-purple' :
            'bg-neon-green/10 text-neon-green'
        }`}>{source}</span>
    );
}

export default SourceChip;
