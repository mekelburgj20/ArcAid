import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { PickAwardGate } from '../services/PickAwardGate.js';

// ---------------------------------------------------------------------------
// Admin queue-on-behalf (v2.121.0).
//
// Owner ask: "I won't be around to pick but I want Medieval Madness if I win"
// — an admin relays that into the player's OWN queue. The endpoint must not be
// a softer door than the player's own `POST /:roomId/pick-game`: it runs the
// identical `PickQueueService` pipeline, so cooldown / platform rules / the
// max-5 cap all still apply, and the row is attributed to the TARGET player
// (`games.picker_discord_id`), never the admin.
// ---------------------------------------------------------------------------

const PLAYER = '111111111111111111';
const ADMIN_DISCORD = '999999999999999999';

async function createTestApp() {
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

const adminToken = (roomId: string) =>
    signToken({ role: 'room_admin', gameRoomIds: [roomId], discordId: ADMIN_DISCORD, username: 'RoomAdmin' } as never);

/** An approved catalogue entry the pick pipeline can resolve. */
async function seedCatalogue(name: string, opts: { platforms?: string[]; type?: string } = {}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO global_games (id, name, type, platforms, features, status)
         VALUES (?, ?, ?, ?, '[]', 'approved')`,
        crypto.randomUUID(), name, opts.type ?? 'pinball', JSON.stringify(opts.platforms ?? ['vpx']),
    );
}

async function seedRoomAndTournament(slug: string) {
    const roomId = await createTestRoom(slug, slug);
    const tournamentId = await createTestTournament(roomId, { name: `${slug} Cup` });
    const db = await getDatabase();
    await db.run('UPDATE tournaments SET winner_picks = 1 WHERE id = ?', tournamentId);
    PickAwardGate.invalidate();
    return { roomId, tournamentId };
}

const queueUrl = (roomId: string, tournamentId: string) =>
    `/api/rooms/${roomId}/admin/tournaments/${tournamentId}/queue`;

describe('POST /:roomId/admin/tournaments/:tournamentId/queue', () => {
    beforeEach(async () => {
        await setupTestDb();
        PickAwardGate.invalidate();
        vi.restoreAllMocks();
    });

    it('queues the game attributed to the target player, not the admin', async () => {
        const app = await createTestApp();
        const { roomId, tournamentId } = await seedRoomAndTournament('qob-happy');
        await seedCatalogue('Medieval Madness');

        const res = await request(app)
            .post(queueUrl(roomId, tournamentId))
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ forUserId: PLAYER, gameName: 'medieval madness' });

        expect(res.status).toBe(200);
        // Catalogue spelling wins over whatever the admin typed.
        expect(res.body.game.name).toBe('Medieval Madness');
        expect(res.body.queue.map((g: { name: string }) => g.name)).toEqual(['Medieval Madness']);

        const db = await getDatabase();
        const row = await db.get(
            `SELECT picker_discord_id, status, queue_order FROM games WHERE tournament_id = ? AND name = 'Medieval Madness'`,
            tournamentId,
        );
        expect(row.picker_discord_id).toBe(PLAYER);
        expect(row.status).toBe('QUEUED');
        expect(row.queue_order).toBe(1);
    });

    it('writes a pick.queue_on_behalf audit row', async () => {
        const app = await createTestApp();
        const { roomId, tournamentId } = await seedRoomAndTournament('qob-audit');
        await seedCatalogue('Attack From Mars');

        await request(app)
            .post(queueUrl(roomId, tournamentId))
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ forUserId: PLAYER, gameName: 'Attack From Mars' })
            .expect(200);

        const db = await getDatabase();
        const audit = await db.get(
            `SELECT actor, action, target_id, details FROM audit_log WHERE action = 'pick.queue_on_behalf'`,
        );
        expect(audit).toBeDefined();
        expect(audit.actor).toBe(ADMIN_DISCORD);
        expect(audit.target_id).toBe(tournamentId);
        expect(JSON.parse(audit.details)).toMatchObject({ forUserId: PLAYER, gameName: 'Attack From Mars' });
    });

    it('rejects once the player already holds five queued games (the shared cap)', async () => {
        const app = await createTestApp();
        const { roomId, tournamentId } = await seedRoomAndTournament('qob-cap');
        const db = await getDatabase();
        for (let i = 1; i <= 5; i++) {
            await db.run(
                `INSERT INTO games (id, tournament_id, name, status, picker_discord_id, queue_order)
                 VALUES (?, ?, ?, 'QUEUED', ?, ?)`,
                crypto.randomUUID(), tournamentId, `Filler ${i}`, PLAYER, i,
            );
        }
        await seedCatalogue('Sixth Table');

        const res = await request(app)
            .post(queueUrl(roomId, tournamentId))
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ forUserId: PLAYER, gameName: 'Sixth Table' });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('QUEUE_FULL');
        expect(res.body.error).toContain('Queue limit reached');
    });

    it('rejects a game inside its cooldown window', async () => {
        const app = await createTestApp();
        const { roomId, tournamentId } = await seedRoomAndTournament('qob-cooldown');
        await seedCatalogue('Recently Played');
        // A COMPLETED instance inside the default 120-day lookback is exactly
        // what TournamentEngine.isGameEligible reads.
        await createTestGame(tournamentId, {
            name: 'Recently Played',
            status: 'COMPLETED',
            startDate: new Date(Date.now() - 2 * 86400_000).toISOString(),
            endDate: new Date(Date.now() - 86400_000).toISOString(),
        });

        const res = await request(app)
            .post(queueUrl(roomId, tournamentId))
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ forUserId: PLAYER, gameName: 'Recently Played' });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('COOLDOWN');
        expect(res.body.error).toContain('cooldown');
    });

    it("rejects a game the tournament's platform rules exclude", async () => {
        const app = await createTestApp();
        const { roomId, tournamentId } = await seedRoomAndTournament('qob-rules');
        const db = await getDatabase();
        await db.run(
            `UPDATE tournaments SET platform_rules = ? WHERE id = ?`,
            JSON.stringify({ engines: { required: ['fx_classic'], excluded: [] }, devices: { required: [], excluded: [] } }),
            tournamentId,
        );
        await seedCatalogue('VPX Only Table', { platforms: ['vpx'] });

        const res = await request(app)
            .post(queueUrl(roomId, tournamentId))
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ forUserId: PLAYER, gameName: 'VPX Only Table' });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PLATFORM_RESTRICTED');
    });

    it('rejects a duplicate already in that player\'s queue', async () => {
        const app = await createTestApp();
        const { roomId, tournamentId } = await seedRoomAndTournament('qob-dupe');
        await seedCatalogue('Twilight Zone');

        await request(app)
            .post(queueUrl(roomId, tournamentId))
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ forUserId: PLAYER, gameName: 'Twilight Zone' })
            .expect(200);

        const res = await request(app)
            .post(queueUrl(roomId, tournamentId))
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ forUserId: PLAYER, gameName: 'twilight zone' });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('DUPLICATE_IN_QUEUE');

        const db = await getDatabase();
        const count = await db.get(
            `SELECT COUNT(*) AS c FROM games WHERE tournament_id = ? AND status = 'QUEUED'`, tournamentId,
        );
        expect(count.c).toBe(1);
    });

    it("403s an admin of a different room", async () => {
        const app = await createTestApp();
        const { roomId, tournamentId } = await seedRoomAndTournament('qob-mine');
        const otherRoomId = await createTestRoom('qob-theirs', 'QOB Theirs');
        await seedCatalogue('Cross Room Table');

        const res = await request(app)
            .post(queueUrl(roomId, tournamentId))
            .set('Authorization', `Bearer ${adminToken(otherRoomId)}`)
            .send({ forUserId: PLAYER, gameName: 'Cross Room Table' });

        expect(res.status).toBe(403);

        const db = await getDatabase();
        const row = await db.get(`SELECT id FROM games WHERE name = 'Cross Room Table'`);
        expect(row).toBeUndefined();
    });

    it('401s an unauthenticated caller', async () => {
        const app = await createTestApp();
        const { roomId, tournamentId } = await seedRoomAndTournament('qob-anon');
        await seedCatalogue('Anon Table');

        const res = await request(app)
            .post(queueUrl(roomId, tournamentId))
            .send({ forUserId: PLAYER, gameName: 'Anon Table' });

        expect(res.status).toBe(401);
    });
});

describe('DELETE /:roomId/admin/tournaments/:tournamentId/queue/:gameId', () => {
    beforeEach(async () => {
        await setupTestDb();
        PickAwardGate.invalidate();
    });

    it("removes another player's queued game and audits it", async () => {
        const app = await createTestApp();
        const { roomId, tournamentId } = await seedRoomAndTournament('qob-del');
        await seedCatalogue('Removable Table');

        const created = await request(app)
            .post(queueUrl(roomId, tournamentId))
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ forUserId: PLAYER, gameName: 'Removable Table' })
            .expect(200);

        const gameId = created.body.game.id;
        const res = await request(app)
            .delete(`${queueUrl(roomId, tournamentId)}/${gameId}`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`);

        expect(res.status).toBe(200);
        expect(res.body.queue).toEqual([]);

        const db = await getDatabase();
        expect(await db.get('SELECT id FROM games WHERE id = ?', gameId)).toBeUndefined();
        const audit = await db.get(`SELECT details FROM audit_log WHERE action = 'pick.queue_remove_on_behalf'`);
        expect(audit).toBeDefined();
        expect(JSON.parse(audit.details)).toMatchObject({ forUserId: PLAYER, gameName: 'Removable Table' });
    });

    it("403s an admin of a different room", async () => {
        const app = await createTestApp();
        const { roomId, tournamentId } = await seedRoomAndTournament('qob-del-cross');
        const otherRoomId = await createTestRoom('qob-del-other', 'QOB Del Other');
        await seedCatalogue('Protected Table');

        const created = await request(app)
            .post(queueUrl(roomId, tournamentId))
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ forUserId: PLAYER, gameName: 'Protected Table' })
            .expect(200);

        const res = await request(app)
            .delete(`${queueUrl(roomId, tournamentId)}/${created.body.game.id}`)
            .set('Authorization', `Bearer ${adminToken(otherRoomId)}`);

        expect(res.status).toBe(403);

        const db = await getDatabase();
        expect(await db.get('SELECT id FROM games WHERE id = ?', created.body.game.id)).toBeDefined();
    });
});

describe('PickQueueService is the SAME gate the player path runs', () => {
    beforeEach(async () => {
        await setupTestDb();
        PickAwardGate.invalidate();
    });

    // The extraction's contract: `POST /pick-game` behaves exactly as before,
    // including its deliberate lack of a duplicate-in-queue guard.
    it('the player queue path still allows what it allowed pre-extraction', async () => {
        const app = await createTestApp();
        const { roomId, tournamentId } = await seedRoomAndTournament('qob-parity');
        await seedCatalogue('Parity Table');
        const db = await getDatabase();
        // Occupy the single slot so the pick path takes its queue branch.
        await createTestGame(tournamentId, { name: 'Live Game', status: 'ACTIVE' });

        const playerToken = signToken({ role: 'player', discordId: PLAYER, username: 'Player' } as never);
        const res = await request(app)
            .post(`/api/rooms/${roomId}/pick-game`)
            .set('Authorization', `Bearer ${playerToken}`)
            .send({ tournamentId, gameName: 'Parity Table' });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('queued');

        const row = await db.get(
            `SELECT picker_discord_id FROM games WHERE tournament_id = ? AND name = 'Parity Table'`, tournamentId,
        );
        expect(row.picker_discord_id).toBe(PLAYER);
    });
});
