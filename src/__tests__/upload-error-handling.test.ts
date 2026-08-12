import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import multer from 'multer';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { withUploadErrors } from '../api/uploadMiddleware.js';
import * as logger from '../utils/logger.js';

/**
 * Owner field report (2026-08-11): a mobile score submission with a photo
 * attached failed with the bare generic "Submission failed" and ZERO server
 * log lines. Root cause: multer's `fileFilter`/`LIMIT_FILE_SIZE` rejections
 * bypass the route handler and hit Express's default (unlogged, non-JSON)
 * error handler. `withUploadErrors` fixes that — this covers the wrapper
 * directly plus one real route wired through it.
 */

const VALID_PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(8),
]);

function playerToken(discordId: string, username: string, roomId = '') {
    return signToken({ role: 'player', gameRoomIds: roomId ? [roomId] : [], discordId, username });
}

async function seedCatalogueGame(gameName: string, platforms = ['real']) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_games (id, name, type, platforms, status)
         VALUES (?, ?, 'pinball', ?, 'approved')`,
        id, gameName, JSON.stringify(platforms),
    );
    return id;
}

describe('withUploadErrors wrapper', () => {
    it('translates a MulterError LIMIT_FILE_SIZE into a JSON 400 with the size-limit message', async () => {
        const app = express();
        const stubMiddleware = (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
            next(new multer.MulterError('LIMIT_FILE_SIZE'));
        };
        app.post('/upload', withUploadErrors(stubMiddleware), (_req, res) => {
            res.status(201).json({ ok: true });
        });

        const res = await request(app).post('/upload').send();
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ error: expect.stringMatching(/30MB/) });
    });

    it('translates a fileFilter Error (unsupported mimetype) into a JSON 400 carrying that message', async () => {
        const app = express();
        const stubMiddleware = (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
            next(new Error('Only PNG, APNG, JPEG, and WebP images are allowed'));
        };
        app.post('/upload', withUploadErrors(stubMiddleware), (_req, res) => {
            res.status(201).json({ ok: true });
        });

        const res = await request(app).post('/upload').send();
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Only PNG, APNG, JPEG, and WebP images are allowed' });
    });

    it('translates busboy\'s "Unexpected end of form" (truncated multipart stream) into an actionable JSON 400', async () => {
        // v2.100.4 field evidence: iOS Safari's lazy camera-roll File reference
        // can truncate the upload mid-stream; the raw busboy message reached
        // players verbatim ("unexpected end of form"). The wrapper now
        // translates it; the FE materialization fix addresses the cause.
        const app = express();
        const stubMiddleware = (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
            next(new Error('Unexpected end of form'));
        };
        app.post('/upload', withUploadErrors(stubMiddleware), (_req, res) => {
            res.status(201).json({ ok: true });
        });

        const res = await request(app).post('/upload').send();
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'The photo upload was interrupted before it finished — please try again.' });
    });

    it('translates any other MulterError code into a generic JSON 400', async () => {
        const app = express();
        const stubMiddleware = (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
            next(new multer.MulterError('LIMIT_UNEXPECTED_FILE'));
        };
        app.post('/upload', withUploadErrors(stubMiddleware), (_req, res) => {
            res.status(201).json({ ok: true });
        });

        const res = await request(app).post('/upload').send();
        expect(res.status).toBe(400);
        expect(res.body.error).toBeTruthy();
    });

    it('calls through to the route handler when there is no upload error', async () => {
        const app = express();
        const stubMiddleware = (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
            next();
        };
        const handler = vi.fn((_req: express.Request, res: express.Response) => res.status(201).json({ ok: true }));
        app.post('/upload', withUploadErrors(stubMiddleware), handler);

        const res = await request(app).post('/upload').send();
        expect(res.status).toBe(201);
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('logs one warning line naming the route path and mimetype on rejection', async () => {
        const spy = vi.spyOn(logger, 'logWarn').mockImplementation(() => {});
        const app = express();
        const stubMiddleware = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
            req._uploadRejectedFile = { mimetype: 'image/heic', originalname: 'IMG_0001.heic' };
            next(new Error('Only PNG, APNG, JPEG, and WebP images are allowed'));
        };
        app.post('/upload-route', withUploadErrors(stubMiddleware), (_req, res) => res.status(201).json({ ok: true }));

        const res = await request(app).post('/upload-route').send();
        expect(res.status).toBe(400);
        expect(spy).toHaveBeenCalledTimes(1);
        const [message, meta] = spy.mock.calls[0] as [string, { mimetype?: string }];
        expect(message).toContain('/upload-route');
        expect(meta).toMatchObject({ mimetype: 'image/heic' });

        spy.mockRestore();
    });
});

describe('withUploadErrors wired into a real route (submit-score)', () => {
    async function createTestApp() {
        await setupTestDb();
        const app = express();
        app.use(express.json());
        const { default: roomsRouter } = await import('../api/routes/rooms.js');
        app.use('/api/rooms', roomsRouter);
        return app;
    }

    it('rejects an unsupported mimetype (e.g. image/heic) with a JSON 400 naming the allowed formats', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('upload-heic', 'Upload HEIC');
        const gameName = 'Upload HEIC Game';
        await seedCatalogueGame(gameName);
        const token = playerToken('upload-user-1', 'UploadOne', roomId);

        const res = await request(app)
            .post(`/api/rooms/${roomId}/submit-score/${encodeURIComponent(gameName)}`)
            .set('Authorization', `Bearer ${token}`)
            .field('score', '1000')
            .field('engine', 'real')
            .field('device', 'real_cabinet')
            .attach('photo', Buffer.from('not-really-a-heic-but-content-does-not-matter'), {
                filename: 'IMG_0001.heic',
                contentType: 'image/heic',
            });

        expect(res.status).toBe(400);
        expect(res.type).toMatch(/json/);
        expect(res.body.error).toMatch(/PNG.*JPEG.*WebP|PNG, APNG, JPEG, and WebP/i);
    });

    it('still accepts a valid PNG through the wrapper (handler runs, score is stored)', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('upload-png', 'Upload PNG');
        const gameName = 'Upload PNG Game';
        await seedCatalogueGame(gameName);
        const token = playerToken('upload-user-2', 'UploadTwo', roomId);

        const res = await request(app)
            .post(`/api/rooms/${roomId}/submit-score/${encodeURIComponent(gameName)}`)
            .set('Authorization', `Bearer ${token}`)
            .field('score', '1000')
            .field('engine', 'real')
            .field('device', 'real_cabinet')
            .attach('photo', VALID_PNG, { filename: 'score.png', contentType: 'image/png' });

        expect(res.status).toBe(201);
    });
});
