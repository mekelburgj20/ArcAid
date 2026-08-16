/**
 * Hand-curated studio attribution for AtGames tables the storefront does not
 * attribute on its own.
 *
 * `AtGamesEStoreClient` derives the studio from AtGames' own per-publisher
 * collections and reaches ~86% of the pinball catalogue automatically. This
 * module covers the residue, and follows the repo's existing curated-data
 * convention (`steamPinballPackContents.ts`, `fxVrPackContents.ts`): a typed
 * module, committed, with the provenance of each decision written down.
 *
 * ── This map is NOT self-maintaining. ────────────────────────────────────
 * It is a snapshot of what AtGames' store looked like on 2026-08-16. If
 * AtGames ships a new pack that lists no contents, its tables will arrive
 * unattributed and this map will not know them.
 *
 * What IS self-maintaining is everything above it. The importer consults this
 * map LAST, after four derived tiers:
 *
 *   1. a pack that names the table in its "Tables included" list
 *   2. a series rule ("Africa (Natural History)")
 *   3. a pack-title prefix ("Star Trek™ Pinball: Discovery")
 *   4. the brand the name announces ("Williams™ Pinball: FunHouse™")
 *
 * Tiers 1, 3 and 4 generalise: a future "Star Wars Pinball Legends Mini Pack"
 * whose tables are named "Star Wars Pinball: <x>" is attributed with no code
 * change at all, and the moment AtGames adds a contents list to any pack
 * below, tier 1 takes over and that entry here goes quietly inert.
 *
 * The gap is made LOUD rather than silent: every sync logs the names of the
 * tables nothing attributed (see `AtGamesImportService`), so a new
 * unenumerated pack shows up as an actionable line in the sync log instead of
 * being absorbed as a permanent blank. That log line is the maintenance
 * trigger for this file.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * STUDIO ONLY, deliberately. These entries never assert a manufacturer, year
 * or any other machine fact — VPS/OPDB/IPDB know those better, and a curated
 * guess would compete with a real metadata source. Studio is the one field
 * nobody else supplies.
 *
 * Keys are matched through `atgamesMatchKey`, so ™/® and punctuation in the
 * live API name do not need reproducing exactly.
 */

export interface StudioOverride {
    /** The API game name, as AtGames returns it. */
    name: string;
    studio: string;
    /** Why we believe it — the store evidence behind the call. */
    why: string;
}

export const ATGAMES_STUDIO_OVERRIDES: StudioOverride[] = [
    // ── Store lists the table, but under a name the API doesn't use ──────
    // These are naming divergences, not missing data. Left as overrides
    // rather than fuzzy-matched: a spelling-tolerant matcher able to bridge
    // "Battetoads"→"Battletoads" would also be able to bridge two genuinely
    // different Zaccaria designs, which is the failure this whole arc exists
    // to prevent.
    { name: 'Battletoads', studio: 'AtGames Originals', why: 'Rare Pinball Pack [AtGames Originals] lists it as "Battetoads™" — a typo in the store listing.' },
    { name: 'Zombies', studio: 'Magic Pixel', why: 'Zaccaria Pinball Pack 7 [Magic Pixel] lists it as "Zombie", singular.' },
    { name: 'Primal Carnage', studio: 'Magic Pixel', why: 'Sold as "Zaccaria Primal Carnage Solid State Legends Single Pack" [Magic Pixel]; per the Zaccaria four-design taxonomy the Solid State edition is the plain-named faithful sim.' },
    { name: 'Primal Carnage Remake', studio: 'Magic Pixel', why: 'Zaccaria design, same family as the Primal Carnage single packs [Magic Pixel].' },

    // ── Zen mini packs that publish no contents list (prose only) ────────
    // Verified 2026-08-16: each of these products sits in
    // legends-4k-pinball-packs-zen-studios and its body_html carries a
    // marketing description with no <ul> of tables.
    { name: 'Borderlands®: Vault Hunter Pinball', studio: 'Zen Studios', why: 'Gearbox® Pinball Legends Mini Pack [Zen Studios] — no contents list.' },
    { name: 'Brothers in Arms®: Win the War Pinball', studio: 'Zen Studios', why: 'Gearbox® Pinball Legends Mini Pack [Zen Studios] — no contents list.' },
    { name: 'Homeworld®: Journey to Hiigara Pinball', studio: 'Zen Studios', why: 'Gearbox® Pinball Legends Mini Pack [Zen Studios] — no contents list.' },

    { name: 'Jaws™ Pinball', studio: 'Zen Studios', why: 'Universal Classics Pinball™ Legends Mini Pack [Zen Studios] — its prose names Jaws™ but there is no contents list.' },
    { name: 'E.T.™ Pinball', studio: 'Zen Studios', why: 'Universal Classics Pinball™ Legends Mini Pack [Zen Studios] — no contents list.' },
    { name: 'Back to the Future™ Pinball', studio: 'Zen Studios', why: 'Universal Classics Pinball™ Legends Mini Pack [Zen Studios] — no contents list.' },

    { name: 'Battlestar Galactica Pinball', studio: 'Zen Studios', why: 'Universal Pinball: TV Classics Legends Mini Pack [Zen Studios] — no contents list.' },
    { name: 'Knight Rider Pinball', studio: 'Zen Studios', why: 'Universal Pinball: TV Classics Legends Mini Pack [Zen Studios] — no contents list.' },
    { name: 'Xena: Warrior Princess Pinball', studio: 'Zen Studios', why: 'Universal Pinball: TV Classics Legends Mini Pack [Zen Studios] — no contents list.' },

    { name: "A Samurai's Vengeance", studio: 'Zen Studios', why: 'Honor and Legacy Legends Mini Pack [Zen Studios] — named in the pack prose, no contents list.' },
    { name: "Verne's Mysterious Island", studio: 'Zen Studios', why: 'Honor and Legacy Legends Mini Pack [Zen Studios] — named in the pack prose, no contents list.' },

    { name: 'Godzilla Pinball', studio: 'Zen Studios', why: 'Godzilla vs. Kong Pinball Legends Mini Pack [Zen Studios] — the pack-title prefix reaches "Godzilla vs. Kong Pinball" but not the two single-monster tables.' },
    { name: 'Kong Pinball', studio: 'Zen Studios', why: 'Godzilla vs. Kong Pinball Legends Mini Pack [Zen Studios] — see above.' },

    { name: 'Jurassic Park™ Pinball', studio: 'Zen Studios', why: 'Jurassic World Pinball Legends Mini Pack [Zen Studios] — the prefix tier reaches "Jurassic World™ Pinball" only.' },
    { name: 'Jurassic Park Pinball Mayhem™', studio: 'Zen Studios', why: 'Jurassic World Pinball Legends Mini Pack [Zen Studios] — see above.' },

    { name: 'Wrath of the Elder Gods: Director’s Cut', studio: 'Zen Studios', why: 'Zen original; no separate AtGames SKU carries a contents list naming it.' },

    // ── Williams/Bally machines in the unlisted "Volume" packs ───────────
    // The brand tier already attributes every table the API names
    // "Williams™ Pinball: <x>". These are the same packs' tables, which the
    // API names WITHOUT the brand prefix, so nothing derived can reach them.
    // Store evidence: Williams™ Pinball Volume 1/4/9 and Williams™ Pinball:
    // Universal Monsters are all in legends-4k-pinball-packs-zen-studios,
    // and every Williams-branded pack in the store is Zen's.
    { name: 'Medieval Madness™', studio: 'Zen Studios', why: 'Williams™ Pinball Volume pack [Zen Studios] — no contents list; API name carries no brand prefix.' },
    { name: 'Monster Bash™', studio: 'Zen Studios', why: 'Williams™ Pinball Volume pack [Zen Studios] — no contents list.' },
    { name: 'Junk Yard™', studio: 'Zen Studios', why: 'Williams™ Pinball Volume pack [Zen Studios] — no contents list.' },
    { name: 'Whirlwind™', studio: 'Zen Studios', why: 'Williams™ Pinball Volume pack [Zen Studios] — no contents list.' },
    { name: 'Swords of Fury™', studio: 'Zen Studios', why: 'Williams™ Pinball Volume pack [Zen Studios] — no contents list.' },
    { name: 'The Getaway: High Speed II™', studio: 'Zen Studios', why: 'Williams™ Pinball Volume pack [Zen Studios] — no contents list.' },
    { name: 'The Machine™: Bride of Pin·Bot™', studio: 'Zen Studios', why: 'Williams™ Pinball Volume pack [Zen Studios] — no contents list.' },
    { name: 'The Creature From The Black Lagoon™', studio: 'Zen Studios', why: 'Williams™ Pinball: Universal Monsters Legends Mini Pack [Zen Studios] — no contents list.' },

    // ── TAITO Pinball Pack 2 and 3 ──────────────────────────────────────
    // Pack 1 lists its contents and is attributed automatically; 2 and 3 do
    // not. All three products sit in the AtGames Originals collections, so
    // the studio is the store's own answer, not an inference about Taito.
    { name: 'Arkanoid (Pinball)', studio: 'AtGames Originals', why: 'TAITO Pinball Pack 2/3 [AtGames Originals] — packs 2 and 3 carry no contents list.' },
    { name: 'Bubble Bobble (Pinball)', studio: 'AtGames Originals', why: 'TAITO Pinball Pack 2/3 [AtGames Originals] — no contents list.' },
    { name: "Chack'n Pop (Pinball)", studio: 'AtGames Originals', why: 'TAITO Pinball Pack 2/3 [AtGames Originals] — no contents list.' },
    { name: 'Elevator Action (Pinball)', studio: 'AtGames Originals', why: 'TAITO Pinball Pack 2/3 [AtGames Originals] — no contents list.' },
    { name: 'The Legend of Kage (Pinball)', studio: 'AtGames Originals', why: 'TAITO Pinball Pack 2/3 [AtGames Originals] — no contents list.' },
    { name: 'Operation Wolf', studio: 'AtGames Originals', why: 'TAITO Pinball Pack 2/3 [AtGames Originals] — no contents list.' },
    { name: 'Rainbow Islands', studio: 'AtGames Originals', why: 'TAITO Pinball Pack 2/3 [AtGames Originals] — no contents list.' },
    { name: 'Zoo Keeper (Pinball)', studio: 'AtGames Originals', why: 'TAITO Pinball Pack 2/3 [AtGames Originals] — no contents list.' },

    // ── Announced but not yet released ──────────────────────────────────
    // AtGames provisions a table into the catalogue API BEFORE it goes on
    // sale, so an upcoming release exists as a feed row with no store listing
    // of any kind — no pack title, no contents list, not even pack prose
    // (searched across every pinball collection, 2026-08-16).
    //
    // All three below come from AtGames' own published Originals release
    // schedule (owner-supplied, 2026-08-16): Firefighter: Urban — August 20;
    // City Golf — September 10; Wild Games — September 24. Each is filed
    // there under "AtGames Originals".
    //
    // This is the recurring shape of this file's maintenance, and it is
    // self-correcting: when the table ships it gets a store listing, a
    // derived tier resolves it, and the entry here goes inert. The same
    // schedule names further AtGames Originals releases (Natural History
    // Pinball Pack 4 — December 2026, American Moments Pinball Bundle — TBA,
    // First Responders: EMS — February 2027) which are NOT added here yet:
    // they aren't in the feed, and an entry for a table that doesn't exist
    // would be an untestable guess.
    { name: 'Firefighter: Urban', studio: 'AtGames Originals', why: 'AtGames Originals release schedule, 20 Aug 2026; sibling of "Firefighter: Wildlands Legends Single Pack" [AtGames Originals]. No store listing of its own yet.' },
    { name: 'City Golf', studio: 'AtGames Originals', why: 'AtGames Originals release schedule, 10 Sep 2026 (4KP, HD). In the catalogue feed ahead of release, so no store listing exists yet.' },
    { name: 'Wild Games', studio: 'AtGames Originals', why: 'AtGames Originals release schedule, 24 Sep 2026 (4KP, HD). In the catalogue feed ahead of release, so no store listing exists yet.' },
];

/** Lookup keyed by `atgamesMatchKey(name)`; built once at module load. */
export function buildOverrideIndex(
    keyFn: (name: string) => string,
): Map<string, StudioOverride> {
    const index = new Map<string, StudioOverride>();
    for (const entry of ATGAMES_STUDIO_OVERRIDES) {
        const key = keyFn(entry.name);
        if (key) index.set(key, entry);
    }
    return index;
}
