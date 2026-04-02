import { getDatabase } from '../database/database.js';
import { logInfo, logError } from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const STYLES_DIR = path.join(process.cwd(), 'data', 'styles');
const BG_DIR = path.join(STYLES_DIR, 'backgrounds');
const HEADER_DIR = path.join(STYLES_DIR, 'headers');

// Scraped data location
const SCRAPED_DIR = path.join(process.cwd(), 'data', 'iscored-styles');
const SCRAPED_BG_DIR = path.join(SCRAPED_DIR, 'backgrounds');
const SCRAPED_HEADER_DIR = path.join(SCRAPED_DIR, 'headers');
const SCRAPED_METADATA = path.join(SCRAPED_DIR, 'styles.json');

export interface StyleCatalogueEntry {
    id: string;
    iscored_style_id: number | null;
    name: string;
    author: string;
    notes: string;
    has_background: number;
    has_header: number;
    source: string;
    created_at: string;
}

function ensureDir(dir: string) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

export class StyleCatalogueService {
    /**
     * Search styles by name or author with pagination.
     */
    static async search(query: string, limit: number = 50, offset: number = 0): Promise<{ styles: StyleCatalogueEntry[]; total: number }> {
        const db = await getDatabase();
        const like = `%${query}%`;
        const styles = await db.all<StyleCatalogueEntry[]>(
            `SELECT * FROM style_catalogue WHERE name LIKE ? OR author LIKE ? ORDER BY name ASC, author ASC LIMIT ? OFFSET ?`,
            like, like, limit, offset
        );
        const row = await db.get<{ count: number }>(
            `SELECT COUNT(*) as count FROM style_catalogue WHERE name LIKE ? OR author LIKE ?`,
            like, like
        );
        return { styles, total: row?.count ?? 0 };
    }

    /**
     * Get a single style by ID.
     */
    static async getById(id: string): Promise<StyleCatalogueEntry | undefined> {
        const db = await getDatabase();
        return db.get<StyleCatalogueEntry>('SELECT * FROM style_catalogue WHERE id = ?', id);
    }

    /**
     * Import all scraped iScored styles from data/iscored-styles/styles.json.
     * Idempotent — uses INSERT OR IGNORE.
     * Copies image files to data/styles/.
     */
    static async importFromScraped(): Promise<{ imported: number; copied: number; total: number }> {
        if (!fs.existsSync(SCRAPED_METADATA)) {
            throw new Error(`Scraped styles not found at ${SCRAPED_METADATA}. Run "npm run scrape-styles" first.`);
        }

        const scraped: Array<{
            styleId: number;
            styleName: string;
            author: string;
            notes: string;
            hasBackground: boolean;
            hasHeaderImage: boolean;
        }> = JSON.parse(fs.readFileSync(SCRAPED_METADATA, 'utf-8'));

        const db = await getDatabase();
        ensureDir(BG_DIR);
        ensureDir(HEADER_DIR);

        let imported = 0;
        let copied = 0;

        // Use a transaction for bulk insert
        await db.run('BEGIN TRANSACTION');
        try {
            for (const entry of scraped) {
                const catalogueId = `iscored-${entry.styleId}`;

                const result = await db.run(
                    `INSERT OR IGNORE INTO style_catalogue (id, iscored_style_id, name, author, notes, has_background, has_header, source)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 'iscored')`,
                    catalogueId,
                    entry.styleId,
                    entry.styleName,
                    entry.author,
                    entry.notes,
                    entry.hasBackground ? 1 : 0,
                    entry.hasHeaderImage ? 1 : 0
                );
                if ((result.changes ?? 0) > 0) imported++;

                // Copy background image
                if (entry.hasBackground) {
                    const src = path.join(SCRAPED_BG_DIR, `gameBg${entry.styleId}.png`);
                    const dest = path.join(BG_DIR, `${catalogueId}.png`);
                    if (fs.existsSync(src) && !fs.existsSync(dest)) {
                        fs.copyFileSync(src, dest);
                        copied++;
                    }
                }

                // Copy header image
                if (entry.hasHeaderImage) {
                    const src = path.join(SCRAPED_HEADER_DIR, `game${entry.styleId}.png`);
                    const dest = path.join(HEADER_DIR, `${catalogueId}.png`);
                    if (fs.existsSync(src) && !fs.existsSync(dest)) {
                        fs.copyFileSync(src, dest);
                        copied++;
                    }
                }
            }
            await db.run('COMMIT');
        } catch (err) {
            await db.run('ROLLBACK');
            throw err;
        }

        logInfo(`Style import complete: ${imported} new DB rows, ${copied} files copied, ${scraped.length} total in source.`);
        return { imported, copied, total: scraped.length };
    }

    /**
     * Create a custom style from uploaded files.
     * Returns the new catalogue ID.
     */
    static async createCustom(data: {
        name: string;
        author: string;
        notes: string;
        backgroundBuffer?: Buffer;
        headerBuffer?: Buffer;
    }): Promise<string> {
        if (!data.backgroundBuffer && !data.headerBuffer) {
            throw new Error('At least one image (background or header/logo) is required');
        }
        const db = await getDatabase();
        const id = `custom-${crypto.randomUUID()}`;

        ensureDir(BG_DIR);
        ensureDir(HEADER_DIR);

        // Save background image if provided
        const hasBackground = !!data.backgroundBuffer;
        if (data.backgroundBuffer) {
            fs.writeFileSync(path.join(BG_DIR, `${id}.png`), data.backgroundBuffer);
        }

        // Save header image if provided
        const hasHeader = !!data.headerBuffer;
        if (data.headerBuffer) {
            fs.writeFileSync(path.join(HEADER_DIR, `${id}.png`), data.headerBuffer);
        }

        await db.run(
            `INSERT INTO style_catalogue (id, iscored_style_id, name, author, notes, has_background, has_header, source)
             VALUES (?, NULL, ?, ?, ?, ?, ?, 'custom')`,
            id, data.name, data.author, data.notes, hasBackground ? 1 : 0, hasHeader ? 1 : 0
        );

        logInfo(`Custom style created: "${data.name}" by ${data.author} (${id})`);
        return id;
    }

    /**
     * Delete a style and its associated image files.
     */
    static async delete(id: string): Promise<boolean> {
        const db = await getDatabase();
        const result = await db.run('DELETE FROM style_catalogue WHERE id = ?', id);
        if ((result.changes ?? 0) === 0) return false;

        // Remove image files
        const bgPath = path.join(BG_DIR, `${id}.png`);
        const headerPath = path.join(HEADER_DIR, `${id}.png`);
        try { if (fs.existsSync(bgPath)) fs.unlinkSync(bgPath); } catch { /* ignore */ }
        try { if (fs.existsSync(headerPath)) fs.unlinkSync(headerPath); } catch { /* ignore */ }

        // Clear references on any games using this style
        await db.run('UPDATE games SET catalogue_style_id = NULL, style_header_disabled = 0 WHERE catalogue_style_id = ?', id);
        await db.run('UPDATE games SET logo_style_id = NULL WHERE logo_style_id = ?', id);
        await db.run('UPDATE games SET bg_style_id = NULL WHERE bg_style_id = ?', id);
        await db.run('UPDATE game_room_game_library SET logo_style_id = NULL WHERE logo_style_id = ?', id);
        await db.run('UPDATE game_room_game_library SET bg_style_id = NULL WHERE bg_style_id = ?', id);

        logInfo(`Style deleted: ${id}`);
        return true;
    }

    /**
     * Assign a catalogue style to a game.
     */
    static async assignToGame(gameId: string, catalogueStyleId: string, headerDisabled: boolean): Promise<boolean> {
        const db = await getDatabase();

        // Verify style exists
        const style = await db.get('SELECT id FROM style_catalogue WHERE id = ?', catalogueStyleId);
        if (!style) return false;

        const result = await db.run(
            'UPDATE games SET catalogue_style_id = ?, style_header_disabled = ? WHERE id = ?',
            catalogueStyleId, headerDisabled ? 1 : 0, gameId
        );
        return (result.changes ?? 0) > 0;
    }

    /**
     * Remove style assignment from a game.
     */
    static async removeFromGame(gameId: string): Promise<boolean> {
        const db = await getDatabase();
        const result = await db.run(
            'UPDATE games SET catalogue_style_id = NULL, style_header_disabled = 0 WHERE id = ?',
            gameId
        );
        return (result.changes ?? 0) > 0;
    }

    /**
     * Get the style assigned to a game.
     */
    static async getGameStyle(gameId: string): Promise<{ style: StyleCatalogueEntry; headerDisabled: boolean } | null> {
        const db = await getDatabase();
        const game = await db.get<{ catalogue_style_id: string | null; style_header_disabled: number }>(
            'SELECT catalogue_style_id, style_header_disabled FROM games WHERE id = ?', gameId
        );
        if (!game?.catalogue_style_id) return null;

        const style = await db.get<StyleCatalogueEntry>(
            'SELECT * FROM style_catalogue WHERE id = ?', game.catalogue_style_id
        );
        if (!style) return null;

        return { style, headerDisabled: game.style_header_disabled === 1 };
    }

    /**
     * Assign a style image to a game as logo, background, or both.
     */
    static async assignImageToGame(gameId: string, styleId: string, imageType: 'logo' | 'background' | 'both'): Promise<{ ok: boolean; error?: string }> {
        const db = await getDatabase();
        const style = await db.get('SELECT id, has_background, has_header FROM style_catalogue WHERE id = ?', styleId);
        if (!style) return { ok: false, error: 'Style not found' };

        if ((imageType === 'logo' || imageType === 'both') && !style.has_header) {
            return { ok: false, error: 'This style does not have a logo/header image' };
        }
        if ((imageType === 'background' || imageType === 'both') && !style.has_background) {
            return { ok: false, error: 'This style does not have a background image' };
        }

        if (imageType === 'logo' || imageType === 'both') {
            await db.run('UPDATE games SET logo_style_id = ? WHERE id = ?', styleId, gameId);
        }
        if (imageType === 'background' || imageType === 'both') {
            await db.run('UPDATE games SET bg_style_id = ? WHERE id = ?', styleId, gameId);
        }
        return { ok: true };
    }

    /**
     * Remove logo, background, or both image assignments from a game.
     */
    static async removeImageFromGame(gameId: string, imageType: 'logo' | 'background' | 'both'): Promise<boolean> {
        const db = await getDatabase();
        if (imageType === 'logo' || imageType === 'both') {
            await db.run('UPDATE games SET logo_style_id = NULL WHERE id = ?', gameId);
        }
        if (imageType === 'background' || imageType === 'both') {
            await db.run('UPDATE games SET bg_style_id = NULL WHERE id = ?', gameId);
        }
        return true;
    }

    /**
     * Assign a style image as room library default for a game.
     */
    static async assignImageToLibrary(gameRoomId: string, gameName: string, styleId: string, imageType: 'logo' | 'background' | 'both'): Promise<{ ok: boolean; error?: string }> {
        const db = await getDatabase();
        const style = await db.get('SELECT id, has_background, has_header FROM style_catalogue WHERE id = ?', styleId);
        if (!style) return { ok: false, error: 'Style not found' };

        if ((imageType === 'logo' || imageType === 'both') && !style.has_header) {
            return { ok: false, error: 'This style does not have a logo/header image' };
        }
        if ((imageType === 'background' || imageType === 'both') && !style.has_background) {
            return { ok: false, error: 'This style does not have a background image' };
        }

        if (imageType === 'logo' || imageType === 'both') {
            await db.run('UPDATE game_room_game_library SET logo_style_id = ? WHERE game_room_id = ? AND game_name = ?', styleId, gameRoomId, gameName);
        }
        if (imageType === 'background' || imageType === 'both') {
            await db.run('UPDATE game_room_game_library SET bg_style_id = ? WHERE game_room_id = ? AND game_name = ?', styleId, gameRoomId, gameName);
        }
        return { ok: true };
    }

    /**
     * Get total count of styles in the catalogue.
     */
    static async getCount(): Promise<number> {
        const db = await getDatabase();
        const row = await db.get<{ count: number }>('SELECT COUNT(*) as count FROM style_catalogue');
        return row?.count ?? 0;
    }
}
