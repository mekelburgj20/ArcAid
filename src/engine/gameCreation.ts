import { getDatabase } from '../database/database.js';
import { v4 as uuidv4 } from 'uuid';
import { logError, logInfo, logWarn } from '../utils/logger.js';
import { IScoredSessionRegistry } from './IScoredSessionRegistry.js';
import { getIScoredCredsForRoom } from '../utils/iscoredCreds.js';

/**
 * Result of a pin-to-scoreboard operation. iScored mirroring is best-effort —
 * a failure there leaves the local row in place so the admin can retry rather
 * than losing the pin. Callers surface `iscoredStatus` to the UI.
 */
export interface PinGameResult {
    gameId: string;
    name: string;
    iscoredStatus: 'created' | 'failed' | 'skipped';
    iscoredId: string | null;
}

export interface PinGameOptions {
    roomId: string;
    gameName: string;
    /**
     * When true and the room has usable iScored creds, also create the game on
     * iScored and store the returned `iscored_id`. False leaves the pin local-
     * only. Default false (caller should be explicit).
     */
    createOnIScored?: boolean;
    /**
     * Additional iScored tags to apply after creation. Pinned games typically
     * want something like `['MG']` (manual/library games), but callers can
     * pass whatever their taxonomy expects.
     */
    iScoredTags?: string[];
}

/**
 * Creates a standalone (non-tournament) game row for the given room, optionally
 * mirrored to iScored. Used by the pin-to-scoreboard endpoint.
 *
 * Data-model invariants:
 *   - `tournament_id` is NULL — pinned games live outside tournament state.
 *   - `game_room_id` is authoritative for pinned rows (v2.4.0 column; for
 *     tournament games it's the denormalized tournament.game_room_id).
 *   - `global_game_id` is resolved via `GlobalGameService.upsert` so the row
 *     takes part in global-scoreboard fan-out immediately.
 *
 * Per-game style overlays are pulled from `game_room_game_library` at insert
 * time. Custom platforms / display-name overlays were dropped in step 2c.
 *
 * iScored mirroring:
 *   - creds resolved via `getIScoredCredsForRoom` (per-room → env fallback).
 *   - When creds absent or `createOnIScored=false`, status=`skipped`.
 *   - When creds present but the client throws, status=`failed` and the local
 *     row is KEPT — the admin can retry via the UI without losing the pin.
 */
export async function pinGameToScoreboard(opts: PinGameOptions): Promise<PinGameResult> {
    const db = await getDatabase();
    const gameId = uuidv4();
    const nowIso = new Date().toISOString();

    // --- 1) Resolve global_game_id + enrich from catalogue / room library ---
    const { GlobalGameService } = await import('../services/GlobalGameService.js');

    // Read catalogue entry — drives type/display defaults. The room's per-game
    // style overlay (game_room_game_library) survives until 2e drops the table.
    const catEntry = await db.get(
        `SELECT id, type, display_name AS lib_display_name, external_url AS lib_external_url
         FROM global_games
         WHERE LOWER(name) = LOWER(?) AND status = 'approved'
         LIMIT 1`,
        opts.gameName,
    );
    const styleOverlay = await db.get(
        `SELECT catalogue_style_id, logo_style_id, bg_style_id, style_header_disabled,
                bg_zoom, bg_pos_x, bg_pos_y
         FROM game_room_game_library
         WHERE game_name = ? COLLATE NOCASE AND game_room_id = ?`,
        opts.gameName, opts.roomId,
    );
    const libEntry = catEntry && styleOverlay ? { ...catEntry, ...styleOverlay } : (catEntry || styleOverlay);

    const type = catEntry?.type === 'video_game' ? 'video_game' : 'pinball';
    let globalGameId: string | null = catEntry?.id ?? null;
    if (!globalGameId) {
        const { id } = await GlobalGameService.upsert({
            name: opts.gameName,
            type,
            status: 'approved',
        });
        globalGameId = id;
    }

    // --- 2) Insert games row (tournament_id NULL, game_room_id set) ---
    const displayName = libEntry?.lib_display_name ?? null;
    const externalUrl = libEntry?.lib_external_url ?? null;
    const styleId: string | null = null;

    await db.run(
        `INSERT INTO games (
            id, tournament_id, game_room_id, name, global_game_id, status, start_date, created_at,
            style_id, catalogue_style_id, logo_style_id, bg_style_id, style_header_disabled,
            bg_zoom, bg_pos_x, bg_pos_y,
            display_name, external_url
         ) VALUES (?, NULL, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        gameId, opts.roomId, opts.gameName, globalGameId, nowIso, nowIso,
        styleId,
        libEntry?.catalogue_style_id ?? null,
        libEntry?.logo_style_id ?? null,
        libEntry?.bg_style_id ?? null,
        libEntry?.style_header_disabled ?? 0,
        // v2.115.0: background framing follows the library default onto the pin.
        libEntry?.bg_zoom ?? null,
        libEntry?.bg_pos_x ?? null,
        libEntry?.bg_pos_y ?? null,
        displayName,
        externalUrl,
    );

    logInfo(`Pinned "${opts.gameName}" as game ${gameId} in room ${opts.roomId}`);

    // --- 3) Optional iScored mirroring ---
    if (!opts.createOnIScored) {
        return { gameId, name: opts.gameName, iscoredStatus: 'skipped', iscoredId: null };
    }

    const creds = await getIScoredCredsForRoom(opts.roomId);
    if (!creds) {
        logWarn(`Pin: createOnIScored requested but no creds available for room ${opts.roomId}`);
        return { gameId, name: opts.gameName, iscoredStatus: 'skipped', iscoredId: null };
    }

    try {
        const iscoredId = await IScoredSessionRegistry.getInstance().withSession(creds, async (client) => {
            const id = await client.createGame(opts.gameName, styleId ?? undefined);
            if (opts.iScoredTags && opts.iScoredTags.length > 0) {
                try { await client.setGameTags(id, opts.iScoredTags.join(',')); } catch (tagErr) {
                    logWarn(`Pin: tag set failed for ${id} — pin kept, tags skipped`, tagErr);
                }
            }
            try { await client.setGameStatus(id, { locked: false, hidden: false }); } catch { /* non-fatal */ }
            return id;
        });
        await db.run('UPDATE games SET iscored_id = ? WHERE id = ?', iscoredId, gameId);
        logInfo(`Pin: iScored game created (${iscoredId}) for local game ${gameId}`);
        return { gameId, name: opts.gameName, iscoredStatus: 'created', iscoredId };
    } catch (err) {
        logError(`Pin: iScored mirroring failed for "${opts.gameName}" — local row kept`, err);
        return { gameId, name: opts.gameName, iscoredStatus: 'failed', iscoredId: null };
    }
}

/**
 * Removes a pinned game. The local row is always deleted; iScored deletion is
 * opt-in via `deleteOnIScored`. Before deleting, submission-bearing tables are
 * unlinked (`game_id = NULL`) so score history survives the removal.
 */
export async function unpinGameFromScoreboard(opts: {
    roomId: string;
    gameId: string;
    deleteOnIScored?: boolean;
}): Promise<{ deleted: boolean; iscoredStatus: 'deleted' | 'failed' | 'skipped' }> {
    const db = await getDatabase();

    const row = await db.get(
        `SELECT id, tournament_id, game_room_id, name, iscored_id
         FROM games
         WHERE id = ? AND game_room_id = ? AND tournament_id IS NULL`,
        opts.gameId, opts.roomId,
    );
    if (!row) return { deleted: false, iscoredStatus: 'skipped' };

    let iscoredStatus: 'deleted' | 'failed' | 'skipped' = 'skipped';
    if (opts.deleteOnIScored && row.iscored_id) {
        const creds = await getIScoredCredsForRoom(opts.roomId);
        if (creds) {
            try {
                const deleted = await IScoredSessionRegistry.getInstance().withSession(creds, (client) =>
                    client.deleteGame(row.iscored_id, row.name),
                );
                if (deleted) {
                    iscoredStatus = 'deleted';
                } else {
                    logWarn(`Unpin: iScored delete skipped for ${row.iscored_id} (not in dropdown). Local row will still be removed.`);
                    iscoredStatus = 'failed';
                }
            } catch (err) {
                logError(`Unpin: iScored delete failed for ${row.iscored_id}`, err);
                iscoredStatus = 'failed';
            }
        }
    }

    // Preserve score history: unlink FK to games.id before deleting the row.
    await db.run('UPDATE submissions SET game_id = NULL WHERE game_id = ?', opts.gameId);
    await db.run('UPDATE score_history SET game_id = NULL WHERE game_id = ?', opts.gameId);
    await db.run('UPDATE global_scores SET origin_game_id = NULL WHERE origin_game_id = ?', opts.gameId);
    await db.run('DELETE FROM games WHERE id = ?', opts.gameId);

    logInfo(`Unpinned game ${opts.gameId} ("${row.name}") from room ${opts.roomId} (iScored: ${iscoredStatus})`);
    return { deleted: true, iscoredStatus };
}
