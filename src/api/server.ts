import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { z } from 'zod';
import { logInfo, logError } from '../utils/logger.js';
import { getTerminology } from '../utils/terminology.js';
import { hashPassword, verifyPassword, signToken, getAdminPasswordHash, setAdminPasswordHash } from './auth.js';
import { requireAuth } from './middleware.js';
import { CreateTournamentSchema, UpdateTournamentSchema, ImportGamesSchema, SettingsSchema } from './schemas.js';
import { SettingsService } from '../services/SettingsService.js';
import { TournamentService } from '../services/TournamentService.js';
import { GameLibraryService } from '../services/GameLibraryService.js';
import { LogService } from '../services/LogService.js';

export const serverEvents = new EventEmitter();

function validate<S extends z.ZodTypeAny>(schema: S, data: unknown): { data: z.infer<S> } | { error: string } {
    const result = schema.safeParse(data);
    if (!result.success) {
        return { error: result.error.issues.map((i: z.ZodIssue) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    }
    return { data: result.data as z.infer<S> };
}

export function startApiServer(port: number = 3001) {
    const app = express();

    app.use(cors());
    app.use(express.json());

    // --- Auth Endpoints ---

    app.post('/api/auth/login', async (req, res) => {
        try {
            const { password } = req.body;
            if (!password || typeof password !== 'string') {
                return res.status(400).json({ error: 'Password required' });
            }

            const hash = await getAdminPasswordHash();

            if (!hash) {
                const newHash = await hashPassword(password);
                await setAdminPasswordHash(newHash);
                const token = signToken({ role: 'admin' });
                return res.json({ token });
            }

            const valid = await verifyPassword(password, hash);
            if (!valid) {
                return res.status(401).json({ error: 'Invalid password' });
            }

            const token = signToken({ role: 'admin' });
            res.json({ token });
        } catch (error) {
            logError('API Error (POST /api/auth/login):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.post('/api/auth/change-password', requireAuth, async (req, res) => {
        try {
            const { newPassword } = req.body;
            if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
                return res.status(400).json({ error: 'New password must be at least 8 characters' });
            }
            const hash = await hashPassword(newPassword);
            await setAdminPasswordHash(hash);
            res.json({ success: true });
        } catch (error) {
            logError('API Error (POST /api/auth/change-password):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // --- Status Endpoint ---
    app.get('/api/status', async (req, res) => {
        try {
            const isSetup = await SettingsService.isSetupComplete();
            res.json({
                status: 'online',
                terminologyMode: process.env.TERMINOLOGY_MODE || 'generic',
                terms: getTerminology(),
                needsSetup: !isSetup
            });
        } catch (error) {
            logError('API Error (/api/status):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // --- Logs Endpoint ---
    app.get('/api/logs', (req, res) => {
        try {
            const logs = LogService.getRecentLogs();
            res.json({ logs });
        } catch (error) {
            res.status(500).json({ error: 'Failed to read logs' });
        }
    });

    // --- Settings Endpoints ---
    app.get('/api/settings', requireAuth, async (req, res) => {
        try {
            const settings = await SettingsService.getAll();
            res.json(settings);
        } catch (error) {
            logError('API Error (/api/settings):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.post('/api/settings', requireAuth, async (req, res) => {
        try {
            const validationResult = validate(SettingsSchema, req.body);
            if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

            const settings = validationResult.data;

            if (Object.keys(settings).some(key => key === 'ADMIN_PASSWORD_HASH')) {
                return res.status(400).json({ error: 'ADMIN_PASSWORD_HASH cannot be set via this endpoint' });
            }

            const { needsRestart } = await SettingsService.saveMany(settings);
            res.json({ success: true });

            if (needsRestart) {
                logInfo('Setup complete! Signaling restart...');
                setTimeout(() => serverEvents.emit('restart'), 500);
            }
        } catch (error) {
            logError('API Error (POST /api/settings):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // --- Tournaments Endpoints ---
    app.get('/api/tournaments', async (req, res) => {
        try {
            const rows = await TournamentService.getAll();
            res.json(rows);
        } catch (error) {
            logError('API Error (/api/tournaments):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.post('/api/tournaments', requireAuth, async (req, res) => {
        try {
            const validationResult = validate(CreateTournamentSchema, req.body);
            if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
            await TournamentService.create(validationResult.data);
            res.json({ success: true });
        } catch (error) {
            logError('API Error (POST /api/tournaments):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.put('/api/tournaments/:id', requireAuth, async (req, res) => {
        try {
            const validationResult = validate(UpdateTournamentSchema, req.body);
            if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
            await TournamentService.update(req.params.id as string, validationResult.data);
            res.json({ success: true });
        } catch (error) {
            logError('API Error (PUT /api/tournaments):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.delete('/api/tournaments/:id', requireAuth, async (req, res) => {
        try {
            await TournamentService.delete(req.params.id as string);
            res.json({ success: true });
        } catch (error) {
            logError('API Error (DELETE /api/tournaments):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // --- Game Library Endpoints ---
    app.get('/api/game_library', async (req, res) => {
        try {
            const rows = await GameLibraryService.getAll();
            res.json(rows);
        } catch (error) {
            logError('API Error (/api/game_library):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.post('/api/game_library/import', requireAuth, async (req, res) => {
        try {
            const validationResult = validate(ImportGamesSchema, req.body);
            if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

            const imported = await GameLibraryService.importGames(validationResult.data.games);
            res.json({ success: true, imported });
        } catch (error) {
            logError('API Error (POST /api/game_library/import):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // --- Serve React Frontend (Production) ---
    const frontendPath = path.join(process.cwd(), 'admin-ui', 'dist');
    if (fs.existsSync(frontendPath)) {
        logInfo('Found built Admin UI, serving static files.');
        app.use(express.static(frontendPath));

        app.get(/^(?!\/api).*/, (req, res) => {
            res.sendFile(path.join(frontendPath, 'index.html'));
        });
    }

    app.listen(port, '0.0.0.0', () => {
        logInfo(`Admin API Server listening on port ${port}`);
    });
}
