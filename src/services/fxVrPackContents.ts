/**
 * Curated pack-contents map for the Pinball FX VR importer.
 *
 * Source-of-truth: tmp/fx-vr-tables-draft.md (user-curated).
 * Pinball FX VR is a Meta Quest standalone product — no Steam DLC API
 * exposes its catalogue, so this list is hand-maintained. Re-emit after
 * editing the markdown:
 *
 *   node tmp/emit-fx-vr-data-ts.js > src/services/fxVrPackContents.ts
 *
 * The importer flattens FX_VR_PACKS to FX_VR_TABLES at runtime; both are
 * exported so admin tooling can inspect the per-pack grouping if needed.
 */

/** Pack → constituent table names. Order matches the markdown source. */
export const FX_VR_PACKS: Array<{ pack: string; tables: string[] }> = [
    { pack: 'Base (free with app)', tables: [
        'Pinball Noir',
        'Curse of the Mummy',
        'Sky Pirates: Treasures of the Clouds',
    ] },
    { pack: 'Singles', tables: [
        'Indiana Jones - The Pinball Adventure',
        'The Addams Family',
        'Star Trek: The Next Generation',
        'World Cup Soccer',
        'Twilight Zone',
    ] },
    { pack: 'Universal Pinball: TV Classics', tables: [
        'Battlestar Galactica Pinball',
        'Xena: Warrior Princess Pinball',
        'Knight Rider Pinball',
    ] },
    { pack: 'Williams Pinball: Volume 1', tables: [
        'Medieval Madness',
        'The Getaway: High Speed II',
        'Junk Yard',
    ] },
    { pack: 'Williams Pinball: Volume 2', tables: [
        'Attack from Mars',
        'Black Rose',
        'The Party Zone',
    ] },
    { pack: 'Williams Pinball: Volume 3', tables: [
        'Theatre of Magic',
        'Safe Cracker',
        'The Champion Pub',
    ] },
    { pack: 'Williams Pinball: Volume 9', tables: [
        'WHO dunnit',
        'Taxi',
        'PIN-BOT',
    ] },
    { pack: 'Williams Pinball: Volume 10', tables: [
        'Diner',
        'Fire!',
        'Comet',
    ] },
    { pack: 'Tomb Raider Pinball', tables: [
        'Adventures of Lara Croft',
        'Secrets of Croft Manor',
    ] },
    { pack: 'Williams Pinball: Universal Monsters', tables: [
        'Monster Bash',
        'Creature From The Black Lagoon',
    ] },
    { pack: 'Williams Pinball: Scared Stiff', tables: [
        'Scared Stiff',
    ] },
    { pack: 'Williams Pinball: Elvira and the Party Monsters', tables: [
        'Elvira and the Party Monsters',
    ] },
    { pack: 'A Charlie Brown Christmas Pinball', tables: [
        'A Charlie Brown Christmas Pinball',
    ] },
    { pack: 'Godzilla vs. Kong Pinball Pack', tables: [
        'Kong Pinball',
        'Godzilla Pinball',
        'Godzilla vs. Kong Pinball',
    ] },
    { pack: 'Bethesda Pinball', tables: [
        'Fallout Pinball',
        'DOOM Pinball',
        'The Elder Scrolls V: Skyrim Pinball',
    ] },
];

/** Flat de-duplicated list of all FX VR tables. Used by the import service. */
export const FX_VR_TABLES: string[] = [
    'Pinball Noir',
    'Curse of the Mummy',
    'Sky Pirates: Treasures of the Clouds',
    'Indiana Jones - The Pinball Adventure',
    'The Addams Family',
    'Star Trek: The Next Generation',
    'World Cup Soccer',
    'Twilight Zone',
    'Battlestar Galactica Pinball',
    'Xena: Warrior Princess Pinball',
    'Knight Rider Pinball',
    'Medieval Madness',
    'The Getaway: High Speed II',
    'Junk Yard',
    'Attack from Mars',
    'Black Rose',
    'The Party Zone',
    'Theatre of Magic',
    'Safe Cracker',
    'The Champion Pub',
    'WHO dunnit',
    'Taxi',
    'PIN-BOT',
    'Diner',
    'Fire!',
    'Comet',
    'Adventures of Lara Croft',
    'Secrets of Croft Manor',
    'Monster Bash',
    'Creature From The Black Lagoon',
    'Scared Stiff',
    'Elvira and the Party Monsters',
    'A Charlie Brown Christmas Pinball',
    'Kong Pinball',
    'Godzilla Pinball',
    'Godzilla vs. Kong Pinball',
    'Fallout Pinball',
    'DOOM Pinball',
    'The Elder Scrolls V: Skyrim Pinball',
];
