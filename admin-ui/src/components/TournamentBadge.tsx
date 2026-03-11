interface TournamentBadgeProps {
  type: string;
}

// Use colors distinct from status badges (green=ACTIVE, amber=QUEUED, cyan=COMPLETED)
const typeColors: Record<string, string> = {
  DG: 'bg-neon-magenta/15 text-neon-magenta border-neon-magenta/30',
  'WG-VPXS': 'bg-neon-blue/15 text-neon-blue border-neon-blue/30',
  'WG-VR': 'bg-neon-purple/15 text-neon-purple border-neon-purple/30',
  MG: 'bg-neon-coral/15 text-neon-coral border-neon-coral/30',
};

export default function TournamentBadge({ type }: TournamentBadgeProps) {
  const colors = typeColors[type.toUpperCase()] || 'bg-border/30 text-muted border-border';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-display font-bold uppercase tracking-wider border ${colors}`}>
      {type}
    </span>
  );
}
