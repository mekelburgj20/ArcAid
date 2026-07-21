// S19 - deterministic build-id derivation for the service worker's static
// cache name. Consumed by the `arcaid-sw-build-id` Vite plugin
// (admin-ui/vite.config.ts). Kept as a plain pure-function module (no Vite
// types) so it's trivially unit-testable from admin-ui's vitest suite.
import { createHash } from 'node:crypto';

const BUILD_ID_LENGTH = 12;
export const BUILD_ID_PLACEHOLDER = '__ARCAID_BUILD_ID__';

/**
 * Derives a stable build id from the emitted asset filenames + index.html
 * contents. Same build output -> same id (no timestamps, no randomness) so
 * repeated builds of unchanged source produce byte-identical sw.js output.
 */
export function computeBuildId(assetFileNames: string[], indexHtml: string): string {
  const hash = createHash('sha256');
  const sorted = [...assetFileNames].sort();
  hash.update(sorted.join('\n'));
  hash.update('\n---\n'); // separator so an asset list can't collide with index.html content
  hash.update(indexHtml);
  return hash.digest('hex').slice(0, BUILD_ID_LENGTH);
}

/**
 * Replaces every occurrence of the BUILD_ID placeholder in the sw.js source
 * with the computed id. Throws if the placeholder is absent - guards against
 * someone renaming the placeholder in sw.js without updating this plugin,
 * which would otherwise silently ship a sw.js with a permanently-fixed cache
 * name (the exact bug this sprint exists to kill).
 */
export function injectBuildId(swSource: string, buildId: string): string {
  if (!swSource.includes(BUILD_ID_PLACEHOLDER)) {
    throw new Error(
      `[arcaid-sw-build-id] Placeholder "${BUILD_ID_PLACEHOLDER}" not found in sw.js source. ` +
        'Was it renamed without updating admin-ui/scripts/swBuildId.ts / vite.config.ts?'
    );
  }
  return swSource.split(BUILD_ID_PLACEHOLDER).join(buildId);
}
