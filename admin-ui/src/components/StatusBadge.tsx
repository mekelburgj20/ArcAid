interface StatusBadgeProps {
  status: 'ACTIVE' | 'QUEUED' | 'COMPLETED' | 'HIDDEN' | string;
}

const statusStyles: Record<string, string> = {
  ACTIVE: 'bg-neon-green/15 text-neon-green border-neon-green/30',
  QUEUED: 'bg-neon-amber/15 text-neon-amber border-neon-amber/30',
  COMPLETED: 'bg-neon-cyan/15 text-neon-cyan border-neon-cyan/30',
  HIDDEN: 'bg-faint/15 text-faint border-faint/30',
};

export default function StatusBadge({ status }: StatusBadgeProps) {
  const style = statusStyles[status] || statusStyles.HIDDEN;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${style}`}>
      {status === 'ACTIVE' && <span className="w-1.5 h-1.5 rounded-full bg-neon-green mr-1.5 pulse" />}
      {status}
    </span>
  );
}
