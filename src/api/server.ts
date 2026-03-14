import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { createServer } from 'http';
import { EventEmitter } from 'events';
import { z } from 'zod';
import { initWebSocket } from './websocket.js';
import { getDatabase } from '../database/database.js';
import { logInfo, logError, logWarn } from '../utils/logger.js';
import { hashPassword, verifyPassword, signToken, verifyToken, getAdminPasswordHash, setAdminPasswordHash } from './auth.js';
import { requireAuth } from './middleware.js';
import { CreateTournamentSchema, UpdateTournamentSchema, ImportGamesSchema, UpdateGameSchema, SettingsSchema, HistoryQuerySchema, BackupRestoreParamsSchema, MergePlayerSchema, CreateRankingGroupSchema, UpdateRankingGroupSchema, UpdatePreferencesSchema } from './schemas.js';
import { SettingsService } from '../services/SettingsService.js';
import { TournamentService } from '../services/TournamentService.js';
import { GameLibraryService } from '../services/GameLibraryService.js';
import { LogService } from '../services/LogService.js';
import { getDashboardData } from '../services/DashboardService.js';
import { listBackups, restoreBackup } from '../services/BackupService.js';
import { VpsImportService } from '../services/VpsImportService.js';
import { RatingService } from '../services/RatingService.js';

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

    // --- Discord OAuth2 Endpoints ---

    app.get('/api/auth/discord', async (req, res) => {
        try {
            const clientId = process.env.DISCORD_CLIENT_ID;
            const clientSecret = process.env.DISCORD_CLIENT_SECRET;
            if (!clientId || !clientSecret) {
                return res.status(400).json({ error: 'Discord OAuth not configured. Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET.' });
            }

            // Return client ID so the frontend can build the OAuth URL with its own origin
            res.json({ clientId });
        } catch (error) {
            logError('API Error (GET /api/auth/discord):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.post('/api/auth/discord/callback', async (req, res) => {
        try {
            const { code, redirectUri } = req.body;
            if (!code || !redirectUri) {
                return res.status(400).json({ error: 'Authorization code and redirectUri required' });
            }

            const clientId = process.env.DISCORD_CLIENT_ID;
            const clientSecret = process.env.DISCORD_CLIENT_SECRET;
            const guildId = process.env.DISCORD_GUILD_ID;
            const adminRoleId = process.env.DISCORD_ADMIN_ROLE_ID;

            if (!clientId || !clientSecret) {
                return res.status(400).json({ error: 'Discord OAuth not configured' });
            }
            if (!guildId) {
                return res.status(400).json({ error: 'DISCORD_GUILD_ID not configured' });
            }
            if (!adminRoleId) {
                return res.status(400).json({ error: 'DISCORD_ADMIN_ROLE_ID not configured. Use /setup admin-role in Discord first.' });
            }

            // Exchange code for access token
            const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: clientId,
                    client_secret: clientSecret,
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: redirectUri,
                }),
            });

            if (!tokenRes.ok) {
                const err = await tokenRes.text();
                logError('Discord OAuth token exchange failed:', err);
                return res.status(401).json({ error: 'Failed to exchange authorization code' });
            }

            const tokenData = await tokenRes.json() as { access_token: string; token_type: string };

            // Get user info
            const userRes = await fetch('https://discord.com/api/users/@me', {
                headers: { Authorization: `Bearer ${tokenData.access_token}` },
            });
            if (!userRes.ok) {
                return res.status(401).json({ error: 'Failed to fetch Discord user info' });
            }
            const user = await userRes.json() as { id: string; username: string; global_name?: string; avatar?: string };

            // Get guild member info (check role)
            const memberRes = await fetch(`https://discord.com/api/users/@me/guilds/${guildId}/member`, {
                headers: { Authorization: `Bearer ${tokenData.access_token}` },
            });
            if (!memberRes.ok) {
                return res.status(403).json({ error: 'You are not a member of this server' });
            }
            const member = await memberRes.json() as { roles: string[] };

            // Check if user has the admin role
            if (!member.roles.includes(adminRoleId)) {
                return res.status(403).json({ error: 'You do not have the required admin role' });
            }

            // Issue JWT
            const displayName = user.global_name || user.username;
            const avatarUrl = user.avatar
                ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
                : null;

            const token = signToken({
                role: 'admin',
                discordId: user.id,
                username: displayName,
                avatar: avatarUrl || undefined,
            });

            logInfo(`Discord OAuth login: ${displayName} (${user.id})`);
            res.json({ token, user: { discordId: user.id, username: displayName, avatar: avatarUrl } });
        } catch (error) {
            logError('API Error (POST /api/auth/discord/callback):', error);
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

    // --- Auth Info Endpoint ---
    app.get('/api/auth/me', requireAuth, (req, res) => {
        const authHeader = req.headers['authorization'];
        const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!token) return res.status(401).json({ error: 'No token' });
        const payload = verifyToken(token);
        if (!payload) return res.status(401).json({ error: 'Invalid token' });
        res.json({
            role: payload.role,
            discordId: payload.discordId || null,
            username: payload.username || 'Admin',
            avatar: payload.avatar || null,
        });
    });

    // --- User Preferences Endpoints ---
    app.get('/api/me/preferences', requireAuth, async (req, res) => {
        try {
            const authHeader = req.headers['authorization'];
            const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
            if (!token) return res.status(401).json({ error: 'No token' });
            const payload = verifyToken(token);
            if (!payload) return res.status(401).json({ error: 'Invalid token' });

            // Password-only admins use a stable key since they have no discordId
            const userId = payload.discordId || 'admin-password';
            const { PreferencesService } = await import('../services/PreferencesService.js');
            const prefs = await PreferencesService.getAll(userId);
            res.json(prefs);
        } catch (error) {
            logError('API Error (GET /api/me/preferences):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.post('/api/me/preferences', requireAuth, async (req, res) => {
        try {
            const authHeader = req.headers['authorization'];
            const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
            if (!token) return res.status(401).json({ error: 'No token' });
            const payload = verifyToken(token);
            if (!payload) return res.status(401).json({ error: 'Invalid token' });

            const validationResult = validate(UpdatePreferencesSchema, req.body);
            if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

            const userId = payload.discordId || 'admin-password';
            const { PreferencesService } = await import('../services/PreferencesService.js');
            await PreferencesService.setTheme(userId, validationResult.data.ui_theme);
            res.json({ success: true });
        } catch (error) {
            logError('API Error (POST /api/me/preferences):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // --- Status Endpoint ---
    app.get('/api/status', async (req, res) => {
        try {
            const isSetup = await SettingsService.isSetupComplete();
            res.json({
                status: 'online',
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
            const { Scheduler } = await import('../engine/Scheduler.js');
            await Scheduler.getInstance().reload();
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
            const { Scheduler } = await import('../engine/Scheduler.js');
            await Scheduler.getInstance().reload();
            res.json({ success: true });
        } catch (error) {
            logError('API Error (PUT /api/tournaments):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.delete('/api/tournaments/:id', requireAuth, async (req, res) => {
        try {
            await TournamentService.delete(req.params.id as string);
            const { Scheduler } = await import('../engine/Scheduler.js');
            await Scheduler.getInstance().reload();
            res.json({ success: true });
        } catch (error) {
            logError('API Error (DELETE /api/tournaments):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.post('/api/tournaments/reorder-lineup', requireAuth, async (req, res) => {
        try {
            const { TournamentEngine } = await import('../engine/TournamentEngine.js');
            const engine = TournamentEngine.getInstance();
            await engine.reorderIScoredLineup();
            res.json({ success: true });
        } catch (error) {
            logError('API Error (POST /api/tournaments/reorder-lineup):', error);
            const message = error instanceof Error ? error.message : 'Internal Server Error';
            res.status(500).json({ error: message });
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

    app.put('/api/game_library/:name', requireAuth, async (req, res) => {
        try {
            const originalName = decodeURIComponent(req.params.name as string);
            const validationResult = validate(UpdateGameSchema, req.body);
            if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

            const updated = await GameLibraryService.updateGame(originalName, validationResult.data);
            if (!updated) return res.status(404).json({ error: 'Game not found' });
            res.json({ success: true });
        } catch (error) {
            logError('API Error (PUT /api/game_library/:name):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.post('/api/game_library/import-vps', requireAuth, async (req, res) => {
        try {
            const result = await VpsImportService.importFromVps();
            res.json({ success: true, ...result });
        } catch (error) {
            logError('API Error (POST /api/game_library/import-vps):', error);
            res.status(500).json({ error: error instanceof Error ? error.message : 'VPS import failed' });
        }
    });

    // --- Ratings Endpoints ---
    app.get('/api/ratings', async (req, res) => {
        try {
            const ratings = await RatingService.getAllRatings();
            const userId = (req.headers['x-user-id'] as string) || '';
            const userRatings = userId ? await RatingService.getUserRatings(userId) : {};
            res.json({ ratings, userRatings });
        } catch (error) {
            logError('API Error (GET /api/ratings):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.get('/api/ratings/:gameName', async (req, res) => {
        try {
            const gameName = decodeURIComponent(req.params.gameName as string);
            const userId = (req.headers['x-user-id'] as string) || '';
            const info = await RatingService.getGameRating(gameName, userId || undefined);
            res.json(info);
        } catch (error) {
            logError('API Error (GET /api/ratings/:gameName):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.post('/api/ratings/:gameName', async (req, res) => {
        try {
            const gameName = decodeURIComponent(req.params.gameName as string);
            const userId = (req.headers['x-user-id'] as string) || '';
            const rating = Number(req.body?.rating);
            if (!userId) return res.status(400).json({ error: 'x-user-id header required' });
            if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1-5' });
            await RatingService.setRating(gameName, userId, rating);
            const info = await RatingService.getGameRating(gameName, userId);
            res.json(info);
        } catch (error) {
            logError('API Error (POST /api/ratings/:gameName):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // --- Dashboard Endpoint ---
    app.get('/api/dashboard', async (req, res) => {
        try {
            const data = await getDashboardData();
            res.json(data);
        } catch (error) {
            logError('API Error (/api/dashboard):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // --- History Endpoint ---
    app.get('/api/history', async (req, res) => {
        try {
            const validationResult = validate(HistoryQuerySchema, req.query);
            if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

            const { page, limit, tournament_id, type } = validationResult.data;
            const offset = (page - 1) * limit;
            const db = await getDatabase();

            const conditions: string[] = ["g.status = 'COMPLETED'"];
            const params: unknown[] = [];

            if (tournament_id) {
                conditions.push('g.tournament_id = ?');
                params.push(tournament_id);
            }
            if (type) {
                conditions.push('t.type = ?');
                params.push(type);
            }

            const whereClause = conditions.join(' AND ');

            const countRow = await db.get(
                `SELECT COUNT(*) as total FROM games g JOIN tournaments t ON g.tournament_id = t.id WHERE ${whereClause}`,
                ...params
            );
            const total = countRow?.total ?? 0;

            const results = await db.all(
                `SELECT
                    g.name AS game_name,
                    t.name AS tournament_name,
                    t.type AS tournament_type,
                    g.start_date,
                    g.end_date,
                    s.iscored_username AS winner_name,
                    s.score AS winner_score
                FROM games g
                JOIN tournaments t ON g.tournament_id = t.id
                LEFT JOIN (
                    SELECT game_id, iscored_username, score,
                           ROW_NUMBER() OVER (PARTITION BY game_id ORDER BY score DESC) AS rn
                    FROM submissions
                ) s ON s.game_id = g.id AND s.rn = 1
                WHERE ${whereClause}
                ORDER BY g.end_date DESC
                LIMIT ? OFFSET ?`,
                ...params, limit, offset
            );

            res.json({ results, total, page, limit });
        } catch (error) {
            logError('API Error (/api/history):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // --- Backup Endpoints ---
    app.get('/api/backups', requireAuth, async (req, res) => {
        try {
            const backups = await listBackups();
            res.json(backups);
        } catch (error) {
            logError('API Error (/api/backups):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.post('/api/backups/:name/restore', requireAuth, async (req, res) => {
        try {
            const validationResult = validate(BackupRestoreParamsSchema, { name: req.params.name as string });
            if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

            await restoreBackup(validationResult.data.name);
            res.json({ success: true, message: `Backup "${validationResult.data.name}" restored. Restarting...` });

            serverEvents.emit('restart');
            logInfo('Restart signal emitted after backup restore.');
            setTimeout(() => process.exit(0), 1000);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logError('API Error (POST /api/backups/:name/restore):', error);
            res.status(400).json({ error: message });
        }
    });

    // --- Create Backup Endpoint ---
    app.post('/api/backups', requireAuth, async (req, res) => {
        try {
            const { BackupManager } = await import('../engine/BackupManager.js');
            const { IScoredClient } = await import('../engine/IScoredClient.js');
            const manager = BackupManager.getInstance();
            const client = new IScoredClient();
            const hasCredentials = !!(process.env.ISCORED_USERNAME && process.env.ISCORED_PASSWORD);
            if (hasCredentials) {
                try { await client.connect(); } catch { /* proceed without iScored */ }
            }
            try {
                const backupPath = await manager.createBackup(client);
                if (backupPath) {
                    res.json({ success: true, path: backupPath });
                } else {
                    res.status(500).json({ error: 'Backup failed' });
                }
            } finally {
                if (hasCredentials) {
                    try { await client.disconnect(); } catch { /* ignore */ }
                }
            }
        } catch (error) {
            logError('API Error (POST /api/backups):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // --- Scheduler Reload Endpoint ---
    app.post('/api/scheduler/reload', requireAuth, async (req, res) => {
        try {
            const { Scheduler } = await import('../engine/Scheduler.js');
            await Scheduler.getInstance().reload();
            res.json({ success: true });
        } catch (error) {
            logError('API Error (POST /api/scheduler/reload):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // --- Merge/Rename Player Endpoint ---
    app.post('/api/admin/merge-player', requireAuth, async (req, res) => {
        try {
            const validationResult = validate(MergePlayerSchema, req.body);
            if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

            const { fromUsername, toUsername } = validationResult.data;
            if (fromUsername.toLowerCase() === toUsername.toLowerCase()) {
                return res.status(400).json({ error: 'Source and target usernames are the same' });
            }

            const db = await getDatabase();

            // Update sync-format submission IDs (gameId-oldname → gameId-newname)
            // so that future syncs don't treat renamed records as stale
            const syncRows = await db.all(
                `SELECT id, game_id FROM submissions WHERE LOWER(iscored_username) = LOWER(?) AND id LIKE '%' || '-' || ?`,
                fromUsername, fromUsername.toLowerCase()
            );
            for (const row of syncRows) {
                const newId = `${row.game_id}-${toUsername.toLowerCase()}`;
                // Check for conflict — if target ID already exists, delete the old one
                const existing = await db.get('SELECT id FROM submissions WHERE id = ?', newId);
                if (existing) {
                    await db.run('DELETE FROM submissions WHERE id = ?', row.id);
                } else {
                    await db.run('UPDATE submissions SET id = ? WHERE id = ?', newId, row.id);
                }
            }

            // Update username in remaining submissions
            const subResult = await db.run(
                'UPDATE submissions SET iscored_username = ? WHERE LOWER(iscored_username) = LOWER(?)',
                toUsername, fromUsername
            );

            // Update scores table (legacy data)
            const scoreResult = await db.run(
                'UPDATE scores SET iscored_username = ? WHERE LOWER(iscored_username) = LOWER(?)',
                toUsername, fromUsername
            );

            // Update user_mappings if the old name was mapped
            await db.run(
                'UPDATE user_mappings SET iscored_username = ? WHERE LOWER(iscored_username) = LOWER(?)',
                toUsername, fromUsername
            );

            // Invalidate all leaderboard caches
            const { LeaderboardService } = await import('../services/LeaderboardService.js');
            await LeaderboardService.invalidateAll();
            const { RankingService } = await import('../services/RankingService.js');
            await RankingService.invalidateAll();

            const totalUpdated = (subResult.changes || 0) + (scoreResult.changes || 0);
            logInfo(`Merged player '${fromUsername}' -> '${toUsername}': ${totalUpdated} records updated`);

            res.json({
                success: true,
                submissionsUpdated: subResult.changes || 0,
                scoresUpdated: scoreResult.changes || 0,
            });
        } catch (error) {
            logError('API Error (POST /api/admin/merge-player):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // --- Ranking Groups Endpoints ---
    app.get('/api/ranking-groups', async (req, res) => {
        try {
            const { RankingService } = await import('../services/RankingService.js');
            const groups = await RankingService.getAll();
            res.json(groups);
        } catch (error) {
            logError('API Error (GET /api/ranking-groups):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.get('/api/ranking-groups/:id', async (req, res) => {
        try {
            const { RankingService } = await import('../services/RankingService.js');
            const group = await RankingService.getById(req.params.id as string);
            if (!group) return res.status(404).json({ error: 'Ranking group not found' });
            res.json(group);
        } catch (error) {
            logError('API Error (GET /api/ranking-groups/:id):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.post('/api/ranking-groups', requireAuth, async (req, res) => {
        try {
            const validationResult = validate(CreateRankingGroupSchema, req.body);
            if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
            const { RankingService } = await import('../services/RankingService.js');
            await RankingService.create(validationResult.data);
            res.json({ success: true });
        } catch (error) {
            logError('API Error (POST /api/ranking-groups):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.put('/api/ranking-groups/:id', requireAuth, async (req, res) => {
        try {
            const validationResult = validate(UpdateRankingGroupSchema, req.body);
            if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
            const { RankingService } = await import('../services/RankingService.js');
            await RankingService.update(req.params.id as string, validationResult.data);
            res.json({ success: true });
        } catch (error) {
            logError('API Error (PUT /api/ranking-groups/:id):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.delete('/api/ranking-groups/:id', requireAuth, async (req, res) => {
        try {
            const { RankingService } = await import('../services/RankingService.js');
            await RankingService.delete(req.params.id as string);
            res.json({ success: true });
        } catch (error) {
            logError('API Error (DELETE /api/ranking-groups/:id):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.get('/api/ranking-groups/:id/rankings', async (req, res) => {
        try {
            const { RankingService } = await import('../services/RankingService.js');
            const group = await RankingService.getById(req.params.id as string);
            if (!group) return res.status(404).json({ error: 'Ranking group not found' });
            const rankings = await RankingService.getRankings(req.params.id as string);
            res.json({ group, rankings });
        } catch (error) {
            logError('API Error (GET /api/ranking-groups/:id/rankings):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.post('/api/ranking-groups/:id/recompute', requireAuth, async (req, res) => {
        try {
            const { RankingService } = await import('../services/RankingService.js');
            await RankingService.invalidate(req.params.id as string);
            const rankings = await RankingService.computeRankings(req.params.id as string);
            res.json({ success: true, count: rankings.length });
        } catch (error) {
            logError('API Error (POST /api/ranking-groups/:id/recompute):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // Public endpoint for active ranking groups (for scoreboard)
    app.get('/api/rankings', async (req, res) => {
        try {
            const { RankingService } = await import('../services/RankingService.js');
            const data = await RankingService.getActiveWithRankings();
            res.json(data);
        } catch (error) {
            logError('API Error (GET /api/rankings):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // --- Game Activation / Deactivation Endpoints ---
    app.post('/api/tournaments/:id/activate-game', requireAuth, async (req, res) => {
        try {
            const tournamentId = req.params.id as string;
            const { gameName } = req.body;
            if (!gameName || typeof gameName !== 'string') {
                return res.status(400).json({ error: 'gameName is required' });
            }

            const db = await getDatabase();
            const tournament = await db.get('SELECT id, type, mode FROM tournaments WHERE id = ?', tournamentId);
            if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

            const { TournamentEngine } = await import('../engine/TournamentEngine.js');
            const engine = TournamentEngine.getInstance();

            // Look up style_id from game_library
            const gameLibEntry = await db.get('SELECT style_id FROM game_library WHERE name = ? COLLATE NOCASE', gameName);
            const styleId = gameLibEntry?.style_id || undefined;

            // Create on iScored if credentials available
            let iscoredId: string | undefined;
            const hasCredentials = !!(process.env.ISCORED_USERNAME && process.env.ISCORED_PASSWORD);
            if (hasCredentials) {
                const { IScoredClient } = await import('../engine/IScoredClient.js');
                const client = new IScoredClient();
                try {
                    await client.connect();
                    iscoredId = await client.createGame(gameName, styleId);
                    await client.setGameTags(iscoredId, tournament.type);
                    await client.setGameStatus(iscoredId, { locked: false, hidden: false });
                } finally {
                    await client.disconnect();
                }
            }

            // Activate in DB without completing existing active games
            await db.exec('BEGIN TRANSACTION');
            try {
                const game = await engine.activateGame(tournamentId, gameName, styleId, iscoredId, false);
                await db.exec('COMMIT');
                logInfo(`Admin activated game: ${gameName} for tournament ${tournamentId}`);
                res.json({ success: true, gameId: game.id });

                // Reorder iScored lineup in background
                engine.reorderIScoredLineup().catch(err =>
                    logWarn('Failed to reorder iScored lineup after activation:', err)
                );
            } catch (dbError) {
                await db.exec('ROLLBACK');
                throw dbError;
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Internal Server Error';
            logError('API Error (POST /api/tournaments/:id/activate-game):', error);
            res.status(500).json({ error: message });
        }
    });

    app.post('/api/games/:id/deactivate', requireAuth, async (req, res) => {
        try {
            const gameId = req.params.id as string;
            const { TournamentEngine } = await import('../engine/TournamentEngine.js');
            const engine = TournamentEngine.getInstance();
            const dbOnly = req.body?.dbOnly === true;
            const result = await engine.deactivateGame(gameId, dbOnly);
            res.json({ success: true, ...result });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Internal Server Error';
            logError('API Error (POST /api/games/:id/deactivate):', error);
            res.status(400).json({ error: message });
        }
    });

    // --- Active Games List Endpoint ---
    app.get('/api/games/active', async (req, res) => {
        try {
            const db = await getDatabase();
            const rows = await db.all(
                `SELECT g.id, g.name, g.tournament_id, g.iscored_id, g.start_date, t.name as tournament_name
                 FROM games g JOIN tournaments t ON g.tournament_id = t.id
                 WHERE g.status = 'ACTIVE'
                 ORDER BY g.start_date DESC`
            );
            res.json(rows);
        } catch (error) {
            logError('API Error (GET /api/games/active):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // --- Log Stream Endpoint (SSE) ---
    app.get('/api/logs/stream', (req, res) => {
        const logPath = path.join(process.cwd(), 'data', 'arcaid.log');

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });

        res.write(':\n\n');

        let lastSize = 0;
        try {
            if (fs.existsSync(logPath)) {
                lastSize = fs.statSync(logPath).size;
            }
        } catch { /* file may not exist yet */ }

        const sendNewLines = () => {
            try {
                if (!fs.existsSync(logPath)) return;
                const stat = fs.statSync(logPath);
                if (stat.size <= lastSize) {
                    if (stat.size < lastSize) lastSize = 0;
                    else return;
                }

                const fd = fs.openSync(logPath, 'r');
                const buffer = Buffer.alloc(stat.size - lastSize);
                fs.readSync(fd, buffer, 0, buffer.length, lastSize);
                fs.closeSync(fd);

                const lines = buffer.toString('utf-8').split('\n').filter(Boolean);
                for (const line of lines) {
                    res.write(`data: ${JSON.stringify(line)}\n\n`);
                }
                lastSize = stat.size;
            } catch { /* ignore read errors during rotation */ }
        };

        const dataDir = path.dirname(logPath);
        const logFilename = path.basename(logPath);
        let watcher: fs.FSWatcher | null = null;

        try {
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            watcher = fs.watch(dataDir, (eventType, filename) => {
                if (filename === logFilename) sendNewLines();
            });
        } catch {
            const interval = setInterval(sendNewLines, 2000);
            req.on('close', () => clearInterval(interval));
        }

        const keepalive = setInterval(() => res.write(':\n\n'), 30000);

        req.on('close', () => {
            clearInterval(keepalive);
            if (watcher) watcher.close();
        });
    });

    // --- Portal (Game Room) Endpoint ---
    app.get('/api/portal', async (req, res) => {
        try {
            const name = await SettingsService.get('GAME_ROOM_NAME');
            const slug = await SettingsService.get('GAME_ROOM_SLUG');
            const uiTheme = await SettingsService.get('UI_THEME');
            if (!slug) {
                return res.json({ slug: null, name: null, ui_theme: uiTheme || 'arcade' });
            }
            res.json({ slug, name: name || slug, ui_theme: uiTheme || 'arcade' });
        } catch (error) {
            logError('API Error (/api/portal):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // --- Leaderboard Endpoints ---
    app.get('/api/leaderboard', async (req, res) => {
        try {
            const { LeaderboardService } = await import('../services/LeaderboardService.js');
            const leaderboards = await LeaderboardService.getActiveLeaderboards();
            res.json(leaderboards);
        } catch (error) {
            logError('API Error (/api/leaderboard):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.get('/api/leaderboard/:gameId', async (req, res) => {
        try {
            const { LeaderboardService } = await import('../services/LeaderboardService.js');
            const gameId = req.params.gameId as string;
            const rankings = await LeaderboardService.getForGame(gameId);

            // Include game metadata for full leaderboard view
            const db = await getDatabase();
            const game = await db.get(`
                SELECT g.name as game_name, t.name as tournament_name, gl.image_url
                FROM games g
                LEFT JOIN tournaments t ON g.tournament_id = t.id
                LEFT JOIN game_library gl ON g.name = gl.name COLLATE NOCASE
                WHERE g.id = ?
            `, gameId);

            res.json({
                gameId,
                gameName: game?.game_name || 'Unknown',
                tournamentName: game?.tournament_name || 'Untracked',
                imageUrl: game?.image_url || null,
                rankings,
            });
        } catch (error) {
            logError('API Error (/api/leaderboard/:gameId):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // --- Stats Endpoints ---
    app.get('/api/stats/players', async (req, res) => {
        try {
            const { StatsService } = await import('../services/StatsService.js');
            const players = await StatsService.getAllPlayerStats();
            res.json(players);
        } catch (error) {
            logError('API Error (/api/stats/players):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.get('/api/stats/player/:identifier', async (req, res) => {
        try {
            const { StatsService } = await import('../services/StatsService.js');
            const identifier = decodeURIComponent(req.params.identifier as string);
            // If it looks like a Discord ID (17-20 digits), look up by discord_user_id; otherwise by username
            const isDiscordId = /^\d{17,20}$/.test(identifier);
            const stats = isDiscordId
                ? await StatsService.getPlayerStats(identifier)
                : await StatsService.getPlayerStatsByUsername(identifier);
            if (!stats) {
                return res.status(404).json({ error: 'Player not found' });
            }
            res.json(stats);
        } catch (error) {
            logError('API Error (/api/stats/player):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.get('/api/stats/game/:name', async (req, res) => {
        try {
            const { StatsService } = await import('../services/StatsService.js');
            const stats = await StatsService.getGameStats(decodeURIComponent(req.params.name as string));
            if (!stats) {
                res.status(404).json({ error: 'Game not found' });
                return;
            }
            res.json(stats);
        } catch (error) {
            logError('API Error (/api/stats/game):', error);
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

    // Create HTTP server and attach Socket.io
    const httpServer = createServer(app);
    initWebSocket(httpServer);

    httpServer.listen(port, '0.0.0.0', () => {
        logInfo(`Admin API Server listening on port ${port}`);
    });
}
