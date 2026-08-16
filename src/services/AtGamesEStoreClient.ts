import axios from 'axios';
import { logInfo, logWarn } from '../utils/logger.js';

/**
 * AtGames eStore (atgames.us) — studio attribution for Legends pinball tables.
 *
 * The AtGames catalogue API (`AtGamesApiClient`) knows every table's id and
 * canonical name but says nothing about WHO made it. The eStore does, because
 * AtGames sells the tables in packs and files each pack under its publisher.
 *
 * atgames.us is a stock Shopify storefront, so none of this needs scraping:
 * every collection is served as JSON at `/collections/<handle>/products.json`,
 * unauthenticated. Two notes on why it's done THIS way:
 *
 *  - The "Publisher" facet visible in the storefront UI is a metafield, and
 *    metafields are absent from `products.json`. (`vendor` is "AtGames E-Store"
 *    on every row and `tags` carries only fulfilment flags — neither is the
 *    publisher.) Rather than reverse-engineer the facet's query parameters,
 *    this reads the per-publisher COLLECTIONS AtGames already maintains, which
 *    are plain listings with a stable handle.
 *
 *  - The pack → table mapping is inside each product's `body_html`, as a
 *    "Tables included:" heading followed by a `<ul>`. Packs that ship a single
 *    table have no list and are resolved from the product title instead.
 *
 * Measured against the live store 2026-08-16: 138 pack products across the
 * seven collections yield 187 distinct table names with ZERO conflicts — no
 * table appears under two publishers.
 */

const STORE_BASE = 'https://atgames.us';

/**
 * Per-publisher collection handles. There is deliberately no
 * `legends-hd-pinball-packs-zen-studios`: Zen ships 4K-only, which is why the
 * HD storefront's publisher filter shows no Zen entry.
 *
 * ZEN IS A CLOSED SET (owner, 2026-08-16): AtGames and Zen Studios have ended
 * their partnership, so no further Zen tables are coming to Legends. Expect the
 * Zen collection to go static and possibly to 404 outright if AtGames delists
 * it. Neither breaks anything — `buildStudioMap` skips a failed collection with
 * a warning, and `studio` is written with `COALESCE(?, studio)`, so a sync that
 * can no longer see the Zen collection LEAVES the ~70 already-attributed rows
 * exactly as they are. Do not "fix" a missing Zen collection by hardcoding its
 * tables; the catalogue already holds the answer.
 */
const PUBLISHER_COLLECTIONS: Record<string, string> = {
    'legends-4k-pinball-packs-zen-studios': 'Zen Studios',
    'legends-4k-pinball-packs-magic-pixel': 'Magic Pixel',
    'legends-4k-pinball-packs-farsight-studios': 'FarSight Studios',
    'legends-4k-pinball-packs-atgames-originals': 'AtGames Originals',
    'legends-hd-pinball-packs-magic-pixel': 'Magic Pixel',
    'legends-hd-pinball-packs-farsight-studios': 'FarSight Studios',
    'legends-hd-pinball-packs-atgames-originals': 'AtGames Originals',
};

/**
 * Licensed brands that appear in pack titles and ARE the physical machine's
 * manufacturer. Matched against the pack title only, and only used to fill a
 * NULL manufacturer — never to overwrite one.
 *
 * Kept separate from the publisher on purpose. "Gottlieb Pinball Pack 2" is
 * published by FarSight and manufactured by Gottlieb; "Williams Pinball: Fish
 * Tales" is published by Zen and manufactured by Williams. Collapsing the two
 * would break dedup — see the migration 148 header.
 */
const LICENSED_MANUFACTURERS: Array<{ pattern: RegExp; manufacturer: string }> = [
    { pattern: /\bZaccaria\b/i, manufacturer: 'Zaccaria' },
    { pattern: /\bGottlieb\b/i, manufacturer: 'Gottlieb' },
    { pattern: /\bWilliams\b/i, manufacturer: 'Williams' },
    { pattern: /\bBally\b/i, manufacturer: 'Bally' },
];

/**
 * Series → publisher, for packs whose contents the store does not list.
 *
 * The gap is real and bounded: ~12 multi-table products (Zen's "… Legends Mini
 * Pack" SKUs, Dr. Seuss 1/2, TAITO 2/3, Natural History 3) publish no "Tables
 * included" list and name no table in their title. Every one of them belongs to
 * a SERIES that the API marks in the table's own name — "Fox in Socks (Dr.
 * Seuss)", "Africa (Natural History)" — and every series has exactly one
 * publisher. Matching on the series closes the gap without guessing per-table.
 *
 * Keyed on the parenthetical the API appends, lowercased.
 */
const SERIES_PUBLISHERS: Record<string, string> = {
    'dr. seuss': 'AtGames Originals',
    'natural history': 'AtGames Originals',
};

/**
 * Pack-title prefix claims, for multi-table packs whose contents the store
 * doesn't list.
 *
 * ~12 products ship several tables behind one SKU and publish no "Tables
 * included" list — Zen's "Star Trek™ Pinball Legends Mini Pack", "Williams™
 * Pinball Volume 4", the DreamWorks and Tomb Raider mini packs. Their contents
 * are not a mystery, though: AtGames names the tables after the pack, so the
 * API row "Star Trek™ Pinball: Deep Space Nine" sits under the pack "Star
 * Trek™ Pinball". Claiming by title prefix reaches them without a hand-written
 * per-table list that would rot the moment Zen ships another volume.
 *
 * Deliberately SUBORDINATE to the explicit table lists: a prefix claim is only
 * consulted for a table nothing else attributed, so it can never override a
 * pack that actually names its contents. Longest prefix wins, so a specific
 * claim beats a general one.
 */
function packPrefixKey(title: string): string | null {
    const base = title
        .replace(/\s*\(.*$/, '')                                  // "(For Legends 4K…)"
        .replace(/\s*Legends\s+(Single|Mini)\s+(Premium\s+)?Pack.*$/i, '')
        .replace(/\s*Legends\s+HD\s+Universal\s+Pack.*$/i, '')
        .replace(/\s*Volume\s+\d+\s*$/i, '')                      // "Williams™ Pinball Volume 4"
        .replace(/\s*Pack\s+\d+\s*$/i, '')                        // "TAITO Pinball Pack 2"
        .replace(/\s*Pinball\s+Pack\s*\d*\s*$/i, ' Pinball')
        .trim();
    const key = atgamesMatchKey(base);
    // Two characters of prefix would claim half the catalogue. Anything this
    // short means the strippers ate the whole title.
    return key.length >= 4 ? key : null;
}

export interface StudioAttribution {
    /** Publishing studio, e.g. 'Zen Studios'. */
    studio: string;
    /** Physical machine manufacturer when the pack title names a licensed
     *  brand, else null. NEVER the studio. */
    manufacturer: string | null;
    /** The pack this attribution came from — provenance for the sync log. */
    packTitle: string;
}

interface ShopifyProduct {
    title: string;
    handle: string;
    body_html: string | null;
}

/**
 * Match key for joining store table names to API game names.
 *
 * The two sides decorate the same table differently: the store sells
 * "Attack from Mars™" inside a Williams pack, the API calls the row
 * "Williams™ Pinball: Attack from Mars™". Series packs diverge the other way —
 * the store lists "Africa", the API says "Africa (Natural History)". Stripping
 * the publisher/series decoration from both sides makes them meet.
 *
 * Intentionally NOT `normalizeGameName`: that one strips leading articles and
 * edition suffixes, which are load-bearing distinctions here ("Locomotion" vs
 * "Locomotion Remake"). This key only removes decoration.
 */
export function atgamesMatchKey(name: string): string {
    return (name || '')
        .toLowerCase()
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[™®]/g, '')
        // Publisher/brand prefix: "Williams™ Pinball: Attack from Mars™".
        .replace(/^(williams|bally|gottlieb|zaccaria|taito|universal)\s+pinball\s*[:\-]?\s*/, '')
        // Series/kind parenthetical: "(Natural History)", "(Pinball)", "(Dr. Seuss)".
        .replace(/\s*\([^)]*\)\s*/g, ' ')
        .replace(/\bpinball\b/g, ' ')
        .replace(/[^a-z0-9]/g, '');
}

/**
 * The name to run catalogue dedup against — AtGames' name with its storefront
 * decoration removed, and NOTHING else removed.
 *
 * Distinct from `atgamesMatchKey`, which flattens a name to a comparison key.
 * This returns a real name string that `normalizeGameName` can still process,
 * because the catalogue's step-4 walk is what consumes it.
 *
 * Two things come off:
 *   - the brand prefix Zen puts on its licensed ports ("Williams™ Pinball: X")
 *   - the series label AtGames appends ("(Natural History)", "(Dr. Seuss)")
 *
 * One thing deliberately STAYS ON: "(Pinball)". That parenthetical is IDENTITY,
 * not decoration — AtGames ships a pinball TABLE and an emulated arcade ROM of
 * the same licence, and "Space Invaders (Pinball)" is a different game on a
 * different engine from "Space Invaders". Stripping it would merge an AtGames
 * original into Bally's 1980 machine, which is the bug this exists to prevent.
 */
export function atgamesDedupName(name: string): string {
    return (name || '')
        .replace(/^(Williams|Bally|Gottlieb|Zaccaria|Taito|Universal)\s*[™®]?\s*Pinball\s*[:\-]\s*/i, '')
        .replace(/\s*\((?:Natural History|Dr\.? Seuss)\)\s*/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Extracts the licensed brand an API name announces, lowercased, or null.
 *
 * Only the explicit "<Brand> Pinball:" form counts — "Williams™ Pinball:
 * FunHouse™" yes, bare "Medieval Madness™" no, even though both are Williams
 * machines. The point is to read what the row SAYS, not to recognise machines.
 */
export function brandOf(name: string): string | null {
    const m = (name || '').match(/^(williams|bally|gottlieb|zaccaria|taito|universal)[™®\s]*\s+pinball\b/i);
    return m ? m[1]!.toLowerCase() : null;
}

/** Extracts the series parenthetical from an API game name, lowercased. */
export function seriesOf(name: string): string | null {
    const m = (name || '').match(/\(([^)]+)\)\s*$/);
    return m ? m[1]!.trim().toLowerCase() : null;
}

/**
 * Recovers a table name from a list item written as marketing copy.
 *
 * Most packs list bare names. One authoring style writes the name in CAPS
 * followed by a pitch — "FUNHOUSE: Starring Rudy, pinball's most iconic
 * ventriloquist dummy antagonist!" — and without this the whole sentence
 * becomes the "table name" and matches nothing. Williams™ Pinball Volume 6 is
 * the pack that revealed it; the rule costs nothing on the other 137.
 *
 * The ALL-CAPS head is what makes this safe. Ordinary titles containing a
 * colon — "Star Trek™ Pinball: Deep Space Nine", "The Getaway: High Speed II"
 * — have lowercase letters before the colon and are left completely alone,
 * which matters because truncating one of those would silently merge three
 * distinct tables into their shared prefix.
 */
export function stripBlurb(item: string): string {
    const m = item.match(/^([^a-z:]{3,}?):\s+\S/);
    if (!m) return item;
    return m[1]!.trim();
}

/**
 * Pulls the `<li>` items out of a product's "Tables included:" list.
 * Returns null when the product has no such list (single-table packs and the
 * handful of series packs that omit it).
 */
function parseTableList(bodyHtml: string): string[] | null {
    const block = bodyHtml.match(/[Tt]ables?\s+[Ii]ncluded[\s\S]{0,80}?<ul>([\s\S]*?)<\/ul>/);
    if (!block) return null;
    const items = [...block[1]!.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)]
        .map(m => m[1]!
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&nbsp;/g, ' ')
            .replace(/&#8217;|&rsquo;/g, "'")
            .replace(/[™®]/g, '')
            .trim())
        .map(stripBlurb)
        .filter(Boolean);
    return items.length > 0 ? items : null;
}

/**
 * Recovers the table name from a single-table pack's title.
 *
 * Titles follow "<table> Legends <Single|Mini> [Premium ]Pack (For Legends …)",
 * optionally behind a "Williams™ Pinball:" style brand prefix that
 * `atgamesMatchKey` strips later anyway. Returns null for multi-table packs,
 * which have no single name to recover.
 */
function parseSingleTableTitle(title: string): string | null {
    if (!/\bSingle\b/i.test(title)) return null;
    const cleaned = title
        .replace(/\s*\(.*$/, '')
        .replace(/\s*Legends\s+Single\s+(Premium\s+)?Pack.*$/i, '')
        // Bare brand qualifier the store adds and the API doesn't: the store
        // sells "Zaccaria Space Shuttle Deluxe", the API calls the table
        // "Space Shuttle Deluxe". (atgamesMatchKey only strips the longer
        // "<Brand> Pinball:" form.)
        .replace(/^(Zaccaria|Gottlieb|Taito)\s+(?!Pinball\b)/i, '')
        .trim();
    return cleaned.length > 0 ? cleaned : null;
}

function manufacturerFromPackTitle(title: string): string | null {
    for (const { pattern, manufacturer } of LICENSED_MANUFACTURERS) {
        if (pattern.test(title)) return manufacturer;
    }
    return null;
}

export class AtGamesEStoreClient {
    /**
     * Fetches every pack product in a collection. Shopify caps `limit` at 250
     * and paginates with `page`; the largest collection here is 65 products, so
     * this is one request in practice — the loop exists so a growing catalogue
     * doesn't silently truncate.
     */
    private static async fetchCollection(handle: string): Promise<ShopifyProduct[]> {
        const out: ShopifyProduct[] = [];
        for (let page = 1; page <= 20; page++) {
            const res = await axios.get<{ products: ShopifyProduct[] }>(
                `${STORE_BASE}/collections/${handle}/products.json`,
                { params: { limit: 250, page }, timeout: 30000 },
            );
            const batch = res.data?.products ?? [];
            out.push(...batch);
            if (batch.length < 250) break;
        }
        return out;
    }

    /**
     * Builds the table → studio map.
     *
     * Keyed by `atgamesMatchKey` so the caller can look up an API game name
     * directly. A table claimed by two publishers is logged and the first
     * claim wins — the store has never actually produced one, so a hit here
     * means the store's own filing changed and wants a human look.
     */
    static async buildStudioMap(): Promise<{
        byKey: Map<string, StudioAttribution>;
        byPrefix: Array<{ prefix: string; attribution: StudioAttribution }>;
        byBrand: Map<string, StudioAttribution>;
        bySeries: Map<string, string>;
        packsSeen: number;
        conflicts: string[];
    }> {
        const byKey = new Map<string, StudioAttribution>();
        const prefixClaims = new Map<string, StudioAttribution>();
        const byBrand = new Map<string, StudioAttribution>();
        const conflicts: string[] = [];
        let packsSeen = 0;

        for (const [handle, studio] of Object.entries(PUBLISHER_COLLECTIONS)) {
            let products: ShopifyProduct[];
            try {
                products = await this.fetchCollection(handle);
            } catch (err) {
                // One dead collection must not sink the whole import — the
                // tables it would have attributed simply keep a null studio.
                logWarn(`AtGames eStore: collection "${handle}" failed (${err instanceof Error ? err.message : String(err)}) — skipping`);
                continue;
            }
            logInfo(`AtGames eStore: ${handle} → ${studio}, ${products.length} packs`);

            for (const product of products) {
                packsSeen++;
                const manufacturer = manufacturerFromPackTitle(product.title);
                const listed = parseTableList(product.body_html || '');
                const names = listed ?? (() => {
                    const single = parseSingleTableTitle(product.title);
                    return single ? [single] : [];
                })();

                for (const name of names) {
                    const key = atgamesMatchKey(name);
                    if (!key) continue;
                    const prior = byKey.get(key);
                    if (prior && prior.studio !== studio) {
                        conflicts.push(`"${name}": ${prior.studio} (${prior.packTitle}) vs ${studio} (${product.title})`);
                        continue;
                    }
                    if (prior) continue;
                    byKey.set(key, { studio, manufacturer, packTitle: product.title });
                }

                // Every pack also stakes a prefix claim, used only as a last
                // resort for tables no list named. First claim wins, so a
                // disagreement between two publishers' packs leaves the
                // earlier one standing rather than flip-flopping per run.
                const prefix = packPrefixKey(product.title);
                if (prefix && !prefixClaims.has(prefix)) {
                    prefixClaims.set(prefix, { studio, manufacturer, packTitle: product.title });
                }

                // And a BRAND claim, read off the store's own filing rather
                // than assumed: whichever collection holds the Williams packs
                // is who publishes Williams tables on Legends. That answers the
                // "Williams™ Pinball Volume 4" problem — the volume packs list
                // no contents and their tables' names survive no prefix match
                // (atgamesMatchKey strips the brand from BOTH sides), but the
                // names still announce the brand.
                if (manufacturer && !byBrand.has(manufacturer.toLowerCase())) {
                    byBrand.set(manufacturer.toLowerCase(), { studio, manufacturer, packTitle: product.title });
                }
            }
        }

        // Longest first, so "startrekpinball" is tried before "pinball".
        const byPrefix = [...prefixClaims.entries()]
            .map(([prefix, attribution]) => ({ prefix, attribution }))
            .sort((a, b) => b.prefix.length - a.prefix.length);

        const bySeries = new Map(Object.entries(SERIES_PUBLISHERS));

        if (conflicts.length > 0) {
            logWarn(`AtGames eStore: ${conflicts.length} table(s) claimed by two publishers — first claim kept:\n  ${conflicts.join('\n  ')}`);
        }
        logInfo(
            `AtGames eStore: ${byKey.size} tables attributed across ${packsSeen} packs, ` +
            `${byPrefix.length} prefix claims, ${byBrand.size} brand claims (${[...byBrand].map(([b, a]) => `${b}→${a.studio}`).join(', ')})`,
        );

        return { byKey, byPrefix, byBrand, bySeries, packsSeen, conflicts };
    }

    /**
     * Last-resort attribution for a table no pack listed by name. Returns the
     * longest pack-title prefix that matches, or null.
     */
    static matchByPrefix(
        byPrefix: Array<{ prefix: string; attribution: StudioAttribution }>,
        gameName: string,
    ): StudioAttribution | null {
        const key = atgamesMatchKey(gameName);
        if (!key) return null;
        for (const { prefix, attribution } of byPrefix) {
            if (key.startsWith(prefix)) return attribution;
        }
        return null;
    }
}
