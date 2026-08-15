import { randomUUID } from 'crypto';
import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from './GameRoomSettingsService.js';

/**
 * Style-system revamp P2 — Style Profiles.
 *
 * A profile is a named snapshot of a room's APPEARANCE, owned by the admin who
 * saved it rather than by any one room, so a person who runs several rooms can
 * dress a new one in two clicks instead of re-deriving forty settings.
 *
 * Owner decisions (2026-08-13, settled): profiles are owner-keyed; kiosk keys
 * are included; `LOGO_URL` / `SCOREBOARD_BG_URL` / `SCOREBOARD_TITLE` are
 * excluded because they are room IDENTITY, not style — applying a profile must
 * never rename a room or hang another room's logo on it. The style/art
 * catalogue is already global, so image REFERENCES inside a profile resolve
 * anywhere.
 */

/**
 * The portable set. A key is in here iff it changes how a scoreboard LOOKS and
 * means the same thing in any room.
 *
 * Deliberately a hardcoded allowlist rather than "every SCOREBOARD_* key":
 * convention-based capture is how a policy or credential key eventually rides
 * along into a profile and gets copied somewhere it does not belong. Same
 * reasoning as `ENCRYPTED_SETTING_KEYS` in `utils/secrets.ts` — an allowlist
 * fails closed, a convention fails open. Adding a new appearance setting means
 * adding it here on purpose.
 */
export const PORTABLE_STYLE_KEYS = [
    // Look / card family
    'SCOREBOARD_STYLE',
    'SCOREBOARD_THEME',
    'SCOREBOARD_PODIUM_VARIANT',
    'SCOREBOARD_LAYOUT',
    'SCOREBOARD_MAX_SCORES',
    'SCOREBOARD_MIN_SCORES',
    'SCOREBOARD_CARD_SPACING',
    'SCOREBOARD_CARD_BG_FILL',
    'SCOREBOARD_CARD_OPACITY',
    'SCOREBOARD_ZOOM',
    // Title + logo PRESENTATION. The title TEXT and the logo IMAGE are
    // identity and are excluded; how they are drawn is style.
    'SCOREBOARD_TITLE_STYLE',
    'SCOREBOARD_TITLE_SIZE',
    'SCOREBOARD_TITLE_HIDDEN',
    'SCOREBOARD_LOGO_ENABLED',
    'LOGO_POSITION',
    'LOGO_MAX_HEIGHT',
    // Background PRESENTATION — again, not the image itself.
    'SCOREBOARD_BG_MODE',
    'SCOREBOARD_BG_OPACITY',
    // Game titles on cards
    'SCOREBOARD_GAME_TITLE_STYLE',
    'SCOREBOARD_TITLE_FONT_SIZE',
    // Rankings
    'SCOREBOARD_RANKINGS_POSITION',
    'SCOREBOARD_RANKINGS_STICKY',
    'SCOREBOARD_RANKINGS_STYLE',
    // QR
    'SCOREBOARD_QR_MODE',
    'SCOREBOARD_QR_SIZE',
    'SCOREBOARD_QR_POSITION',
    'SCOREBOARD_QR_OFFSET_PX',
    // Mobile
    'SCOREBOARD_MOBILE_VERTICAL',
    'SCOREBOARD_MOBILE_SCALE',
    // Display behaviour
    'SCOREBOARD_HIDE_EMPTY',
    'SCOREBOARD_SHOW_TIMER',
    // Kiosk (owner decision 3: in profiles)
    'KIOSK_ENABLED',
    'KIOSK_AUTO_SCROLL',
    'KIOSK_REFRESH_SECONDS',
    'KIOSK_ZOOM',
] as const;

/**
 * Room-identity keys that must never enter a profile. Not needed by the code
 * — the allowlist above already excludes them — but stated explicitly so the
 * intent survives someone later "helpfully" widening the capture, and asserted
 * by a test.
 */
export const NEVER_PORTABLE_KEYS = [
    'SCOREBOARD_TITLE',
    'LOGO_URL',
    'SCOREBOARD_BG_URL',
    'GAME_ROOM_NAME',
    'GAME_ROOM_SLUG',
] as const;

export interface StyleProfile {
    id: string;
    ownerUserId: string;
    name: string;
    settings: Record<string, string>;
    isDefault: boolean;
    createdAt: string;
    updatedAt: string;
}

interface StyleProfileRow {
    id: string;
    owner_user_id: string;
    name: string;
    settings: string;
    is_default: number;
    created_at: string;
    updated_at: string;
}

export class StyleProfileNameConflictError extends Error {
    constructor(name: string) {
        super(`A style profile named "${name}" already exists`);
        this.name = 'StyleProfileNameConflictError';
    }
}

function hydrate(row: StyleProfileRow): StyleProfile {
    let settings: Record<string, string> = {};
    try {
        const parsed = JSON.parse(row.settings);
        // A profile whose JSON is an array or a scalar is corrupt, not empty —
        // but a corrupt profile must not take the settings page down with it.
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            settings = parsed as Record<string, string>;
        }
    } catch {
        settings = {};
    }
    return {
        id: row.id,
        ownerUserId: row.owner_user_id,
        name: row.name,
        settings,
        isDefault: row.is_default === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export class StyleProfileService {
    /**
     * Snapshot a room's current appearance, keeping only portable keys that the
     * room has actually stored. Unset keys are OMITTED rather than captured at
     * their default: a profile records the choices someone made, so applying it
     * to another room leaves that room's unrelated defaults alone and the
     * profile keeps tracking the product default like every other room.
     */
    static async snapshotRoom(gameRoomId: string): Promise<Record<string, string>> {
        const all = await GameRoomSettingsService.getAll(gameRoomId);
        const snapshot: Record<string, string> = {};
        for (const key of PORTABLE_STYLE_KEYS) {
            const value = all[key];
            if (value !== undefined && value !== '') snapshot[key] = value;
        }
        return snapshot;
    }

    /** Strips anything not portable. Applied on every write path, so a profile
     *  can never carry a key the allowlist does not name — including one that
     *  arrived in a hand-crafted API request. */
    static sanitize(settings: Record<string, string>): Record<string, string> {
        const clean: Record<string, string> = {};
        for (const key of PORTABLE_STYLE_KEYS) {
            const value = settings[key];
            if (typeof value === 'string' && value !== '') clean[key] = value;
        }
        return clean;
    }

    static async listForOwner(ownerUserId: string): Promise<StyleProfile[]> {
        const db = await getDatabase();
        const rows = await db.all<StyleProfileRow[]>(
            `SELECT * FROM style_profiles WHERE owner_user_id = ? ORDER BY is_default DESC, LOWER(name) ASC`,
            ownerUserId,
        );
        return rows.map(hydrate);
    }

    static async getForOwner(ownerUserId: string, id: string): Promise<StyleProfile | null> {
        const db = await getDatabase();
        const row = await db.get<StyleProfileRow>(
            `SELECT * FROM style_profiles WHERE id = ? AND owner_user_id = ?`,
            id, ownerUserId,
        );
        return row ? hydrate(row) : null;
    }

    static async create(
        ownerUserId: string,
        name: string,
        settings: Record<string, string>,
    ): Promise<StyleProfile> {
        const db = await getDatabase();
        const trimmed = name.trim();
        const existing = await db.get(
            `SELECT id FROM style_profiles WHERE owner_user_id = ? AND LOWER(name) = LOWER(?)`,
            ownerUserId, trimmed,
        );
        if (existing) throw new StyleProfileNameConflictError(trimmed);

        const id = randomUUID();
        await db.run(
            `INSERT INTO style_profiles (id, owner_user_id, name, settings) VALUES (?, ?, ?, ?)`,
            id, ownerUserId, trimmed, JSON.stringify(this.sanitize(settings)),
        );
        const created = await this.getForOwner(ownerUserId, id);
        if (!created) throw new Error('style profile vanished immediately after insert');
        return created;
    }

    /** Overwrites a profile's captured settings (and optionally its name) —
     *  the "update this profile from the room I'm looking at" path. */
    static async update(
        ownerUserId: string,
        id: string,
        patch: { name?: string; settings?: Record<string, string> },
    ): Promise<StyleProfile | null> {
        const db = await getDatabase();
        const current = await this.getForOwner(ownerUserId, id);
        if (!current) return null;

        const nextName = patch.name?.trim() ?? current.name;
        if (nextName.toLowerCase() !== current.name.toLowerCase()) {
            const clash = await db.get(
                `SELECT id FROM style_profiles WHERE owner_user_id = ? AND LOWER(name) = LOWER(?) AND id != ?`,
                ownerUserId, nextName, id,
            );
            if (clash) throw new StyleProfileNameConflictError(nextName);
        }

        const nextSettings = patch.settings ? this.sanitize(patch.settings) : current.settings;
        await db.run(
            `UPDATE style_profiles SET name = ?, settings = ?, updated_at = datetime('now')
             WHERE id = ? AND owner_user_id = ?`,
            nextName, JSON.stringify(nextSettings), id, ownerUserId,
        );
        return this.getForOwner(ownerUserId, id);
    }

    static async delete(ownerUserId: string, id: string): Promise<boolean> {
        const db = await getDatabase();
        const result = await db.run(
            `DELETE FROM style_profiles WHERE id = ? AND owner_user_id = ?`,
            id, ownerUserId,
        );
        return (result.changes ?? 0) > 0;
    }

    /**
     * "Default for all my rooms" — at most one per owner, enforced by a partial
     * unique index. Cleared first so the index can never reject the set, and
     * both statements run in one transaction so a failure cannot leave the
     * owner with no default at all.
     */
    static async setDefault(ownerUserId: string, id: string | null): Promise<void> {
        const db = await getDatabase();
        await db.run('BEGIN');
        try {
            await db.run(
                `UPDATE style_profiles SET is_default = 0, updated_at = datetime('now')
                 WHERE owner_user_id = ? AND is_default = 1`,
                ownerUserId,
            );
            if (id) {
                await db.run(
                    `UPDATE style_profiles SET is_default = 1, updated_at = datetime('now')
                     WHERE id = ? AND owner_user_id = ?`,
                    id, ownerUserId,
                );
            }
            await db.run('COMMIT');
        } catch (err) {
            await db.run('ROLLBACK');
            throw err;
        }
    }

    static async getDefaultForOwner(ownerUserId: string): Promise<StyleProfile | null> {
        const db = await getDatabase();
        const row = await db.get<StyleProfileRow>(
            `SELECT * FROM style_profiles WHERE owner_user_id = ? AND is_default = 1`,
            ownerUserId,
        );
        return row ? hydrate(row) : null;
    }

    /**
     * Write a profile onto a room.
     *
     * Only the keys the profile carries are written. Keys it does not carry are
     * left exactly as the room had them — applying a profile is "make these
     * things look like this", not "reset the room". That is what keeps a
     * profile safe to apply to a room whose identity and policy settings you
     * do not want to think about.
     *
     * Returns the keys written, so the caller can audit precisely what changed.
     */
    static async applyToRoom(gameRoomId: string, profile: StyleProfile): Promise<string[]> {
        const toWrite = this.sanitize(profile.settings);
        const keys = Object.keys(toWrite);
        if (keys.length === 0) return [];
        await GameRoomSettingsService.saveMany(gameRoomId, toWrite);
        return keys;
    }
}
