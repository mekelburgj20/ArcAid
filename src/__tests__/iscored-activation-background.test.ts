import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { PickAwardGate } from '../services/PickAwardGate.js';
import { IScoredSessionRegistry } from '../engine/IScoredSessionRegistry.js';
import type { IScoredClient } from '../engine/IScoredClient.js';
import { drainBackgroundTasks } from '../utils/backgroundTasks.js';
import { isConfirmedEmptyGameList, pickCreatedGameRow } from '../utils/iscoredGameNames.js';

/**
 * F10 — activation never waits on iScored (ProBros, 2026-11-10).
 *
 * The web Activate button and the web pick built the iScored board BEFORE
 * activating, inside the HTTP request. ProBros' iScored room had been emptied,
 * the lineup loader treated "no games" as a failure, and each attempt retried
 * for ~110 s until Cloudflare cut it (HTTP 524) — nothing was activated. Both
 * routes now activate in Arcaid, answer, and build the board afterwards; a
 * board failure is a problem row on the room's Activity page, never a refusal.
 */

vi.mock('../utils/logger.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/logger.js')>();
    return { ...actual, logWarn: vi.fn(), logInfo: vi.fn() };
});

/** A promise the test settles by hand, so "answered before the board" is provable. */
function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function makeFakeClient(createGame: () => Promise<string>) {
    const fns = {
        createGame: vi.fn(createGame),
        setGameTags: vi.fn(async () => {}),
        setGameStatus: vi.fn(async () => {}),
        repositionLineup: vi.fn(async () => {}),
    };
    const client = {
        connect: async () => {},
        disconnect: async () => {},
        ...fns,
    } as unknown as IScoredClient;
    return { client, ...fns };
}

let roomCounter = 0;

async function seedIScoredRoom() {
    const roomId = await createTestRoom(`f10-room-${++roomCounter}`, `F10 Room ${roomCounter}`);
    await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'true');
    await GameRoomSettingsService.set(roomId, 'ISCORED_USERNAME', 'f10acct');
    await GameRoomSettingsService.set(roomId, 'ISCORED_PASSWORD', 'f10pw');
    await GameRoomSettingsService.set(roomId, 'ISCORED_PUBLIC_URL', 'https://iscored.info/f10acct');
    const tournamentId = await createTestTournament(roomId, { name: `Weekly ${roomCounter}`, type: 'PB-WEEKLY' });
    return { roomId, tournamentId };
}

async function roomsApp() {
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

async function gameNamed(tournamentId: string, name: string) {
    const db = await getDatabase();
    return db.get<{ id: string; status: string; iscored_id: string | null }>(
        'SELECT id, status, iscored_id FROM games WHERE tournament_id = ? AND name = ?', tournamentId, name,
    );
}

async function problemRows(roomId: string) {
    const db = await getDatabase();
    return db.all<Array<{ event_type: string; severity: string; summary: string; game_name: string | null }>>(
        `SELECT event_type, severity, summary, game_name FROM activity_log
          WHERE game_room_id = ? AND event_type = 'iscored_board_failed'`, roomId,
    );
}

beforeEach(async () => { await setupTestDb(); });

afterEach(async () => {
    await drainBackgroundTasks();
    const reg = IScoredSessionRegistry.getInstance();
    reg.setClientFactoryForTests(null);
    await reg.shutdown();
});

describe('POST /tournaments/:id/activate-game — the board is built after the answer', () => {
    it('answers with the game ACTIVE before iScored finishes, then links the board', async () => {
        const { roomId, tournamentId } = await seedIScoredRoom();
        const board = deferred<string>();
        const fake = makeFakeClient(() => board.promise);
        IScoredSessionRegistry.getInstance().setClientFactoryForTests(() => fake.client);

        const res = await request(await roomsApp())
            .post(`/api/rooms/${roomId}/tournaments/${tournamentId}/activate-game`)
            .set('Authorization', `Bearer ${signToken({ role: 'room_admin', gameRoomIds: [roomId] })}`)
            .send({ gameName: 'White Water' });

        expect(res.status).toBe(200);
        expect(res.body.iscoredStatus).toBe('pending');
        const before = await gameNamed(tournamentId, 'White Water');
        expect(before?.status).toBe('ACTIVE');
        expect(before?.iscored_id).toBeNull();

        board.resolve('ISC_WW');
        await drainBackgroundTasks();

        const after = await gameNamed(tournamentId, 'White Water');
        expect(after?.iscored_id).toBe('ISC_WW');
        expect(fake.createGame).toHaveBeenCalledWith('White Water', undefined);
        expect(fake.setGameTags).toHaveBeenCalledWith('ISC_WW', 'PB-WEEKLY');
        expect(fake.setGameStatus).toHaveBeenCalledWith('ISC_WW', { locked: false, hidden: false });
        expect(fake.repositionLineup).toHaveBeenCalledWith(['ISC_WW']);
        expect(await problemRows(roomId)).toHaveLength(0);
    });

    it('an iScored failure leaves the game live and writes a problem row naming the retry', async () => {
        const { roomId, tournamentId } = await seedIScoredRoom();
        const fake = makeFakeClient(async () => { throw new Error('Failed to load Lineup list after 3 attempts.'); });
        IScoredSessionRegistry.getInstance().setClientFactoryForTests(() => fake.client);

        const res = await request(await roomsApp())
            .post(`/api/rooms/${roomId}/tournaments/${tournamentId}/activate-game`)
            .set('Authorization', `Bearer ${signToken({ role: 'room_admin', gameRoomIds: [roomId] })}`)
            .send({ gameName: 'White Water' });
        expect(res.status).toBe(200);
        await drainBackgroundTasks();

        const game = await gameNamed(tournamentId, 'White Water');
        expect(game?.status).toBe('ACTIVE');
        expect(game?.iscored_id).toBeNull();
        const rows = await problemRows(roomId);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.severity).toBe('problem');
        expect(rows[0]!.game_name).toBe('White Water');
        expect(rows[0]!.summary).toContain('Failed to load Lineup list');
        expect(rows[0]!.summary).toContain('Create on iScored');
    });

    it('a game removed before the board lands is not re-linked, and the stray board is reported', async () => {
        const { roomId, tournamentId } = await seedIScoredRoom();
        const board = deferred<string>();
        const fake = makeFakeClient(() => board.promise);
        IScoredSessionRegistry.getInstance().setClientFactoryForTests(() => fake.client);

        const res = await request(await roomsApp())
            .post(`/api/rooms/${roomId}/tournaments/${tournamentId}/activate-game`)
            .set('Authorization', `Bearer ${signToken({ role: 'room_admin', gameRoomIds: [roomId] })}`)
            .send({ gameName: 'White Water' });
        expect(res.status).toBe(200);
        const db = await getDatabase();
        await db.run('DELETE FROM games WHERE id = ?', res.body.gameId);

        board.resolve('ISC_STRAY');
        await drainBackgroundTasks();

        const rows = await problemRows(roomId);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.summary).toContain('ISC_STRAY');
        expect(fake.repositionLineup).not.toHaveBeenCalled();
    });

    it('a room with iScored off answers "skipped" and opens no session', async () => {
        const { roomId, tournamentId } = await seedIScoredRoom();
        await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
        const factory = vi.fn(() => makeFakeClient(async () => 'NEVER').client);
        IScoredSessionRegistry.getInstance().setClientFactoryForTests(factory);

        const res = await request(await roomsApp())
            .post(`/api/rooms/${roomId}/tournaments/${tournamentId}/activate-game`)
            .set('Authorization', `Bearer ${signToken({ role: 'room_admin', gameRoomIds: [roomId] })}`)
            .send({ gameName: 'White Water' });
        await drainBackgroundTasks();

        expect(res.status).toBe(200);
        expect(res.body.iscoredStatus).toBe('skipped');
        expect((await gameNamed(tournamentId, 'White Water'))?.status).toBe('ACTIVE');
        expect(factory).not.toHaveBeenCalled();
    });
});

describe('POST /pick-game — a win pick activates before the board is built', () => {
    const savedEnv = { user: process.env.ISCORED_USERNAME, pass: process.env.ISCORED_PASSWORD };
    beforeEach(() => {
        // The web pick still gates iScored on the env account being configured.
        process.env.ISCORED_USERNAME = 'envacct';
        process.env.ISCORED_PASSWORD = 'envpw';
    });
    afterEach(() => {
        if (savedEnv.user === undefined) delete process.env.ISCORED_USERNAME; else process.env.ISCORED_USERNAME = savedEnv.user;
        if (savedEnv.pass === undefined) delete process.env.ISCORED_PASSWORD; else process.env.ISCORED_PASSWORD = savedEnv.pass;
    });

    it('answers "activated" with no board yet, then links it', async () => {
        const { roomId, tournamentId } = await seedIScoredRoom();
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET max_active_games = 1, winner_picks = 1 WHERE id = ?', tournamentId);
        PickAwardGate.invalidate();
        await db.run(
            `INSERT INTO global_games (id, name, type, platforms, features, status)
             VALUES (?, 'White Water', 'pinball', '["vpx"]', '[]', 'approved')`,
            crypto.randomUUID(),
        );
        const wonGameId = await createTestGame(tournamentId, { status: 'COMPLETED', name: 'High Speed' });
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, picker_discord_id, picker_type, picker_designated_at, reminder_count, won_game_id)
             VALUES (?, ?, '[Pending Pick]', 'QUEUED', 'PICKER_1', 'WINNER', ?, 0, ?)`,
            crypto.randomUUID(), tournamentId, new Date().toISOString(), wonGameId,
        );

        const board = deferred<string>();
        const fake = makeFakeClient(() => board.promise);
        IScoredSessionRegistry.getInstance().setClientFactoryForTests(() => fake.client);

        const token = signToken({ role: 'player', gameRoomIds: [roomId], discordId: 'PICKER_1', username: 'Picker' } as never);
        const res = await request(await roomsApp())
            .post(`/api/rooms/${roomId}/pick-game`)
            .set('Authorization', `Bearer ${token}`)
            .send({ tournamentId, gameName: 'White Water' });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('activated');
        const before = await gameNamed(tournamentId, 'White Water');
        expect(before?.status).toBe('ACTIVE');
        expect(before?.iscored_id).toBeNull();

        board.resolve('ISC_PICK');
        await drainBackgroundTasks();
        expect((await gameNamed(tournamentId, 'White Water'))?.iscored_id).toBe('ISC_PICK');
        expect(fake.setGameTags).toHaveBeenCalledWith('ISC_PICK', 'PB-WEEKLY');
    });
});

describe('iScored game-list helpers', () => {
    it('isConfirmedEmptyGameList accepts only an OK answer with no games', () => {
        expect(isConfirmedEmptyGameList({ ok: true, text: '[]' })).toBe(true);
        expect(isConfirmedEmptyGameList({ ok: true, text: ' [ ] ' })).toBe(true);
        expect(isConfirmedEmptyGameList({ ok: true, text: '' })).toBe(true);
        expect(isConfirmedEmptyGameList({ ok: true, text: 'null' })).toBe(true);
        expect(isConfirmedEmptyGameList({ ok: false, text: '' })).toBe(false);
        expect(isConfirmedEmptyGameList({ ok: true, text: '[{"GameID":1,"GameName":"X"}]' })).toBe(false);
        expect(isConfirmedEmptyGameList({ ok: true, text: '<html>login</html>' })).toBe(false);
        expect(isConfirmedEmptyGameList({ ok: true, text: '{}' })).toBe(false);
    });

    it('pickCreatedGameRow prefers the row named like the request when several are new', () => {
        expect(pickCreatedGameRow([], 'White Water')).toBeNull();
        expect(pickCreatedGameRow([{ id: '1', name: 'Anything' }], 'White Water')?.id).toBe('1');
        const rows = [
            { id: '1', name: 'Aliens Legacy' },
            { id: '2', name: 'WHITE WATER' },
            { id: '3', name: 'Dark Chaos' },
        ];
        expect(pickCreatedGameRow(rows, 'White Water')?.id).toBe('2');
        // iScored strips apostrophes on save.
        expect(pickCreatedGameRow([{ id: '4', name: 'Gilligans Island' }, { id: '5', name: 'Zzz' }], "Gilligan's Island")?.id).toBe('4');
        // No name match: the old rule (last row) stands.
        expect(pickCreatedGameRow(rows, 'Nope')?.id).toBe('3');
    });
});
