/**
 * W131.2 (ADR 0045, docs/shared-device-plan.md §4-§5) - who is playing on a
 * shared Witness device, and whose each play is.
 *
 * A device with ONE person on it credits that person, exactly as before
 * (`only`). With several, every device report is credited by this order:
 *
 *  1. `player=<slot>` the device sent - the person it held at game start.
 *  2. The person whose game-START attempt (`attempt=<key>`) the server already
 *     credited: a score follows its own attempt.
 *  3. With `clock_offset` (device clock -> server clock, seconds): the
 *     session open at the game's start on the SERVER's clock.
 *  4. Otherwise the session open when the report arrived (`fallback`, shown
 *     as such on the plays list).
 *
 * With no session open the device's DEFAULT player plays. The corrected time
 * is used for attribution only: verdicts, check-in tiers and attempt windows
 * keep reading the device's raw times (ADR 0045 decision 3).
 *
 * The ONE place these rules live. Every device path calls `resolve` once and
 * threads the answer.
 */
import { getDatabase } from '../database/database.js';
import { logInfo, logWarn } from '../utils/logger.js';
import { ActivityLogService } from './ActivityLogService.js';

type Db = Awaited<ReturnType<typeof getDatabase>>;

export type AttributionKind = 'only' | 'device' | 'attempt' | 'session' | 'fallback';

export interface PlayAttribution {
    /** Canonical id of the player the play is credited to. */
    userId: string;
    kind: AttributionKind;
    /** The `witness_play_sessions` row that decided it, when one did. */
    sessionId: number | null;
}

/** A clock offset larger than this is not a clock, it is garbage (10 days). */
export const MAX_CLOCK_OFFSET_SEC = 10 * 24 * 3600;

/**
 * `clock_offset` off the wire: integer seconds to ADD to a device time to get
 * the server's. Malformed or absurd = null (never a 400, like every other
 * optional device field).
 */
export function parseClockOffset(raw: unknown): number | null {
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    const s = String(raw).trim();
    if (!/^-?\d{1,7}$/.test(s)) return null;
    const n = Number(s);
    return Math.abs(n) <= MAX_CLOCK_OFFSET_SEC ? n : null;
}

/** `player=<slot>` off the wire: 8 lowercase hex, else null. */
export function parsePlayerSlot(raw: unknown): string | null {
    return typeof raw === 'string' && /^[0-9a-f]{8}$/.test(raw.trim()) ? raw.trim() : null;
}

export class WitnessPlaySessionError extends Error {
    readonly code: 'NOT_FOUND' | 'NOT_ON_DEVICE' | 'NOT_OWNER';
    constructor(code: WitnessPlaySessionError['code'], message: string) {
        super(message);
        this.name = 'WitnessPlaySessionError';
        this.code = code;
    }
}

export interface PlayingAs {
    userId: string;
    label: string | null;
    /** True when nobody chose: the device's default player. */
    isDefault: boolean;
    since: string | null;
    via: 'web' | 'cabinet' | null;
}

interface ActivePlayer { canonical_user_id: string; slot: string; role: string }

export class WitnessPlaySessionService {
    private static async activePlayers(db: Db, deviceId: string): Promise<ActivePlayer[]> {
        return db.all<ActivePlayer[]>(
            `SELECT canonical_user_id, slot, role FROM witness_device_players
              WHERE device_id = ? AND removed_at IS NULL ORDER BY added_at ASC, rowid ASC`,
            deviceId,
        );
    }

    /**
     * Who plays when nobody chose: `default_player` while they are on the
     * device, else the account that paired it while it is, else the first
     * owner. A device with no player rows at all (never in production after
     * migration 225) is its pairing account's.
     */
    static async defaultPlayer(deviceId: string, db?: Db): Promise<string | null> {
        const conn = db ?? await getDatabase();
        const device = await conn.get<{ canonical_user_id: string; default_player: string | null }>(
            `SELECT canonical_user_id, default_player FROM witness_devices WHERE atgames_unique_id = ?`, deviceId,
        );
        if (!device) return null;
        const players = await WitnessPlaySessionService.activePlayers(conn, deviceId);
        if (players.length === 0) return device.canonical_user_id;
        const on = new Set(players.map(p => p.canonical_user_id));
        if (device.default_player && on.has(device.default_player)) return device.default_player;
        if (on.has(device.canonical_user_id)) return device.canonical_user_id;
        return (players.find(p => p.role === 'owner') ?? players[0]!).canonical_user_id;
    }

    /** The open session on a device, if anyone chose. */
    static async openSession(deviceId: string, db?: Db): Promise<{ id: number; userId: string; startedAt: string; via: string } | null> {
        const conn = db ?? await getDatabase();
        const row = await conn.get<{ id: number; canonical_user_id: string; started_at: string; started_via: string }>(
            `SELECT s.id, s.canonical_user_id, s.started_at, s.started_via
               FROM witness_play_sessions s
               JOIN witness_device_players p
                 ON p.device_id = s.device_id AND p.canonical_user_id = s.canonical_user_id AND p.removed_at IS NULL
              WHERE s.device_id = ? AND s.ended_at IS NULL`,
            deviceId,
        );
        return row ? { id: row.id, userId: row.canonical_user_id, startedAt: row.started_at, via: row.started_via } : null;
    }

    /** Whose play is this? See the class comment for the order. Never throws: on any failure, the default player. */
    static async resolve(deviceId: string, hints: {
        slot?: string | null;
        attemptKey?: string | null;
        /** Device-clock epoch seconds of the game (or table) START. */
        startedTs?: number | null;
        clockOffset?: number | null;
    } = {}): Promise<PlayAttribution | null> {
        const db = await getDatabase();
        try {
            const players = await WitnessPlaySessionService.activePlayers(db, deviceId);
            const fallbackUser = await WitnessPlaySessionService.defaultPlayer(deviceId, db);
            if (!fallbackUser) return null;
            if (players.length <= 1) {
                return { userId: players[0]?.canonical_user_id ?? fallbackUser, kind: 'only', sessionId: null };
            }
            const on = new Set(players.map(p => p.canonical_user_id));

            if (hints.slot) {
                const bySlot = players.find(p => p.slot === hints.slot);
                if (bySlot) return { userId: bySlot.canonical_user_id, kind: 'device', sessionId: null };
            }

            if (hints.attemptKey) {
                const attempt = await db.get<{ canonical_user_id: string }>(
                    `SELECT canonical_user_id FROM attempts WHERE device_id = ? AND attempt_key = ? ORDER BY id LIMIT 1`,
                    deviceId, hints.attemptKey,
                );
                if (attempt && on.has(attempt.canonical_user_id)) {
                    return { userId: attempt.canonical_user_id, kind: 'attempt', sessionId: null };
                }
            }

            if (hints.clockOffset != null && hints.startedTs != null && Number.isFinite(hints.startedTs)) {
                const at = Math.floor(hints.startedTs) + hints.clockOffset;
                const session = await db.get<{ id: number; canonical_user_id: string }>(
                    `SELECT id, canonical_user_id FROM witness_play_sessions
                      WHERE device_id = ?
                        AND CAST(strftime('%s', started_at) AS INTEGER) <= ?
                        AND (ended_at IS NULL OR CAST(strftime('%s', ended_at) AS INTEGER) > ?)
                      ORDER BY started_at DESC, id DESC LIMIT 1`,
                    deviceId, at, at,
                );
                if (session && on.has(session.canonical_user_id)) {
                    return { userId: session.canonical_user_id, kind: 'session', sessionId: session.id };
                }
                return { userId: fallbackUser, kind: 'session', sessionId: null };
            }

            const open = await WitnessPlaySessionService.openSession(deviceId, db);
            return open
                ? { userId: open.userId, kind: 'fallback', sessionId: open.id }
                : { userId: fallbackUser, kind: 'fallback', sessionId: null };
        } catch (err) {
            logWarn(`Witness: play attribution failed for ${deviceId}, crediting the default player (${err instanceof Error ? err.message : String(err)})`);
            const fallbackUser = await WitnessPlaySessionService.defaultPlayer(deviceId, db).catch(() => null);
            return fallbackUser ? { userId: fallbackUser, kind: 'fallback', sessionId: null } : null;
        }
    }

    /** Who is playing right now (for the device's screens and the web). */
    static async playingAs(deviceId: string): Promise<PlayingAs | null> {
        const db = await getDatabase();
        const open = await WitnessPlaySessionService.openSession(deviceId, db);
        const userId = open?.userId ?? await WitnessPlaySessionService.defaultPlayer(deviceId, db);
        if (!userId) return null;
        const { resolveUserLabels } = await import('./PlayerProfileResolver.js');
        const label = (await resolveUserLabels([userId]))[userId] ?? null;
        return {
            userId, label, isDefault: !open,
            since: open?.startedAt ?? null,
            via: open ? (open.via === 'cabinet' ? 'cabinet' : 'web') : null,
        };
    }

    /**
     * Switch who is playing. `actorId` null = the device itself (the tile's
     * picker, `via: 'cabinet'`). Anyone on the device may switch it to anyone
     * on it; choosing the person already playing changes nothing.
     */
    static async switchTo(input: {
        deviceId: string; targetUserId: string; actorId: string | null; via: 'web' | 'cabinet';
    }): Promise<PlayingAs> {
        const db = await getDatabase();
        const { WitnessDevicePlayersService } = await import('./WitnessDevicePlayersService.js');
        if (input.actorId && !(await WitnessDevicePlayersService.roleOn(input.deviceId, input.actorId, db))) {
            throw new WitnessPlaySessionError('NOT_FOUND', 'No such device on your account');
        }
        if (!(await WitnessDevicePlayersService.roleOn(input.deviceId, input.targetUserId, db))) {
            throw new WitnessPlaySessionError('NOT_ON_DEVICE', 'That person is not on this device');
        }
        const open = await WitnessPlaySessionService.openSession(input.deviceId, db);
        const current = open?.userId ?? await WitnessPlaySessionService.defaultPlayer(input.deviceId, db);
        if (!(open && open.userId === input.targetUserId)) {
            await db.exec('BEGIN');
            try {
                await db.run(
                    `UPDATE witness_play_sessions SET ended_at = datetime('now') WHERE device_id = ? AND ended_at IS NULL`,
                    input.deviceId,
                );
                await db.run(
                    `INSERT INTO witness_play_sessions (device_id, canonical_user_id, started_by, started_via)
                     VALUES (?, ?, ?, ?)`,
                    input.deviceId, input.targetUserId, input.actorId, input.via,
                );
                await db.exec('COMMIT');
            } catch (err) {
                await db.exec('ROLLBACK').catch(() => {});
                throw err;
            }
            if (current !== input.targetUserId) {
                logInfo(`Witness: device ${input.deviceId} now playing as ${input.targetUserId} (${input.via}${input.actorId ? `, by ${input.actorId}` : ''})`);
                void ActivityLogService.recordForDevice(input.deviceId, input.targetUserId, {
                    category: 'device', eventType: 'device_player_switched',
                    actorUserId: input.actorId,
                    summary: input.via === 'cabinet' ? 'Player switched on the cabinet' : 'Player switched on arcaid.app',
                });
            }
        }
        return (await WitnessPlaySessionService.playingAs(input.deviceId))!;
    }

    /** End the open session of someone leaving the device (their plays stop being theirs). */
    static async endSessionsOf(deviceId: string, userId: string, db?: Db): Promise<void> {
        const conn = db ?? await getDatabase();
        await conn.run(
            `UPDATE witness_play_sessions SET ended_at = datetime('now')
              WHERE device_id = ? AND canonical_user_id = ? AND ended_at IS NULL`,
            deviceId, userId,
        );
    }

    /** End every open session (the device was unpaired). */
    static async endAllSessions(deviceId: string): Promise<void> {
        const db = await getDatabase();
        await db.run(`UPDATE witness_play_sessions SET ended_at = datetime('now') WHERE device_id = ? AND ended_at IS NULL`, deviceId);
    }

    /** An owner sets who plays when nobody chose. */
    static async setDefaultPlayer(ownerId: string, deviceId: string, targetUserId: string): Promise<void> {
        const db = await getDatabase();
        const { WitnessDevicePlayersService } = await import('./WitnessDevicePlayersService.js');
        const role = await WitnessDevicePlayersService.roleOn(deviceId, ownerId, db);
        if (!role) throw new WitnessPlaySessionError('NOT_FOUND', 'No such device on your account');
        if (role !== 'owner') throw new WitnessPlaySessionError('NOT_OWNER', 'Only an owner of this device can choose who plays by default');
        if (!(await WitnessDevicePlayersService.roleOn(deviceId, targetUserId, db))) {
            throw new WitnessPlaySessionError('NOT_ON_DEVICE', 'That person is not on this device');
        }
        await db.run(`UPDATE witness_devices SET default_player = ? WHERE atgames_unique_id = ?`, targetUserId, deviceId);
    }

    /**
     * A device report carried a valid `clock_offset`: the device runs a build
     * that can be shared (ruling 5). Stamped at most once an hour.
     */
    static async noteClockOffset(deviceId: string, offset: number | null): Promise<void> {
        if (offset == null) return;
        try {
            const db = await getDatabase();
            await db.run(
                `UPDATE witness_devices SET clock_offset_at = datetime('now')
                  WHERE atgames_unique_id = ?
                    AND (clock_offset_at IS NULL OR clock_offset_at < datetime('now', '-1 hour'))`,
                deviceId,
            );
        } catch (err) {
            logWarn(`Witness: clock offset stamp failed for ${deviceId} (${err instanceof Error ? err.message : String(err)})`);
        }
    }

    /** Can this device take a second player? Only once its build has sent a clock offset (ruling 5). */
    static async householdReady(deviceId: string, db?: Db): Promise<boolean> {
        const conn = db ?? await getDatabase();
        const row = await conn.get<{ clock_offset_at: string | null }>(
            `SELECT clock_offset_at FROM witness_devices WHERE atgames_unique_id = ?`, deviceId,
        );
        return !!row?.clock_offset_at;
    }

    /** The person on the device holding this slot, or null. */
    static async userForSlot(deviceId: string, slot: string): Promise<string | null> {
        const db = await getDatabase();
        const row = await db.get<{ canonical_user_id: string }>(
            `SELECT canonical_user_id FROM witness_device_players WHERE device_id = ? AND slot = ? AND removed_at IS NULL`,
            deviceId, slot,
        );
        return row?.canonical_user_id ?? null;
    }

    /** The people a device may switch between, for the cabinet's picker (labels safe for its naive reader). */
    static async pickerFor(deviceId: string): Promise<Array<{ slot: string; label: string; playing: boolean }>> {
        const db = await getDatabase();
        const players = await WitnessPlaySessionService.activePlayers(db, deviceId);
        const now = await WitnessPlaySessionService.playingAs(deviceId);
        const { resolveUserLabels } = await import('./PlayerProfileResolver.js');
        const { cabinetAccountLabel } = await import('./WitnessService.js');
        const labels = await resolveUserLabels(players.map(p => p.canonical_user_id));
        return players.map((p, i) => ({
            slot: p.slot,
            label: cabinetAccountLabel(labels[p.canonical_user_id]) || `Player ${i + 1}`,
            playing: p.canonical_user_id === now?.userId,
        }));
    }
}
