import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { logInfo, logError } from '../../utils/logger.js';
import { getDatabase } from '../../database/database.js';
import { requireAuth, requireSuperAdmin } from '../middleware.js';
import { validate } from '../validate.js';
import { isAllowedImage } from '../uploadValidation.js';
import {
    SettingsSchema,
    BackupRestoreParamsSchema, CreateGameRoomSchema,
} from '../schemas.js';
import { SettingsService } from '../../services/SettingsService.js';
import { GameRoomService } from '../../services/GameRoomService.js';
import { isProviderUserId } from '../../utils/identityProvider.js';
import { AdminService } from '../../services/AdminService.js';
import { GameLibraryService } from '../../services/GameLibraryService.js';
import { LogService } from '../../services/LogService.js';
import { getDashboardData } from '../../services/DashboardService.js';
import { listBackups, restoreBackup, verifyBackup, deleteBackup } from '../../services/BackupService.js';
import { VpsImportService } from '../../services/VpsImportService.js';
import { WizardImportService } from '../../services/WizardImportService.js';
import { serverEvents } from '../server.js';
import { AuditService } from '../../services/AuditService.js';
import { StyleCatalogueService } from '../../services/StyleCatalogueService.js';
import { StyleUploadSchema } from '../schemas.js';
import multer from 'multer';
import { GlobalGameService, isVirtualOnlyManufacturer } from '../../services/GlobalGameService.js';
import { OPDBImportService } from '../../services/OPDBImportService.js';
import { IGDBImportService } from '../../services/IGDBImportService.js';
import { SyncLogService } from '../../services/SyncLogService.js';
import { ScoreReportService } from '../../services/ScoreReportService.js';
import { GlobalScoreService } from '../../services/GlobalScoreService.js';
import { normalizeSubmitterUserId } from '../../services/SubmissionContextService.js';

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
        let resolvedId: string | null = null;
        if (isProviderUserId(input.trim())) {
            // Accept a pasted Discord snowflake OR a `google:<sub>` id directly —
            // granting super_admin to a Google-identified user by pasted ID is
            // legitimate (role derivation is table-based and provider-agnostic).
            resolvedId = input.trim();
        } else {
            // Gather candidate guild IDs: all rooms' configured guilds plus the env-level DISCORD_GUILD_ID fallback
            const guildIds = new Set<string>();
            const rooms = await GameRoomService.getAll();
            const { GameRoomSettingsService } = await import('../../services/GameRoomSettingsService.js');
            for (const room of rooms) {
                const guildId = await GameRoomSettingsService.get(room.id, 'DISCORD_GUILD_ID');
                if (guildId) guildIds.add(guildId);
            }
            if (process.env.DISCORD_GUILD_ID) guildIds.add(process.env.DISCORD_GUILD_ID);

            for (const guildId of guildIds) {
                resolvedId = await resolveDiscordUserId(input.trim(), guildId);
                if (resolvedId) break;
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
        const { getIScoredCredsForRoom } = await import('../../utils/iscoredCreds.js');
        const manager = BackupManager.getInstance();
        // Backups currently use only the env-fallback iScored account (legacy
        // global config). When per-room backups are added, this should iterate
        // accounts via the registry.
        const creds = await getIScoredCredsForRoom(null);
        let backupPath: string | null = null;
        if (creds) {
            // Creds present → capture live iScored state inside a serialized
            // session for the env-fallback account.
            const { IScoredSessionRegistry } = await import('../../engine/IScoredSessionRegistry.js');
            backupPath = await IScoredSessionRegistry.getInstance().withSession(
                creds,
                (client) => manager.createBackup(client),
            );
        } else {
            // No iScored creds → DB+assets only. createBackup() with no client
            // skips the live iScored capture step (per the optional-client change).
            backupPath = await manager.createBackup();
        }

        if (!backupPath) {
            return res.status(500).json({ error: 'Backup failed' });
        }

        // After a successful create, prune per the configured retention policy.
        try {
            const retentionCount = parseInt((await SettingsService.get('BACKUP_RETENTION_COUNT')) || '', 10);
            const retentionDays = parseInt((await SettingsService.get('BACKUP_RETENTION_DAYS')) || '', 10);
            const opts: { retentionCount?: number; retentionDays?: number } = {};
            if (Number.isFinite(retentionCount) && retentionCount > 0) opts.retentionCount = retentionCount;
            if (Number.isFinite(retentionDays) && retentionDays > 0) opts.retentionDays = retentionDays;
            if (opts.retentionCount || opts.retentionDays) {
                const removed = await manager.pruneBackups(opts);
                if (removed > 0) logInfo(`Backup prune (post-create): removed ${removed} old backup(s).`);
            }
        } catch (pruneErr) {
            logError('Backup prune after create failed (backup itself succeeded):', pruneErr);
        }

        res.json({ success: true, path: backupPath });
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

// GET /api/admin/backups/:name/verify — run PRAGMA integrity_check against the
// backup's arcaid.db (read-only) and report the result.
router.get('/backups/:name/verify', async (req, res) => {
    try {
        const validationResult = validate(BackupRestoreParamsSchema, { name: req.params.name as string });
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const name = validationResult.data.name;
        const { ok, result } = await verifyBackup(name);
        res.json({ ok, result });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logError('API Error (GET /api/admin/backups/:name/verify):', error);
        res.status(400).json({ error: message });
    }
});

// GET /api/admin/backups/:name/download — stream the backup's standalone
// arcaid.db (small, fully-checkpointed). Uploaded assets live in the shared
// mirror and are not part of the per-backup download. Super-admin gated by the
// router-level requireAuth + requireSuperAdmin.
router.get('/backups/:name/download', async (req, res) => {
    try {
        const validationResult = validate(BackupRestoreParamsSchema, { name: req.params.name as string });
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const name = validationResult.data.name;
        const dbPath = path.join(process.cwd(), 'backups', name, 'arcaid.db');
        if (!fs.existsSync(dbPath)) {
            return res.status(404).json({ error: `Backup "${name}" has no database file` });
        }
        return res.download(dbPath, `${name}.db`);
    } catch (error) {
        logError('API Error (GET /api/admin/backups/:name/download):', error);
        if (!res.headersSent) res.status(500).json({ error: 'Internal Server Error' });
    }
});

// DELETE /api/admin/backups/:name — permanently remove a backup directory (its DB
// + any bundled assets). Its absence let old backups pile up until prod hit 100%
// disk (2026-07-04 incident). Super-admin gated by the router-level requireAuth +
// requireSuperAdmin; auto-audited by the admin auditMiddleware.
router.delete('/backups/:name', async (req, res) => {
    try {
        const validationResult = validate(BackupRestoreParamsSchema, { name: req.params.name as string });
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        await deleteBackup(validationResult.data.name);
        res.json({ success: true, message: `Backup "${validationResult.data.name}" deleted.` });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logError('API Error (DELETE /api/admin/backups/:name):', error);
        res.status(400).json({ error: message });
    }
});

// Schedule/retention config — stored as plaintext global settings (NOT secrets).
const BackupConfigSchema = z.object({
    enabled: z.boolean().optional(),
    cron: z.string().regex(
        /^(\*|([0-9]|[1-5][0-9])|\*\/([0-9]|[1-5][0-9])) (\*|([0-9]|1[0-9]|2[0-3])|\*\/([0-9]|1[0-9]|2[0-3])) (\*|L|([1-9]|[12][0-9]|3[01])|\*\/([1-9]|[12][0-9]|3[01])) (\*|([1-9]|1[0-2])|\*\/([1-9]|1[0-2])) (\*|([0-6])|\*\/([0-6]))$/,
        'Invalid cron expression (must be 5 fields: min hour day month weekday)'
    ).optional(),
    retentionCount: z.number().int().nonnegative().nullable().optional(),
    retentionDays: z.number().int().nonnegative().nullable().optional(),
});

// GET /api/admin/backups/config — current schedule + retention config.
router.get('/backups/config', async (req, res) => {
    try {
        const [enabledRaw, cron, countRaw, daysRaw] = await Promise.all([
            SettingsService.get('BACKUP_ENABLED'),
            SettingsService.get('BACKUP_SCHEDULE_CRON'),
            SettingsService.get('BACKUP_RETENTION_COUNT'),
            SettingsService.get('BACKUP_RETENTION_DAYS'),
        ]);
        const parseNum = (v: string | null): number | null => {
            if (v === null || v.trim() === '') return null;
            const n = parseInt(v, 10);
            return Number.isFinite(n) ? n : null;
        };
        res.json({
            enabled: enabledRaw !== 'false',
            cron: cron || '',
            retentionCount: parseNum(countRaw),
            retentionDays: parseNum(daysRaw),
        });
    } catch (error) {
        logError('API Error (GET /api/admin/backups/config):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// PUT /api/admin/backups/config — update schedule + retention, then reschedule.
router.put('/backups/config', async (req, res) => {
    try {
        const validationResult = validate(BackupConfigSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const data = validationResult.data;

        const toSave: Record<string, unknown> = {};
        if (data.enabled !== undefined) toSave['BACKUP_ENABLED'] = data.enabled ? 'true' : 'false';
        if (data.cron !== undefined) toSave['BACKUP_SCHEDULE_CRON'] = data.cron;
        // null / undefined retention → empty string deletes the setting row.
        if (data.retentionCount !== undefined) {
            toSave['BACKUP_RETENTION_COUNT'] = data.retentionCount === null ? '' : String(data.retentionCount);
        }
        if (data.retentionDays !== undefined) {
            toSave['BACKUP_RETENTION_DAYS'] = data.retentionDays === null ? '' : String(data.retentionDays);
        }

        if (Object.keys(toSave).length > 0) {
            await SettingsService.saveMany(toSave);
        }

        // Trigger Scheduler to re-register the backup cron with the new config.
        try {
            const { Scheduler } = await import('../../engine/Scheduler.js');
            await Scheduler.getInstance().rescheduleBackup();
        } catch (schedErr) {
            logError('Backup reschedule after config save failed:', schedErr);
        }

        res.json({ success: true });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logError('API Error (PUT /api/admin/backups/config):', error);
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
        const { maskEncryptedValues } = await import('../../utils/secrets.js');
        res.json(maskEncryptedValues(settings));
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

        // Hot-invalidate the high-value notification flag cache so a super-admin
        // toggle takes effect immediately instead of after the 10s TTL.
        if ('NOTIFY_HIGH_VALUE_DEFAULT_ON' in settings) {
            const { NotificationService } = await import('../../services/NotificationService.js');
            NotificationService.invalidateFlagCache();
        }

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

// --- Style Catalogue Management ---

// Multer config: memory storage, 30MB max per file (wheel PNGs / APNGs can be large)
const styleUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB
    fileFilter: (_req, file, cb) => {
        if (['image/png', 'image/apng', 'image/jpeg', 'image/webp'].includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only PNG, APNG, JPEG, and WebP images are allowed'));
        }
    },
});

// Import scraped iScored styles into DB + copy images
router.post('/styles/import', async (req, res) => {
    try {
        const result = await StyleCatalogueService.importFromScraped();
        res.json({ success: true, ...result });
    } catch (error) {
        logError('API Error (POST /api/admin/styles/import):', error);
        res.status(500).json({ error: error instanceof Error ? error.message : 'Style import failed' });
    }
});

// Upload a custom style (at least one image required)
router.post('/styles/upload', styleUpload.fields([
    { name: 'background', maxCount: 1 },
    { name: 'header', maxCount: 1 },
]), async (req, res) => {
    try {
        const validationResult = validate(StyleUploadSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
        const bgFile = files?.background?.[0];
        const headerFile = files?.header?.[0];
        if (!bgFile && !headerFile) {
            return res.status(400).json({ error: 'At least one image (background or header) is required' });
        }

        // Magic-byte validation: reject files whose bytes don't match an allowed image signature (S11)
        if (bgFile && !isAllowedImage(bgFile.buffer)) {
            return res.status(400).json({ error: 'Invalid image file' });
        }
        if (headerFile && !isAllowedImage(headerFile.buffer)) {
            return res.status(400).json({ error: 'Invalid image file' });
        }

        const id = await StyleCatalogueService.createCustom({
            name: validationResult.data.name,
            author: validationResult.data.author,
            notes: validationResult.data.notes,
            backgroundBuffer: bgFile?.buffer,
            headerBuffer: headerFile?.buffer,
        });

        const style = await StyleCatalogueService.getById(id);
        res.status(201).json({ success: true, style });
    } catch (error) {
        logError('API Error (POST /api/admin/styles/upload):', error);
        res.status(500).json({ error: error instanceof Error ? error.message : 'Style upload failed' });
    }
});

// Delete a style
router.delete('/styles/:id', async (req, res) => {
    try {
        const deleted = await StyleCatalogueService.delete(req.params.id as string);
        if (!deleted) return res.status(404).json({ error: 'Style not found' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE /api/admin/styles/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
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

// --- Global Catalogue ---

// Sync endpoints
// These kick off long-running imports in the background and return 202 immediately.
// Frontend polls /admin/catalogue/sync-status to observe progress via sync_logs table.

router.post('/catalogue/sync-vps', async (_req, res) => {
    void (async () => {
        try {
            await VpsImportService.importFromVps();
        } catch (error) {
            logError('Background VPS sync error:', error);
        }
    })();
    res.status(202).json({ success: true, started: true, source: 'vps' });
});

router.post('/catalogue/sync-wizard', async (_req, res) => {
    void (async () => {
        try {
            await WizardImportService.importFromWizard();
        } catch (error) {
            logError('Background Wizard sync error:', error);
        }
    })();
    res.status(202).json({ success: true, started: true, source: 'wizard' });
});

router.post('/catalogue/sync-opdb', async (_req, res) => {
    if (!process.env.OPDB_API_KEY) {
        return res.status(400).json({
            error: 'OPDB_API_KEY is not configured. Add it under Global Settings → Configuration, or register at https://opdb.org to get an API key.',
        });
    }
    void (async () => {
        try {
            await OPDBImportService.importFromOPDB();
        } catch (error) {
            logError('Background OPDB sync error:', error);
        }
    })();
    res.status(202).json({ success: true, started: true, source: 'opdb' });
});

router.post('/catalogue/sync-igdb', async (_req, res) => {
    if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
        return res.status(400).json({
            error: 'TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must be configured for IGDB import. Add them under Global Settings → Configuration.',
        });
    }
    void (async () => {
        try {
            await IGDBImportService.importFromIGDB();
        } catch (error) {
            logError('Background IGDB sync error:', error);
        }
    })();
    res.status(202).json({ success: true, started: true, source: 'igdb' });
});

/**
 * v2.5.0: Steam Pinball catalogue sync (Zen Studios + Zaccaria).
 * Pulls DLC lists from six Steam apps, expands curated packs into their
 * constituent table names, applies skip-list, upserts each as a global_games
 * row tagged with the canonical platform. No env-var pre-flight — Steam's
 * appdetails endpoint is anonymous.
 */
router.post('/catalogue/sync-steam-pinball', async (_req, res) => {
    void (async () => {
        try {
            const { SteamPinballImportService } = await import('../../services/SteamPinballImportService.js');
            await SteamPinballImportService.importAll();
        } catch (error) {
            logError('Background Steam Pinball sync error:', error);
        }
    })();
    res.status(202).json({ success: true, started: true, source: 'steam-pinball' });
});

/**
 * Pinball FX VR catalogue tagger. Walks the curated FX_VR_TABLES list and
 * applies `pinball_fx_vr` to matching `global_games` rows. No external HTTP
 * (the source list is baked in from tmp/fx-vr-tables-draft.md), so this
 * runs in seconds — but we still 202-and-poll to match the admin sync UX.
 */
router.post('/catalogue/sync-fx-vr', async (_req, res) => {
    void (async () => {
        try {
            const { FxVrImportService } = await import('../../services/FxVrImportService.js');
            await FxVrImportService.applyTags();
        } catch (error) {
            logError('Background FX VR sync error:', error);
        }
    })();
    res.status(202).json({ success: true, started: true, source: 'fx-vr' });
});

/**
 * AtGames Legends Pinball catalogue tagger. Pulls column A of the curated
 * Google Sheet (no API key required — public CSV export endpoint) and
 * applies `atgames` to matching `global_games` rows. Creates new rows for
 * names not yet in the catalogue. Mirrors the FX VR + Steam Pinball sync
 * UX (202 + poll) since the network fetch + per-row upsert can take 30s+
 * for a few-hundred-row sheet.
 */
router.post('/catalogue/sync-atgames', async (_req, res) => {
    void (async () => {
        try {
            const { AtGamesImportService } = await import('../../services/AtGamesImportService.js');
            await AtGamesImportService.applyTags();
        } catch (error) {
            logError('Background AtGames sync error:', error);
        }
    })();
    res.status(202).json({ success: true, started: true, source: 'atgames' });
});

// Catalogue browse & management
router.get('/catalogue/games', async (req, res) => {
    try {
        const { search, type, status, source, cursor, limit, offset } = req.query;
        if (search) {
            const result = await GlobalGameService.search(search as string, {
                type: type as string,
                status: status as string,
                source: source as string,
                limit: limit ? parseInt(limit as string) : undefined,
                cursor: cursor as string,
            });
            res.json(result);
        } else {
            const result = await GlobalGameService.getAll({
                status: status as string,
                type: type as string,
                source: source as string,
                limit: limit ? parseInt(limit as string) : undefined,
                offset: offset ? parseInt(offset as string) : undefined,
            });
            res.json(result);
        }
    } catch (error) {
        logError('API Error (GET /api/admin/catalogue/games):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/catalogue/games/:id', async (req, res) => {
    try {
        const game = await GlobalGameService.getById(req.params.id as string);
        if (!game) return res.status(404).json({ error: 'Game not found' });
        res.json(game);
    } catch (error) {
        logError('API Error (GET /api/admin/catalogue/games/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.put('/catalogue/games/:id', async (req, res) => {
    try {
        const updated = await GlobalGameService.update(req.params.id as string, req.body);
        if (!updated) return res.status(404).json({ error: 'Game not found' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (PUT /api/admin/catalogue/games/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.patch('/catalogue/games/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        if (!['approved', 'pending', 'rejected'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }
        const discordId = (req as any).user?.discordId;
        const updated = await GlobalGameService.updateStatus(req.params.id as string, status, discordId);
        if (!updated) return res.status(404).json({ error: 'Game not found' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (PATCH /api/admin/catalogue/games/:id/status):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/catalogue/games/merge', async (req, res) => {
    try {
        const { targetId, sourceId } = req.body;
        if (!targetId || !sourceId) return res.status(400).json({ error: 'targetId and sourceId required' });
        const result = await GlobalGameService.merge(targetId, sourceId);
        res.json({ success: true, scoresMoved: result.scoresMoved });
    } catch (error) {
        logError('API Error (POST /api/admin/catalogue/games/merge):', error);
        res.status(500).json({ error: error instanceof Error ? error.message : 'Merge failed' });
    }
});

/**
 * v2.13.0: bulk-merge IPDB-shared duplicates whose rows pass the
 * safe-merge heuristic (same year, compatible manufacturers, no
 * community/digital markers). Pass `?dry=true` to preview without
 * mutating; default is destructive.
 */
router.post('/catalogue/merge-ipdb-duplicates', async (req, res) => {
    try {
        const dryRun = req.query.dry === 'true' || req.body?.dry === true;
        const result = await GlobalGameService.mergeIpdbDuplicates({ dryRun });
        res.json({ success: true, dryRun, ...result });
    } catch (error) {
        logError('API Error (POST /api/admin/catalogue/merge-ipdb-duplicates):', error);
        res.status(500).json({ error: error instanceof Error ? error.message : 'Bulk merge failed' });
    }
});

/**
 * Extracts the numeric IPDB machine ID from an IPDB URL. Mirrors
 * GlobalGameService's private `extractIpdbMachineId` exactly (not exported,
 * so replicated here) — keep the regex in sync if that one changes.
 */
function extractIpdbMachineId(url: string | null | undefined): string | null {
    if (!url) return null;
    const match = url.match(/ipdb\.org\/machine\.cgi\?id=(\d+)/i);
    return match ? match[1]! : null;
}

/**
 * GET /admin/catalogue/dedup-audit — read-only scan for the §2 disease from
 * the 2026-07-02 prod dup review: a virtual-only-manufacturer or
 * missing-manufacturer row whose ipdb_url is a thematic reference (not an
 * identity claim) still sitting in the identity-bearing column. State-based
 * (re-scans the live table on every call) — rows already stripped to
 * based_on_ipdb_url won't re-flag, and rows re-planted by a VPS re-sync
 * since the last strip will. No allowlist/exclusion bookkeeping needed.
 */
router.get('/catalogue/dedup-audit', async (_req, res) => {
    try {
        const db = await getDatabase();

        const totalRow = await db.get(`SELECT COUNT(*) as c FROM global_games`);
        const scannedRows = totalRow?.c ?? 0;

        // Suspects: any row (any type — ipdb_url is inherently pinball-shaped,
        // but we don't gate on type here so a miscategorized row still flags)
        // whose manufacturer is virtual-only/missing per the curated predicate.
        const withIpdb = await db.all(`
            SELECT id, name, manufacturer, year, ipdb_url, imported_from, platforms, status, created_at
            FROM global_games WHERE ipdb_url IS NOT NULL
        `);
        const suspects = withIpdb
            // v2.21.1: only PARSEABLE IPDB links are identity suspects — VPS
            // ships literal "Not Available" placeholder strings in its ipdbUrl
            // field, which are data junk, not spurious identity claims
            // (migration 110 clears the legacy population; upsert drops new
            // ones at the door). Without this filter they flooded the first
            // prod audit run with 95 false suspects.
            .filter((r: any) => isVirtualOnlyManufacturer(r.manufacturer) && extractIpdbMachineId(r.ipdb_url))
            .map((r: any) => ({ ...r, platforms: JSON.parse(r.platforms || '[]') }));

        // Shared-IPDB groups: ALL pinball rows with a non-null ipdb_url,
        // grouped by extracted IPDB machine id. Groups with >1 row are
        // unresolved duplicates (the identity-dedup hierarchy in
        // GlobalGameService only prevents *new* dupes going forward; this
        // surfaces ones that already exist).
        const pinballRows = await db.all(`
            SELECT id, name, manufacturer, year, ipdb_url, status, imported_from
            FROM global_games WHERE type = 'pinball' AND ipdb_url IS NOT NULL
        `);
        const groups = new Map<string, any[]>();
        for (const r of pinballRows) {
            const ipdbId = extractIpdbMachineId(r.ipdb_url);
            if (!ipdbId) continue;
            if (!groups.has(ipdbId)) groups.set(ipdbId, []);
            groups.get(ipdbId)!.push(r);
        }

        // "Loosely agree" heuristic for real-manufacturer groups: same first
        // word, case-insensitive (e.g. "Stern" / "Stern Pinball" both reduce
        // to "stern"). Deliberately loose — this only decides the *suggested*
        // action surfaced to the admin, not an automatic merge; the strict
        // manufacturer-compatibility check used by the actual bulk-merge tool
        // lives in GlobalGameService.mergeIpdbDuplicates.
        const firstWord = (m: string | null | undefined): string =>
            (m || '').trim().toLowerCase().split(/\s+/)[0] || '';

        const sharedIpdbGroups = [...groups.entries()]
            .filter(([, rows]) => rows.length > 1)
            .map(([ipdbId, rows]) => {
                const realRows = rows.filter(r => !isVirtualOnlyManufacturer(r.manufacturer));
                const virtualRows = rows.filter(r => isVirtualOnlyManufacturer(r.manufacturer));

                let suggestedAction: 'merge' | 'strip-virtual-side' | 'review';
                if (virtualRows.length > 0 && realRows.length > 0) {
                    // Mixed group — the virtual/missing side's ipdb_url is a
                    // thematic reference, not the same identity as the real
                    // machine. Strip it, don't merge.
                    suggestedAction = 'strip-virtual-side';
                } else if (realRows.length > 1) {
                    const words = new Set(realRows.map(r => firstWord(r.manufacturer)));
                    const soleWord = [...words][0];
                    suggestedAction = (words.size === 1 && soleWord) ? 'merge' : 'review';
                } else {
                    // All-virtual group (no real side to anchor a decision), or
                    // a shape the two branches above don't cover — needs a human.
                    suggestedAction = 'review';
                }

                return {
                    ipdbId,
                    rows: rows.map(r => ({
                        id: r.id, name: r.name, manufacturer: r.manufacturer, year: r.year,
                        status: r.status, imported_from: r.imported_from,
                    })),
                    suggestedAction,
                };
            });

        res.json({
            suspects,
            sharedIpdbGroups,
            summary: {
                suspectCount: suspects.length,
                sharedGroupCount: sharedIpdbGroups.length,
                scannedRows,
            },
        });
    } catch (error) {
        logError('API Error (GET /api/admin/catalogue/dedup-audit):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /admin/catalogue/dedup-audit/strip — body { ids: string[] } (1-100).
 * For each id, re-checks the suspect predicate against the CURRENT row
 * (not a stale client-side snapshot) before acting — only virtual-only/
 * missing-manufacturer rows with a non-null ipdb_url are touched. Moves
 * ipdb_url -> based_on_ipdb_url (thematic reference, preserved) without
 * clobbering an existing based_on_ipdb_url value; if one's already set,
 * just nulls ipdb_url. Idempotent — re-running on already-stripped ids is a
 * no-op (ipdb_url is already null, so the predicate no longer matches).
 */
router.post('/catalogue/dedup-audit/strip', async (req, res) => {
    try {
        const { ids } = req.body ?? {};
        if (
            !Array.isArray(ids) ||
            ids.length === 0 ||
            ids.length > 100 ||
            !ids.every((id: unknown) => typeof id === 'string' && id.length > 0)
        ) {
            return res.status(400).json({ error: 'ids must be an array of 1-100 strings' });
        }

        const db = await getDatabase();
        const results: Array<{ id: string; action: 'stripped' | 'skipped' }> = [];
        let stripped = 0;
        let skipped = 0;

        for (const id of ids as string[]) {
            const row = await db.get(
                `SELECT id, manufacturer, ipdb_url, based_on_ipdb_url FROM global_games WHERE id = ?`,
                id
            );
            if (!row || !row.ipdb_url || !isVirtualOnlyManufacturer(row.manufacturer)) {
                results.push({ id, action: 'skipped' });
                skipped++;
                continue;
            }

            if (!extractIpdbMachineId(row.ipdb_url)) {
                // v2.21.1: junk link (e.g. VPS's literal "Not Available"
                // placeholder) — clear it outright; preserving garbage as a
                // "thematic reference" would just relocate the pollution.
                await db.run(`UPDATE global_games SET ipdb_url = NULL WHERE id = ?`, id);
            } else if (row.based_on_ipdb_url) {
                // based_on already holds a reference — don't overwrite it,
                // just clear the identity-bearing column.
                await db.run(`UPDATE global_games SET ipdb_url = NULL WHERE id = ?`, id);
            } else {
                await db.run(
                    `UPDATE global_games SET based_on_ipdb_url = ipdb_url, ipdb_url = NULL WHERE id = ?`,
                    id
                );
            }
            results.push({ id, action: 'stripped' });
            stripped++;
        }

        res.json({ stripped, skipped, results });
    } catch (error) {
        logError('API Error (POST /api/admin/catalogue/dedup-audit/strip):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.delete('/catalogue/games/:id', async (req, res) => {
    try {
        const deleted = await GlobalGameService.delete(req.params.id as string);
        if (!deleted) return res.status(404).json({ error: 'Game not found' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE /api/admin/catalogue/games/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ---------------------------------------------------------------------------
// v2.5.0 — super-admin Catalogue Approval queue.
// Surfaces pending global_games rows submitted via the per-room proposal flow.
// Approve / Reject / Merge actions repoint room references via the existing
// GlobalGameService.merge primitive when consolidating duplicates.
// ---------------------------------------------------------------------------

/** GET /admin/catalogue/pending — list pending submissions joined with room + submitter. */
router.get('/catalogue/pending', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const cursor = (req.query.cursor as string) || null;
        const db = await getDatabase();
        const rows = await db.all(`
            SELECT
                gg.id, gg.name, gg.manufacturer, gg.year, gg.type, gg.platforms,
                gg.submitted_by_user_id, gg.submitted_by_room_id, gg.submitted_at,
                gr.name as submitted_by_room_name, gr.slug as submitted_by_room_slug,
                um.iscored_username as submitted_by_username
            FROM global_games gg
            LEFT JOIN game_rooms gr ON gr.id = gg.submitted_by_room_id
            LEFT JOIN user_mappings um ON um.discord_user_id = gg.submitted_by_user_id
            WHERE gg.status = 'pending'
              ${cursor ? 'AND gg.submitted_at < ?' : ''}
            ORDER BY gg.submitted_at DESC
            LIMIT ?
        `, ...(cursor ? [cursor, limit + 1] : [limit + 1]));
        const hasMore = rows.length > limit;
        const data = rows.slice(0, limit).map((r: any) => ({
            ...r,
            platforms: JSON.parse(r.platforms || '[]'),
        }));
        res.json({
            data,
            hasMore,
            nextCursor: hasMore ? data[data.length - 1]?.submitted_at : null,
        });
    } catch (error) {
        logError('API Error (GET /api/admin/catalogue/pending):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/** GET /admin/catalogue/pending-count — single integer for the nav badge. */
router.get('/catalogue/pending-count', async (req, res) => {
    try {
        const db = await getDatabase();
        const row = await db.get(`SELECT COUNT(*) as count FROM global_games WHERE status = 'pending'`);
        res.json({ count: row?.count ?? 0 });
    } catch (error) {
        logError('API Error (GET /api/admin/catalogue/pending-count):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/** POST /admin/catalogue/pending/:gameId/approve — flip status to 'approved'. */
router.post('/catalogue/pending/:gameId/approve', async (req, res) => {
    try {
        const gameId = req.params.gameId as string;
        const db = await getDatabase();
        const game = await db.get(`SELECT id, status FROM global_games WHERE id = ?`, gameId);
        if (!game) return res.status(404).json({ error: 'Game not found' });
        if (game.status !== 'pending') {
            return res.status(409).json({ error: `Game is ${game.status}, not pending` });
        }
        const reviewerId = req.user?.discordId || req.user?.username || 'admin';
        await db.run(
            `UPDATE global_games SET status = 'approved', reviewed_by = ? WHERE id = ?`,
            reviewerId, gameId,
        );
        res.json({ ok: true, gameId, status: 'approved' });
    } catch (error) {
        logError('API Error (POST /api/admin/catalogue/pending/:gameId/approve):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /admin/catalogue/pending/:gameId/reject — flip status to 'rejected'.
 * Body may include `{ reason: string }` for the audit trail. The rejected row
 * stays in the catalogue (status='rejected', not deleted) so the proposing
 * room's `game_library.global_game_id` reference doesn't dangle. Public reads
 * filter rejected rows out — the room's library entry continues to function.
 */
router.post('/catalogue/pending/:gameId/reject', async (req, res) => {
    try {
        const gameId = req.params.gameId as string;
        const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
        const db = await getDatabase();
        const game = await db.get(`SELECT id, status FROM global_games WHERE id = ?`, gameId);
        if (!game) return res.status(404).json({ error: 'Game not found' });
        if (game.status !== 'pending') {
            return res.status(409).json({ error: `Game is ${game.status}, not pending` });
        }
        const reviewerId = req.user?.discordId || req.user?.username || 'admin';
        await db.run(
            `UPDATE global_games SET status = 'rejected', reviewed_by = ? WHERE id = ?`,
            reviewerId, gameId,
        );
        // Note: the auditLog middleware automatically captures actor + IP +
        // correlation_id + sanitized request body (which includes `reason`).
        res.json({ ok: true, gameId, status: 'rejected', reason: reason || null });
    } catch (error) {
        logError('API Error (POST /api/admin/catalogue/pending/:gameId/reject):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /admin/catalogue/pending/:gameId/merge_into/:targetGameId — treat the
 * pending entry as a duplicate of an approved game. Reuses
 * GlobalGameService.merge to repoint room references + delete the pending row.
 * Refuses to merge into a non-approved target (would orphan the wrong way).
 */
router.post('/catalogue/pending/:gameId/merge_into/:targetGameId', async (req, res) => {
    try {
        const gameId = req.params.gameId as string;
        const targetGameId = req.params.targetGameId as string;
        if (gameId === targetGameId) return res.status(400).json({ error: 'gameId and targetGameId must differ' });
        const db = await getDatabase();
        const pending = await db.get(`SELECT id, status FROM global_games WHERE id = ?`, gameId);
        if (!pending) return res.status(404).json({ error: 'Pending game not found' });
        if (pending.status !== 'pending') {
            return res.status(409).json({ error: `Source is ${pending.status}, not pending` });
        }
        const target = await db.get(`SELECT id, status FROM global_games WHERE id = ?`, targetGameId);
        if (!target) return res.status(404).json({ error: 'Target game not found' });
        if (target.status !== 'approved') {
            return res.status(400).json({ error: 'Target must be an approved game' });
        }
        const result = await GlobalGameService.merge(targetGameId, gameId);
        // auditLog middleware records the merge automatically with full body.
        res.json({ ok: true, mergedFrom: gameId, mergedInto: targetGameId, scoresMoved: result.scoresMoved });
    } catch (error) {
        logError('API Error (POST /api/admin/catalogue/pending/:gameId/merge_into/:targetGameId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Catalogue counts
router.get('/catalogue/counts', async (req, res) => {
    try {
        const counts = await GlobalGameService.getCounts();
        res.json(counts);
    } catch (error) {
        logError('API Error (GET /api/admin/catalogue/counts):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Sync health dashboard
router.get('/catalogue/sync-logs', async (req, res) => {
    try {
        const { source } = req.query;
        if (source) {
            const logs = await SyncLogService.getBySource(source as string);
            res.json(logs);
        } else {
            const logs = await SyncLogService.getRecent();
            res.json(logs);
        }
    } catch (error) {
        logError('API Error (GET /api/admin/catalogue/sync-logs):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/catalogue/sync-status', async (req, res) => {
    try {
        const latest = await SyncLogService.getLatestPerSource();
        res.json(latest);
    } catch (error) {
        logError('API Error (GET /api/admin/catalogue/sync-status):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Game Feedback (report-a-problem review queue, v2.25.0) ---

/** GET /api/admin/catalogue/feedback?status=open|resolved — queue listing with live game context. */
router.get('/catalogue/feedback', async (req, res) => {
    try {
        const { GameFeedbackService } = await import('../../services/GameFeedbackService.js');
        const resolved = (req.query.status as string) === 'resolved';
        const reports = await GameFeedbackService.list({ resolved });
        res.json(reports);
    } catch (error) {
        logError('API Error (GET /api/admin/catalogue/feedback):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/** POST /api/admin/catalogue/feedback/:id/resolve — body { resolution: fixed|upstream|dismissed, note? }. */
router.post('/catalogue/feedback/:id/resolve', async (req, res) => {
    try {
        const parsed = (await import('../schemas.js')).ResolveGameFeedbackSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid resolution' });
        }
        const { GameFeedbackService } = await import('../../services/GameFeedbackService.js');
        const ok = await GameFeedbackService.resolve({
            id: req.params.id as string,
            resolution: parsed.data.resolution,
            note: parsed.data.note,
            resolvedBy: req.user!.discordId || req.user!.username || 'admin',
        });
        if (!ok) return res.status(404).json({ error: 'Report not found or already resolved' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST /api/admin/catalogue/feedback/:id/resolve):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Score Reports (admin moderation queue) ---

/** GET /api/admin/score-reports — list pending reports with full context */
router.get('/score-reports', async (req, res) => {
    try {
        const status = (req.query.status as string) || 'pending';
        const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
        const offset = parseInt(req.query.offset as string) || 0;
        const reports = status === 'resolved'
            ? await ScoreReportService.listResolved(limit, offset)
            : await ScoreReportService.listPending(limit, offset);
        res.json(reports);
    } catch (error) {
        logError('API Error (GET /api/admin/score-reports):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/** POST /api/admin/score-reports/:reportId/dismiss */
router.post('/score-reports/:reportId/dismiss', async (req, res) => {
    try {
        const ok = await ScoreReportService.dismiss(req.params.reportId as string, (req.user!.discordId || req.user!.username || 'admin'));
        if (!ok) return res.status(404).json({ error: 'Report not found or already resolved' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST /api/admin/score-reports/:reportId/dismiss):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/** POST /api/admin/score-reports/:reportId/soft-delete */
router.post('/score-reports/:reportId/soft-delete', async (req, res) => {
    try {
        const ok = await ScoreReportService.softDeleteScore(req.params.reportId as string, (req.user!.discordId || req.user!.username || 'admin'));
        if (!ok) return res.status(404).json({ error: 'Report not found' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST /api/admin/score-reports/:reportId/soft-delete):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/** POST /api/admin/score-reports/:reportId/hard-delete */
router.post('/score-reports/:reportId/hard-delete', async (req, res) => {
    try {
        const ok = await ScoreReportService.hardDeleteScore(req.params.reportId as string, (req.user!.discordId || req.user!.username || 'admin'));
        if (!ok) return res.status(404).json({ error: 'Report not found' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST /api/admin/score-reports/:reportId/hard-delete):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/** POST /api/admin/score-reports/:reportId/ban — body: { durationDays?: number|null, reason?: string } */
router.post('/score-reports/:reportId/ban', async (req, res) => {
    try {
        const durationDays = req.body?.durationDays ?? null;
        const reason = req.body?.reason;
        const ok = await ScoreReportService.banUser(
            req.params.reportId as string,
            (req.user!.discordId || req.user!.username || 'admin'),
            durationDays,
            reason
        );
        if (!ok) return res.status(404).json({ error: 'Report not found' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST /api/admin/score-reports/:reportId/ban):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- User Bans ---

/** GET /api/admin/bans?active=1 */
router.get('/bans', async (req, res) => {
    try {
        const activeOnly = req.query.active === '1' || req.query.active === 'true';
        const bans = await ScoreReportService.listBans(activeOnly);
        res.json(bans);
    } catch (error) {
        logError('API Error (GET /api/admin/bans):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/** POST /api/admin/bans — body: { discordUserId, durationDays?, reason? } */
router.post('/bans', async (req, res) => {
    try {
        const { discordUserId, durationDays, reason } = req.body || {};
        if (!discordUserId) return res.status(400).json({ error: 'discordUserId is required' });
        const ban = await ScoreReportService.ban(
            discordUserId,
            (req.user!.discordId || req.user!.username || 'admin'),
            durationDays ?? null,
            reason
        );
        res.status(201).json(ban);
    } catch (error) {
        logError('API Error (POST /api/admin/bans):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/** POST /api/admin/bans/:banId/lift */
router.post('/bans/:banId/lift', async (req, res) => {
    try {
        const ok = await ScoreReportService.lift(req.params.banId as string, (req.user!.discordId || req.user!.username || 'admin'));
        if (!ok) return res.status(404).json({ error: 'Ban not found or already lifted' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST /api/admin/bans/:banId/lift):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Global Scores (admin visibility into deleted scores, restore, hard-delete) ---

/** GET /api/admin/global-scores/deleted */
router.get('/global-scores/deleted', async (req, res) => {
    try {
        const { getDatabase } = await import('../../database/database.js');
        const db = await getDatabase();
        const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
        const rows = await db.all(
            `SELECT s.*, gg.name as game_name
             FROM global_scores s
             LEFT JOIN global_games gg ON gg.id = s.global_game_id
             WHERE s.deleted_at IS NOT NULL
             ORDER BY s.deleted_at DESC
             LIMIT ?`,
            limit
        );
        res.json(rows);
    } catch (error) {
        logError('API Error (GET /api/admin/global-scores/deleted):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/** POST /api/admin/global-scores/:scoreId/restore */
router.post('/global-scores/:scoreId/restore', async (req, res) => {
    try {
        const ok = await GlobalScoreService.restore(req.params.scoreId as string);
        if (!ok) return res.status(404).json({ error: 'Score not found' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST /api/admin/global-scores/:scoreId/restore):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/** DELETE /api/admin/global-scores/:scoreId?hard=true */
router.delete('/global-scores/:scoreId', async (req, res) => {
    try {
        const hard = req.query.hard === 'true' || req.query.hard === '1';
        const ok = hard
            ? await GlobalScoreService.hardDelete(req.params.scoreId as string)
            : await GlobalScoreService.softDelete(req.params.scoreId as string, (req.user!.discordId || req.user!.username || 'admin'));
        if (!ok) return res.status(404).json({ error: 'Score not found' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE /api/admin/global-scores/:scoreId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ─── Global Score Backfill (one-time) ───────────────────────────────────
// Migrates historical room scores (submissions + community_scores) into
// global_scores. Idempotent — skips rows that already exist (dedup on
// player+game+score+room). Also backfills games.global_game_id for existing
// tournament games by name matching against the global catalogue.
router.post('/global-backfill', requireAuth, requireSuperAdmin, async (_req, res) => {
    try {
        const db = (await import('../../database/database.js')).getDatabase;
        const dbConn = await db();
        const { normalizeGameName } = await import('../../utils/catalogueUtils.js');

        const stats = { gamesLinked: 0, submissionsBackfilled: 0, communityBackfilled: 0, skippedNoMatch: 0, skippedDupes: 0 };

        // Step 1: Build a lookup of normalized global_game names → id
        const globalGames = await dbConn.all(
            `SELECT id, name, display_name FROM global_games WHERE status = 'approved' AND global_leaderboard = 1`
        );
        const normalizedMap = new Map<string, string>();
        for (const gg of globalGames) {
            normalizedMap.set(normalizeGameName(gg.name), gg.id);
            if (gg.display_name) normalizedMap.set(normalizeGameName(gg.display_name), gg.id);
        }

        // Step 2: Backfill games.global_game_id where missing
        const unlinkedGames = await dbConn.all(
            `SELECT id, name FROM games WHERE global_game_id IS NULL`
        );
        for (const g of unlinkedGames) {
            const norm = normalizeGameName(g.name);
            const match = normalizedMap.get(norm);
            if (match) {
                await dbConn.run('UPDATE games SET global_game_id = ? WHERE id = ?', match, g.id);
                stats.gamesLinked++;
            }
        }

        // Step 3: Backfill submissions → global_scores
        const submissions = await dbConn.all(`
            SELECT s.id, s.iscored_username, s.score, s.photo_url, s.timestamp,
                   g.global_game_id, g.name as game_name, t.game_room_id,
                   COALESCE(um.discord_user_id, 'SYSTEM') as discord_user_id
            FROM submissions s
            JOIN games g ON g.id = s.game_id
            JOIN tournaments t ON t.id = g.tournament_id
            LEFT JOIN user_mappings um ON LOWER(um.iscored_username) = LOWER(s.iscored_username)
            WHERE g.global_game_id IS NOT NULL
        `);

        for (const s of submissions) {
            // Dedup check
            const exists = await dbConn.get(
                `SELECT id FROM global_scores
                 WHERE global_game_id = ? AND origin_game_room_id = ?
                   AND LOWER(iscored_username) = LOWER(?) AND score = ?`,
                s.global_game_id, s.game_room_id, s.iscored_username, s.score
            );
            if (exists) { stats.skippedDupes++; continue; }

            const id = (await import('crypto')).randomUUID();
            const submittedBy = normalizeSubmitterUserId(s.discord_user_id);
            await dbConn.run(
                `INSERT INTO global_scores (
                    id, global_game_id, player_id, iscored_username, score,
                    photo_url, origin_type, origin_game_room_id,
                    exclude_from_global, submitted_at,
                    submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
                    submitted_by_anonymous_name, merged_from_anonymous_identity_id
                ) VALUES (?, ?, ?, ?, ?, ?, 'game_room', ?, 0, ?, ?, NULL, ?, ?, NULL)`,
                id, s.global_game_id, s.discord_user_id, s.iscored_username,
                s.score, s.photo_url || null, s.game_room_id,
                s.timestamp || new Date().toISOString(),
                s.game_room_id, submittedBy, submittedBy ? null : s.iscored_username
            );
            stats.submissionsBackfilled++;
        }

        // Step 4: Backfill community_scores → global_scores
        const communityScores = await dbConn.all(`
            SELECT cs.id, cs.game_name, cs.game_room_id, cs.iscored_username,
                   cs.discord_user_id, cs.score, cs.photo_url, cs.created_at
            FROM community_scores cs
        `);

        for (const cs of communityScores) {
            // Resolve global_game_id by name
            const norm = normalizeGameName(cs.game_name);
            const globalGameId = normalizedMap.get(norm);
            if (!globalGameId) { stats.skippedNoMatch++; continue; }

            const exists = await dbConn.get(
                `SELECT id FROM global_scores
                 WHERE global_game_id = ? AND origin_game_room_id = ?
                   AND LOWER(iscored_username) = LOWER(?) AND score = ?`,
                globalGameId, cs.game_room_id, cs.iscored_username, cs.score
            );
            if (exists) { stats.skippedDupes++; continue; }

            const id = (await import('crypto')).randomUUID();
            const submittedBy = normalizeSubmitterUserId(cs.discord_user_id);
            await dbConn.run(
                `INSERT INTO global_scores (
                    id, global_game_id, player_id, iscored_username, score,
                    photo_url, origin_type, origin_game_room_id,
                    exclude_from_global, submitted_at,
                    submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
                    submitted_by_anonymous_name, merged_from_anonymous_identity_id
                ) VALUES (?, ?, ?, ?, ?, ?, 'game_room', ?, 0, ?, ?, NULL, ?, ?, NULL)`,
                id, globalGameId, cs.discord_user_id || 'COMMUNITY',
                cs.iscored_username, cs.score, cs.photo_url || null,
                cs.game_room_id, cs.created_at || new Date().toISOString(),
                cs.game_room_id, submittedBy, submittedBy ? null : cs.iscored_username
            );
            stats.communityBackfilled++;
        }

        // Step 5: Invalidate all leaderboard caches
        const { GlobalLeaderboardService } = await import('../../services/GlobalLeaderboardService.js');
        await GlobalLeaderboardService.invalidateAll();

        logInfo(`Global backfill complete: ${JSON.stringify(stats)}`);
        res.json({ success: true, stats });
    } catch (error) {
        logError('API Error (POST /api/admin/global-backfill):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

export default router;
