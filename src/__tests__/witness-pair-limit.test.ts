import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';

/**
 * W97 (v2.243.0) - caps on pairing a device id an account has never held. The
 * Castcade match relay gives each paired device its own budget of wrong match
 * codes (ADR 0039), so an account that could pair without limit had no budget
 * at all. New pairings only: existing rows keep working and re-pair freely.
 */
const USER = '123456789012345678';
const OTHER = '876543210987654321';

async function pair(user: string, deviceId: string): Promise<{ code: string; token: string }> {
    const { WitnessService } = await import('../services/WitnessService.js');
    const { code } = await WitnessService.createPairingCode(user);
    const { token } = await WitnessService.redeemPairingCode(code, deviceId, null, 'desktop');
    return { code, token };
}

/** Rows as an older release left them: paired long ago, so the daily window is not in play. */
async function seedDevices(user: string, n: number, opts: { revoked?: boolean; pairedAt?: string } = {}) {
    const db = await getDatabase();
    for (let i = 0; i < n; i++) {
        await db.run(
            `INSERT INTO witness_devices (atgames_unique_id, canonical_user_id, token_hash, paired_at, revoked_at, device_type)
             VALUES (?, ?, 'x', datetime('now', ?), ${opts.revoked ? `datetime('now')` : 'NULL'}, 'desktop')`,
            `seed-${user}-${opts.revoked ? 'r' : 'a'}-${i}`, user, opts.pairedAt ?? '-30 days',
        );
    }
}

beforeEach(async () => { await setupTestDb(); });

describe('Witness device pairing caps (W97)', () => {
    it('the 11th active device is refused, and the code is not consumed', async () => {
        const { WitnessService, MAX_ACTIVE_DEVICES_PER_USER } = await import('../services/WitnessService.js');
        expect(MAX_ACTIVE_DEVICES_PER_USER).toBe(10);
        await seedDevices(USER, 10);
        const { code } = await WitnessService.createPairingCode(USER);
        await expect(WitnessService.redeemPairingCode(code, 'new-device', null, 'desktop'))
            .rejects.toMatchObject({ code: 'DEVICE_LIMIT' });
        const db = await getDatabase();
        const row = await db.get<{ consumed_at: string | null }>(
            'SELECT consumed_at FROM witness_pairing_codes WHERE code = ?', code,
        );
        expect(row!.consumed_at).toBeNull();
        expect(await db.get('SELECT 1 FROM witness_devices WHERE atgames_unique_id = ?', 'new-device')).toBeUndefined();

        // Unpair one, and the same code works.
        expect(await WitnessService.revokeDevice(USER, `seed-${USER}-a-0`)).toBe(true);
        const { token } = await WitnessService.redeemPairingCode(code, 'new-device', null, 'desktop');
        expect(token).toBeTruthy();
    });

    it('an account already over the cap keeps every device, and each one still re-pairs', async () => {
        await seedDevices(USER, 14);
        const { WitnessService } = await import('../services/WitnessService.js');
        const { token } = await pair(USER, `seed-${USER}-a-3`);
        expect(await WitnessService.verifyDevice(`seed-${USER}-a-3`, token)).toBeTruthy();
        const db = await getDatabase();
        const live = await db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM witness_devices WHERE canonical_user_id = ? AND revoked_at IS NULL', USER,
        );
        expect(live!.n).toBe(14);
        // A new one is refused.
        await expect(pair(USER, 'new-device')).rejects.toMatchObject({ code: 'DEVICE_LIMIT' });
    });

    it('unpaired devices do not count toward the active cap', async () => {
        await seedDevices(USER, 9);
        await seedDevices(USER, 6, { revoked: true });
        expect((await pair(USER, 'tenth')).token).toBeTruthy();
        await expect(pair(USER, 'eleventh')).rejects.toMatchObject({ code: 'DEVICE_LIMIT' });
    });

    it('the sixth new device inside 24 hours is refused; the caps are per account', async () => {
        const { WitnessService, MAX_NEW_DEVICES_PER_DAY } = await import('../services/WitnessService.js');
        expect(MAX_NEW_DEVICES_PER_DAY).toBe(5);
        for (let i = 0; i < 5; i++) await pair(USER, `today-${i}`);
        await expect(pair(USER, 'today-5')).rejects.toMatchObject({ code: 'DEVICE_LIMIT' });
        // Unpairing does not hand the day's allowance back.
        await WitnessService.revokeDevice(USER, 'today-0');
        await expect(pair(USER, 'today-5')).rejects.toMatchObject({ code: 'DEVICE_LIMIT' });
        // One of today's own devices re-pairs, unpaired or live.
        expect((await pair(USER, 'today-0')).token).toBeTruthy();
        expect((await pair(USER, 'today-1')).token).toBeTruthy();
        // Another account is unaffected.
        expect((await pair(OTHER, 'other-0')).token).toBeTruthy();
    });

    it('a pairing older than 24 hours is outside the window', async () => {
        await seedDevices(USER, 5, { pairedAt: '-25 hours' });
        expect((await pair(USER, 'next-day')).token).toBeTruthy();
    });

    it('an unpaired device taken by another account is a new pairing for it, dated now', async () => {
        await seedDevices(USER, 1, { revoked: true });
        await seedDevices(OTHER, 5, { pairedAt: '-1 hour' });
        const deviceId = `seed-${USER}-r-0`;
        await expect(pair(OTHER, deviceId)).rejects.toMatchObject({ code: 'DEVICE_LIMIT' });

        const db = await getDatabase();
        await db.run(`UPDATE witness_devices SET paired_at = datetime('now', '-3 days') WHERE canonical_user_id = ?`, OTHER);
        await pair(OTHER, deviceId);
        const row = await db.get<{ canonical_user_id: string; recent: number }>(
            `SELECT canonical_user_id, (paired_at > datetime('now', '-1 minute')) AS recent
               FROM witness_devices WHERE atgames_unique_id = ?`, deviceId,
        );
        expect(row).toMatchObject({ canonical_user_id: OTHER, recent: 1 });
    });
});
