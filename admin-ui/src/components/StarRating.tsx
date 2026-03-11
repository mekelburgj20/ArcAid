import { useState } from 'react';

interface StarRatingProps {
  rating: number;
  onRate?: (rating: number) => void;
  size?: 'sm' | 'md';
}

export default function StarRating({ rating, onRate, size = 'sm' }: StarRatingProps) {
  const [hover, setHover] = useState(0);
  const interactive = !!onRate;
  const starSize = size === 'sm' ? 'text-sm' : 'text-lg';

  return (
    <div className={`inline-flex gap-0.5 ${interactive ? 'cursor-pointer' : ''}`}>
      {[1, 2, 3, 4, 5].map(star => {
        const filled = star <= (hover || rating);
        return (
          <span
            key={star}
            className={`${starSize} transition-colors ${
              filled ? 'text-neon-amber' : 'text-border'
            } ${interactive ? 'hover:scale-110' : ''}`}
            onClick={() => onRate?.(star)}
            onMouseEnter={() => interactive && setHover(star)}
            onMouseLeave={() => interactive && setHover(0)}
          >
            ★
          </span>
        );
      })}
    </div>
  );
}
