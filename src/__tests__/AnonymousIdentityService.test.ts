import { describe, it, expect, beforeEach } from 'vitest';
import { AnonymousIdentityService } from '../services/AnonymousIdentityService.js';
import { setupTestDb, createTestRoom } from './helpers.js';

describe('AnonymousIdentityService.upsert (Sprint 13 UNIQUE + atomicity)', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    it('returns the same id for repeated upserts with the same guild+nickname', async () => {
        const roomId = await createTestRoom();
        const a = await AnonymousIdentityService.upsert({ roomId, guildId: 'guild-1', serverNickname: 'Justin' });
        const b = await AnonymousIdentityService.upsert({ roomId, guildId: 'guild-1', serverNickname: 'Justin' });
        expect(a).toBe(b);
    });

    it('is case-insensitive on server_nickname', async () => {
        const roomId = await createTestRoom();
        const lower = await AnonymousIdentityService.upsert({ roomId, guildId: 'guild-2', serverNickname: 'Wizard' });
        const upper = await AnonymousIdentityService.upsert({ roomId, guildId: 'guild-2', serverNickname: 'WIZARD' });
        expect(lower).toBe(upper);
    });

    it('handles concurrent upserts atomically (no duplicate rows)', async () => {
        const roomId = await createTestRoom();
        // Parallel upserts with identical input — previously raced before Sprint 13.
        const results = await Promise.all(
            Array.from({ length: 10 }, () =>
                AnonymousIdentityService.upsert({ roomId, guildId: 'guild-3', serverNickname: 'RaceCondition' }),
            ),
        );
        const unique = new Set(results);
        expect(unique.size).toBe(1);
    });

    it('falls back to (room_id, nickname) key when guildId is null', async () => {
        const roomA = await createTestRoom('room-a', 'Room A');
        const roomB = await createTestRoom('room-b', 'Room B');
        const inA = await AnonymousIdentityService.upsert({ roomId: roomA, guildId: null, serverNickname: 'Floater' });
        const inB = await AnonymousIdentityService.upsert({ roomId: roomB, guildId: null, serverNickname: 'Floater' });
        // Same nickname, different rooms, no guild → must produce distinct identities.
        expect(inA).not.toBe(inB);
        // Repeated call in Room A returns the existing id.
        const inAAgain = await AnonymousIdentityService.upsert({ roomId: roomA, guildId: null, serverNickname: 'Floater' });
        expect(inAAgain).toBe(inA);
    });

    it('rejects empty server_nickname', async () => {
        const roomId = await createTestRoom();
        await expect(
            AnonymousIdentityService.upsert({ roomId, guildId: null, serverNickname: '  ' }),
        ).rejects.toThrow(/serverNickname/i);
    });
});
