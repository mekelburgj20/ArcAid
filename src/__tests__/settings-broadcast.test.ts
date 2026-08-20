import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { signToken } from '../api/auth.js';

/**
 * The kiosk-live loop (C1). A room settings write has to tell the room's open
 * screens — the kiosk on the wall, every public scoreboard, the other admins —
 * that the appearance changed, or a save made from a phone in the game room
 * changes nothing anyone can see until someone reloads a page.
 *
 * The emitter itself is a no-op without a live Socket.io server (`io` is null
 * outside `initWebSocket`), so this mocks the websocket module and asserts the
 * ROUTE calls it, room-scoped, after a successful save. The empty payload is
 * part of the contract: clients refetch `GET /:roomId/scoreboard-config`
 * (which has its own key allowlist) rather than trust a pushed body.
 */

const emitSettingsUpdated = vi.fn();
const emitLeaderboardUpdated = vi.fn();

vi.mock('../api/websocket.js', () => ({
    emitSettingsUpdated: (...args: unknown[]) => emitSettingsUpdated(...args),
    emitLeaderboardUpdated: (...args: unknown[]) => emitLeaderboardUpdated(...args),
    emitScoreNew: vi.fn(),
    emitScoreNewGlobal: vi.fn(),
    emitLobbyEvent: vi.fn(),
    getIO: () => null,
}));

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

function adminToken(roomId: string) {
    return signToken({ role: 'room_admin', gameRoomIds: [roomId] });
}

describe('settings:updated broadcast', () => {
    beforeEach(() => {
        emitSettingsUpdated.mockClear();
    });

    it('POST /:roomId/settings broadcasts to the room after a successful save', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();

        const res = await request(app)
            .post(`/api/rooms/${roomId}/settings`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ SCOREBOARD_STYLE: 'showcase' });

        expect(res.status).toBe(200);
        expect(emitSettingsUpdated).toHaveBeenCalledTimes(1);
        expect(emitSettingsUpdated).toHaveBeenCalledWith(roomId);
    });

    it('does not broadcast when the payload fails validation', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();

        const res = await request(app)
            .post(`/api/rooms/${roomId}/settings`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ SCOREBOARD_STYLE: 42 });

        expect(res.status).toBe(400);
        expect(emitSettingsUpdated).not.toHaveBeenCalled();
    });

    it('does not broadcast for an unauthenticated write', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();

        const res = await request(app)
            .post(`/api/rooms/${roomId}/settings`)
            .send({ SCOREBOARD_STYLE: 'showcase' });

        expect(res.status).toBe(401);
        expect(emitSettingsUpdated).not.toHaveBeenCalled();
    });
});
