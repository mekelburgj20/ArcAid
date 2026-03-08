import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { z } from 'zod';
import { getDatabase } from '../database/database.js';
import { logInfo, logError } from '../utils/logger.js';
import { getTerminology } from '../utils/terminology.js';
import { hashPassword, verifyPassword, signToken, getAdminPasswordHash, setAdminPasswordHash } from './auth.js';
import { requireAuth } from './middleware.js';
import { CreateTournamentSchema, UpdateTournamentSchema, ImportGamesSchema, SettingsSchema } from './schemas.js';

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

    // POST /api/auth/login
    app.post('/api/auth/login', async (req, res) => {
        try {
            const { password } = req.body;
            if (!password || typeof password !== 'string') {
                return res.status(400).json({ error: 'Password required' });
            }

            const hash = await getAdminPasswordHash();

            // If no password set yet, accept any password and set it as the admin password
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

    // POST /api/auth/change-password
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
            const db = await getDatabase();
            const row = await db.get("SELECT value FROM settings WHERE key = 'SETUP_COMPLETE'");
            const isSetup = row?.value === 'true';

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
            const logPath = path.join(process.cwd(), 'data', 'arcaid.log');
            if (!fs.existsSync(logPath)) {
                return res.json({ logs: "No logs found yet." });
            }

            // Read last N lines (simple implementation for now)
            const content = fs.readFileSync(logPath, 'utf-8');
            const lines = content.split('\n').filter(Boolean);
            const tail = lines.slice(-200).join('\n'); // Return last 200 lines
            res.json({ logs: tail });
        } catch (error) {
             res.status(500).json({ error: 'Failed to read logs' });
        }
    });

    // --- Settings Endpoints ---
    app.get('/api/settings', requireAuth, async (req, res) => {
        try {
            const db = await getDatabase();
            const rows = await db.all('SELECT key, value FROM settings');
            const settings = rows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {});
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

            // Prevent overwriting the admin password hash via settings endpoint
            if (Object.keys(settings).some(key => key === 'ADMIN_PASSWORD_HASH')) {
                return res.status(400).json({ error: 'ADMIN_PASSWORD_HASH cannot be set via this endpoint' });
            }

            const db = await getDatabase();
            let needsRestart = false;

            for (const [key, value] of Object.entries(settings)) {
                await db.run(
                    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
                    key, String(value)
                );
                if (key === 'SETUP_COMPLETE' && value === 'true') {
                    needsRestart = true;
                }
            }

            res.json({ success: true });

            // If this was the first-run wizard, signal restart so the bot connects.
            if (needsRestart) {
                logInfo('🔄 Setup complete! Signaling restart...');
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
            const db = await getDatabase();
            const rows = await db.all('SELECT * FROM tournaments');
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

            const { id, name, type, cadence, guild_id, discord_channel_id, discord_role_id, is_active } = validationResult.data;
            const db = await getDatabase();
            await db.run(
                'INSERT INTO tournaments (id, name, type, cadence, guild_id, discord_channel_id, discord_role_id, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                id, name, type, JSON.stringify(cadence), guild_id, discord_channel_id, discord_role_id, is_active ? 1 : 0
            );
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

            const { name, type, cadence, guild_id, discord_channel_id, discord_role_id, is_active } = validationResult.data;
            const db = await getDatabase();
            await db.run(
                'UPDATE tournaments SET name = ?, type = ?, cadence = ?, guild_id = ?, discord_channel_id = ?, discord_role_id = ?, is_active = ? WHERE id = ?',
                name, type, JSON.stringify(cadence), guild_id, discord_channel_id, discord_role_id, is_active ? 1 : 0, req.params.id
            );
            res.json({ success: true });
        } catch (error) {
            logError('API Error (PUT /api/tournaments):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.delete('/api/tournaments/:id', requireAuth, async (req, res) => {
        try {
            const db = await getDatabase();
            await db.run('DELETE FROM tournaments WHERE id = ?', req.params.id);
            res.json({ success: true });
        } catch (error) {
            logError('API Error (DELETE /api/tournaments):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // --- Game Library Endpoints ---
    app.get('/api/game_library', async (req, res) => {
        try {
            const db = await getDatabase();
            const rows = await db.all('SELECT * FROM game_library');
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

            const { games } = validationResult.data;
            const db = await getDatabase();

            await db.exec('BEGIN TRANSACTION');
            for (const game of games) {
                await db.run(
                    `INSERT OR REPLACE INTO game_library
                    (name, aliases, style_id, css_title, css_initials, css_scores, css_box, bg_color, tournament_types)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    game.name, game.aliases || '', game.style_id || '', game.css_title || '', game.css_initials || '',
                    game.css_scores || '', game.css_box || '', game.bg_color || '', game.tournament_types || ''
                );
            }
            await db.exec('COMMIT');

            res.json({ success: true, imported: games.length });
        } catch (error) {
            await getDatabase().then(db => db.exec('ROLLBACK').catch(() => {}));
            logError('API Error (POST /api/game_library/import):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // --- Serve React Frontend (Production) ---
    const frontendPath = path.join(process.cwd(), 'admin-ui', 'dist');
    if (fs.existsSync(frontendPath)) {
        logInfo('📦 Found built Admin UI, serving static files.');
        app.use(express.static(frontendPath));

        // Catch-all to route React Router requests back to index.html
        // Express 5+ requires valid regex syntax for catch-alls
        app.get(/^(?!\/api).*/, (req, res) => {
            res.sendFile(path.join(frontendPath, 'index.html'));
        });
    }

    // Explicitly bind to 0.0.0.0 so it's accessible outside the Docker container
    app.listen(port, '0.0.0.0', () => {
        logInfo(`🌐 Admin API Server listening on port ${port}`);
    });
}
