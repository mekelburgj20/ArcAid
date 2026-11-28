/**
 * W132.2 (ADR 0046) - the DMD's live dot lines, the one part of a cabinet
 * screen the cabinet draws itself (countdowns tick, tickers scroll). Sent in
 * the frames manifest as one flat string (`s<i>Dots`), so the cabinet's naive
 * `"key":"value"` reader can take it:
 *
 *   lines split by `;`, fields by `|`
 *   text|<small>|<big>          a label over a big value
 *   count|<small>|<end epoch>   D HH:MM:SS (MM:SS under an hour), ticking
 *   ticker|<small>|<text>       the text scrolls
 *   logo                        the built-in dot logo
 *
 * Text is upper case and limited to `A-Z 0-9 space , . : / # + & ! ? ' -` and
 * the middle dot; anything else is DROPPED here (so `|`, `;`, `"` and `\`
 * can never reach the wire). A line whose text is left empty is dropped.
 */

export type DotLine =
    | { type: 'text'; small: string; big: string }
    | { type: 'count'; small: string; endTs: number }
    | { type: 'ticker'; small: string; text: string }
    | { type: 'logo' };

/** Longest small label / big value / ticker text the cabinet lays out (cut, never an ellipsis). */
export const DOT_SMALL_MAX = 48;
export const DOT_BIG_MAX = 32;
export const DOT_TICKER_MAX = 400;

/** The middle dot, the ticker's separator. */
export const DOT_SEPARATOR = '·';

const NOT_ALLOWED = /[^A-Z0-9 ,.:/#+&!?'·-]/g;

/** Upper case, allowed characters only, spaces collapsed, cut at `max`. */
export function dotText(value: unknown, max: number): string {
    if (typeof value !== 'string') return '';
    return value
        .normalize('NFD').replace(/[̀-ͯ]/g, '') // É -> E, not dropped
        .toUpperCase()
        .replace(/[‘’]/g, "'")
        .replace(NOT_ALLOWED, '')
        .replace(/ {2,}/g, ' ')
        .trim()
        .slice(0, Math.max(0, Math.floor(max)))
        .trim();
}

/** One line in wire form, or null when nothing printable is left. */
function dotLine(line: DotLine): string | null {
    switch (line.type) {
        case 'logo':
            return 'logo';
        case 'count': {
            if (!Number.isFinite(line.endTs) || line.endTs <= 0) return null;
            return `count|${dotText(line.small, DOT_SMALL_MAX)}|${Math.floor(line.endTs)}`;
        }
        case 'text': {
            const small = dotText(line.small, DOT_SMALL_MAX);
            const big = dotText(line.big, DOT_BIG_MAX);
            return small || big ? `text|${small}|${big}` : null;
        }
        case 'ticker': {
            const text = dotText(line.text, DOT_TICKER_MAX);
            return text ? `ticker|${dotText(line.small, DOT_SMALL_MAX)}|${text}` : null;
        }
    }
}

/** The manifest's `s<i>Dots` value ("" = no dot lines). */
export function dotsString(lines: readonly DotLine[]): string {
    return lines.map(dotLine).filter((l): l is string => l !== null).join(';');
}
