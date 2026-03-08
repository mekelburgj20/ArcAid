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
    <span className={`font-display font-bold text-neon-amber ${sizes[size]}`}>
      {score.toLocaleString()}
    </span>
  );
}
