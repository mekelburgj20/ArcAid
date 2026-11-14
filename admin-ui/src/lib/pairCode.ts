/** W102 - a typed pairing code: no spaces, upper case. */
export function cleanCode(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}
