import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';

// S22 Phase 1 content moderation (v2.43.0, tmp/s22-moderation-contract.md) —
// covers the new content_reports table: room reports + player-name reports,
// the anti-spam partial-unique-index dedup, and the super-admin queue.

async function createApp() {
    await setupTestDb();
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    const { default: adminRouter } = await import('../api/routes/admin.js');
    app.use('/api/admin', adminRouter);
    app.use('/api', globalRouter);
    return app;
}

// Fresh client IP per call — writeLimiter is IP-keyed and its in-memory store
// survives across tests in this file (s11/rap-game-feedback pattern).
let ipCounter = 1;
function freshIp(): string {
    const n = ipCounter++;
    return `10.98.${(n >> 8) & 0xff}.${n & 0xff}`;
}

function playerToken(discordId = '111222333444555666'): string {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username: 'reporter' });
}

function roomAdminToken(roomId: string): string {
    return signToken({ role: 'room_admin', gameRoomIds: [roomId] });
}

function superToken(): string {
    return signToken({ role: 'super_admin', gameRoomIds: [], discordId: '999888777666555444', username: 'admin' });
}

describe('POST /api/global/rooms/:roomId/report', () => {
    it('401s a guest (no token)', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('cr-room-1', 'Room One');
        const res = await request(app)
            .post(`/api/global/rooms/${roomId}/report`)
            .set('X-Forwarded-For', freshIp())
            .send({ reason: 'bad room' });
        expect(res.status).toBe(401);
    });

    it('404s an unknown room', async () => {
        const app = await createApp();
        const res = await request(app)
            .post('/api/global/rooms/does-not-exist/report')
            .set('Authorization', `Bearer ${playerToken()}`)
            .set('X-Forwarded-For', freshIp())
            .send({});
        expect(res.status).toBe(404);
    });

    it('happy path: 200 + row persisted', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('cr-room-2', 'Room Two');
        const res = await request(app)
            .post(`/api/global/rooms/${roomId}/report`)
            .set('Authorization', `Bearer ${playerToken()}`)
            .set('X-Forwarded-For', freshIp())
            .send({ reason: 'This room is spamming' });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);

        const db = await getDatabase();
        const row = await db.get('SELECT * FROM content_reports WHERE target_type = ?', 'room');
        expect(row.game_room_id).toBe(roomId);
        expect(row.target_name).toBe('Room Two');
        expect(row.reason).toBe('This room is spamming');
        expect(row.resolved_at).toBeNull();
    });

    it('409s a duplicate OPEN report on the same room from the same reporter', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('cr-room-3', 'Room Three');
        const token = playerToken();
        const first = await request(app)
            .post(`/api/global/rooms/${roomId}/report`)
            .set('Authorization', `Bearer ${token}`)
            .set('X-Forwarded-For', freshIp())
            .send({});
        expect(first.status).toBe(200);

        const dup = await request(app)
            .post(`/api/global/rooms/${roomId}/report`)
            .set('Authorization', `Bearer ${token}`)
            .set('X-Forwarded-For', freshIp())
            .send({});
        expect(dup.status).toBe(409);
    });

    it('allows a re-report once the prior report is resolved', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('cr-room-4', 'Room Four');
        const token = playerToken();
        const first = await request(app)
            .post(`/api/global/rooms/${roomId}/report`)
            .set('Authorization', `Bearer ${token}`)
            .set('X-Forwarded-For', freshIp())
            .send({});
        expect(first.status).toBe(200);

        const { ContentReportService } = await import('../services/ContentReportService.js');
        const db = await getDatabase();
        const row = await db.get('SELECT id FROM content_reports WHERE target_type = ?', 'room');
        await ContentReportService.dismiss(row.id, 'admin');

        const again = await request(app)
            .post(`/api/global/rooms/${roomId}/report`)
            .set('Authorization', `Bearer ${token}`)
            .set('X-Forwarded-For', freshIp())
            .send({});
        expect(again.status).toBe(200);
    });
});

describe('POST /api/global/report-name', () => {
    it('401s a guest', async () => {
        const app = await createApp();
        const res = await request(app)
            .post('/api/global/report-name')
            .set('X-Forwarded-For', freshIp())
            .send({ targetName: 'BadActor' });
        expect(res.status).toBe(401);
    });

    it('400s a missing targetName', async () => {
        const app = await createApp();
        const res = await request(app)
            .post('/api/global/report-name')
            .set('Authorization', `Bearer ${playerToken()}`)
            .set('X-Forwarded-For', freshIp())
            .send({});
        expect(res.status).toBe(400);
    });

    it('keys dedup by IDENTITY when targetUserId is known — same identity under a different room/name still 409s', async () => {
        const app = await createApp();
        const roomA = await createTestRoom('cr-name-room-a', 'Room A');
        const roomB = await createTestRoom('cr-name-room-b', 'Room B');
        const token = playerToken();

        const first = await request(app)
            .post('/api/global/report-name')
            .set('Authorization', `Bearer ${token}`)
            .set('X-Forwarded-For', freshIp())
            .send({ roomId: roomA, targetUserId: 'discord-target-1', targetName: 'Bob' });
        expect(first.status).toBe(200);

        // Same identity, different room + different typed name — still keyed
        // on the identity, so this is a duplicate.
        const second = await request(app)
            .post('/api/global/report-name')
            .set('Authorization', `Bearer ${token}`)
            .set('X-Forwarded-For', freshIp())
            .send({ roomId: roomB, targetUserId: 'discord-target-1', targetName: 'Bob_2' });
        expect(second.status).toBe(409);
    });

    it('keys dedup by (room, name) when targetUserId is absent', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('cr-name-room-c', 'Room C');
        const token = playerToken();

        const first = await request(app)
            .post('/api/global/report-name')
            .set('Authorization', `Bearer ${token}`)
            .set('X-Forwarded-For', freshIp())
            .send({ roomId, targetName: 'AnonTroll' });
        expect(first.status).toBe(200);

        const dup = await request(app)
            .post('/api/global/report-name')
            .set('Authorization', `Bearer ${token}`)
            .set('X-Forwarded-For', freshIp())
            .send({ roomId, targetName: 'AnonTroll' });
        expect(dup.status).toBe(409);

        // A DIFFERENT name in the same room is not a duplicate.
        const otherName = await request(app)
            .post('/api/global/report-name')
            .set('Authorization', `Bearer ${token}`)
            .set('X-Forwarded-For', freshIp())
            .send({ roomId, targetName: 'OtherTroll' });
        expect(otherName.status).toBe(200);
    });

    it('429s a reporter who exceeds the open-report cap', async () => {
        const app = await createApp();
        const db = await getDatabase();
        const reporter = '111222333444555666';
        for (let i = 0; i < 20; i++) {
            await db.run(
                `INSERT INTO content_reports (target_type, target_key, target_name, reporter_user_id)
                 VALUES ('player_name', ?, ?, ?)`,
                `name:global:spam${i}`, `Spam${i}`, reporter,
            );
        }
        const res = await request(app)
            .post('/api/global/report-name')
            .set('Authorization', `Bearer ${playerToken(reporter)}`)
            .set('X-Forwarded-For', freshIp())
            .send({ targetName: 'OneMoreSpam' });
        expect(res.status).toBe(429);
    });
});

describe('super-admin reports queue authz', () => {
    it('403s a non-super-admin token (room admin)', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('cr-authz-1');
        const res = await request(app)
            .get('/api/admin/reports')
            .set('Authorization', `Bearer ${roomAdminToken(roomId)}`)
            .set('X-Forwarded-For', freshIp());
        expect([401, 403]).toContain(res.status);
    });

    it('403s a player token', async () => {
        const app = await createApp();
        const res = await request(app)
            .get('/api/admin/reports')
            .set('Authorization', `Bearer ${playerToken()}`)
            .set('X-Forwarded-For', freshIp());
        expect([401, 403]).toContain(res.status);
    });

    it('401s no token at all', async () => {
        const app = await createApp();
        const res = await request(app)
            .get('/api/admin/reports')
            .set('X-Forwarded-For', freshIp());
        expect([401, 403]).toContain(res.status);
    });
});

describe('super-admin reports queue — list/dismiss/resolve', () => {
    it('lists pending reports, dismisses one, resolves another', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('cr-queue-1', 'Queue Room');
        const token = playerToken('reporter-a');
        const token2 = playerToken('reporter-b');

        const r1 = await request(app)
            .post(`/api/global/rooms/${roomId}/report`)
            .set('Authorization', `Bearer ${token}`)
            .set('X-Forwarded-For', freshIp())
            .send({ reason: 'first' });
        const r2 = await request(app)
            .post('/api/global/report-name')
            .set('Authorization', `Bearer ${token2}`)
            .set('X-Forwarded-For', freshIp())
            .send({ roomId, targetName: 'Troll', reason: 'second' });
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);

        const list = await request(app)
            .get('/api/admin/reports?status=pending')
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp());
        expect(list.status).toBe(200);
        expect(list.body).toHaveLength(2);
        // Enriched with room context (rooms.ts join-requests idiom)
        expect(list.body.find((r: any) => r.target_type === 'room').room_name).toBe('Queue Room');

        const roomReportId = list.body.find((r: any) => r.target_type === 'room').id;
        const nameReportId = list.body.find((r: any) => r.target_type === 'player_name').id;

        const dismissRes = await request(app)
            .post(`/api/admin/reports/${roomReportId}/dismiss`)
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp());
        expect(dismissRes.status).toBe(200);

        const resolveRes = await request(app)
            .post(`/api/admin/reports/${nameReportId}/resolve`)
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp())
            .send({ resolution: 'Renamed the offending player.' });
        expect(resolveRes.status).toBe(200);

        const pendingAfter = await request(app)
            .get('/api/admin/reports?status=pending')
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp());
        expect(pendingAfter.body).toHaveLength(0);

        const resolvedAfter = await request(app)
            .get('/api/admin/reports?status=resolved')
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp());
        expect(resolvedAfter.body).toHaveLength(2);
        const resolvedNameRow = resolvedAfter.body.find((r: any) => r.id === nameReportId);
        expect(resolvedNameRow.resolution).toBe('Renamed the offending player.');
        const resolvedRoomRow = resolvedAfter.body.find((r: any) => r.id === roomReportId);
        expect(resolvedRoomRow.resolution).toBe('dismissed');
    });

    it('filters by type=room / type=player_name', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('cr-filter-1', 'Filter Room');
        await request(app)
            .post(`/api/global/rooms/${roomId}/report`)
            .set('Authorization', `Bearer ${playerToken('reporter-c')}`)
            .set('X-Forwarded-For', freshIp())
            .send({});
        await request(app)
            .post('/api/global/report-name')
            .set('Authorization', `Bearer ${playerToken('reporter-d')}`)
            .set('X-Forwarded-For', freshIp())
            .send({ roomId, targetName: 'FilterTroll' });

        const roomsOnly = await request(app)
            .get('/api/admin/reports?type=room')
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp());
        expect(roomsOnly.body).toHaveLength(1);
        expect(roomsOnly.body[0].target_type).toBe('room');

        const namesOnly = await request(app)
            .get('/api/admin/reports?type=player_name')
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp());
        expect(namesOnly.body).toHaveLength(1);
        expect(namesOnly.body[0].target_type).toBe('player_name');
    });

    it('dismissing/resolving an already-resolved report 404s', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('cr-double-1');
        const filed = await request(app)
            .post(`/api/global/rooms/${roomId}/report`)
            .set('Authorization', `Bearer ${playerToken()}`)
            .set('X-Forwarded-For', freshIp())
            .send({});
        const list = await request(app)
            .get('/api/admin/reports')
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp());
        const id = list.body[0].id;

        await request(app)
            .post(`/api/admin/reports/${id}/dismiss`)
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp());

        const second = await request(app)
            .post(`/api/admin/reports/${id}/dismiss`)
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp());
        expect(second.status).toBe(404);
    });
});

describe('GET /api/admin/reports/pending-count', () => {
    it('sums open content_reports + open score_reports', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('cr-count-1');
        await request(app)
            .post(`/api/global/rooms/${roomId}/report`)
            .set('Authorization', `Bearer ${playerToken('reporter-e')}`)
            .set('X-Forwarded-For', freshIp())
            .send({});
        await request(app)
            .post('/api/global/report-name')
            .set('Authorization', `Bearer ${playerToken('reporter-f')}`)
            .set('X-Forwarded-For', freshIp())
            .send({ roomId, targetName: 'CountTroll' });

        // Seed one score_reports row directly (no scoreId FK enforcement on that table).
        const db = await getDatabase();
        await db.run(
            `INSERT INTO score_reports (id, score_id, reporter_discord_id, reason) VALUES (?, ?, ?, ?)`,
            'score-report-1', 'nonexistent-score', 'reporter-g', 'bad score',
        );

        const res = await request(app)
            .get('/api/admin/reports/pending-count')
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp());
        expect(res.status).toBe(200);
        expect(res.body.pending).toBe(3);
    });
});
