/**
 * Curated pack-contents map for the Pinball FX Classic VR importer.
 *
 * Source-of-truth: tmp/fx-classic-vr-tables-draft.md (owner-curated, ADR 0019).
 * Pinball FX Classic VR is a separate Zen product from Pinball FX VR — no
 * Steam DLC API exposes its catalogue either, so this list is hand-maintained.
 * Re-emit after editing the markdown:
 *
 *   node tmp/emit-fx-classic-vr-data-ts.js > src/services/fxClassicVrPackContents.ts
 *
 * The importer flattens FX_CLASSIC_VR_PACKS to FX_CLASSIC_VR_TABLES at
 * runtime; both are exported so admin tooling can inspect the per-pack
 * grouping if needed.
 */

/** Pack → constituent table names. Order matches the markdown source. */
export const FX_CLASSIC_VR_PACKS: Array<{ pack: string; tables: string[] }> = [
    { pack: 'Base / Season 1 Pack', tables: [
        'CastleStorm',
        'Wild West Rampage',
        'BioLab',
        'Paranormal',
        'Earth Defense',
    ] },
    { pack: 'Universal Classics', tables: [
        'Back to the Future Pinball',
        'Jaws Pinball',
        'E.T. Pinball',
    ] },
    { pack: 'The Walking Dead', tables: [
        'The Walking Dead',
    ] },
];

/** Flat de-duplicated list of all FX Classic VR tables. Used by the import service. */
export const FX_CLASSIC_VR_TABLES: string[] = [
    'CastleStorm',
    'Wild West Rampage',
    'BioLab',
    'Paranormal',
    'Earth Defense',
    'Back to the Future Pinball',
    'Jaws Pinball',
    'E.T. Pinball',
    'The Walking Dead',
];
