/**
 * The tournament-type chip shared by the public History list and the
 * per-tournament board page. Colors mirror `TournamentBadge` (admin History) —
 * kept separate because the public pages intentionally avoid the admin
 * component set.
 *
 * `flex-shrink-0 whitespace-nowrap` is load-bearing: the tag is a fixed token,
 * so at 390px the name beside it must yield rather than the badge wrapping onto
 * its own line (the reported "type tags wrap" symptom).
 */
export const TOURNAMENT_TYPE_COLORS: Record<string, string> = {
  DG: 'bg-neon-magenta/15 text-neon-magenta border-neon-magenta/30',
  'WG-VPXS': 'bg-neon-blue/15 text-neon-blue border-neon-blue/30',
  'WG-VR': 'bg-neon-purple/15 text-neon-purple border-neon-purple/30',
  MG: 'bg-neon-coral/15 text-neon-coral border-neon-coral/30',
};

export function TournamentTypeBadge({ type }: { type: string }) {
  const colors = TOURNAMENT_TYPE_COLORS[type.toUpperCase()] || 'bg-border/30 text-muted border-border';
  return (
    <span className={`inline-flex flex-shrink-0 whitespace-nowrap items-center px-2 py-0.5 rounded text-[10px] font-display font-bold uppercase tracking-wider border ${colors}`}>
      {type}
    </span>
  );
}
