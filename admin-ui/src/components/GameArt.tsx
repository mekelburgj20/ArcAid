import { useState } from 'react';

/**
 * A table's art as a small rounded thumbnail (v2.240.0, B25): History, the
 * tournament page, the player page and the Stats page put one beside each
 * game. `src` comes from the server (`GameArtService`: the catalogue art the
 * score card falls back to). With no art, or art that fails to load, it draws
 * the game's initials on a plain tile so the column still lines up.
 *
 * Decorative: the game's name is always written beside it, so the image has
 * empty alt text and is hidden from assistive tech.
 */
export default function GameArt({ src, name, size = 48, className = '' }: {
  src: string | null | undefined;
  name: string;
  /** Edge length in px (square). */
  size?: number;
  className?: string;
}) {
  // Remembers WHICH src failed, so a new src gets its own try.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const box = { width: size, height: size };

  if (src && failedSrc !== src) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden="true"
        loading="lazy"
        decoding="async"
        width={size}
        height={size}
        data-testid="game-art"
        onError={() => setFailedSrc(src)}
        className={`flex-shrink-0 rounded-md object-cover bg-raised border border-border/50 ${className}`}
        style={box}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      data-testid="game-art-fallback"
      className={`flex-shrink-0 rounded-md border border-border/50 bg-raised flex items-center justify-center font-display font-bold text-faint select-none ${className}`}
      style={{ ...box, fontSize: Math.max(9, Math.round(size * 0.32)) }}
    >
      {gameInitials(name)}
    </span>
  );
}

/** "Attack from Mars" -> "AM", "Godzilla" -> "GO", "24" -> "24". */
function gameInitials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const significant = words.filter(w => /^[\p{Lu}\p{N}]/u.test(w));
  const pick = significant.length >= 2 ? significant : words;
  if (pick.length >= 2) return (pick[0]![0]! + pick[1]![0]!).toUpperCase();
  return (pick[0] ?? '?').slice(0, 2).toUpperCase();
}
