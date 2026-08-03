interface ScoreDisplayProps {
  score: number;
  size?: 'sm' | 'md' | 'lg';
}

const sizes = {
  sm: 'text-sm',
  md: 'text-xl',
  lg: 'text-3xl',
};

export default function ScoreDisplay({ score, size = 'md' }: ScoreDisplayProps) {
  return (
    // Shared primitive: every call site renders it as a fixed-size cell beside
    // flexible text (table cells, flex rows, stat cards), so the number must
    // never wrap or be squeezed. `nowrap` alone would still let a flex parent
    // shrink the box, hence `flex-shrink-0` too — safe everywhere it's used.
    <span className={`font-display font-bold text-neon-amber whitespace-nowrap tabular-nums flex-shrink-0 ${sizes[size]}`}>
      {score != null ? score.toLocaleString() : '—'}
    </span>
  );
}
