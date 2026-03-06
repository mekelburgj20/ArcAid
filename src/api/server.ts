import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { getDatabase } from '../database/database.js';
import { logInfo, logError } from '../utils/logger.js';
import { getTerminology } from '../utils/terminology.js';

export function startApiServer(port: number = 3001) {
    const app = express();

    app.use(cors());
    app.use(express.json());

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
    app.get('/api/settings', async (req, res) => {
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

    app.post('/api/settings', async (req, res) => {
        try {
            const db = await getDatabase();
            const settings = req.body;
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

            // If this was the first-run wizard, restart the server so the bot connects.
            // Docker Compose will automatically restart the process.
            if (needsRestart) {
                logInfo('🔄 Setup complete! Restarting process to connect bot...');
                setTimeout(() => process.exit(0), 1000);
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

    app.post('/api/tournaments', async (req, res) => {
        try {
            const db = await getDatabase();
            const { id, name, type, cadence, guild_id, discord_channel_id, discord_role_id, is_active } = req.body;
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

    app.put('/api/tournaments/:id', async (req, res) => {
        try {
            const db = await getDatabase();
            const { name, type, cadence, guild_id, discord_channel_id, discord_role_id, is_active } = req.body;
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

    app.delete('/api/tournaments/:id', async (req, res) => {
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

    app.post('/api/game_library/import', async (req, res) => {
        try {
            const db = await getDatabase();
            const games = req.body.games; // Expected to be an array of game objects

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
