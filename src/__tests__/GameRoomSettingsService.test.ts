import { describe, it, expect, beforeEach } from 'vitest';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { isEncrypted, maskFor } from '../utils/secrets.js';
import { getDatabase } from '../database/database.js';
import { setupTestDb, createTestRoom } from './helpers.js';

describe('GameRoomSettingsService — encryption transparency', () => {
    let roomId: string;

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
    });

    it('stores ISCORED_PASSWORD encrypted but returns plaintext on get()', async () => {
        await GameRoomSettingsService.set(roomId, 'ISCORED_PASSWORD', 'hunter2');

        const returned = await GameRoomSettingsService.get(roomId, 'ISCORED_PASSWORD');
        expect(returned).toBe('hunter2');

        // Verify raw row is ciphertext, not plaintext
        const db = await getDatabase();
        const raw = await db.get(
            'SELECT value FROM game_room_settings WHERE game_room_id = ? AND key = ?',
            roomId, 'ISCORED_PASSWORD',
        );
        expect(raw.value).not.toBe('hunter2');
        expect(isEncrypted(raw.value)).toBe(true);
    });

    it('does not encrypt non-registered keys', async () => {
        await GameRoomSettingsService.set(roomId, 'ISCORED_USERNAME', 'alice');
        const db = await getDatabase();
        const raw = await db.get(
            'SELECT value FROM game_room_settings WHERE game_room_id = ? AND key = ?',
            roomId, 'ISCORED_USERNAME',
        );
        expect(raw.value).toBe('alice');
    });

    it('saveMany empty value deletes the row (closes the empty-skip bug)', async () => {
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', '123456789');
        expect(await GameRoomSettingsService.get(roomId, 'DISCORD_GUILD_ID')).toBe('123456789');

        await GameRoomSettingsService.saveMany(roomId, { DISCORD_GUILD_ID: '' });
        expect(await GameRoomSettingsService.get(roomId, 'DISCORD_GUILD_ID')).toBeNull();
    });

    it('saveMany mask sentinel is a no-op (unchanged secret)', async () => {
        await GameRoomSettingsService.set(roomId, 'ISCORED_PASSWORD', 'original');
        expect(await GameRoomSettingsService.get(roomId, 'ISCORED_PASSWORD')).toBe('original');

        // Frontend posts back the mask for untouched secret fields — backend must
        // leave the stored value alone.
        await GameRoomSettingsService.saveMany(roomId, {
            ISCORED_PASSWORD: maskFor('ISCORED_PASSWORD'),
        });
        expect(await GameRoomSettingsService.get(roomId, 'ISCORED_PASSWORD')).toBe('original');
    });

    it('saveMany new value replaces the stored secret', async () => {
        await GameRoomSettingsService.set(roomId, 'ISCORED_PASSWORD', 'old');
        await GameRoomSettingsService.saveMany(roomId, { ISCORED_PASSWORD: 'new' });
        expect(await GameRoomSettingsService.get(roomId, 'ISCORED_PASSWORD')).toBe('new');
    });

    it('empty value passed to set() deletes the row', async () => {
        await GameRoomSettingsService.set(roomId, 'DISCORD_INVITE_URL', 'https://discord.gg/abc');
        await GameRoomSettingsService.set(roomId, 'DISCORD_INVITE_URL', '');
        expect(await GameRoomSettingsService.get(roomId, 'DISCORD_INVITE_URL')).toBeNull();
    });

    it('getAll() returns plaintext for encrypted keys', async () => {
        await GameRoomSettingsService.set(roomId, 'ISCORED_PASSWORD', 'hunter2');
        await GameRoomSettingsService.set(roomId, 'ISCORED_USERNAME', 'alice');
        const all = await GameRoomSettingsService.getAll(roomId);
        expect(all.ISCORED_PASSWORD).toBe('hunter2');
        expect(all.ISCORED_USERNAME).toBe('alice');
    });
});
