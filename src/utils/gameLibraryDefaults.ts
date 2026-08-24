import { logWarn } from './logger.js';

type Db = {
    get<T>(sql: string, ...params: unknown[]): Promise<T | undefined>;
    run(sql: string, ...params: unknown[]): Promise<unknown>;
};

interface StyleOverlayRow {
    catalogue_style_id: string | null;
    logo_style_id: string | null;
    bg_style_id: string | null;
    style_header_disabled: number | null;
    bg_zoom: number | null;
    bg_pos_x: number | null;
    bg_pos_y: number | null;
}

interface CatalogueDefaultsRow {
    display_name: string | null;
    external_url: string | null;
}

/**
 * Apply the room's saved presentation defaults to a freshly-created `games` row.
 *
 * Two independent overlays, both best-effort:
 *   1. `game_room_game_library` — the per-room, per-game STYLE overlay
 *      (catalogue/logo/bg style ids, header suppression, background framing).
 *      v2.115.0: the framing travels with the style so a saved default keeps
 *      its composition across rotations.
 *   2. `global_games` — the catalogue's `display_name` / `external_url`.
 *
 * Extracted from `TournamentEngine.activateGame` in v2.135.0 so the Live Event
 * scheduler creates rounds that look identical to rotation games. **Both
 * creators must call this** — a round that skips it renders with the raw game
 * name and no artwork while the same game in a rotation tournament looks right.
 *
 * Never throws: presentation defaults are cosmetic, and failing a round start
 * over a missing style row would be strictly worse than an unstyled card.
 */
export async function applyLibraryDefaults(
    db: Db,
    gameRoomId: string | null | undefined,
    gameId: string,
    gameName: string,
): Promise<void> {
    if (!gameRoomId) return;
    try {
        const libraryEntry = await db.get<StyleOverlayRow>(
            `SELECT catalogue_style_id, logo_style_id, bg_style_id, style_header_disabled,
                    bg_zoom, bg_pos_x, bg_pos_y
             FROM game_room_game_library
             WHERE game_room_id = ? AND game_name = ? AND (catalogue_style_id IS NOT NULL OR logo_style_id IS NOT NULL OR bg_style_id IS NOT NULL)`,
            gameRoomId, gameName,
        );
        if (libraryEntry) {
            await db.run(
                `UPDATE games SET catalogue_style_id = ?, logo_style_id = ?, bg_style_id = ?, style_header_disabled = ?,
                    bg_zoom = ?, bg_pos_x = ?, bg_pos_y = ? WHERE id = ?`,
                libraryEntry.catalogue_style_id, libraryEntry.logo_style_id, libraryEntry.bg_style_id, libraryEntry.style_header_disabled,
                libraryEntry.bg_zoom ?? null, libraryEntry.bg_pos_x ?? null, libraryEntry.bg_pos_y ?? null,
                gameId,
            );
        }

        const libGame = await db.get<CatalogueDefaultsRow>(
            `SELECT display_name, external_url FROM global_games
             WHERE LOWER(name) = LOWER(?) AND status = 'approved' LIMIT 1`,
            gameName,
        );
        if (libGame?.display_name || libGame?.external_url) {
            await db.run(
                'UPDATE games SET display_name = COALESCE(?, display_name), external_url = COALESCE(?, external_url) WHERE id = ?',
                libGame.display_name || null, libGame.external_url || null, gameId,
            );
        }
    } catch (error) {
        logWarn(`applyLibraryDefaults failed for game '${gameName}' (${gameId}) — card will render unstyled:`, error);
    }
}
