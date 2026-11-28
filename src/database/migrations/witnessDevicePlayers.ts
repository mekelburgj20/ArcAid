/**
 * Migration 225 (W131.1, ADR 0045) - several players on one Witness device.
 *
 * `witness_device_players` holds who is on a device and with what role
 * (`owner` manages the device; `player` only plays on it), and each player's
 * OWN score routing: the four routing columns that lived on `witness_devices`
 * move here, because each player belongs to different rooms. One row per
 * (device, player); leaving or unpairing stamps `removed_at` and a rejoin
 * reactivates the same row, so `slot` (the short id a device build will send
 * as `player=`, W131.2) never changes for that person on that device.
 *
 * `witness_device_invites` holds the single-use invite links an owner makes.
 * The code is a secret in a link, so only its SHA-256 is stored (like device
 * tokens).
 *
 * Backfill: every device row gets an `owner` row for its pairing account,
 * carrying the device's routing as it stands; an unpaired device's row is
 * stamped removed at its `revoked_at`. The device's own routing columns are
 * left in place, unread (dropping them is a rebuild for no behaviour).
 */
import type { Database } from 'sqlite';

export async function witnessDevicePlayers(db: Database): Promise<void> {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS witness_device_players (
            device_id TEXT NOT NULL,
            canonical_user_id TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'player',
            slot TEXT NOT NULL,
            added_at TEXT NOT NULL DEFAULT (datetime('now')),
            added_by TEXT,
            removed_at TEXT,
            target_room_id TEXT,
            target_tournament_id TEXT,
            global_only INTEGER NOT NULL DEFAULT 0,
            global_fallback INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (device_id, canonical_user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_witness_device_players_user
            ON witness_device_players(canonical_user_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_witness_device_players_slot
            ON witness_device_players(device_id, slot);

        CREATE TABLE IF NOT EXISTS witness_device_invites (
            code_hash TEXT PRIMARY KEY,
            device_id TEXT NOT NULL,
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            expires_at TEXT NOT NULL,
            consumed_at TEXT,
            consumed_by TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_witness_device_invites_device
            ON witness_device_invites(device_id);
    `);

    await db.run(`
        INSERT OR IGNORE INTO witness_device_players
            (device_id, canonical_user_id, role, slot, added_at, removed_at,
             target_room_id, target_tournament_id, global_only, global_fallback)
        SELECT atgames_unique_id, canonical_user_id, 'owner', lower(hex(randomblob(4))), paired_at, revoked_at,
               target_room_id, target_tournament_id, COALESCE(global_only, 0), COALESCE(global_fallback, 1)
          FROM witness_devices
    `);
}
