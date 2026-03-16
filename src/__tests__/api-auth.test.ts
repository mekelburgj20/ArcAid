import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb } from './helpers.js';
import { signToken } from '../api/auth.js';

// Build a minimal test app with auth routes
async function createTestApp() {
    await setupTestDb();

    const app = express();
    app.use(express.json());

    const { default: authRouter } = await import('../api/routes/auth.js');
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api/auth', authRouter);
    app.use('/api', globalRouter);

    return app;
}

describe('Auth API', () => {
    describe('POST /api/auth/login', () => {
        it('creates admin password on first login and returns token', async () => {
            const app = await createTestApp();

            const res = await request(app)
                .post('/api/auth/login')
                .send({ password: 'testpassword123' });

            expect(res.status).toBe(200);
            expect(res.body.token).toBeTruthy();
            expect(typeof res.body.token).toBe('string');
        });

        it('rejects wrong password after initial setup', async () => {
            const app = await createTestApp();

            // First login sets the password
            await request(app)
                .post('/api/auth/login')
                .send({ password: 'correctpassword' });

            // Wrong password
            const res = await request(app)
                .post('/api/auth/login')
                .send({ password: 'wrongpassword' });

            expect(res.status).toBe(401);
            expect(res.body.error).toBe('Invalid password');
        });

        it('accepts correct password after initial setup', async () => {
            const app = await createTestApp();

            await request(app)
                .post('/api/auth/login')
                .send({ password: 'mypassword' });

            const res = await request(app)
                .post('/api/auth/login')
                .send({ password: 'mypassword' });

            expect(res.status).toBe(200);
            expect(res.body.token).toBeTruthy();
        });

        it('returns 400 when password is missing', async () => {
            const app = await createTestApp();

            const res = await request(app)
                .post('/api/auth/login')
                .send({});

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Password required');
        });
    });

    describe('GET /api/auth/me', () => {
        it('returns user info for valid token', async () => {
            const app = await createTestApp();
            const token = signToken({ role: 'super_admin', gameRoomIds: [], username: 'TestAdmin' });

            const res = await request(app)
                .get('/api/auth/me')
                .set('Authorization', `Bearer ${token}`);

            expect(res.status).toBe(200);
            expect(res.body.role).toBe('super_admin');
            expect(res.body.username).toBe('TestAdmin');
        });

        it('returns 401 without token', async () => {
            const app = await createTestApp();

            const res = await request(app).get('/api/auth/me');

            expect(res.status).toBe(401);
        });

        it('returns 401 with invalid token', async () => {
            const app = await createTestApp();

            const res = await request(app)
                .get('/api/auth/me')
                .set('Authorization', 'Bearer invalid-token');

            expect(res.status).toBe(401);
        });
    });
});

describe('Status API', () => {
    describe('GET /api/status', () => {
        it('returns online status with health checks', async () => {
            const app = await createTestApp();

            const res = await request(app).get('/api/status');

            expect(res.status).toBe(200);
            expect(res.body.status).toBe('online');
            expect(res.body.checks).toBeTruthy();
            expect(res.body.checks.database.status).toBe('ok');
            expect(res.body.uptime).toBeGreaterThanOrEqual(0);
        });
    });
});
