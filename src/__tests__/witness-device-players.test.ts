import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';

/**
 * W131.1 (ADR 0045, docs/shared-device-plan.md §3) - players and co-owners on
 * one Witness device: invites, roles, routing per player, and the owner-only
 * device actions. Until W131.2 every play is still credited to the account
 * that paired, so nothing about scoring is tested here.
 */
const WIFE = '111111111111111111';
const HUSBAND = '222222222222222222';
const KID = '333333333333333333';
const STRANGER = '444444444444444444';
const CAB = 'cab-household';

async function svc() {
    const { WitnessDevicePlayersService, WitnessPlayerError, MAX_PLAYERS_PER_DEVICE } = await import('../services/WitnessDevicePlayersService.js');
    const { WitnessService, WitnessPairError } = await import('../services/WitnessService.js');
    return { P: WitnessDevicePlayersService, WitnessPlayerError, MAX_PLAYERS_PER_DEVICE, W: WitnessService, WitnessPairError };
}

async function pair(user: string, deviceId = CAB): Promise<string> {
    const { W } = await svc();
    const { code } = await W.createPairingCode(user);
    const { token } = await W.redeemPairingCode(code, deviceId, null, 'atgames');
    return token;
}

async function join(owner: string, player: string, deviceId = CAB): Promise<void> {
    const { P } = await svc();
    const { code } = await P.createInvite(owner, deviceId);
    await P.acceptInvite(player, code);
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
    await expect(p).rejects.toMatchObject({ code });
}

beforeEach(async () => { await setupTestDb(); });

describe('W131.1 device players', () => {
    it('pairing makes the pairing account the device owner', async () => {
        const { P, W } = await svc();
        await pair(WIFE);
        expect(await P.roleOn(CAB, WIFE)).toBe('owner');
        const [device] = await W.listDevices(WIFE);
        expect(device).toMatchObject({ atgamesUniqueId: CAB, role: 'owner', pairedByYou: true });
    });

    it('the migration gives every existing device an owner row carrying its routing', async () => {
        const db = await getDatabase();
        const room = await createTestRoom('fam', 'Family Room');
        await db.run(
            `INSERT INTO witness_devices (atgames_unique_id, canonical_user_id, token_hash, target_room_id, global_fallback)
             VALUES ('old-cab', ?, 'h', ?, 0)`,
            WIFE, room,
        );
        await db.run(
            `INSERT INTO witness_devices (atgames_unique_id, canonical_user_id, token_hash, revoked_at)
             VALUES ('gone-cab', ?, 'h', datetime('now'))`,
            WIFE,
        );
        const { witnessDevicePlayers } = await import('../database/migrations/witnessDevicePlayers.js');
        await witnessDevicePlayers(db);

        const rows = await db.all<Array<{ device_id: string; role: string; target_room_id: string | null; global_fallback: number; removed_at: string | null; slot: string }>>(
            `SELECT device_id, role, target_room_id, global_fallback, removed_at, slot FROM witness_device_players ORDER BY device_id`,
        );
        expect(rows.map(r => [r.device_id, r.role, r.target_room_id, r.global_fallback, r.removed_at === null])).toEqual([
            ['gone-cab', 'owner', null, 1, false],
            ['old-cab', 'owner', room, 0, true],
        ]);
        expect(rows.every(r => /^[0-9a-f]{8}$/.test(r.slot))).toBe(true);

        // Idempotent: a second run adds nothing and changes nothing.
        await witnessDevicePlayers(db);
        expect((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM witness_device_players`))!.n).toBe(2);

        const { W } = await svc();
        expect(await W.getDeviceTarget('old-cab')).toEqual({ roomId: room, tournamentId: null, globalOnly: false, globalFallback: false });
    });

    it('an invite adds a player, once', async () => {
        const { P, W } = await svc();
        await pair(WIFE);
        const { code } = await P.createInvite(WIFE, CAB);

        const preview = await P.previewInvite(HUSBAND, code);
        expect(preview).toMatchObject({ deviceType: 'atgames', alreadyOnDevice: false, deviceTail: CAB.slice(-4) });

        await P.acceptInvite(HUSBAND, code);
        expect(await P.roleOn(CAB, HUSBAND)).toBe('player');
        const [device] = await W.listDevices(HUSBAND);
        expect(device).toMatchObject({ atgamesUniqueId: CAB, role: 'player', pairedByYou: false });

        // Single use: the same link does nothing for a third person.
        await expectCode(P.acceptInvite(KID, code), 'INVITE_INVALID');
        expect(await P.previewInvite(KID, code)).toBeNull();

        const players = await P.listPlayers(HUSBAND, CAB);
        expect(players!.map(p => [p.userId, p.role, p.pairedDevice, p.isYou])).toEqual([
            [WIFE, 'owner', true, false],
            [HUSBAND, 'player', false, true],
        ]);
        expect(await P.listPlayers(STRANGER, CAB)).toBeNull();
    });

    it('accepting while already on the device is refused and keeps the link usable', async () => {
        const { P } = await svc();
        await pair(WIFE);
        const { code } = await P.createInvite(WIFE, CAB);
        await expectCode(P.acceptInvite(WIFE, code), 'ALREADY_ON_DEVICE');
        await P.acceptInvite(HUSBAND, code);
        expect(await P.roleOn(CAB, HUSBAND)).toBe('player');
    });

    it('an expired invite is not valid', async () => {
        const { P } = await svc();
        await pair(WIFE);
        const { code } = await P.createInvite(WIFE, CAB);
        const db = await getDatabase();
        await db.run(`UPDATE witness_device_invites SET expires_at = datetime('now', '-1 minute')`);
        await expectCode(P.acceptInvite(HUSBAND, code), 'INVITE_INVALID');
    });

    it('a device holds at most MAX_PLAYERS_PER_DEVICE people', async () => {
        const { P, MAX_PLAYERS_PER_DEVICE } = await svc();
        await pair(WIFE);
        for (let i = 1; i < MAX_PLAYERS_PER_DEVICE; i++) await join(WIFE, `90000000000000000${i}`);
        await expectCode(P.createInvite(WIFE, CAB), 'DEVICE_FULL');
    });

    it('a player cannot manage the device', async () => {
        const { P, W } = await svc();
        await pair(WIFE);
        await join(WIFE, HUSBAND);
        await expectCode(P.createInvite(HUSBAND, CAB), 'NOT_OWNER');
        expect(await W.setUpdatePreferences(HUSBAND, CAB, { autoUpdate: false })).toBeNull();
        expect(await W.revokeDevice(HUSBAND, CAB)).toBe(false);
        expect(await P.roleOn(CAB, WIFE)).toBe('owner');
    });

    it('each player routes their own scores', async () => {
        const { W } = await svc();
        const room = await createTestRoom('fam', 'Family Room');
        const db = await getDatabase();
        await db.run(`INSERT INTO room_members (user_id, room_id, source) VALUES (?, ?, 'admin_invite')`, HUSBAND, room);
        await pair(WIFE);
        await join(WIFE, HUSBAND);

        await W.setDeviceTarget(HUSBAND, CAB, { roomId: room });
        expect((await W.getDeviceTarget(CAB, HUSBAND)).roomId).toBe(room);
        // The wife's routing, and the device's default player's, are untouched.
        expect((await W.getDeviceTarget(CAB, WIFE)).roomId).toBeNull();
        expect((await W.getDeviceTarget(CAB)).roomId).toBeNull();
        expect((await W.listDevices(HUSBAND))[0].targetRoomId).toBe(room);
        expect((await W.listDevices(WIFE))[0].targetRoomId).toBeNull();

        await W.setDeviceTarget(WIFE, CAB, { globalOnly: true });
        expect((await W.getDeviceTarget(CAB)).globalOnly).toBe(true);
        expect((await W.getDeviceTarget(CAB, HUSBAND)).roomId).toBe(room);

        // Someone not on the device has nothing to set.
        await expect(W.setDeviceTarget(STRANGER, CAB, { globalOnly: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('co-owners: promote, step down, never remove each other, the last owner stays', async () => {
        const { P } = await svc();
        await pair(WIFE);
        await join(WIFE, HUSBAND);
        await join(WIFE, KID);

        await expectCode(P.setRole(HUSBAND, CAB, KID, 'owner'), 'NOT_OWNER');
        await P.setRole(WIFE, CAB, HUSBAND, 'owner');
        expect(await P.roleOn(CAB, HUSBAND)).toBe('owner');

        await expectCode(P.removePlayer(WIFE, CAB, HUSBAND), 'NOT_ALLOWED');
        await expectCode(P.setRole(WIFE, CAB, HUSBAND, 'player'), 'NOT_ALLOWED');
        await P.removePlayer(HUSBAND, CAB, KID);
        expect(await P.roleOn(CAB, KID)).toBeNull();

        // The husband steps down; now the wife is the only owner and cannot.
        await P.setRole(HUSBAND, CAB, HUSBAND, 'player');
        expect(await P.roleOn(CAB, HUSBAND)).toBe('player');
        await expectCode(P.setRole(WIFE, CAB, WIFE, 'player'), 'LAST_OWNER');
    });

    it('anyone may leave, except the pairing account (until W131.2) and the last owner', async () => {
        const { P } = await svc();
        await pair(WIFE);
        await join(WIFE, HUSBAND);
        await P.removePlayer(HUSBAND, CAB, HUSBAND);
        expect(await P.roleOn(CAB, HUSBAND)).toBeNull();
        await expectCode(P.removePlayer(WIFE, CAB, WIFE), 'PAIRING_ACCOUNT');

        // A rejoin reactivates the same row: same slot, own routing kept.
        const db = await getDatabase();
        const before = await db.get<{ slot: string }>(`SELECT slot FROM witness_device_players WHERE canonical_user_id = ?`, HUSBAND);
        await join(WIFE, HUSBAND);
        const after = await db.get<{ slot: string; removed_at: string | null; role: string }>(
            `SELECT slot, removed_at, role FROM witness_device_players WHERE canonical_user_id = ?`, HUSBAND,
        );
        expect(after).toEqual({ slot: before!.slot, removed_at: null, role: 'player' });

        // A co-owner who did not pair may leave once another owner remains.
        await P.setRole(WIFE, CAB, HUSBAND, 'owner');
        await P.removePlayer(HUSBAND, CAB, HUSBAND);
        expect(await P.roleOn(CAB, HUSBAND)).toBeNull();
    });

    it('a co-owner may unpair, which takes everyone off and voids invites', async () => {
        const { P, W } = await svc();
        await pair(WIFE);
        await join(WIFE, HUSBAND);
        await P.setRole(WIFE, CAB, HUSBAND, 'owner');
        const { code } = await P.createInvite(WIFE, CAB);

        expect(await W.revokeDevice(HUSBAND, CAB)).toBe(true);
        expect(await W.listDevices(WIFE)).toEqual([]);
        expect(await W.listDevices(HUSBAND)).toEqual([]);
        expect(await P.roleOn(CAB, WIFE)).toBeNull();
        expect(await P.previewInvite(KID, code)).toBeNull();
    });

    it('a co-owner may re-pair a live device (token rotation); a stranger may not', async () => {
        const { P, W, WitnessPairError } = await svc();
        const oldToken = await pair(WIFE);
        await join(WIFE, HUSBAND);
        await P.setRole(WIFE, CAB, HUSBAND, 'owner');
        const db = await getDatabase();
        await db.run(`UPDATE witness_devices SET auto_update = 0 WHERE atgames_unique_id = ?`, CAB);

        const newToken = await pair(HUSBAND);
        expect(newToken).not.toBe(oldToken);
        const row = await db.get<{ canonical_user_id: string; auto_update: number }>(
            `SELECT canonical_user_id, auto_update FROM witness_devices WHERE atgames_unique_id = ?`, CAB,
        );
        // The device keeps its pairing account and its switches; both stay owners.
        expect(row).toEqual({ canonical_user_id: WIFE, auto_update: 0 });
        expect(await P.roleOn(CAB, WIFE)).toBe('owner');
        expect(await P.roleOn(CAB, HUSBAND)).toBe('owner');
        expect(await W.verifyDevice(CAB, newToken)).not.toBeNull();
        expect(await W.verifyDevice(CAB, oldToken)).toBeNull();

        // A mere player is refused like a stranger.
        await join(WIFE, KID);
        const { code } = await W.createPairingCode(KID);
        await expect(W.redeemPairingCode(code, CAB, null, 'atgames')).rejects.toBeInstanceOf(WitnessPairError);
        const { code: c2 } = await W.createPairingCode(STRANGER);
        await expect(W.redeemPairingCode(c2, CAB, null, 'atgames')).rejects.toMatchObject({ code: 'DEVICE_CONFLICT' });
    });

    it('another account taking an unpaired device starts with nobody else on it', async () => {
        const { P } = await svc();
        await pair(WIFE);
        await join(WIFE, HUSBAND);
        const { W } = await svc();
        await W.revokeDevice(WIFE, CAB);

        await pair(STRANGER);
        expect(await P.roleOn(CAB, STRANGER)).toBe('owner');
        expect(await P.roleOn(CAB, WIFE)).toBeNull();
        expect(await P.roleOn(CAB, HUSBAND)).toBeNull();
    });

    it('only an owner (or the pairing account) may ask for the device logs', async () => {
        const { W } = await svc();
        await pair(WIFE);
        await join(WIFE, HUSBAND);
        const db = await getDatabase();
        await db.run(`UPDATE witness_devices SET app_version = '1.1.0' WHERE atgames_unique_id = ?`, CAB);
        const { WitnessLogService } = await import('../services/WitnessLogService.js');
        await expect(WitnessLogService.request(HUSBAND, CAB)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        const { request } = await WitnessLogService.request(WIFE, CAB);
        expect(request.id).toBeTruthy();
        expect(W).toBeTruthy();
    });
});
