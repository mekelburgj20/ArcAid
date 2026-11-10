/**
 * Look up a game's art in a `gameArt` map from the server (v2.240.0, B25):
 * keyed by the lowercased game name, exactly as `GameArtService.key` builds it.
 */
export function gameArtFor(map: Record<string, string> | null | undefined, name: string | null | undefined): string | null {
  if (!map || !name) return null;
  return map[name.toLowerCase()] ?? null;
}
