import { useState, type CSSProperties } from 'react';

/**
 * A table's art as a rounded square thumbnail (v2.240.0, B25): History, the
 * tournament page, the player page and the Stats page put one beside each
 * game. `src` comes from the server (`GameArtService`: the catalogue art the
 * score card falls back to). With no art, or art that fails to load, it draws
 * the game's initials on a plain tile so the column still lines up.
 *
 * v2.241.0 (B26): `mobileSize` gives phones their own edge length, so the
 * art can be large on a desktop without crowding a 390px row.
 *
 * Decorative: the game's name is always written beside it, so the image has
 * empty alt text and is hidden from assistive tech.
 */
export default function GameArt({ src, name, size = 48, mobileSize, className = '' }: {
  src: string | null | undefined;
  name: string;
  /** Edge length in px (square), from the `sm` breakpoint up. */
  size?: number;
  /** Edge length below `sm`; defaults to `size`. */
  mobileSize?: number;
  className?: string;
}) {
  // Remembers WHICH src failed, so a new src gets its own try.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const box = {
    '--art': `${size}px`,
    '--art-sm': `${mobileSize ?? size}px`,
  } as CSSProperties;
  const sizing = 'w-[var(--art-sm)] h-[var(--art-sm)] sm:w-[var(--art)] sm:h-[var(--art)]';

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
        className={`flex-shrink-0 rounded-lg object-cover bg-raised border border-border/50 ${sizing} ${className}`}
        style={box}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      data-testid="game-art-fallback"
      className={`flex-shrink-0 rounded-lg border border-border/50 bg-raised flex items-center justify-center font-display font-bold text-faint select-none ${sizing} ${className}`}
      style={{ ...box, fontSize: Math.max(9, Math.round(Math.min(size, mobileSize ?? size) * 0.32)) }}
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
