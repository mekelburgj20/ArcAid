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
 * user U." The verify-join that matches it to AtGames scores lives in
 * `WitnessVerifyService`, and produces a BADGE, never a gate. So even a stolen
 * token only lets an attacker pollute their OWN witness trail. This service
 * deliberately does the smallest correct thing and no scoring.
 *
 * ## Two things the device reports (ADR 0021)
 *
 *   - **Observations** — a table session (`launch_ts`/`exit_ts`, device clock),
 *     tagged `via` = `live` (the resident beacon saw it) or `retro` (derived
 *     from on-disk traces afterwards).
 *   - **Check-ins** — "the Witness app is open right now", stamped with the
 *     SERVER's clock. On a cabinet that runs one thing at a time, that is proof
 *     no table was mid-session at that instant.
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
    /** Score routing (P9b) — a null room means UNDESIGNATED. */
    targetRoomId: string | null;
    targetRoomName: string | null;
    targetTournamentId: string | null;
    targetTournamentName: string | null;
    globalFallback: boolean;
}

export class WitnessTargetError extends Error {
    readonly code: 'NOT_FOUND' | 'NOT_A_MEMBER' | 'TOURNAMENT_NOT_IN_ROOM';
    constructor(code: WitnessTargetError['code'], message: string) {
        super(message);
        this.code = code;
        this.name = 'WitnessTargetError';
    }
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
        /**
         * `'retro'` = derived after the fact from on-disk traces rather than
         * seen live by the resident beacon. ANY other value (including absent)
         * is `'live'` — a tag this permissive must fail closed to the stronger
         * claim being the DEFAULT, never to a caller's typo silently marking a
         * live report as retro. Same trust either way (ADR 0021); the column
         * exists so the distinction survives for later analysis.
         */
        via?: string | null;
    }): Promise<boolean> {
        const deviceId = (input.atgamesUniqueId || '').trim();
        const table = (input.tableName || '').trim();
        if (!deviceId || !input.token || !table || !Number.isFinite(input.launchTs)) return false;

        const device = await WitnessService.authenticateDevice(deviceId, input.token);
        if (!device) return false;

        const db = await getDatabase();
        const launch = Math.floor(input.launchTs);
        const exit = input.exitTs != null && Number.isFinite(input.exitTs) ? Math.floor(input.exitTs) : null;
        const duration = input.durationSec != null && Number.isFinite(input.durationSec)
            ? Math.floor(input.durationSec)
            : (exit != null ? exit - launch : null);
        const via = input.via === 'retro' ? 'retro' : 'live';

        await db.run(
            `INSERT INTO witness_observations
                (atgames_unique_id, canonical_user_id, table_name, launch_ts, exit_ts, duration_sec, via)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(atgames_unique_id, table_name, launch_ts) DO UPDATE SET
                exit_ts = COALESCE(excluded.exit_ts, witness_observations.exit_ts),
                duration_sec = COALESCE(excluded.duration_sec, witness_observations.duration_sec)`,
            // `via` is deliberately absent from the DO UPDATE: first writer
            // wins. A retro sweep that re-reports a session the beacon already
            // saw live must not downgrade it, and a live report arriving after
            // a retro row must not overstate what was actually observed.
            deviceId, device.canonical_user_id, table, launch, exit, duration, via,
        );
        await WitnessService.touchDevice(deviceId);
        return true;
    }

    /**
     * Record one round-start CHECK-IN from the device (GET) — tier 2 of the
     * three-tier trust model (ADR 0021).
     *
     * These cabinets run one thing at a time: the Witness app being in the
     * FOREGROUND at time T proves no table was mid-session at T. So a score
     * exited after a check-in that happened at/after the round opened was
     * necessarily launched inside the window, even when the beacon produced no
     * session observation to join.
     *
     * The timestamp is the SERVER's and only ever the server's — that is the
     * entire point. A device-supplied time would make the attestation a
     * self-report, and tier 2 would prove nothing.
     *
     * Returns false for unknown / revoked / wrong-token, exactly like
     * `recordObservation`, so the ROUTE can answer with one undifferentiated
     * 401. Repeated check-ins are expected and are NOT deduped: each one is
     * another attestation point, and more of them can only ever help.
     */
    static async recordCheckin(atgamesUniqueId: string, token: string): Promise<{ ts: string } | null> {
        const deviceId = (atgamesUniqueId || '').trim();
        if (!deviceId || !token) return null;

        const device = await WitnessService.authenticateDevice(deviceId, token);
        if (!device) return null;

        const db = await getDatabase();
        const res = await db.run(
            `INSERT INTO witness_checkins (atgames_unique_id, canonical_user_id, server_ts)
             VALUES (?, ?, datetime('now'))`,
            deviceId, device.canonical_user_id,
        ) as { lastID?: number };
        await WitnessService.touchDevice(deviceId);

        const stored = await db.get<{ server_ts: string }>(
            'SELECT server_ts FROM witness_checkins WHERE id = ?', res.lastID,
        );
        return { ts: stored?.server_ts ?? '' };
    }

    /**
     * Record one VPXS score the Witness read off the cabinet's own stick (P9).
     *
     * Same device-token auth and same undifferentiated failure as the other two
     * device-facing writers, for the same reason. What differs is that this one
     * can succeed at AUTHENTICATION and still decline to record: a score whose
     * table matches no open game of this player is a perfectly normal event
     * (they played something that is not in a tournament), and the device must
     * be told "accepted, not matched" rather than "unauthorised", or it would
     * retry forever against a wall.
     *
     * Returns `null` ONLY for an auth failure, so the route can keep answering
     * a bare 401 for that and 200 for everything else.
     */
    static async recordVpxScore(input: {
        atgamesUniqueId: string;
        token: string;
        tableName: string;
        rom?: string | null;
        slug?: string | null;
        score: number;
        startedTs: number;
        endedTs: number;
        durationSec?: number | null;
        reason?: string | null;
        via?: string | null;
    }): Promise<import('./VpxScoreIngestService.js').VpxIngestResult | null> {
        const deviceId = (input.atgamesUniqueId || '').trim();
        if (!deviceId || !input.token) return null;

        const device = await WitnessService.authenticateDevice(deviceId, input.token);
        if (!device) return null;

        const { VpxScoreIngestService } = await import('./VpxScoreIngestService.js');
        const target = await WitnessService.getDeviceTarget(deviceId);
        const result = await VpxScoreIngestService.ingest({
            canonicalUserId: device.canonical_user_id,
            target,
            tableName: (input.tableName || '').trim(),
            rom: input.rom ?? null,
            slug: input.slug ?? null,
            score: input.score,
            startedTs: input.startedTs,
            endedTs: input.endedTs,
            durationSec: input.durationSec ?? null,
            reason: input.reason ?? null,
        });

        // A matched VPX score also files its own OBSERVATION, and that is the
        // whole reason the verify layer needs no VPX-specific rule:
        //
        // The launcher's record carries the GAME's start and end, which is
        // finer-grained than the table SESSION the resident detector sees — one
        // VPX session routinely contains several games. Verifying a VPX score
        // against the session's launch time would flag every second and third
        // game of a legitimate sitting, because the session began before the
        // round did. Filing the game itself as an observation makes the
        // existing tier-1 join answer the right question: the exit matches the
        // score's timestamp exactly, and the launch it compares against the
        // round start is the GAME's launch.
        if (result.status === 'ingested' || result.status === 'duplicate') {
            await WitnessService.recordObservation({
                atgamesUniqueId: deviceId,
                token: input.token,
                tableName: (input.tableName || '').trim(),
                launchTs: Math.floor(input.startedTs),
                exitTs: Math.floor(input.endedTs),
                durationSec: input.durationSec ?? null,
                via: input.via ?? null,
            });
        }

        await WitnessService.touchDevice(deviceId);
        return result;
    }

    /**
     * The ONE device-token check. Both device-facing writers go through it so
     * they cannot drift on what "authenticated" means, and so neither can ever
     * reveal WHICH of device/token/revocation was wrong.
     */
    private static async authenticateDevice(
        deviceId: string, token: string,
    ): Promise<{ canonical_user_id: string } | null> {
        const db = await getDatabase();
        const device = await db.get<{ canonical_user_id: string; token_hash: string; revoked_at: string | null }>(
            `SELECT canonical_user_id, token_hash, revoked_at FROM witness_devices WHERE atgames_unique_id = ?`,
            deviceId,
        );
        if (!device || device.revoked_at || device.token_hash !== hashToken(token)) return null;
        return { canonical_user_id: device.canonical_user_id };
    }

    private static async touchDevice(deviceId: string): Promise<void> {
        const db = await getDatabase();
        await db.run(
            `UPDATE witness_devices SET last_seen_at = datetime('now') WHERE atgames_unique_id = ?`,
            deviceId,
        );
    }

    /**
     * Point a cabinet at a room (and optionally one tournament in it), or clear
     * the designation by passing nulls.
     *
     * The validation is the whole value of this method: a designation the
     * player could not legitimately score into would send their scores
     * somewhere they cannot see, which is worse than having no designation at
     * all. So the room must be one they belong to, and the tournament must
     * belong to that room.
     */
    static async setDeviceTarget(canonicalUserId: string, deviceId: string, target: {
        roomId?: string | null;
        tournamentId?: string | null;
        globalFallback?: boolean;
    }): Promise<WitnessDevice> {
        const db = await getDatabase();
        const device = await db.get<{ atgames_unique_id: string }>(
            `SELECT atgames_unique_id FROM witness_devices
              WHERE atgames_unique_id = ? AND canonical_user_id = ? AND revoked_at IS NULL`,
            deviceId, canonicalUserId,
        );
        if (!device) throw new WitnessTargetError('NOT_FOUND', 'No such cabinet paired to your account');

        const roomId = target.roomId ?? null;
        // Clearing the room clears the tournament with it: a tournament
        // designation without its room is a dangling pointer that would outlive
        // the choice the player actually made.
        const tournamentId = roomId ? (target.tournamentId ?? null) : null;

        if (roomId) {
            const member = await db.get<{ user_id: string }>(
                `SELECT user_id FROM room_members WHERE room_id = ? AND user_id = ?`,
                roomId, canonicalUserId,
            );
            if (!member) {
                throw new WitnessTargetError('NOT_A_MEMBER', 'You are not a member of that room');
            }
        }
        if (tournamentId) {
            const tournament = await db.get<{ id: string }>(
                `SELECT id FROM tournaments WHERE id = ? AND game_room_id = ?`,
                tournamentId, roomId,
            );
            if (!tournament) {
                throw new WitnessTargetError('TOURNAMENT_NOT_IN_ROOM', 'That tournament is not in that room');
            }
        }

        await db.run(
            `UPDATE witness_devices
                SET target_room_id = ?, target_tournament_id = ?, global_fallback = ?
              WHERE atgames_unique_id = ? AND canonical_user_id = ?`,
            roomId, tournamentId,
            target.globalFallback === false ? 0 : 1,
            deviceId, canonicalUserId,
        );

        const devices = await WitnessService.listDevices(canonicalUserId);
        return devices.find(d => d.atgamesUniqueId === deviceId)!;
    }

    /**
     * The routing a score from this cabinet should follow.
     *
     * A designated tournament that has FINISHED is treated as absent rather
     * than cleared: a stale pointer must not quietly swallow scores weeks after
     * the event, and read-time expiry needs no cleanup job to stay correct.
     */
    static async getDeviceTarget(deviceId: string): Promise<{
        roomId: string | null; tournamentId: string | null; globalFallback: boolean;
    }> {
        const db = await getDatabase();
        const row = await db.get<{
            target_room_id: string | null; target_tournament_id: string | null;
            global_fallback: number; tournament_active: number | null;
        }>(
            `SELECT d.target_room_id, d.target_tournament_id, d.global_fallback,
                    t.is_active AS tournament_active
               FROM witness_devices d
               LEFT JOIN tournaments t ON t.id = d.target_tournament_id
              WHERE d.atgames_unique_id = ?`,
            deviceId,
        );
        if (!row) return { roomId: null, tournamentId: null, globalFallback: true };
        const tournamentId = row.target_tournament_id && row.tournament_active === 0
            ? null
            : row.target_tournament_id;
        return {
            roomId: row.target_room_id,
            tournamentId,
            globalFallback: row.global_fallback !== 0,
        };
    }

    /**
     * One short human line naming where this cabinet's scores go, for the app
     * to print on its status screen.
     *
     * This is the whole defence against a stale designation: a player who
     * pointed the cabinet at last Tuesday's event and forgot sees it at the
     * moment they open the Witness to check in, rather than discovering it when
     * their scores are missing from tonight's board.
     */
    static async describeTarget(deviceId: string): Promise<string> {
        const target = await WitnessService.getDeviceTarget(deviceId);
        if (!target.roomId) return 'Global Scoreboard';

        const db = await getDatabase();
        const room = await db.get<{ name: string }>(
            'SELECT name FROM game_rooms WHERE id = ?', target.roomId,
        );
        const roomName = room?.name ?? 'your room';
        if (!target.tournamentId) return roomName;

        const tournament = await db.get<{ name: string }>(
            'SELECT name FROM tournaments WHERE id = ?', target.tournamentId,
        );
        return tournament?.name ? `${roomName} / ${tournament.name}` : roomName;
    }

    /** The cabinets a player has paired (Account Settings). */
    static async listDevices(canonicalUserId: string): Promise<WitnessDevice[]> {
        const db = await getDatabase();
        const rows = await db.all<Array<{
            atgames_unique_id: string; atgames_username: string | null; paired_at: string;
            last_seen_at: string | null; target_room_id: string | null; room_name: string | null;
            target_tournament_id: string | null; tournament_name: string | null; global_fallback: number;
        }>>(
            `SELECT d.atgames_unique_id, d.atgames_username, d.paired_at, d.last_seen_at,
                    d.target_room_id, r.name AS room_name,
                    d.target_tournament_id, t.name AS tournament_name,
                    d.global_fallback
               FROM witness_devices d
               LEFT JOIN game_rooms r ON r.id = d.target_room_id
               LEFT JOIN tournaments t ON t.id = d.target_tournament_id
              WHERE d.canonical_user_id = ? AND d.revoked_at IS NULL
              ORDER BY d.paired_at DESC`,
            canonicalUserId,
        );
        return rows.map(r => ({
            atgamesUniqueId: r.atgames_unique_id,
            atgamesUsername: r.atgames_username,
            pairedAt: r.paired_at,
            lastSeenAt: r.last_seen_at,
            targetRoomId: r.target_room_id,
            targetRoomName: r.room_name,
            targetTournamentId: r.target_tournament_id,
            targetTournamentName: r.tournament_name,
            globalFallback: r.global_fallback !== 0,
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
