/**
 * Migration 226 (W131.2, ADR 0045) - who is playing on a shared Witness device.
 *
 * - `witness_play_sessions`: one row per "Playing as" choice, SERVER clock at
 *   both ends; at most one open session per device (partial unique index).
 * - `witness_devices.default_player`: who plays when no session is open
 *   (NULL = the account that paired the device).
 * - `witness_devices.clock_offset_at`: when the device last sent a valid
 *   `clock_offset`. A device that never has runs a build that cannot be
 *   shared yet (ruling 5): it takes no second player.
 * - `witness_evidence.attribution` / `play_session_id`: how each play's
 *   player was decided, for the plays list and for moving plays (W131.4).
 */
import type { Database } from 'sqlite';

export async function witnessPlaySessions(db: Database): Promise<void> {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS witness_play_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL,
            canonical_user_id TEXT NOT NULL,
            started_at TEXT NOT NULL DEFAULT (datetime('now')),
            ended_at TEXT,
            started_by TEXT,
            started_via TEXT NOT NULL DEFAULT 'web'
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_witness_play_sessions_open
            ON witness_play_sessions(device_id) WHERE ended_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_witness_play_sessions_device
            ON witness_play_sessions(device_id, started_at);
    `);
    const devices = (await db.all(`PRAGMA table_info(witness_devices)`)) as Array<{ name: string }>;
    if (!devices.some(c => c.name === 'default_player')) {
        await db.exec(`ALTER TABLE witness_devices ADD COLUMN default_player TEXT`);
    }
    if (!devices.some(c => c.name === 'clock_offset_at')) {
        await db.exec(`ALTER TABLE witness_devices ADD COLUMN clock_offset_at TEXT`);
    }
    const evidence = (await db.all(`PRAGMA table_info(witness_evidence)`)) as Array<{ name: string }>;
    if (!evidence.some(c => c.name === 'attribution')) {
        await db.exec(`ALTER TABLE witness_evidence ADD COLUMN attribution TEXT`);
    }
    if (!evidence.some(c => c.name === 'play_session_id')) {
        await db.exec(`ALTER TABLE witness_evidence ADD COLUMN play_session_id INTEGER`);
    }
}
