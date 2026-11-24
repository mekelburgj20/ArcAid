import type { Database } from 'sqlite';

/**
 * Migration 221 (G29, v2.264.0): the viewer's carpet floor choice,
 * `user_preferences.ui_floor`. `'on'` or `'off'` once the viewer flips the
 * switch; NULL (every existing row) means "no choice", so the room's
 * `UI_FLOOR` setting applies, and without one the floor shows. A dedicated
 * nullable column beside `ui_theme` and `appearance`, for the same reason
 * those are columns: it is read on every page load.
 *
 * Idempotent: the column is added only when it is missing.
 */
export async function addUserFloorPreference(db: Database): Promise<void> {
    const columns = (await db.all(`PRAGMA table_info(user_preferences)`)) as Array<{ name: string }>;
    if (columns.some(c => c.name === 'ui_floor')) return;
    await db.exec(`ALTER TABLE user_preferences ADD COLUMN ui_floor TEXT`);
}
