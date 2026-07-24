/**
 * FE port of `getTournamentColor` (src/utils/discord.ts:5-24) to hex strings.
 * Used for the ranking-card tournament-name chips (v2.31.0) — keep the lookup
 * order (uppercase tag/type key, then raw key, then gray fallback) identical
 * to the BE so a tournament's chip color matches its Discord embed color.
 */
const TAG_COLORS: Record<string, string> = {
  // By tag
  'DG': '#FFD700',       // gold
  'WG-VPXS': '#00BFFF',  // sky blue
  'WG-VR': '#AA00FF',    // purple
  'MG': '#00FF88',       // green
  // By generic type (fallback)
  'daily': '#FFD700',
  'weekly': '#00BFFF',
  'monthly': '#AA00FF',
  'custom': '#00FF88',
};

/** Returns the chip color for a tournament type/tag string. */
export function getTournamentColorHex(type?: string | null): string {
  if (!type) return '#888888';
  return TAG_COLORS[type.toUpperCase()] ?? TAG_COLORS[type] ?? '#888888';
}
