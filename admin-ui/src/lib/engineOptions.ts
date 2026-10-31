import {
  CANONICAL_ENGINES,
  UNKNOWN,
  isCanonicalEngine,
  mapLegacyPlatform,
} from './scoreProvenance';

/**
 * The engines offered for one catalogue game: the canonical engines the
 * catalogue lists it on (canonical ids pass through; legacy ids fold through
 * the legacy map - never the alias table, which would re-legacy `fx`), plus
 * `real` always, plus `extra` (e.g. engines the player already holds, so they
 * can be toggled off). Nothing derivable -> the full canonical list.
 *
 * Shared by My Tables (ownership chips) and the per-platform ratings block.
 */
export function engineOptionsFor(cataloguePlatforms: string[], extra: string[] = []): string[] {
  const seen = new Set<string>();
  for (const p of cataloguePlatforms ?? []) {
    const engine = isCanonicalEngine(p) ? p.trim().toLowerCase() : mapLegacyPlatform(p).engine;
    if (engine && engine !== UNKNOWN && isCanonicalEngine(engine)) seen.add(engine);
  }
  if (seen.size === 0) return Object.keys(CANONICAL_ENGINES);
  seen.add('real');
  for (const p of extra ?? []) if (p) seen.add(p);
  return [...seen];
}
