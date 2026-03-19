import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { logInfo, logError } from '../../utils/logger.js';
import { requireAuth, requireSuperAdmin } from '../middleware.js';
import { validate } from '../validate.js';
import {
    SettingsSchema, ImportGamesSchema, UpdateGameSchema,
    BackupRestoreParamsSchema, CreateGameRoomSchema,
} from '../schemas.js';
import { SettingsService } from '../../services/SettingsService.js';
import { GameRoomService } from '../../services/GameRoomService.js';
import { AdminService } from '../../services/AdminService.js';
import { GameLibraryService } from '../../services/GameLibraryService.js';
import { LogService } from '../../services/LogService.js';
import { getDashboardData } from '../../services/DashboardService.js';
import { listBackups, restoreBackup } from '../../services/BackupService.js';
import { VpsImportService } from '../../services/VpsImportService.js';
import { WizardImportService } from '../../services/WizardImportService.js';
import { serverEvents } from '../server.js';
import { AuditService } from '../../services/AuditService.js';

const router = Router();

// All admin routes require auth + super admin
router.use(requireAuth, requireSuperAdmin);

// --- Game Room CRUD ---

router.get('/rooms', async (req, res) => {
    try {
        const rooms = await GameRoomService.getAll();
        res.json(rooms);
    } catch (error) {
        logError('API Error (GET /api/admin/rooms):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/rooms', async (req, res) => {
    try {
        const validationResult = validate(CreateGameRoomSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const data = validationResult.data;
        const existing = await GameRoomService.getBySlug(data.slug);
        if (existing) return res.status(409).json({ error: 'Slug already in use' });

        const room = await GameRoomService.create(data);
        logInfo(`Created game room: ${data.name} (${data.slug})`);
        res.json({ success: true, room });
    } catch (error) {
        logError('API Error (POST /api/admin/rooms):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.put('/rooms/:roomId', async (req, res) => {
    try {
        const updated = await GameRoomService.update(req.params.roomId as string, req.body);
        if (!updated) return res.status(404).json({ error: 'Room not found' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (PUT /api/admin/rooms/:roomId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.delete('/rooms/:roomId', async (req, res) => {
    try {
        const deleted = await GameRoomService.delete(req.params.roomId as string);
        if (!deleted) return res.status(404).json({ error: 'Room not found' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE /api/admin/rooms/:roomId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Super Admin Management ---

router.get('/super-admins', async (req, res) => {
    try {
        const admins = await AdminService.getSuperAdmins();
        res.json(admins);
    } catch (error) {
        logError('API Error (GET /api/admin/super-admins):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/super-admins', async (req, res) => {
    try {
        const { discord_user_id, discord_user, username } = req.body;
        const input = discord_user || discord_user_id;
        if (!input) return res.status(400).json({ error: 'discord_user or discord_user_id required' });

        // Resolve username to ID if needed
        const { resolveDiscordUserId } = await import('../../utils/discord.js');
        // Try resolving against all rooms' guild IDs
        let resolvedId: string | null = null;
        if (/^\d{17,20}$/.test(input.trim())) {
            resolvedId = input.trim();
        } else {
            const rooms = await GameRoomService.getAll();
            const { GameRoomSettingsService } = await import('../../services/GameRoomSettingsService.js');
            for (const room of rooms) {
                const guildId = await GameRoomSettingsService.get(room.id, 'DISCORD_GUILD_ID');
                if (guildId) {
                    resolvedId = await resolveDiscordUserId(input.trim(), guildId);
                    if (resolvedId) break;
                }
            }
        }

        if (!resolvedId) {
            return res.status(400).json({ error: `Could not find Discord user "${input}". Try their numeric user ID instead.` });
        }

        await AdminService.addSuperAdmin(resolvedId, username || input.trim());
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST /api/admin/super-admins):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.delete('/super-admins/:discordId', async (req, res) => {
    try {
        const deleted = await AdminService.removeSuperAdmin(req.params.discordId as string);
        if (!deleted) return res.status(404).json({ error: 'Super admin not found' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE /api/admin/super-admins/:discordId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Global Dashboard ---

router.get('/dashboard', async (req, res) => {
    try {
        const data = await getDashboardData();
        res.json(data);
    } catch (error) {
        logError('API Error (GET /api/admin/dashboard):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Backup Management ---

router.get('/backups', async (req, res) => {
    try {
        const backups = await listBackups();
        res.json(backups);
    } catch (error) {
        logError('API Error (GET /api/admin/backups):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/backups', async (req, res) => {
    try {
        const { BackupManager } = await import('../../engine/BackupManager.js');
        const { IScoredClient } = await import('../../engine/IScoredClient.js');
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
        logError('API Error (POST /api/admin/backups):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/backups/:name/restore', async (req, res) => {
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
        logError('API Error (POST /api/admin/backups/:name/restore):', error);
        res.status(400).json({ error: message });
    }
});

// --- Logs ---

router.get('/logs', (req, res) => {
    try {
        const logs = LogService.getRecentLogs();
        res.json({ logs });
    } catch (error) {
        res.status(500).json({ error: 'Failed to read logs' });
    }
});

router.get('/logs/stream', (req, res) => {
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

// --- Global Settings ---

router.get('/settings', async (req, res) => {
    try {
        const settings = await SettingsService.getAll();
        res.json(settings);
    } catch (error) {
        logError('API Error (GET /api/admin/settings):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/settings', async (req, res) => {
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
        logError('API Error (POST /api/admin/settings):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Master Game Library CRUD ---

router.get('/game_library', async (req, res) => {
    try {
        const rows = await GameLibraryService.getAll();
        res.json(rows);
    } catch (error) {
        logError('API Error (GET /api/admin/game_library):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/game_library/import', async (req, res) => {
    try {
        const validationResult = validate(ImportGamesSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const imported = await GameLibraryService.importGames(validationResult.data.games);
        res.json({ success: true, imported });
    } catch (error) {
        logError('API Error (POST /api/admin/game_library/import):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.put('/game_library/:name', async (req, res) => {
    try {
        const originalName = decodeURIComponent(req.params.name as string);
        const validationResult = validate(UpdateGameSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const updated = await GameLibraryService.updateGame(originalName, validationResult.data);
        if (!updated) return res.status(404).json({ error: 'Game not found' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (PUT /api/admin/game_library/:name):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/game_library/delete', async (req, res) => {
    try {
        const { names } = req.body;
        if (!Array.isArray(names) || names.length === 0) {
            return res.status(400).json({ error: 'names array is required' });
        }
        const deleted = await GameLibraryService.deleteGames(names);
        logInfo(`Deleted ${deleted} games from library: ${names.join(', ')}`);
        res.json({ success: true, deleted });
    } catch (error) {
        logError('API Error (POST /api/admin/game_library/delete):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/game_library/import-vps', async (req, res) => {
    try {
        const result = await VpsImportService.importFromVps();
        if (req.body?.roomId) {
            await GameLibraryService.addToRoom(req.body.roomId, result.names);
        }
        res.json({ success: true, imported: result.imported, total: result.total });
    } catch (error) {
        logError('API Error (POST /api/admin/game_library/import-vps):', error);
        res.status(500).json({ error: error instanceof Error ? error.message : 'VPS import failed' });
    }
});

router.post('/game_library/import-wizard', async (req, res) => {
    try {
        const result = await WizardImportService.importFromWizard();
        if (req.body?.roomId) {
            await GameLibraryService.addToRoom(req.body.roomId, result.names);
        }
        res.json({ success: true, imported: result.imported, total: result.total });
    } catch (error) {
        logError('API Error (POST /api/admin/game_library/import-wizard):', error);
        res.status(500).json({ error: error instanceof Error ? error.message : 'Wizard import failed' });
    }
});

// --- Audit Log ---

router.get('/audit-log', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
        const offset = parseInt(req.query.offset as string) || 0;
        const entries = await AuditService.getRecent(limit, offset);
        res.json(entries);
    } catch (error) {
        logError('API Error (GET /api/admin/audit-log):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

export default router;
