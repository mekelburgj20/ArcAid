import { describe, it, expect, beforeEach } from 'vitest';
import { TournamentService } from '../services/TournamentService.js';
import { setupTestDb, createTestRoom } from './helpers.js';
import crypto from 'crypto';

describe('TournamentService', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    describe('create', () => {
        it('creates a tournament with all fields', async () => {
            const roomId = await createTestRoom();
            const id = crypto.randomUUID();

            await TournamentService.create({
                id,
                name: 'Daily Grind',
                type: 'DG',
                mode: 'pinball',
                cadence: { cron: '0 0 * * *' },
                display_order: 1,
                max_active_games: 2,
                cleanup_rule: { mode: 'retain', count: 3 },
                game_room_id: roomId,
                is_active: true,
            });

            const tournaments = await TournamentService.getAll(roomId);
            expect(tournaments).toHaveLength(1);
            expect(tournaments[0]!.name).toBe('Daily Grind');
            expect(tournaments[0]!.type).toBe('DG');
            expect(tournaments[0]!.mode).toBe('pinball');
            expect(tournaments[0]!.max_active_games).toBe(2);
            expect(tournaments[0]!.display_order).toBe(1);
        });

        it('defaults mode to pinball when not specified', async () => {
            const roomId = await createTestRoom();
            const id = crypto.randomUUID();

            await TournamentService.create({
                id,
                name: 'Test',
                type: 'T',
                cadence: {},
                game_room_id: roomId,
            });

            const tournaments = await TournamentService.getAll(roomId);
            expect(tournaments[0]!.mode).toBe('pinball');
        });
    });

    describe('getAll', () => {
        it('returns tournaments filtered by room', async () => {
            const room1 = await createTestRoom('room-1', 'Room 1');
            const room2 = await createTestRoom('room-2', 'Room 2');

            await TournamentService.create({
                id: crypto.randomUUID(),
                name: 'Tournament A',
                type: 'A',
                cadence: {},
                game_room_id: room1,
            });
            await TournamentService.create({
                id: crypto.randomUUID(),
                name: 'Tournament B',
                type: 'B',
                cadence: {},
                game_room_id: room2,
            });

            const room1Tournaments = await TournamentService.getAll(room1);
            expect(room1Tournaments).toHaveLength(1);
            expect(room1Tournaments[0]!.name).toBe('Tournament A');

            const allTournaments = await TournamentService.getAll();
            expect(allTournaments).toHaveLength(2);
        });
    });

    describe('update', () => {
        it('updates tournament fields', async () => {
            const roomId = await createTestRoom();
            const id = crypto.randomUUID();

            await TournamentService.create({
                id,
                name: 'Original',
                type: 'DG',
                cadence: {},
                game_room_id: roomId,
            });

            await TournamentService.update(id, {
                name: 'Updated',
                type: 'WG',
                mode: 'videogame',
                cadence: { cron: '0 12 * * *' },
                display_order: 5,
                max_active_games: 3,
                cleanup_rule: { mode: 'immediate' },
                game_room_id: roomId,
            });

            const tournaments = await TournamentService.getAll(roomId);
            expect(tournaments[0]!.name).toBe('Updated');
            expect(tournaments[0]!.type).toBe('WG');
            expect(tournaments[0]!.mode).toBe('videogame');
            expect(tournaments[0]!.display_order).toBe(5);
        });
    });

    describe('delete', () => {
        it('removes a tournament', async () => {
            const roomId = await createTestRoom();
            const id = crypto.randomUUID();

            await TournamentService.create({
                id,
                name: 'ToDelete',
                type: 'X',
                cadence: {},
                game_room_id: roomId,
            });

            await TournamentService.delete(id);

            const tournaments = await TournamentService.getAll(roomId);
            expect(tournaments).toHaveLength(0);
        });
    });
});
