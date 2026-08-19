import { describe, it, expect } from 'vitest';
import express from 'express';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { GlobalGameService } from '../services/GlobalGameService.js';

/**
 * Identity P2 — the submit response carries a claim offer when the name the
 * score landed under already holds unclaimed iScored-synced scores in the room.
 *
 * `IdentityClaimService.claimOfferForSubmit`'s own rules are covered in
 * `identity-claims.test.ts`; this pins the WIRING — that the handler computes
 * the offer against the RECORDED name and ships it on the response — since a
 * silently-absent field is exactly the failure mode nothing else would catch.
 */

async function playerToken(discordId: string, username: string, roomId: string) {
    return signToken({ role: 'player', gameRoomIds: [roomId], discordId, username });
}

async function seedCatalogueGame(name: string) {
    await GlobalGameService.upsert({
        name,
        type: 'pinball',
        platforms: ['real'],
        source: 'manual',
        status: 'approved',
    } as Parameters<typeof GlobalGameService.upsert>[0]);
}

describe('submit-score — claim offer on the response', () => {
    async function createTestApp() {
        await setupTestDb();
        const app = express();
        app.use(express.json());
        const { default: roomsRouter } = await import('../api/routes/rooms.js');
        app.use('/api/rooms', roomsRouter);
        return app;
    }

    async function submit(app: express.Express, roomId: string, gameName: string, username: string) {
        const request = (await import('supertest')).default;
        const token = await playerToken(`p2-${username}`, username, roomId);
        return request(app)
            .post(`/api/rooms/${roomId}/submit-score/${encodeURIComponent(gameName)}`)
            .set('Authorization', `Bearer ${token}`)
            .field('score', '4200')
            .field('engine', 'real')
            .field('device', 'real_cabinet');
    }

    async function setupRoomWithGame(slug: string, gameName: string) {
        const roomId = await createTestRoom(slug, slug);
        const tournamentId = await createTestTournament(roomId, { name: 'P2 Tournament' });
        await seedCatalogueGame(gameName);
        await createTestGame(tournamentId, { name: gameName, status: 'ACTIVE' });
        return roomId;
    }

    it('offers the synced name the score landed under', async () => {
        const app = await createTestApp();
        const gameName = 'Offer Game';
        const roomId = await setupRoomWithGame('p2-hit-room', gameName);

        const db = await getDatabase();
        for (let i = 0; i < 2; i++) {
            await db.run(
                `INSERT INTO score_history (game_name, iscored_username, score, source, game_room_id, created_at)
                 VALUES (?, 'ChalataLove', ?, 'sync', ?, datetime('now'))`,
                gameName, 900 + i, roomId,
            );
        }

        const res = await submit(app, roomId, gameName, 'ChalataLove');

        expect(res.status).toBe(201);
        expect(res.body.displayName).toBe('ChalataLove');
        expect(res.body.claimOffer).toEqual({ iscoredUsername: 'ChalataLove', syncScoreCount: 2 });
    });

    it('carries a null offer when nothing synced matches, leaving the rest of the response intact', async () => {
        const app = await createTestApp();
        const gameName = 'Quiet Game';
        const roomId = await setupRoomWithGame('p2-miss-room', gameName);

        const res = await submit(app, roomId, gameName, 'NobodyElse');

        expect(res.status).toBe(201);
        expect(res.body.claimOffer).toBeNull();
        expect(res.body.displayName).toBe('NobodyElse');
    });
});
