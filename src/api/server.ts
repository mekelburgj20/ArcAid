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
