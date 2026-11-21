/**
 * C14 — the catalogue rows the README-era Wizard importer left behind.
 *
 * Until 2026-10-28 the Wizard importer scraped Legends Unchained's README,
 * whose "Wizard Tables" and "Manual Install Tables" sections linked each table
 * to a repo folder (`tables/<slug>` or `external/<slug>`). Upstream then
 * deleted both sections and the `external/` folder; the importer now reads the
 * Table Manager manifest, where every entry carries its VPS game id, so a
 * Wizard table lands on its VPS row (step-1 `vps_id` match).
 *
 * The README rows that never matched a VPS row by name at the time are still
 * in the catalogue: `imported_from = 'wizard'`, no `vps_id`, a link into the
 * repo instead of the catalog site. Most are a second copy of a VPS row under
 * the README's spelling ("Addams Family, The", "Medusa - JP", "Skate Ball").
 * The owner's ruling (2026-11-21): they are ordinary VPX tables that belong on
 * their VPS rows, so they are MERGED (scores, ratings, room links move), never
 * deleted.
 *
 * Everything here is pure so the merge, the migration, the preview and the
 * Wizard reconcile share one definition of each rule.
 */

/**
 * The repo folder the README's manual list pointed at. Deleted upstream (the
 * contents API answers 404 for `external/` on main, checked 2026-11-21), so a
 * link into it is dead: the GitHub tree/blob page and the raw file alike.
 */
const RETIRED_EXTERNAL_PATH =
    /^https?:\/\/(?:github\.com\/LegendsUnchained\/vpx-standalone-alp4k\/(?:tree|blob)\/[^/]+|raw\.githubusercontent\.com\/LegendsUnchained\/vpx-standalone-alp4k\/(?:refs\/heads\/)?[^/]+)\/external\//i;

export function isRetiredWizardExternalUrl(url: string | null | undefined): boolean {
    return typeof url === 'string' && RETIRED_EXTERNAL_PATH.test(url.trim());
}

/** The catalog site the manifest importer writes as `external_url` (v2.201.0). */
const CATALOG_SITE = /^https?:\/\/vpxtablemanager\.com\//i;

/**
 * A row the README-era importer created and the manifest importer never
 * reached: stamped `wizard`, no VPS id, and not carrying the catalog-site link
 * every manifest upsert writes. (Every enabled manifest entry has a `vpsdbId`
 * today; the link test keeps a future id-less manifest entry out of this set.)
 */
export function isReadmeEraWizardRow(row: {
    imported_from?: string | null;
    vps_id?: string | null;
    external_url?: string | null;
}): boolean {
    return row.imported_from === 'wizard'
        && !row.vps_id
        && !(typeof row.external_url === 'string' && CATALOG_SITE.test(row.external_url));
}

/**
 * Features that describe a FILE Legends Unchained distributes, not the game:
 * how it installs (`vpxs`, `vpxs_manual`, `wizard_auto`, `wizard_manual`),
 * what ships with it (`has_backglass`, `has_puppack`, `requires_rom`) and its
 * frame rate (`fps_N`). The manifest is their only source now: the Wizard
 * reconcile replaces them on every row the manifest lists, and a merge never
 * copies them off a README-era row.
 *
 * NOT `has_dmd`: the README's DMD column has no manifest successor, so nothing
 * could ever write it back; it is a fact about the machine and is kept
 * (`wizard-manifest-import.test.ts`).
 */
export function isWizardFileFeature(feature: string): boolean {
    const f = feature.trim().toLowerCase();
    return f === 'vpxs' || f === 'vpxs_manual' || f === 'wizard_auto' || f === 'wizard_manual'
        || f === 'has_backglass' || f === 'has_puppack' || f === 'requires_rom'
        || /^fps_\d+$/.test(f);
}

/**
 * What a README-era row contributes to its survivor's `features` in a merge.
 *
 * Everything that is not a Wizard file fact carries as before. The file facts
 * do not: they described a README file nobody distributes any more, and on a
 * manifest-listed survivor the manifest's own facts are the true ones.
 *
 * ONE exception keeps tournament eligibility unchanged (owner, 2026-11-21:
 * whether `vpxs_manual` survives at all is its own decision, C18): `vpxs` and
 * `vpxs_manual` both put a table in the `atgames` device set
 * (`DEVICE_AVAILABILITY_FEATURES`), so when the old row had either and the
 * survivor has neither, the survivor gets `vpxs_manual`, the weaker claim, and
 * stays exactly as eligible as the two rows were.
 */
export function readmeEraFeatureCarry(sourceFeatures: string[], targetFeatures: string[]): string[] {
    const lower = (xs: string[]) => new Set(xs.map(x => String(x).trim().toLowerCase()));
    const src = lower(sourceFeatures);
    const tgt = lower(targetFeatures);
    const carry = sourceFeatures.filter(f => typeof f === 'string' && !isWizardFileFeature(f));
    const sourceEligible = src.has('vpxs') || src.has('vpxs_manual');
    const targetEligible = tgt.has('vpxs') || tgt.has('vpxs_manual');
    if (sourceEligible && !targetEligible) carry.push('vpxs_manual');
    return carry;
}

const REPO_FOLDER =
    /^https?:\/\/(?:github\.com\/LegendsUnchained\/vpx-standalone-alp4k\/(?:tree|blob)\/[^/]+|raw\.githubusercontent\.com\/LegendsUnchained\/vpx-standalone-alp4k\/(?:refs\/heads\/)?[^/]+)\/(?:tables|external)\/([^/?#]+)/i;
const CATALOG_FOLDER = /^https?:\/\/vpxtablemanager\.com\/catalog\/?#table=([^&?#]+)/i;

/**
 * The Wizard install folder(s) a row's links name: the repo folder of a README
 * link (`tables/<slug>` or `external/<slug>`, live or dead) or a catalog-site
 * page. The folder is the strongest pairing evidence there is: the manifest
 * maps it to a VPS game (`wizard_table_slugs`), so an old row whose folder is
 * listed today belongs on that game's row.
 */
export function wizardFolderSlugs(row: {
    external_url?: string | null;
    image_url?: string | null;
    table_download_urls?: string | null;
}): string[] {
    const urls: string[] = [];
    if (row.external_url) urls.push(row.external_url);
    if (row.image_url) urls.push(row.image_url);
    try {
        const parsed: unknown = JSON.parse(row.table_download_urls || '[]');
        if (Array.isArray(parsed)) {
            for (const d of parsed) {
                const url = (d as { url?: unknown })?.url;
                if (typeof url === 'string') urls.push(url);
            }
        }
    } catch { /* malformed column: no folder from it */ }
    const slugs: string[] = [];
    for (const u of urls) {
        const m = REPO_FOLDER.exec(u.trim()) ?? CATALOG_FOLDER.exec(u.trim());
        const slug = m?.[1] ? decodeURIComponent(m[1]).toLowerCase() : null;
        if (slug && !slugs.includes(slug)) slugs.push(slug);
    }
    return slugs;
}

/**
 * Drops every download entry whose link is on the retired `external/` path.
 * Returns the column value to store (null when nothing is left) and whether
 * anything changed. Shared by the merge and migration 219.
 */
export function withoutRetiredDownloads(raw: string | null | undefined): { value: string | null; changed: boolean } {
    if (!raw) return { value: raw ?? null, changed: false };
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return { value: raw, changed: false }; }
    if (!Array.isArray(parsed)) return { value: raw, changed: false };
    const kept = parsed.filter(d => !isRetiredWizardExternalUrl((d as { url?: unknown })?.url as string));
    if (kept.length === parsed.length) return { value: raw, changed: false };
    return { value: kept.length > 0 ? JSON.stringify(kept) : null, changed: true };
}
