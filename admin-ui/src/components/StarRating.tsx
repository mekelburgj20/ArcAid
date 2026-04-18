import { useState } from 'react';
import { Star } from 'lucide-react';

interface StarRatingProps {
  rating: number;
  onRate?: (rating: number) => void;
  size?: 'sm' | 'md';
}

export default function StarRating({ rating, onRate, size = 'sm' }: StarRatingProps) {
  const [hover, setHover] = useState(0);
  const interactive = !!onRate;
  const pixelSize = size === 'sm' ? 14 : 20;

  return (
    <div className={`inline-flex gap-0.5 ${interactive ? 'cursor-pointer' : ''}`}>
      {[1, 2, 3, 4, 5].map(star => {
        const filled = star <= (hover || rating);
        return (
          <span
            key={star}
            className={`inline-flex transition-colors ${
              filled ? 'text-neon-amber' : 'text-border'
            } ${interactive ? 'hover:scale-110' : ''}`}
            onClick={() => onRate?.(star)}
            onMouseEnter={() => interactive && setHover(star)}
            onMouseLeave={() => interactive && setHover(0)}
            role={interactive ? 'button' : undefined}
            aria-label={interactive ? `Rate ${star} star${star === 1 ? '' : 's'}` : undefined}
          >
            <Star size={pixelSize} fill={filled ? 'currentColor' : 'none'} />
          </span>
        );
      })}
    </div>
  );
}
