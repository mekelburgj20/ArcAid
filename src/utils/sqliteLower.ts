/**
 * SQLite's built-in LOWER() folds ASCII letters only. Every synthetic
 * `iscored:<name>` key is built in SQL with LOWER(), so any JS that builds or
 * compares such a key must fold the same way (JS `toLowerCase()` would turn
 * "ÉRIC" into "éric" while SQLite keeps "Éric" -> "Éric"), or the two sides
 * never meet.
 */
export function sqliteLower(s: string): string {
    return s.replace(/[A-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + 32));
}
