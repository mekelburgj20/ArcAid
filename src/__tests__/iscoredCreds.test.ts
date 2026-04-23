import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getIScoredCredsForRoom } from '../utils/iscoredCreds.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { setupTestDb, createTestRoom } from './helpers.js';

describe('getIScoredCredsForRoom', () => {
    let roomId: string;
    const origEnv = { ...process.env };

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
    });

    afterEach(() => {
        // Restore env vars that tests may have mutated
        process.env = { ...origEnv };
    });

    it('returns null when the room has ISCORED_ENABLED=false, even with per-room creds', async () => {
        await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
        await GameRoomSettingsService.set(roomId, 'ISCORED_USERNAME', 'alice');
        await GameRoomSettingsService.set(roomId, 'ISCORED_PASSWORD', 'secret');
        await GameRoomSettingsService.set(roomId, 'ISCORED_PUBLIC_URL', 'https://iscored.info/alice');
        expect(await getIScoredCredsForRoom(roomId)).toBeNull();
    });

    it('returns per-room creds when all three are set', async () => {
        await GameRoomSettingsService.set(roomId, 'ISCORED_USERNAME', 'alice');
        await GameRoomSettingsService.set(roomId, 'ISCORED_PASSWORD', 'secret');
        await GameRoomSettingsService.set(roomId, 'ISCORED_PUBLIC_URL', 'https://iscored.info/alice');

        const creds = await getIScoredCredsForRoom(roomId);
        expect(creds).not.toBeNull();
        expect(creds!.username).toBe('alice');
        expect(creds!.password).toBe('secret');
        expect(creds!.gameroomName).toBe('alice');
        expect(creds!.source).toBe('room');
    });

    it('returns null when per-room config is partial (username only)', async () => {
        await GameRoomSettingsService.set(roomId, 'ISCORED_USERNAME', 'alice');
        // password + url missing
        expect(await getIScoredCredsForRoom(roomId)).toBeNull();
    });

    it('falls back to env when no per-room config exists', async () => {
        process.env.ISCORED_USERNAME = 'envuser';
        process.env.ISCORED_PASSWORD = 'envpass';
        process.env.ISCORED_PUBLIC_URL = 'https://iscored.info/envroom';

        const creds = await getIScoredCredsForRoom(roomId);
        expect(creds).not.toBeNull();
        expect(creds!.username).toBe('envuser');
        expect(creds!.gameroomName).toBe('envroom');
        expect(creds!.source).toBe('env');
    });

    it('returns null when no roomId and no env creds', async () => {
        delete process.env.ISCORED_USERNAME;
        delete process.env.ISCORED_PASSWORD;
        delete process.env.ISCORED_PUBLIC_URL;
        expect(await getIScoredCredsForRoom(null)).toBeNull();
        expect(await getIScoredCredsForRoom(undefined)).toBeNull();
    });
});
