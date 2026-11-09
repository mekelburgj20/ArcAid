import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, seedCatalogueGames } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';

/**
 * A34 (v2.233.0): an event round must be a catalogue game (owner 2026-11-08:
 * block it). A host typed "Arkanoid" where AtGames' table is "Arkanoid
 * (Pinball)", and the round joined nothing.
 *
 * Pinned:
 *   - an unknown name is refused, and nothing is written (create AND edit);
 *   - a known name is stored in the catalogue's spelling, with its id;
 *   - a round keeping the name it already had is exempt, so an older event
 *     can still be edited.
 */

const MINUTE = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

async function app() {
    const a = express();
    a.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    a.use('/api/rooms', roomsRouter);
    return a;
}

function body(id: string, gameName: string, name = 'Cabinet Night') {
    const start = Date.now() + 60 * MINUTE;
    return {
        id, name, type: 'CN', format: 'event',
        cadence: { timezone: 'UTC', autoRotate: true, autoLock: true },
        event: {
            rounds: [{ roundNo: 1, gameName, scheduledStartAt: iso(start), scheduledEndAt: iso(start + 30 * MINUTE) }],
            checkinRequired: false, aggregateMethod: 'best', endGraceSec: 120,
        },
    };
}

describe('event rounds must be catalogue games', () => {
    let roomId: string;
    let token: string;

    beforeEach(async () => {
        await setupTestDb();
        await seedCatalogueGames('Arkanoid (Pinball)', 'Medieval Madness');
        roomId = await createTestRoom(`cat-${crypto.randomUUID().slice(0, 8)}`, 'Cat Room');
        token = signToken({ role: 'room_admin', gameRoomIds: [roomId], username: 'admin', discordId: 'admin-1' });
    });

    it('refuses a name the catalogue does not have, and creates nothing', async () => {
        const id = crypto.randomUUID();
        const res = await request(await app())
            .post(`/api/rooms/${roomId}/tournaments`).set('Authorization', `Bearer ${token}`)
            .send(body(id, 'Arkanoid'));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('GAME_NOT_IN_CATALOGUE');
        expect(res.body.games).toEqual(['Arkanoid']);
        expect(res.body.error).toMatch(/"Arkanoid" is not in the game catalogue/);

        const db = await getDatabase();
        expect(await db.get('SELECT 1 FROM tournaments WHERE id = ?', id)).toBeUndefined();
    });

    it("stores a known name in the catalogue's spelling, with its catalogue id", async () => {
        const id = crypto.randomUUID();
        const res = await request(await app())
            .post(`/api/rooms/${roomId}/tournaments`).set('Authorization', `Bearer ${token}`)
            .send(body(id, '  arkanoid (PINBALL) '));
        expect(res.status).toBe(200);

        const db = await getDatabase();
        const round = await db.get<{ name: string; global_game_id: string | null }>(
            'SELECT name, global_game_id FROM games WHERE tournament_id = ? AND round_no = 1', id,
        );
        const cat = await db.get<{ id: string }>(`SELECT id FROM global_games WHERE name = 'Arkanoid (Pinball)'`);
        expect(round!.name).toBe('Arkanoid (Pinball)');
        expect(round!.global_game_id).toBe(cat!.id);
    });

    it('lets an older off-catalogue round be kept, refuses a new unknown name, and a refused edit changes nothing', async () => {
        const id = crypto.randomUUID();
        const a = await app();
        expect((await request(a).post(`/api/rooms/${roomId}/tournaments`).set('Authorization', `Bearer ${token}`)
            .send(body(id, 'Medieval Madness'))).status).toBe(200);

        // An event saved before the rule: its round carries a free-text name.
        const db = await getDatabase();
        await db.run(`UPDATE games SET name = 'Old Free Text' WHERE tournament_id = ? AND round_no = 1`, id);

        const keep = await request(a).put(`/api/rooms/${roomId}/tournaments/${id}`).set('Authorization', `Bearer ${token}`)
            .send(body(id, 'Old Free Text', 'Renamed Night'));
        expect(keep.status).toBe(200);

        const refused = await request(a).put(`/api/rooms/${roomId}/tournaments/${id}`).set('Authorization', `Bearer ${token}`)
            .send(body(id, 'Arkanoid', 'Should Not Stick'));
        expect(refused.status).toBe(400);
        expect(refused.body.code).toBe('GAME_NOT_IN_CATALOGUE');
        const row = await db.get<{ name: string }>('SELECT name FROM tournaments WHERE id = ?', id);
        expect(row!.name).toBe('Renamed Night');
    });
});
