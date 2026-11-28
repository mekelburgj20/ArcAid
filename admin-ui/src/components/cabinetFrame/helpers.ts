import type { CSSProperties } from 'react';

/** Never a raw id in a picture: an empty name reads as "A PLAYER" (the contract's own fallback). */
export const nameOf = (n: string | null | undefined): string => (n && n.trim() ? n : 'A PLAYER');

/** The art as a CSS background (a quoted url, so a path with spaces or parentheses is safe). */
export const artStyle = (url: string | null | undefined): CSSProperties | undefined =>
    url ? { backgroundImage: `url(${JSON.stringify(url)})` } : undefined;
