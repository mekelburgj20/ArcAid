import { getDatabase } from '../database/database.js';
import { logInfo } from '../utils/logger.js';

interface GameData {
    name: string;
    display_name?: string;
    aliases?: string;
    style_id?: string;
    mode?: string;
    css_title?: string;
    css_initials?: string;
    css_scores?: string;
    css_box?: string;
    bg_color?: string;
    platforms?: string;
}

export class GameLibraryService {
    /**
     * Searches games in the library by name (partial, case-insensitive).
     */
    static async search(query: string, limit: number = 10): Promise<Array<{ name: string; mode: string; platforms: string }>> {
        const db = await getDatabase();
        return db.all(
            'SELECT name, mode, platforms FROM game_library WHERE name LIKE ? COLLATE NOCASE LIMIT ?',
            `%${query}%`, limit
        );
    }

    /**
     * Returns all games in the library.
     */
    static async getAll(): Promise<any[]> {
        const db = await getDatabase();
        return db.all('SELECT * FROM game_library');
    }

    /**
     * Updates a single game by its original name.
     */
    static async updateGame(originalName: string, game: GameData): Promise<boolean> {
        const db = await getDatabase();
        const result = await db.run(
            `UPDATE game_library SET name = ?, display_name = ?, aliases = ?, style_id = ?, mode = ?, css_title = ?, css_initials = ?, css_scores = ?, css_box = ?, bg_color = ?, platforms = ? WHERE name = ?`,
            game.name, game.display_name || null, game.aliases || '', game.style_id || '',
            game.mode || 'pinball',
            game.css_title || '', game.css_initials || '',
            game.css_scores || '', game.css_box || '',
            game.bg_color || '', game.platforms || '[]',
            originalName
        );
        return (result.changes ?? 0) > 0;
    }

    /**
     * Updates only the style fields for a game (preserves other fields).
     * Used by the style learning loop during maintenance.
     */
    static async updateStyles(name: string, styles: {
        style_id?: string | null;
        css_title?: string;
        css_initials?: string;
        css_scores?: string;
        css_box?: string;
        bg_color?: string;
    }): Promise<boolean> {
        const db = await getDatabase();
        const result = await db.run(
            `UPDATE game_library SET
                style_id = COALESCE(?, style_id),
                css_title = COALESCE(?, css_title),
                css_initials = COALESCE(?, css_initials),
                css_scores = COALESCE(?, css_scores),
                css_box = COALESCE(?, css_box),
                bg_color = COALESCE(?, bg_color)
            WHERE name = ?`,
            styles.style_id || null,
            styles.css_title || null,
            styles.css_initials || null,
            styles.css_scores || null,
            styles.css_box || null,
            styles.bg_color || null,
            name
        );
        return (result.changes ?? 0) > 0;
    }

    /**
     * Deletes games from the library by name.
     * Does NOT affect active tournament games — only removes from the library catalog.
     */
    static async deleteGames(names: string[]): Promise<number> {
        const db = await getDatabase();
        if (names.length === 0) return 0;
        const placeholders = names.map(() => '?').join(',');
        const result = await db.run(
            `DELETE FROM game_library WHERE name IN (${placeholders})`,
            ...names
        );
        return result.changes ?? 0;
    }

    /**
     * Imports an array of games into the library (upsert).
     * Runs in a transaction for atomicity.
     * Auto-merges games whose names differ only by trivial formatting
     * (e.g. comma in parenthetical: "Game (Stern, 2009)" vs "Game (Stern 2009)").
     * Returns the count of imported games and any auto-merged entries.
     */
    static async importGames(games: GameData[]): Promise<{ imported: number; autoMerged: Array<{ imported: string; existing: string }> }> {
        const db = await getDatabase();

        // Build a normalized lookup of all existing games for auto-merge detection
        const allExisting = await db.all('SELECT name, platforms FROM game_library');
        const normalizedMap = new Map<string, { name: string; platforms: string }>();
        for (const row of allExisting) {
            normalizedMap.set(this.normalizeName(row.name), { name: row.name, platforms: row.platforms || '' });
        }

        const autoMerged: Array<{ imported: string; existing: string }> = [];

        await db.exec('BEGIN TRANSACTION');
        try {
            for (const game of games) {
                // Check if game exists by exact name (case-insensitive)
                const existing = await db.get(
                    'SELECT name, platforms FROM game_library WHERE name = ? COLLATE NOCASE',
                    game.name
                );

                // If no exact match, check for a normalized match (auto-merge candidate)
                let mergeTarget: { name: string; platforms: string } | null = null;
                if (!existing) {
                    const norm = this.normalizeName(game.name);
                    const normMatch = normalizedMap.get(norm);
                    if (normMatch && normMatch.name.toLowerCase() !== game.name.toLowerCase()) {
                        mergeTarget = normMatch;
                    }
                }

                const targetName = existing?.name || mergeTarget?.name || null;
                const targetPlatforms = existing?.platforms || mergeTarget?.platforms || '';

                // Merge platforms: union of existing + new
                let mergedPlatforms = game.platforms || '[]';
                if (targetName) {
                    const existingList = this.parsePlatformsList(targetPlatforms);
                    const newList = this.parsePlatformsList(mergedPlatforms);
                    const seen = new Set(existingList.map(p => p.toUpperCase()));
                    const result = [...existingList];
                    for (const p of newList) {
                        if (!seen.has(p.toUpperCase())) {
                            seen.add(p.toUpperCase());
                            result.push(p);
                        }
                    }
                    mergedPlatforms = JSON.stringify(result);
                }

                if (existing) {
                    // Update: preserve existing non-empty fields, merge platforms
                    await db.run(
                        `UPDATE game_library SET
                            aliases = CASE WHEN ? != '' THEN ? ELSE aliases END,
                            style_id = CASE WHEN ? != '' THEN ? ELSE style_id END,
                            mode = ?,
                            css_title = CASE WHEN ? != '' THEN ? ELSE css_title END,
                            css_initials = CASE WHEN ? != '' THEN ? ELSE css_initials END,
                            css_scores = CASE WHEN ? != '' THEN ? ELSE css_scores END,
                            css_box = CASE WHEN ? != '' THEN ? ELSE css_box END,
                            bg_color = CASE WHEN ? != '' THEN ? ELSE bg_color END,
                            platforms = ?
                        WHERE name = ? COLLATE NOCASE`,
                        game.aliases || '', game.aliases || '',
                        game.style_id || '', game.style_id || '',
                        game.mode || 'pinball',
                        game.css_title || '', game.css_title || '',
                        game.css_initials || '', game.css_initials || '',
                        game.css_scores || '', game.css_scores || '',
                        game.css_box || '', game.css_box || '',
                        game.bg_color || '', game.bg_color || '',
                        mergedPlatforms,
                        game.name
                    );
                } else if (mergeTarget) {
                    // Auto-merge: update the existing game's platforms and add alias
                    const existingAliases = await db.get(
                        'SELECT aliases FROM game_library WHERE name = ?',
                        mergeTarget.name
                    );
                    const aliasStr = existingAliases?.aliases || '';
                    const aliasList = aliasStr ? aliasStr.split(',').map((a: string) => a.trim()).filter(Boolean) : [];
                    if (!aliasList.some((a: string) => a.toLowerCase() === game.name.toLowerCase())) {
                        aliasList.push(game.name);
                    }

                    await db.run(
                        `UPDATE game_library SET
                            aliases = ?,
                            style_id = CASE WHEN ? != '' THEN ? ELSE style_id END,
                            mode = ?,
                            css_title = CASE WHEN ? != '' THEN ? ELSE css_title END,
                            css_initials = CASE WHEN ? != '' THEN ? ELSE css_initials END,
                            css_scores = CASE WHEN ? != '' THEN ? ELSE css_scores END,
                            css_box = CASE WHEN ? != '' THEN ? ELSE css_box END,
                            bg_color = CASE WHEN ? != '' THEN ? ELSE bg_color END,
                            platforms = ?
                        WHERE name = ?`,
                        aliasList.join(', '),
                        game.style_id || '', game.style_id || '',
                        game.mode || 'pinball',
                        game.css_title || '', game.css_title || '',
                        game.css_initials || '', game.css_initials || '',
                        game.css_scores || '', game.css_scores || '',
                        game.css_box || '', game.css_box || '',
                        game.bg_color || '', game.bg_color || '',
                        mergedPlatforms,
                        mergeTarget.name
                    );

                    // Transfer room associations if the imported name had any queued
                    // (not applicable during bulk import, but keeps behavior consistent)

                    autoMerged.push({ imported: game.name, existing: mergeTarget.name });
                    // Update the normalized map so subsequent games in this batch see the merged platforms
                    normalizedMap.set(this.normalizeName(mergeTarget.name), { name: mergeTarget.name, platforms: mergedPlatforms });
                } else {
                    // Insert new game
                    await db.run(
                        `INSERT INTO game_library
                        (name, aliases, style_id, mode, css_title, css_initials, css_scores, css_box, bg_color, platforms)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        game.name, game.aliases || '', game.style_id || '',
                        game.mode || 'pinball',
                        game.css_title || '', game.css_initials || '',
                        game.css_scores || '', game.css_box || '',
                        game.bg_color || '', mergedPlatforms
                    );
                    // Add to normalized map for subsequent games in this batch
                    normalizedMap.set(this.normalizeName(game.name), { name: game.name, platforms: mergedPlatforms });
                }
            }
            await db.exec('COMMIT');

            // Auto-sync: merge any new platforms into the master PLATFORMS setting
            await this.syncPlatformsSetting(db, games);

            if (autoMerged.length > 0) {
                logInfo(`Auto-merged ${autoMerged.length} near-duplicate games during import`);
            }

            return { imported: games.length, autoMerged };
        } catch (error) {
            await db.exec('ROLLBACK').catch(() => {});
            throw error;
        }
    }

    /**
     * Merges platforms from imported games into the master PLATFORMS setting.
     */
    private static async syncPlatformsSetting(db: any, games: GameData[]): Promise<void> {
        try {
            const row = await db.get("SELECT value FROM settings WHERE key = 'PLATFORMS'");
            let masterPlatforms: string[] = [];
            try { masterPlatforms = JSON.parse(row?.value || '[]'); } catch {}

            const masterSet = new Set(masterPlatforms.map(p => p.toUpperCase()));
            const newPlatforms = [...masterPlatforms];

            for (const game of games) {
                const gamePlats = this.parsePlatformsList(game.platforms || '');
                for (const p of gamePlats) {
                    if (p && !masterSet.has(p.toUpperCase())) {
                        masterSet.add(p.toUpperCase());
                        newPlatforms.push(p);
                    }
                }
            }

            if (newPlatforms.length > masterPlatforms.length) {
                await db.run(
                    "UPDATE settings SET value = ? WHERE key = 'PLATFORMS'",
                    JSON.stringify(newPlatforms)
                );
            }
        } catch {
            // Non-critical — don't fail the import
        }
    }

    /**
     * Gets games from the library that are associated with a specific game room.
     */
    static async getForRoom(gameRoomId: string): Promise<any[]> {
        const db = await getDatabase();
        return db.all(
            `SELECT gl.*, grgl.catalogue_style_id, grgl.logo_style_id, grgl.bg_style_id, grgl.style_header_disabled
             FROM game_library gl
             JOIN game_room_game_library grgl ON gl.name = grgl.game_name
             WHERE grgl.game_room_id = ?`,
            gameRoomId
        );
    }

    /**
     * Set or clear the default catalogue style for a game in a room's library.
     */
    static async setRoomGameStyle(gameRoomId: string, gameName: string, catalogueStyleId: string | null, headerDisabled: boolean = false): Promise<boolean> {
        const db = await getDatabase();
        const result = await db.run(
            `UPDATE game_room_game_library SET catalogue_style_id = ?, style_header_disabled = ?
             WHERE game_room_id = ? AND game_name = ?`,
            catalogueStyleId, headerDisabled ? 1 : 0, gameRoomId, gameName
        );
        return (result.changes || 0) > 0;
    }

    /**
     * Get the default catalogue style for a game in a room's library.
     */
    static async getRoomGameStyle(gameRoomId: string, gameName: string): Promise<{ catalogue_style_id: string | null; logo_style_id: string | null; bg_style_id: string | null; style_header_disabled: number } | undefined> {
        const db = await getDatabase();
        return db.get(
            `SELECT catalogue_style_id, logo_style_id, bg_style_id, style_header_disabled FROM game_room_game_library
             WHERE game_room_id = ? AND game_name = ?`,
            gameRoomId, gameName
        );
    }

    /**
     * Associates games with a game room.
     */
    static async addToRoom(gameRoomId: string, gameNames: string[]): Promise<void> {
        const db = await getDatabase();
        for (const name of gameNames) {
            await db.run(
                'INSERT OR IGNORE INTO game_room_game_library (game_room_id, game_name) VALUES (?, ?)',
                gameRoomId, name
            );
        }
    }

    /**
     * Removes game associations from a game room.
     */
    static async removeFromRoom(gameRoomId: string, gameNames: string[]): Promise<void> {
        if (gameNames.length === 0) return;
        const db = await getDatabase();
        const placeholders = gameNames.map(() => '?').join(',');
        await db.run(
            `DELETE FROM game_room_game_library WHERE game_room_id = ? AND game_name IN (${placeholders})`,
            gameRoomId, ...gameNames
        );
    }

    /**
     * Merges one game into another in the library.
     * Transfers the source game's platforms to the target, updates any room associations,
     * and deletes the source game.
     */
    static async mergeGames(fromName: string, toName: string): Promise<{ platformsMerged: string[]; roomsUpdated: number }> {
        const db = await getDatabase();

        const fromGame = await db.get('SELECT * FROM game_library WHERE name = ?', fromName);
        const toGame = await db.get('SELECT * FROM game_library WHERE name = ?', toName);
        if (!fromGame) throw new Error(`Source game "${fromName}" not found`);
        if (!toGame) throw new Error(`Target game "${toName}" not found`);

        // Merge platforms
        const fromPlats = this.parsePlatformsList(fromGame.platforms || '');
        const toPlats = this.parsePlatformsList(toGame.platforms || '');
        const seen = new Set(toPlats.map(p => p.toUpperCase()));
        const merged = [...toPlats];
        const added: string[] = [];
        for (const p of fromPlats) {
            if (!seen.has(p.toUpperCase())) {
                seen.add(p.toUpperCase());
                merged.push(p);
                added.push(p);
            }
        }

        await db.run(
            'UPDATE game_library SET platforms = ? WHERE name = ?',
            JSON.stringify(merged), toName
        );

        // Transfer room associations from source to target
        const roomAssocs = await db.all(
            'SELECT game_room_id FROM game_room_game_library WHERE game_name = ?',
            fromName
        );
        let roomsUpdated = 0;
        for (const assoc of roomAssocs) {
            await db.run(
                'INSERT OR IGNORE INTO game_room_game_library (game_room_id, game_name) VALUES (?, ?)',
                assoc.game_room_id, toName
            );
            roomsUpdated++;
        }

        // Delete source game's room associations and library entry
        await db.run('DELETE FROM game_room_game_library WHERE game_name = ?', fromName);
        await db.run('DELETE FROM game_library WHERE name = ?', fromName);

        logInfo(`Merged game "${fromName}" into "${toName}": ${added.length} platforms added, ${roomsUpdated} room associations transferred`);
        return { platformsMerged: added, roomsUpdated };
    }

    /**
     * Finds existing games that are near-matches to the given names.
     * Normalizes by stripping commas and extra whitespace from the
     * parenthetical portion (manufacturer/year) before comparing.
     */
    static async findNearMatches(names: string[]): Promise<Array<{ imported: string; existing: string }>> {
        const db = await getDatabase();
        const allGames = await db.all('SELECT name FROM game_library');

        // Build a map of normalized existing names → original names
        const existingMap = new Map<string, string>();
        for (const row of allGames) {
            existingMap.set(this.normalizeName(row.name), row.name);
        }

        const matches: Array<{ imported: string; existing: string }> = [];
        for (const name of names) {
            const norm = this.normalizeName(name);
            const exactNorm = existingMap.get(norm);
            // Only flag if normalized forms match but raw names differ (case-insensitive)
            if (exactNorm && exactNorm.toLowerCase() !== name.toLowerCase()) {
                matches.push({ imported: name, existing: exactNorm });
            }
        }
        return matches;
    }

    /**
     * Normalizes a game name for near-match detection.
     * Strips commas from inside parentheses and collapses whitespace.
     * e.g. "Cactus Canyon (Bally, 1998)" → "cactus canyon (bally 1998)"
     */
    private static normalizeName(name: string): string {
        return name
            .toLowerCase()
            .replace(/\(([^)]*)\)/g, (_, inner) => `(${inner.replace(/,/g, '').replace(/\s+/g, ' ').trim()})`)
            .trim();
    }

    /**
     * Parses a platforms value (JSON array or comma-separated string) into a string array.
     */
    private static parsePlatformsList(raw: string): string[] {
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed.filter(Boolean);
        } catch {}
        return raw.split(',').map(p => p.trim()).filter(Boolean);
    }
}
