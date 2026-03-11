import type { ReactNode } from 'react';

interface NeonCardProps {
  children: ReactNode;
  title?: string;
  glowColor?: 'cyan' | 'green' | 'magenta' | 'amber' | 'none';
  className?: string;
}

const glowClasses = {
  cyan: 'border-neon-cyan/40 glow-cyan',
  green: 'border-neon-green/40 glow-green',
  magenta: 'border-neon-magenta/40 glow-magenta',
  amber: 'border-neon-amber/40 glow-amber',
  none: 'border-border',
};

export default function NeonCard({ children, title, glowColor = 'none', className = '' }: NeonCardProps) {
  return (
    <div className={`bg-surface border rounded-lg p-4 sm:p-5 min-w-0 overflow-hidden ${glowClasses[glowColor]} ${className}`}>
      {title && (
        <h3 className="font-display text-sm font-bold uppercase tracking-wider text-muted mb-4">{title}</h3>
      )}
      {children}
    </div>
  );
}
