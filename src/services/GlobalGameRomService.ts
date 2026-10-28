import crypto from 'crypto';
import { getDatabase } from '../database/database.js';

/**
 * v2.193.0 (W12, castcade hand-off section 11 / B8 / F8) - the ROM -> catalogue
 * game map in `global_game_roms` (migration 197).
 *
 * Filled from VPS `romFiles[].version` by `VpsImportService.syncRomFiles` (the
 * same field the Castcade companion's `fetch-vps.mjs` reads as the PinMAME ROM
 * id). Two readers, ONE filter (`MAP_FILTER_SQL`), so the companion and the
 * server can never disagree about what a ROM names:
 *
 * - `romMap()` - the public `GET /api/witness/roms` body.
 * - `gameForRom(rom)` - the score ingest's rom tier (`VpxScoreIngestService`).
 *
 * A ROM listed under more than one catalogue game (mods and originals reuse a
 * ROM - `fpwr2_l2` sits under 18 games) is AMBIGUOUS: the map lists it as such
 * and the ingest ignores it. Nothing here ever picks one of several.
 */

/** A catalogue row is in the map only when it is approved and VPS-identified. */
const MAP_FILTER_SQL = `g.status = 'approved' AND g.vps_id IS NOT NULL`;

/** ROM ids are compared lowercased and trimmed (PinMAME ids are case-insensitive in practice). */
export function normalizeRom(rom: string | null | undefined): string | null {
    if (typeof rom !== 'string') return null;
    const r = rom.trim().toLowerCase();
    return r ? r : null;
}

export interface RomMapGame {
    vpsGameId: string;
    globalGameId: string;
    name: string;
    manufacturer: string | null;
    year: number | null;
}

export type RomMapEntry = RomMapGame | { ambiguous: true; candidates: RomMapGame[] };

export interface RomMap {
    /** A content hash of `roms`: changes exactly when the map does. Also the ETag. */
    version: string;
    count: number;
    roms: Record<string, RomMapEntry>;
}

interface RomRow {
    rom: string;
    global_game_id: string;
    vps_id: string;
    name: string;
    manufacturer: string | null;
    year: number | null;
}

export class GlobalGameRomService {
    /** Every ROM in the map, ambiguous ones listed with their candidates. */
    static async romMap(): Promise<RomMap> {
        const db = await getDatabase();
        const rows = await db.all<RomRow[]>(
            `SELECT r.rom, r.global_game_id, g.vps_id, g.name, g.manufacturer, g.year
               FROM global_game_roms r
               JOIN global_games g ON g.id = r.global_game_id
              WHERE ${MAP_FILTER_SQL}
              ORDER BY r.rom, g.name, g.id`,
        );
        const grouped = new Map<string, RomMapGame[]>();
        for (const row of rows) {
            const game: RomMapGame = {
                vpsGameId: row.vps_id,
                globalGameId: row.global_game_id,
                name: row.name,
                manufacturer: row.manufacturer ?? null,
                year: row.year ?? null,
            };
            const list = grouped.get(row.rom);
            if (list) list.push(game);
            else grouped.set(row.rom, [game]);
        }
        const roms: Record<string, RomMapEntry> = {};
        for (const [rom, games] of grouped) {
            roms[rom] = games.length === 1 ? games[0]! : { ambiguous: true, candidates: games };
        }
        // Rows are ordered, so the serialisation is stable: same map, same version.
        const version = crypto.createHash('sha256').update(JSON.stringify(roms)).digest('hex').slice(0, 16);
        return { version, count: grouped.size, roms };
    }

    /**
     * The ONE catalogue game a ROM names, or null when the map does not know
     * the ROM or lists it under more than one game.
     */
    static async gameForRom(rom: string | null | undefined): Promise<{ id: string; name: string; display_name: string | null } | null> {
        const key = normalizeRom(rom);
        if (!key) return null;
        const db = await getDatabase();
        const rows = await db.all<Array<{ id: string; name: string; display_name: string | null }>>(
            `SELECT DISTINCT g.id, g.name, g.display_name
               FROM global_game_roms r
               JOIN global_games g ON g.id = r.global_game_id
              WHERE r.rom = ? AND ${MAP_FILTER_SQL}
              LIMIT 2`,
            key,
        );
        return rows.length === 1 ? rows[0]! : null;
    }
}
