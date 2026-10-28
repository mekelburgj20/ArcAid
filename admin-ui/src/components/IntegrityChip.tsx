import { LogOut, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { IntegrityChipSpec, QuitLabelSpec } from '../lib/integrityBadge';

/**
 * The integrity chip (v2.166.0, ADR 0027) â sits beside the WITNESSED badge on
 * a board row and says what Castcade measured about that score against the
 * tournament's conditions. Same chip shape as `WitnessedChip` in
 * `ProvenanceTags.tsx`: green for a pass, amber for a flag.
 *
 * Amber, not red, on purpose: a flag is a measurement a human may want to look
 * at, not a verdict on the player. The score is still on the board (badge,
 * never gate) and the tooltip carries the reasons.
 */
const BASE =
    'inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded font-display tracking-wide whitespace-nowrap';
const TONE: Record<IntegrityChipSpec['tone'], string> = {
    pass: 'bg-emerald-500/10 text-emerald-400',
    flagged: 'bg-amber-500/10 text-amber-400',
};

export default function IntegrityChip({ chip, className = '' }: { chip: IntegrityChipSpec | null; className?: string }) {
    if (!chip) return null;
    const Icon = chip.tone === 'pass' ? ShieldCheck : ShieldAlert;
    return (
        <span
            className={`${BASE} ${TONE[chip.tone]} ${className}`}
            data-testid={`integrity-chip-${chip.tone}`}
            title={chip.title}
        >
            <Icon size={10} aria-hidden="true" />
            {chip.label}
        </span>
    );
}

/**
 * The quit chip (v2.187.0, W49) — "Quit on ball 2" / "Quit". Neutral on
 * purpose (muted theme tokens, not the flagged amber): a quit game still
 * counts, so this is a fact about how the game ended, not a warning.
 */
export function QuitChip({ quit, className = '' }: { quit: QuitLabelSpec | null; className?: string }) {
    if (!quit) return null;
    return (
        <span
            className={`${BASE} bg-raised text-muted ${className}`}
            data-testid="quit-chip"
            title={quit.title}
        >
            <LogOut size={10} aria-hidden="true" />
            {quit.label}
        </span>
    );
}
