interface TournamentBadgeProps {
  type: string;
}

const typeColors: Record<string, string> = {
  DG: 'bg-neon-cyan/15 text-neon-cyan border-neon-cyan/30',
  'WG-VPXS': 'bg-neon-green/15 text-neon-green border-neon-green/30',
  'WG-VR': 'bg-neon-purple/15 text-neon-purple border-neon-purple/30',
  MG: 'bg-neon-amber/15 text-neon-amber border-neon-amber/30',
};

export default function TournamentBadge({ type }: TournamentBadgeProps) {
  const colors = typeColors[type.toUpperCase()] || 'bg-border/30 text-muted border-border';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-display font-bold uppercase tracking-wider border ${colors}`}>
      {type}
    </span>
  );
}
