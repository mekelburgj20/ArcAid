import { describe, it, expect } from 'vitest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';

/**
 * W35 (v2.191.0) - does unpair + re-pair reset a device's designation?
 * Finding: no. `redeemPairingCode`'s upsert and `revokeDevice` never touch
 * target_room_id / target_tournament_id / global_only / global_fallback, so a
 * same-owner re-pair keeps the target; a different owner is refused.
 */
const USER = '123456789012345678';
const OTHER = '876543210987654321';
const DEVICE = 'cab-repair-w35';

describe('re-pairing a Witness device keeps its target (W35)', () => {
    it('same owner: pair -> target a room -> revoke -> re-pair; target and global_only survive', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('repair-room', 'Repair Room');
        const db = await getDatabase();
        await db.run(`INSERT INTO room_members (user_id, room_id, source) VALUES (?, ?, 'submission')`, USER, roomId);
        const { WitnessService } = await import('../services/WitnessService.js');

        const first = await WitnessService.createPairingCode(USER);
        await WitnessService.redeemPairingCode(first.code, DEVICE, 'Owner');
        await WitnessService.setDeviceTarget(USER, DEVICE, { roomId, tournamentId: null, globalFallback: false });
        expect(await WitnessService.getDeviceTarget(DEVICE)).toMatchObject({
            roomId, tournamentId: null, globalOnly: false, globalFallback: false,
        });

        expect(await WitnessService.revokeDevice(USER, DEVICE)).toBe(true);
        const second = await WitnessService.createPairingCode(USER);
        const { token } = await WitnessService.redeemPairingCode(second.code, DEVICE, 'Owner');
        expect(token).toBeTruthy();

        expect(await WitnessService.getDeviceTarget(DEVICE)).toMatchObject({
            roomId, tournamentId: null, globalOnly: false, globalFallback: false,
        });
        const row = await db.get<{ revoked_at: string | null }>(
            'SELECT revoked_at FROM witness_devices WHERE atgames_unique_id = ?', DEVICE,
        );
        expect(row!.revoked_at).toBeNull();

        // "Global Scoreboard only" survives too.
        await WitnessService.setDeviceTarget(USER, DEVICE, { roomId: null, globalOnly: true });
        await WitnessService.revokeDevice(USER, DEVICE);
        const third = await WitnessService.createPairingCode(USER);
        await WitnessService.redeemPairingCode(third.code, DEVICE, 'Owner');
        expect(await WitnessService.getDeviceTarget(DEVICE)).toMatchObject({ roomId: null, globalOnly: true });
    });

    it('a different owner cannot re-pair a live device (DEVICE_CONFLICT)', async () => {
        await setupTestDb();
        const { WitnessService } = await import('../services/WitnessService.js');
        const a = await WitnessService.createPairingCode(USER);
        await WitnessService.redeemPairingCode(a.code, DEVICE, 'Owner');
        const b = await WitnessService.createPairingCode(OTHER);
        await expect(WitnessService.redeemPairingCode(b.code, DEVICE, 'Thief')).rejects.toMatchObject({ code: 'DEVICE_CONFLICT' });
    });
});
