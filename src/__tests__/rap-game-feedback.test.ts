import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { GlobalGameService } from '../services/GlobalGameService.js';

// Report-a-problem (v2.25.0). Covers:
//   (a) POST /global/games/:id/feedback — authz, server-side current-value
//       snapshot, duplicate-open-report 409, refile-after-resolve,
//   (b) the super-admin queue list + resolve routes,
//   (c) field_sources stamping at the GlobalGameService chokepoints
//       (upsert insert / upsert cross-source update / manual update).

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

// Fresh client IP per call — the writeLimiter on the report route is IP-keyed
// and its in-memory store survives across tests in this file (s11 pattern).
let ipCounter = 1;
function freshIp(): string {
    const n = ipCounter++;
    return `10.99.${(n >> 8) & 0xff}.${n & 0xff}`;
}

function playerToken(discordId = '111222333444555666'): string {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username: 'reporter' });
}

function superToken(): string {
    return signToken({ role: 'super_admin', gameRoomIds: [], discordId: '999888777666555444', username: 'admin' });
}

async function seedGame(overrides: Record<string, unknown> = {}): Promise<string> {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_games (id, name, manufacturer, year, type, status, platforms)
         VALUES (?, ?, ?, ?, 'pinball', 'approved', ?)`,
        id,
        overrides.name ?? 'Feedback Test Game',
        overrides.manufacturer ?? 'Stern',
        overrides.year ?? 2001,
        overrides.platforms ?? '["vpx","real"]',
    );
    return id;
}

describe('POST /api/global/games/:id/feedback', () => {
    it('rejects unauthenticated reports with 401', async () => {
        const app = await createApp();
        const gameId = await seedGame();
        const res = await request(app)
            .post(`/api/global/games/${gameId}/feedback`)
            .set('X-Forwarded-For', freshIp())
            .send({ field: 'manufacturer', suggested_value: 'Bally' });
        expect(res.status).toBe(401);
    });

    it('files a report and snapshots the current value server-side', async () => {
        const app = await createApp();
        const gameId = await seedGame({ manufacturer: 'Stern' });
        const res = await request(app)
            .post(`/api/global/games/${gameId}/feedback`)
            .set('Authorization', `Bearer ${playerToken()}`)
            .set('X-Forwarded-For', freshIp())
            .send({ field: 'manufacturer', suggested_value: 'Bally', note: 'IPDB says Bally' });
        expect(res.status).toBe(201);
        const db = await getDatabase();
        const row = await db.get(
            'SELECT * FROM game_feedback WHERE id = ?', res.body.id,
        );
        expect(row.global_game_id).toBe(gameId);
        expect(row.game_name).toBe('Feedback Test Game');
        expect(row.field).toBe('manufacturer');
        // Snapshotted from the DB, not from anything the client sent
        expect(row.current_value).toBe('Stern');
        expect(row.suggested_value).toBe('Bally');
        expect(row.resolved_at).toBeNull();
    });

    it('409s a duplicate OPEN report on the same field, allows refile after resolution', async () => {
        const app = await createApp();
        const gameId = await seedGame();
        const token = playerToken();
        const first = await request(app)
            .post(`/api/global/games/${gameId}/feedback`)
            .set('Authorization', `Bearer ${token}`)
            .set('X-Forwarded-For', freshIp())
            .send({ field: 'year', suggested_value: '1995' });
        expect(first.status).toBe(201);

        const dup = await request(app)
            .post(`/api/global/games/${gameId}/feedback`)
            .set('Authorization', `Bearer ${token}`)
            .set('X-Forwarded-For', freshIp())
            .send({ field: 'year', suggested_value: '1996' });
        expect(dup.status).toBe(409);

        // A DIFFERENT field from the same reporter is fine
        const otherField = await request(app)
            .post(`/api/global/games/${gameId}/feedback`)
            .set('Authorization', `Bearer ${token}`)
            .set('X-Forwarded-For', freshIp())
            .send({ field: 'artwork', note: 'wrong backglass' });
        expect(otherField.status).toBe(201);

        // Resolve the year report → refiling becomes possible
        const { GameFeedbackService } = await import('../services/GameFeedbackService.js');
        await GameFeedbackService.resolve({ id: first.body.id, resolution: 'dismissed', resolvedBy: 'admin' });
        const refile = await request(app)
            .post(`/api/global/games/${gameId}/feedback`)
            .set('Authorization', `Bearer ${token}`)
            .set('X-Forwarded-For', freshIp())
            .send({ field: 'year', suggested_value: '1996' });
        expect(refile.status).toBe(201);
    });

    it('404s an unknown game and 400s an empty report', async () => {
        const app = await createApp();
        const missing = await request(app)
            .post(`/api/global/games/${crypto.randomUUID()}/feedback`)
            .set('Authorization', `Bearer ${playerToken()}`)
            .set('X-Forwarded-For', freshIp())
            .send({ field: 'name', suggested_value: 'X' });
        expect(missing.status).toBe(404);

        const gameId = await seedGame();
        const empty = await request(app)
            .post(`/api/global/games/${gameId}/feedback`)
            .set('Authorization', `Bearer ${playerToken()}`)
            .set('X-Forwarded-For', freshIp())
            .send({ field: 'name' });
        expect(empty.status).toBe(400);
    });
});

describe('admin queue — GET/resolve /api/admin/catalogue/feedback', () => {
    it('rejects non-super-admin tokens', async () => {
        const app = await createApp();
        const res = await request(app)
            .get('/api/admin/catalogue/feedback')
            .set('Authorization', `Bearer ${playerToken()}`)
            .set('X-Forwarded-For', freshIp());
        expect([401, 403]).toContain(res.status);
    });

    it('lists open reports with live game context and resolves them', async () => {
        const app = await createApp();
        const gameId = await seedGame({ manufacturer: 'Stern', year: 2001 });
        const filed = await request(app)
            .post(`/api/global/games/${gameId}/feedback`)
            .set('Authorization', `Bearer ${playerToken()}`)
            .set('X-Forwarded-For', freshIp())
            .send({ field: 'year', suggested_value: '1999' });
        expect(filed.status).toBe(201);

        const list = await request(app)
            .get('/api/admin/catalogue/feedback')
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp());
        expect(list.status).toBe(200);
        expect(list.body).toHaveLength(1);
        expect(list.body[0].live_name).toBe('Feedback Test Game');
        expect(list.body[0].manufacturer).toBe('Stern');

        const resolve = await request(app)
            .post(`/api/admin/catalogue/feedback/${filed.body.id}/resolve`)
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp())
            .send({ resolution: 'upstream', note: 'Year comes from IPDB — dispute there.' });
        expect(resolve.status).toBe(200);

        const openAfter = await request(app)
            .get('/api/admin/catalogue/feedback')
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp());
        expect(openAfter.body).toHaveLength(0);

        const resolved = await request(app)
            .get('/api/admin/catalogue/feedback?status=resolved')
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp());
        expect(resolved.body).toHaveLength(1);
        expect(resolved.body[0].resolution).toBe('upstream');

        // Second resolve of the same report → 404
        const again = await request(app)
            .post(`/api/admin/catalogue/feedback/${filed.body.id}/resolve`)
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp())
            .send({ resolution: 'dismissed' });
        expect(again.status).toBe(404);
    });

    it('report survives its game being deleted (FK-less + denormalized name)', async () => {
        const app = await createApp();
        const gameId = await seedGame({ name: 'Doomed Game' });
        const filed = await request(app)
            .post(`/api/global/games/${gameId}/feedback`)
            .set('Authorization', `Bearer ${playerToken()}`)
            .set('X-Forwarded-For', freshIp())
            .send({ field: 'name', suggested_value: 'Renamed' });
        expect(filed.status).toBe(201);

        await GlobalGameService.delete(gameId);

        const list = await request(app)
            .get('/api/admin/catalogue/feedback')
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp());
        expect(list.status).toBe(200);
        expect(list.body).toHaveLength(1);
        expect(list.body[0].game_name).toBe('Doomed Game'); // denormalized
        expect(list.body[0].live_name).toBeNull();           // LEFT JOIN miss
    });
});

describe('field_sources stamping', () => {
    it('upsert INSERT stamps supplied fields with the input source', async () => {
        await setupTestDb();
        const { id } = await GlobalGameService.upsert({
            name: 'Stamp Test', manufacturer: 'Stern', year: 2001,
            type: 'pinball', platforms: ['vpx'], imported_from: 'vps',
        });
        const db = await getDatabase();
        const row = await db.get<{ field_sources: string }>(
            'SELECT field_sources FROM global_games WHERE id = ?', id,
        );
        const fs = JSON.parse(row!.field_sources);
        expect(fs.name).toBe('vps');
        expect(fs.manufacturer).toBe('vps');
        expect(fs.year).toBe('vps');
        expect(fs.platforms).toBe('vps');
        expect(fs.display_name).toBeUndefined(); // not supplied → not stamped
    });

    it('cross-source upsert UPDATE re-stamps only the fields the new source supplies', async () => {
        await setupTestDb();
        const { id } = await GlobalGameService.upsert({
            name: 'Stamp Test 2', manufacturer: 'Stern', year: 2001,
            type: 'pinball', display_name: 'Stamp II', imported_from: 'vps',
        });
        const second = await GlobalGameService.upsert({
            name: 'Stamp Test 2', manufacturer: 'Stern', year: 2001,
            type: 'pinball', description: 'from opdb', imported_from: 'opdb',
        });
        expect(second.id).toBe(id);
        expect(second.action).toBe('updated');
        const db = await getDatabase();
        const row = await db.get<{ field_sources: string }>(
            'SELECT field_sources FROM global_games WHERE id = ?', id,
        );
        const fs = JSON.parse(row!.field_sources);
        expect(fs.display_name).toBe('vps');       // untouched by opdb input
        expect(fs.description).toBe('opdb');       // newly supplied
        expect(fs.manufacturer).toBe('opdb');      // supplied (identity match) → re-stamped
    });

    it("manual update() stamps 'manual' presence-based (explicit null = deliberate clear)", async () => {
        await setupTestDb();
        const { id } = await GlobalGameService.upsert({
            name: 'Stamp Test 3', manufacturer: 'Stern', year: 2001,
            type: 'pinball', imported_from: 'vps',
        });
        await GlobalGameService.update(id, { manufacturer: 'Bally', year: null });
        const db = await getDatabase();
        const row = await db.get<{ field_sources: string; manufacturer: string | null; year: number | null }>(
            'SELECT field_sources, manufacturer, year FROM global_games WHERE id = ?', id,
        );
        expect(row!.manufacturer).toBe('Bally');
        expect(row!.year).toBeNull();
        const fs = JSON.parse(row!.field_sources);
        expect(fs.manufacturer).toBe('manual');
        expect(fs.year).toBe('manual');
        expect(fs.name).toBe('vps'); // not touched by the manual edit
    });
});
