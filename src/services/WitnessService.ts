import { randomBytes, createHash } from 'crypto';
import { getDatabase } from '../database/database.js';
import { logInfo, logWarn } from '../utils/logger.js';

/**
 * P8 — Arcaid Witness ingest.
 *
 * The Witness is an opt-in on-device app that reports the one fact neither the
 * AtGames API nor a phone submission can give: the moment a player LAUNCHED a
 * table (not just when they exited it). That closes the gear-up gap — play
 * before the window, exit inside it — which AtGames' exit-only timestamp
 * cannot see (confirmed on hardware: AtGames does not filter gear-up).
 *
 * ## The shape is dictated by the device, not chosen
 *
 * The AtGames External Applications SDK exposes a **synchronous GET only**
 * (`AtGames::httpGet`) — no POST. So every device call is a GET, the device
 * token rides in a query string, and the auth model is built around that
 * constraint rather than fighting it:
 *
 *   - The token is **device-scoped** (one cabinet, keyed on the stable
 *     `ATGAMES_UNIQUE_ID`), **long and random**, **revocable**, and **stored
 *     only as a SHA-256 hash** — the plaintext lives on the device. A token in
 *     a URL will be logged by proxies, so it must be worthless without also
 *     being the right device, and cheap to rotate.
 *   - Reports are **rate-limited by device id** (at the route) and **idempotent**
 *     (the UNIQUE index on (device, table, launch)), because a synchronous GET
 *     with no retry semantics will be retried.
 *
 * ## Blast radius, on purpose
 *
 * An observation is inert data — "table X launched at T on device D, owned by
 * user U." Nothing consumes it yet; the verify-join that matches it to AtGames
 * scores is a later phase. So even a stolen token only lets an attacker
 * pollute their OWN witness trail. This service deliberately does the smallest
 * correct thing and no scoring.
 */

/** Unambiguous when read off a cabinet screen — no 0/O/1/I/L (Throwdown charset). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PAIRING_CODE_LEN = 6;
const PAIRING_TTL_MS = 10 * 60 * 1000;

function makeCode(): string {
    const bytes = randomBytes(PAIRING_CODE_LEN);
    let out = '';
    for (let i = 0; i < PAIRING_CODE_LEN; i++) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
    return out;
}

/** SHA-256 hex. The device token is never stored in the clear. */
function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

export interface WitnessDevice {
    atgamesUniqueId: string;
    atgamesUsername: string | null;
    pairedAt: string;
    lastSeenAt: string | null;
}

export class WitnessPairError extends Error {
    readonly code: 'CODE_INVALID' | 'CODE_EXPIRED' | 'CODE_USED' | 'DEVICE_CONFLICT';
    constructor(code: WitnessPairError['code'], message: string) {
        super(message);
        this.name = 'WitnessPairError';
        this.code = code;
    }
}

export class WitnessService {
    /**
     * Mint a short-lived pairing code for a logged-in player. They type it into
     * the Witness app on the cabinet, which redeems it.
     *
     * A player may only have one live code at a time — minting a new one
     * expires any earlier unconsumed codes, so a screen full of stale codes
     * can't accumulate.
     */
    static async createPairingCode(canonicalUserId: string): Promise<{ code: string; expiresAt: string }> {
        const db = await getDatabase();
        await db.run(
            `UPDATE witness_pairing_codes SET expires_at = datetime('now')
              WHERE canonical_user_id = ? AND consumed_at IS NULL AND expires_at > datetime('now')`,
            canonicalUserId,
        );

        // Expiry is stored and compared in SQLite's own datetime format
        // throughout — a JS ISO string ('…Z') and `datetime('now')` (space,
        // no zone) do NOT string-compare, and `Date.parse` mishandles the
        // latter, so the JS side never touches the comparison.
        const ttlMinutes = Math.round(PAIRING_TTL_MS / 60000);
        for (let attempt = 0; attempt < 6; attempt++) {
            const code = makeCode();
            try {
                await db.run(
                    `INSERT INTO witness_pairing_codes (code, canonical_user_id, expires_at)
                     VALUES (?, ?, datetime('now', ?))`,
                    code, canonicalUserId, `+${ttlMinutes} minutes`,
                );
                const stored = await db.get<{ expires_at: string }>(
                    'SELECT expires_at FROM witness_pairing_codes WHERE code = ?', code,
                );
                logInfo(`Witness: pairing code minted for ${canonicalUserId}`);
                return { code, expiresAt: stored?.expires_at ?? '' };
            } catch {
                // PK clash — try another code.
            }
        }
        throw new Error('Witness: could not mint a unique pairing code');
    }

    /**
     * Redeem a pairing code from the device (GET). Binds the code's owner to
     * this `ATGAMES_UNIQUE_ID` and returns a fresh device token (plaintext,
     * once — only the hash is stored). Re-pairing the SAME device rotates its
     * token; pairing a device already owned by someone else is refused.
     */
    static async redeemPairingCode(
        rawCode: string, atgamesUniqueId: string, atgamesUsername: string | null,
    ): Promise<{ token: string }> {
        const code = (rawCode || '').trim().toUpperCase();
        const deviceId = (atgamesUniqueId || '').trim();
        if (!code || !deviceId) throw new WitnessPairError('CODE_INVALID', 'A pairing code and device id are required');

        const db = await getDatabase();
        const row = await db.get<{ canonical_user_id: string; consumed_at: string | null; is_expired: number }>(
            `SELECT canonical_user_id, consumed_at,
                    (expires_at <= datetime('now')) AS is_expired
             FROM witness_pairing_codes WHERE code = ?`,
            code,
        );
        if (!row) throw new WitnessPairError('CODE_INVALID', 'That pairing code is not valid');
        if (row.consumed_at) throw new WitnessPairError('CODE_USED', 'That pairing code has already been used');
        if (row.is_expired) throw new WitnessPairError('CODE_EXPIRED', 'That pairing code has expired');

        // A device belongs to one Arcaid account. Re-pairing to the SAME owner
        // is a token rotation (fine); a DIFFERENT owner is refused, or one
        // player could hijack another's cabinet trail.
        const existing = await db.get<{ canonical_user_id: string }>(
            `SELECT canonical_user_id FROM witness_devices WHERE atgames_unique_id = ? AND revoked_at IS NULL`,
            deviceId,
        );
        if (existing && existing.canonical_user_id !== row.canonical_user_id) {
            throw new WitnessPairError('DEVICE_CONFLICT', 'This cabinet is already linked to a different Arcaid account');
        }

        const token = randomBytes(32).toString('base64url');
        const tokenHash = hashToken(token);

        await db.exec('BEGIN');
        try {
            await db.run(
                `INSERT INTO witness_devices (atgames_unique_id, canonical_user_id, atgames_username, token_hash, revoked_at)
                 VALUES (?, ?, ?, ?, NULL)
                 ON CONFLICT(atgames_unique_id) DO UPDATE SET
                    canonical_user_id = excluded.canonical_user_id,
                    atgames_username = excluded.atgames_username,
                    token_hash = excluded.token_hash,
                    revoked_at = NULL`,
                deviceId, row.canonical_user_id, atgamesUsername || null, tokenHash,
            );
            await db.run(
                `UPDATE witness_pairing_codes SET consumed_at = datetime('now'), consumed_device_id = ? WHERE code = ?`,
                deviceId, code,
            );
            await db.exec('COMMIT');
        } catch (err) {
            await db.exec('ROLLBACK').catch(() => {});
            throw err;
        }

        logInfo(`Witness: device ${deviceId} paired to ${row.canonical_user_id}`);
        return { token };
    }

    /**
     * Record one witnessed table session from the device (GET). Returns false
     * when the device/token is unknown, revoked, or mismatched — the ROUTE
     * turns that into a 401 and the rate limiter caps abuse; this method never
     * reveals which of the two was wrong.
     *
     * Idempotent: a repeated (device, table, launch) is a no-op success, so the
     * device may safely retry a GET whose response it never saw.
     */
    static async recordObservation(input: {
        atgamesUniqueId: string;
        token: string;
        tableName: string;
        launchTs: number;
        exitTs?: number | null;
        durationSec?: number | null;
    }): Promise<boolean> {
        const deviceId = (input.atgamesUniqueId || '').trim();
        const table = (input.tableName || '').trim();
        if (!deviceId || !input.token || !table || !Number.isFinite(input.launchTs)) return false;

        const db = await getDatabase();
        const device = await db.get<{ canonical_user_id: string; token_hash: string; revoked_at: string | null }>(
            `SELECT canonical_user_id, token_hash, revoked_at FROM witness_devices WHERE atgames_unique_id = ?`,
            deviceId,
        );
        if (!device || device.revoked_at || device.token_hash !== hashToken(input.token)) return false;

        const launch = Math.floor(input.launchTs);
        const exit = input.exitTs != null && Number.isFinite(input.exitTs) ? Math.floor(input.exitTs) : null;
        const duration = input.durationSec != null && Number.isFinite(input.durationSec)
            ? Math.floor(input.durationSec)
            : (exit != null ? exit - launch : null);

        await db.run(
            `INSERT INTO witness_observations
                (atgames_unique_id, canonical_user_id, table_name, launch_ts, exit_ts, duration_sec)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(atgames_unique_id, table_name, launch_ts) DO UPDATE SET
                exit_ts = COALESCE(excluded.exit_ts, witness_observations.exit_ts),
                duration_sec = COALESCE(excluded.duration_sec, witness_observations.duration_sec)`,
            deviceId, device.canonical_user_id, table, launch, exit, duration,
        );
        await db.run(
            `UPDATE witness_devices SET last_seen_at = datetime('now') WHERE atgames_unique_id = ?`,
            deviceId,
        );
        return true;
    }

    /** The cabinets a player has paired (Account Settings). */
    static async listDevices(canonicalUserId: string): Promise<WitnessDevice[]> {
        const db = await getDatabase();
        const rows = await db.all<Array<{
            atgames_unique_id: string; atgames_username: string | null; paired_at: string; last_seen_at: string | null;
        }>>(
            `SELECT atgames_unique_id, atgames_username, paired_at, last_seen_at
             FROM witness_devices WHERE canonical_user_id = ? AND revoked_at IS NULL ORDER BY paired_at DESC`,
            canonicalUserId,
        );
        return rows.map(r => ({
            atgamesUniqueId: r.atgames_unique_id,
            atgamesUsername: r.atgames_username,
            pairedAt: r.paired_at,
            lastSeenAt: r.last_seen_at,
        }));
    }

    /**
     * Unpair a cabinet (soft delete — revoke, so its token stops working and a
     * later re-pair is clean). Self-only: only the owner may revoke, enforced
     * by the WHERE clause. Observations are kept; they are the player's own
     * history and harmless.
     */
    static async revokeDevice(canonicalUserId: string, atgamesUniqueId: string): Promise<boolean> {
        const db = await getDatabase();
        const res = await db.run(
            `UPDATE witness_devices SET revoked_at = datetime('now')
              WHERE atgames_unique_id = ? AND canonical_user_id = ? AND revoked_at IS NULL`,
            atgamesUniqueId, canonicalUserId,
        );
        const changed = (res.changes ?? 0) > 0;
        if (changed) logInfo(`Witness: device ${atgamesUniqueId} unpaired by ${canonicalUserId}`);
        return changed;
    }

    /** Best-effort sweep of expired, unconsumed codes. Cheap; call opportunistically. */
    static async pruneExpiredCodes(): Promise<void> {
        try {
            const db = await getDatabase();
            await db.run(
                `DELETE FROM witness_pairing_codes WHERE consumed_at IS NULL AND expires_at <= datetime('now', '-1 day')`,
            );
        } catch (err) {
            logWarn('Witness: pruneExpiredCodes failed', err);
        }
    }
}
