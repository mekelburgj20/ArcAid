/**
 * W113 (v2.253.2) — text a device reads out of a launcher's JSON can arrive
 * with its `\uXXXX` escapes still in it.
 *
 * Legends Unchained writes its session journal with Go's JSON encoder, which
 * escapes `&`, `<` and `>` as `&`, `<` and `>`, and the cabinet
 * app passes the table name on undecoded. "Attack & Revenge from Mars
 * (Original 2015)" reached the server as `Attack & Revenge from Mars
 * (Original 2015)`, normalised to "attack u0026 revenge from mars" and missed
 * the catalogue's "Attack & Revenge from Mars" on every play (ChalataLove,
 * 2026-11-18).
 *
 * Decoded once, at the witness routes, so matching, the trail row, the
 * activity log and every log line see the real name. A surrogate pair decodes
 * to its one character (two `\uXXXX` in a row make one UTF-16 pair). Anything
 * that is not a backslash, `u` and four hex digits is left exactly as it was.
 */
export function decodeJsonEscapes(value: string): string {
    if (!value.includes('\\u')) return value;
    return value.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** A query parameter a device sent as a name, decoded; '' when absent or not a string. */
export function deviceNameParam(value: unknown): string {
    return typeof value === 'string' ? decodeJsonEscapes(value) : '';
}

/** As `deviceNameParam`, but null when absent (the optional `rom`). */
export function optionalDeviceNameParam(value: unknown): string | null {
    return typeof value === 'string' ? decodeJsonEscapes(value) : null;
}
