/**
 * v2.213.0 - the `DISCORD_JOIN_ROLE_IDS` room setting value: a JSON array of
 * Discord role id strings. An empty selection is stored as '' (the settings
 * save deletes the row).
 */
export function parseRoleIdsValue(raw: string | undefined | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(v => String(v).trim()).filter(v => v.length > 0);
  } catch {
    return [];
  }
}

export function serializeRoleIds(ids: string[]): string {
  const clean = Array.from(new Set(ids.map(v => v.trim()).filter(v => /^\d{5,25}$/.test(v))));
  return clean.length > 0 ? JSON.stringify(clean) : '';
}
