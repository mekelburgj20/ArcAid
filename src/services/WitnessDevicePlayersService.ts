/**
 * W131.1 (ADR 0045, docs/shared-device-plan.md §3) - several players on one
 * Witness device.
 *
 * A device has OWNERS and PLAYERS (`witness_device_players`, migration 225):
 *
 * - An owner manages the DEVICE: unpair, the update switches, the log pull,
 *   adding and removing players. Owning a device gives no power over anyone's
 *   scores. Co-owners have equal rights: any owner promotes a player to owner;
 *   an owner cannot remove another owner, only step down; the last owner
 *   cannot step down or leave (they unpair instead).
 * - A player only plays on it. Each player has their own score routing on
 *   their row (`WitnessService.getDeviceTarget`).
 *
 * W131.2: each play is credited to whoever was playing
 * (`WitnessPlaySessionService`), so the account that paired the device may
 * leave it like anyone else; it keeps meaning "who paired" for the pairing
 * caps only. A device takes a second person only once its build sends a
 * clock offset (ADR 0045 ruling 5, `householdReady`).
 *
 * The ONE place the role rules live: WitnessService's owner-only actions
 * (unpair, update switches, re-pairing a live device) ask `isOwner`.
 */
import { randomBytes, createHash } from 'crypto';
import { getDatabase } from '../database/database.js';
import { logInfo, logWarn } from '../utils/logger.js';
import { ActivityLogService } from './ActivityLogService.js';

type Db = Awaited<ReturnType<typeof getDatabase>>;

export type DevicePlayerRole = 'owner' | 'player';

/** Most people on one device at once (owners included). */
export const MAX_PLAYERS_PER_DEVICE = 6;
/** How long an invite link stays usable. */
export const DEVICE_INVITE_TTL_DAYS = 7;
/** Most unused, unexpired invite links one device may have at a time. */
export const MAX_OPEN_INVITES_PER_DEVICE = 10;

export class WitnessPlayerError extends Error {
    readonly code:
        | 'NOT_FOUND' | 'NOT_OWNER' | 'DEVICE_FULL' | 'INVITE_INVALID' | 'ALREADY_ON_DEVICE'
        | 'LAST_OWNER' | 'NOT_ALLOWED' | 'TOO_MANY_INVITES' | 'DEVICE_NOT_READY';
    constructor(code: WitnessPlayerError['code'], message: string) {
        super(message);
        this.name = 'WitnessPlayerError';
        this.code = code;
    }
}

export interface DevicePlayer {
    userId: string;
    /** Resolved at read (`resolveUserLabels`), never a raw id on screen. */
    label: string | null;
    role: DevicePlayerRole;
    addedAt: string;
    /** The account that paired the device. */
    pairedDevice: boolean;
    isYou: boolean;
}

export interface DeviceInvitePreview {
    deviceType: 'atgames' | 'desktop';
    deviceModelName: string | null;
    deviceTail: string;
    invitedBy: string | null;
    expiresAt: string;
    alreadyOnDevice: boolean;
}

function hashCode(code: string): string {
    return createHash('sha256').update(code).digest('hex');
}

function newSlot(): string {
    return randomBytes(4).toString('hex');
}

interface PlayerRow {
    device_id: string;
    canonical_user_id: string;
    role: string;
    removed_at: string | null;
}

export class WitnessDevicePlayersService {
    /** The caller's role on a LIVE (paired) device, or null when they are not on it. */
    static async roleOn(deviceId: string, userId: string, db?: Db): Promise<DevicePlayerRole | null> {
        const conn = db ?? await getDatabase();
        const row = await conn.get<{ role: string }>(
            `SELECT p.role FROM witness_device_players p
               JOIN witness_devices d ON d.atgames_unique_id = p.device_id AND d.revoked_at IS NULL
              WHERE p.device_id = ? AND p.canonical_user_id = ? AND p.removed_at IS NULL`,
            deviceId, userId,
        );
        if (!row) return null;
        return row.role === 'owner' ? 'owner' : 'player';
    }

    static async isOwner(deviceId: string, userId: string, db?: Db): Promise<boolean> {
        return (await WitnessDevicePlayersService.roleOn(deviceId, userId, db)) === 'owner';
    }

    /**
     * Put a person on a device (insert, or reactivate their earlier row with
     * its slot and their own routing kept). An active row is left as it is.
     * Runs on the caller's connection so it can join their transaction.
     */
    static async ensurePlayerRow(db: Db, input: {
        deviceId: string; userId: string; role: DevicePlayerRole; addedBy: string | null;
    }): Promise<void> {
        const existing = await db.get<PlayerRow>(
            `SELECT device_id, canonical_user_id, role, removed_at FROM witness_device_players
              WHERE device_id = ? AND canonical_user_id = ?`,
            input.deviceId, input.userId,
        );
        if (existing && existing.removed_at === null) return;
        if (existing) {
            await db.run(
                `UPDATE witness_device_players
                    SET removed_at = NULL, role = ?, added_at = datetime('now'), added_by = ?
                  WHERE device_id = ? AND canonical_user_id = ?`,
                input.role, input.addedBy, input.deviceId, input.userId,
            );
            return;
        }
        // The slot is unique per device; a collision on 32 random bits is
        // near impossible, but retry rather than fail a pairing over it.
        for (let i = 0; ; i++) {
            try {
                await db.run(
                    `INSERT INTO witness_device_players (device_id, canonical_user_id, role, slot, added_by)
                     VALUES (?, ?, ?, ?, ?)`,
                    input.deviceId, input.userId, input.role, newSlot(), input.addedBy,
                );
                return;
            } catch (err) {
                if (i >= 2 || !/UNIQUE/i.test(err instanceof Error ? err.message : String(err))) throw err;
            }
        }
    }

    /**
     * Called by `WitnessService.writePairedDevice` inside its transaction.
     * A live device re-paired by one of its owners is a token rotation and
     * changes nothing here. A new or unpaired device starts over: anyone still
     * marked on it is taken off, and the pairing account is its owner.
     */
    static async onPaired(db: Db, input: { deviceId: string; pairerId: string; wasLive: boolean }): Promise<void> {
        if (!input.wasLive) {
            await db.run(
                `UPDATE witness_device_players SET removed_at = datetime('now')
                  WHERE device_id = ? AND removed_at IS NULL AND canonical_user_id <> ?`,
                input.deviceId, input.pairerId,
            );
            await db.run(
                `UPDATE witness_device_players SET role = 'owner'
                  WHERE device_id = ? AND canonical_user_id = ? AND removed_at IS NULL`,
                input.deviceId, input.pairerId,
            );
        }
        await WitnessDevicePlayersService.ensurePlayerRow(db, {
            deviceId: input.deviceId, userId: input.pairerId, role: 'owner', addedBy: input.pairerId,
        });
    }

    /** Called by `WitnessService.revokeDevice`: unpairing ends every place on the device and every invite. */
    static async onUnpaired(deviceId: string): Promise<void> {
        const db = await getDatabase();
        await db.run(
            `UPDATE witness_device_players SET removed_at = datetime('now')
              WHERE device_id = ? AND removed_at IS NULL`,
            deviceId,
        );
        await db.run(`DELETE FROM witness_device_invites WHERE device_id = ? AND consumed_at IS NULL`, deviceId);
        await db.run(`UPDATE witness_devices SET default_player = NULL WHERE atgames_unique_id = ?`, deviceId);
        const { WitnessPlaySessionService } = await import('./WitnessPlaySessionService.js');
        await WitnessPlaySessionService.endAllSessions(deviceId);
    }

    /** The people on a device, for anyone on it. Null when the caller is not on it. */
    static async listPlayers(viewerId: string, deviceId: string): Promise<DevicePlayer[] | null> {
        const db = await getDatabase();
        if (!(await WitnessDevicePlayersService.roleOn(deviceId, viewerId, db))) return null;
        const rows = await db.all<Array<{ canonical_user_id: string; role: string; added_at: string; pairer: string }>>(
            `SELECT p.canonical_user_id, p.role, p.added_at, d.canonical_user_id AS pairer
               FROM witness_device_players p
               JOIN witness_devices d ON d.atgames_unique_id = p.device_id
              WHERE p.device_id = ? AND p.removed_at IS NULL
              ORDER BY p.role = 'owner' DESC, p.added_at ASC`,
            deviceId,
        );
        const { resolveUserLabels } = await import('./PlayerProfileResolver.js');
        const labels = await resolveUserLabels(rows.map(r => r.canonical_user_id));
        return rows.map(r => ({
            userId: r.canonical_user_id,
            label: labels[r.canonical_user_id] ?? null,
            role: r.role === 'owner' ? 'owner' : 'player',
            addedAt: r.added_at,
            pairedDevice: r.canonical_user_id === r.pairer,
            isYou: r.canonical_user_id === viewerId,
        }));
    }

    /** An owner makes a single-use invite link. The code is returned once; only its hash is stored. */
    static async createInvite(ownerId: string, deviceId: string): Promise<{ code: string; expiresAt: string }> {
        const db = await getDatabase();
        const role = await WitnessDevicePlayersService.roleOn(deviceId, ownerId, db);
        if (!role) throw new WitnessPlayerError('NOT_FOUND', 'No such device on your account');
        if (role !== 'owner') throw new WitnessPlayerError('NOT_OWNER', 'Only an owner of this device can add players');
        await WitnessDevicePlayersService.assertReady(db, deviceId);
        await WitnessDevicePlayersService.assertRoom(db, deviceId);
        await db.run(
            `DELETE FROM witness_device_invites WHERE device_id = ? AND consumed_at IS NULL AND expires_at <= datetime('now')`,
            deviceId,
        );
        const open = await db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM witness_device_invites WHERE device_id = ? AND consumed_at IS NULL`,
            deviceId,
        );
        if ((open?.n ?? 0) >= MAX_OPEN_INVITES_PER_DEVICE) {
            throw new WitnessPlayerError(
                'TOO_MANY_INVITES',
                `This device already has ${MAX_OPEN_INVITES_PER_DEVICE} unused invite links. Wait for one to be used or to expire.`,
            );
        }
        const code = randomBytes(16).toString('base64url');
        await db.run(
            `INSERT INTO witness_device_invites (code_hash, device_id, created_by, expires_at)
             VALUES (?, ?, ?, datetime('now', ?))`,
            hashCode(code), deviceId, ownerId, `+${DEVICE_INVITE_TTL_DAYS} days`,
        );
        const row = await db.get<{ expires_at: string }>(
            `SELECT expires_at FROM witness_device_invites WHERE code_hash = ?`, hashCode(code),
        );
        logInfo(`Witness: invite made for device ${deviceId} by ${ownerId}`);
        return { code, expiresAt: row?.expires_at ?? '' };
    }

    /** What an invite is for, before accepting. Null for an unknown, used or expired code. */
    static async previewInvite(userId: string, rawCode: string): Promise<DeviceInvitePreview | null> {
        const db = await getDatabase();
        const invite = await WitnessDevicePlayersService.liveInvite(db, rawCode);
        if (!invite) return null;
        const device = await db.get<{ device_type: string | null; device_model_name: string | null }>(
            `SELECT device_type, device_model_name FROM witness_devices WHERE atgames_unique_id = ?`,
            invite.device_id,
        );
        const { resolveUserLabels } = await import('./PlayerProfileResolver.js');
        const labels = await resolveUserLabels([invite.created_by]);
        return {
            deviceType: device?.device_type === 'desktop' ? 'desktop' : 'atgames',
            deviceModelName: device?.device_model_name ?? null,
            deviceTail: invite.device_id.slice(-4),
            invitedBy: labels[invite.created_by] ?? null,
            expiresAt: invite.expires_at,
            alreadyOnDevice: (await WitnessDevicePlayersService.roleOn(invite.device_id, userId, db)) !== null,
        };
    }

    /** Accept an invite: the caller joins the device as a player. Single use. */
    static async acceptInvite(userId: string, rawCode: string): Promise<{ deviceId: string }> {
        const db = await getDatabase();
        const invite = await WitnessDevicePlayersService.liveInvite(db, rawCode);
        if (!invite) throw new WitnessPlayerError('INVITE_INVALID', 'This invite link is not valid any more. Ask for a new one.');
        if (await WitnessDevicePlayersService.roleOn(invite.device_id, userId, db)) {
            throw new WitnessPlayerError('ALREADY_ON_DEVICE', 'You are already on this device');
        }
        await WitnessDevicePlayersService.assertReady(db, invite.device_id);
        await WitnessDevicePlayersService.assertRoom(db, invite.device_id);

        await db.exec('BEGIN');
        try {
            const used = await db.run(
                `UPDATE witness_device_invites SET consumed_at = datetime('now'), consumed_by = ?
                  WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > datetime('now')`,
                userId, invite.code_hash,
            );
            if ((used.changes ?? 0) !== 1) {
                throw new WitnessPlayerError('INVITE_INVALID', 'This invite link is not valid any more. Ask for a new one.');
            }
            await WitnessDevicePlayersService.ensurePlayerRow(db, {
                deviceId: invite.device_id, userId, role: 'player', addedBy: invite.created_by,
            });
            await db.exec('COMMIT');
        } catch (err) {
            await db.exec('ROLLBACK').catch(() => {});
            throw err;
        }

        logInfo(`Witness: ${userId} joined device ${invite.device_id} (invited by ${invite.created_by})`);
        void WitnessDevicePlayersService.recordActivity(invite.device_id, {
            eventType: 'device_player_added', userId, actorUserId: invite.created_by,
            summary: 'Player added to a Witness device',
        });
        return { deviceId: invite.device_id };
    }

    /**
     * Take someone off a device. A person may always leave; an owner may
     * remove a PLAYER (never another owner). The last owner cannot leave.
     * Leaving ends that person's open session and their default-player spot,
     * so nothing more is credited to someone no longer on the device.
     */
    static async removePlayer(actorId: string, deviceId: string, targetId: string): Promise<void> {
        const db = await getDatabase();
        const actorRole = await WitnessDevicePlayersService.roleOn(deviceId, actorId, db);
        if (!actorRole) throw new WitnessPlayerError('NOT_FOUND', 'No such device on your account');
        const targetRole = await WitnessDevicePlayersService.roleOn(deviceId, targetId, db);
        if (!targetRole) throw new WitnessPlayerError('NOT_FOUND', 'That person is not on this device');

        const self = actorId === targetId;
        if (!self) {
            if (actorRole !== 'owner') throw new WitnessPlayerError('NOT_OWNER', 'Only an owner of this device can remove players');
            if (targetRole === 'owner') {
                throw new WitnessPlayerError('NOT_ALLOWED', 'An owner cannot remove another owner. They can step down themselves.');
            }
        }
        if (self && targetRole === 'owner' && (await WitnessDevicePlayersService.ownerCount(db, deviceId)) <= 1) {
            throw new WitnessPlayerError('LAST_OWNER', 'You are the only owner. Make someone else an owner first, or unpair the device.');
        }

        await db.run(
            `UPDATE witness_device_players SET removed_at = datetime('now')
              WHERE device_id = ? AND canonical_user_id = ? AND removed_at IS NULL`,
            deviceId, targetId,
        );
        await db.run(
            `UPDATE witness_devices SET default_player = NULL WHERE atgames_unique_id = ? AND default_player = ?`,
            deviceId, targetId,
        );
        const { WitnessPlaySessionService } = await import('./WitnessPlaySessionService.js');
        await WitnessPlaySessionService.endSessionsOf(deviceId, targetId, db);
        logInfo(`Witness: ${targetId} ${self ? 'left' : `removed by ${actorId} from`} device ${deviceId}`);
        void WitnessDevicePlayersService.recordActivity(deviceId, {
            eventType: 'device_player_removed', userId: targetId, actorUserId: self ? null : actorId,
            summary: self ? 'Player left a Witness device' : 'Player removed from a Witness device',
        });
    }

    /**
     * Change a role. An owner promotes a player to owner; an owner steps
     * THEMSELVES down to player when another owner remains. Nothing else.
     */
    static async setRole(actorId: string, deviceId: string, targetId: string, role: DevicePlayerRole): Promise<void> {
        const db = await getDatabase();
        const actorRole = await WitnessDevicePlayersService.roleOn(deviceId, actorId, db);
        if (!actorRole) throw new WitnessPlayerError('NOT_FOUND', 'No such device on your account');
        const targetRole = await WitnessDevicePlayersService.roleOn(deviceId, targetId, db);
        if (!targetRole) throw new WitnessPlayerError('NOT_FOUND', 'That person is not on this device');
        if (targetRole === role) return;

        if (role === 'owner') {
            if (actorRole !== 'owner') throw new WitnessPlayerError('NOT_OWNER', 'Only an owner of this device can make someone an owner');
        } else {
            if (actorId !== targetId) {
                throw new WitnessPlayerError('NOT_ALLOWED', 'An owner cannot be stepped down by someone else. They can step down themselves.');
            }
            if ((await WitnessDevicePlayersService.ownerCount(db, deviceId)) <= 1) {
                throw new WitnessPlayerError('LAST_OWNER', 'You are the only owner. Make someone else an owner first.');
            }
        }

        await db.run(
            `UPDATE witness_device_players SET role = ?
              WHERE device_id = ? AND canonical_user_id = ? AND removed_at IS NULL`,
            role, deviceId, targetId,
        );
        logInfo(`Witness: ${targetId} is now ${role} of device ${deviceId} (by ${actorId})`);
        void WitnessDevicePlayersService.recordActivity(deviceId, {
            eventType: 'device_player_role', userId: targetId, actorUserId: actorId === targetId ? null : actorId,
            summary: role === 'owner' ? 'Player made an owner of a Witness device' : 'Owner stepped down to player on a Witness device',
        });
    }

    private static async liveInvite(db: Db, rawCode: string): Promise<{
        code_hash: string; device_id: string; created_by: string; expires_at: string;
    } | null> {
        const code = (rawCode || '').trim();
        if (!code) return null;
        const row = await db.get<{ code_hash: string; device_id: string; created_by: string; expires_at: string }>(
            `SELECT i.code_hash, i.device_id, i.created_by, i.expires_at
               FROM witness_device_invites i
               JOIN witness_devices d ON d.atgames_unique_id = i.device_id AND d.revoked_at IS NULL
              WHERE i.code_hash = ? AND i.consumed_at IS NULL AND i.expires_at > datetime('now')`,
            hashCode(code),
        );
        return row ?? null;
    }

    private static async assertRoom(db: Db, deviceId: string): Promise<void> {
        const n = await db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM witness_device_players WHERE device_id = ? AND removed_at IS NULL`,
            deviceId,
        );
        if ((n?.n ?? 0) >= MAX_PLAYERS_PER_DEVICE) {
            throw new WitnessPlayerError('DEVICE_FULL', `A device can have at most ${MAX_PLAYERS_PER_DEVICE} players`);
        }
    }

    /** ADR 0045 ruling 5: a second person only once the device's build sends a clock offset. */
    private static async assertReady(db: Db, deviceId: string): Promise<void> {
        const { WitnessPlaySessionService } = await import('./WitnessPlaySessionService.js');
        if (!(await WitnessPlaySessionService.householdReady(deviceId, db))) {
            throw new WitnessPlayerError(
                'DEVICE_NOT_READY',
                'This device needs a newer Arcaid Witness (or Castcade) before more players can be added. Update it, open it once, then try again.',
            );
        }
    }

    private static async ownerCount(db: Db, deviceId: string): Promise<number> {
        const n = await db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM witness_device_players
              WHERE device_id = ? AND role = 'owner' AND removed_at IS NULL`,
            deviceId,
        );
        return n?.n ?? 0;
    }

    /** One activity row per room the device sends to (ADR 0037), like pairing and unpairing. */
    private static async recordActivity(deviceId: string, entry: {
        eventType: string; userId: string; actorUserId: string | null; summary: string;
    }): Promise<void> {
        try {
            // The rooms of the person the row is about, by their own routing.
            const rooms = await ActivityLogService.roomsForDevice(deviceId, entry.userId).catch(() => [] as string[]);
            for (const roomId of rooms.length > 0 ? rooms : [null]) {
                void ActivityLogService.record({
                    roomId, category: 'device', eventType: entry.eventType,
                    userId: entry.userId, actorUserId: entry.actorUserId, deviceId,
                    summary: entry.summary,
                });
            }
        } catch (err) {
            logWarn(`Witness: player activity row not written for ${deviceId} (${err instanceof Error ? err.message : String(err)})`);
        }
    }
}
