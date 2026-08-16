import type { Database } from 'sqlite';
import { logInfo } from '../../utils/logger.js';

/**
 * Migration 148 — AtGames columns on `global_games`.
 *
 * A HANDLER rather than an inline `sql` entry, for the same reason as 133: the
 * inline runner swallows exec failures to stay idempotent across `ALTER TABLE
 * ADD COLUMN`, and a swallowed failure here would leave the AtGames importer
 * writing to columns that do not exist — the schema silently disagreeing with
 * the code, with nothing saying so. Pragma-guarding each ADD COLUMN gets
 * idempotency without the swallow, so a REAL failure still halts startup.
 *
 * Columns:
 *   atgames_id   AtGames' own game id, from the public
 *                `/api/leaderboards/games` feed. Joins the step-1 external-id
 *                set in `GlobalGameService.upsert` alongside opdb/vps/igdb/ra.
 *
 *                This is the point of the whole AtGames API arc. The sheet-fed
 *                importer it replaces had no external id at all, so every
 *                "Sync AtGames" click re-derived identity from the NAME via
 *                step 4 — which is what produced the 88 Zaccaria/AtGames
 *                duplicates repaired on prod 2026-08-16, and the "Aliens"
 *                mis-attachment before that. With an id, a re-import lands on
 *                the row it created last time, by construction.
 *
 *                UNIQUE-indexed (partial, `WHERE atgames_id IS NOT NULL`)
 *                because two catalogue rows claiming one AtGames game would
 *                make that lookup ambiguous.
 *
 *   studio       The studio that published the table for the Legends platform
 *                — 'Zen Studios' | 'Magic Pixel' | 'FarSight Studios' |
 *                'AtGames Originals'. Sourced from AtGames' own per-publisher
 *                eStore collections (see `AtGamesEStoreClient`).
 *
 *                DELIBERATELY NOT `manufacturer`. They are different facts:
 *                FarSight publishes Gottlieb machines, Magic Pixel publishes
 *                Zaccaria, Zen publishes Williams/Bally. Writing a studio into
 *                `manufacturer` would make `manufacturerYearAgree` compare
 *                "magic pixel" against "zaccaria", fail, and drop step-4 dedup
 *                onto INSERT — recreating the exact duplicate class this arc
 *                exists to remove. "Zen Studios" would additionally trip
 *                `isVirtualOnlyManufacturer` and suppress IPDB merges on rows
 *                that legitimately are the real machine.
 *
 * No FK anywhere: `atgames_id` points at AtGames, `studio` is a free label.
 */
const COLUMNS: Array<{ name: string; ddl: string }> = [
    { name: 'atgames_id', ddl: 'atgames_id INTEGER' },
    { name: 'studio', ddl: 'studio TEXT' },
];

export async function addAtGamesCatalogueColumns(db: Database): Promise<void> {
    const existing = await db.all<Array<{ name: string }>>(`PRAGMA table_info(global_games)`);
    const have = new Set(existing.map(c => c.name));

    const added: string[] = [];
    for (const col of COLUMNS) {
        if (have.has(col.name)) continue;
        await db.exec(`ALTER TABLE global_games ADD COLUMN ${col.ddl}`);
        added.push(col.name);
    }

    // Partial UNIQUE index. SQLite already treats NULLs as distinct in a
    // UNIQUE index, so the `WHERE` is not what makes the nullable column
    // legal — it keeps the index off the rows that will never carry an
    // `atgames_id`, which is most of the catalogue.
    await db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_global_games_atgames
             ON global_games(atgames_id) WHERE atgames_id IS NOT NULL`,
    );

    logInfo(
        added.length > 0
            ? `[migration] 148: added global_games columns ${added.join(', ')}`
            : '[migration] 148: global_games AtGames columns already present',
    );
}
