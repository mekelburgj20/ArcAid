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
    BackupRestoreParamsSchema, CreateGameRoomSchema, UpdateGameRoomSchema,
    ResolveContentReportSchema, BanActionSchema, CreateBanSchema,
    SuspendRoomSchema, AdminSetDisplayNameSchema,
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
import { RAApiClient } from '../../services/RAApiClient.js';
import { RAMasterListService, RA_SYNC_SOURCE } from '../../services/RAMasterListService.js';
import { raSearchHandler, raImportHandler } from '../raCatalogueHandlers.js';
import { ScoreReportService } from '../../services/ScoreReportService.js';
import { ContentReportService } from '../../services/ContentReportService.js';
import { CommentReportService } from '../../services/CommentReportService.js';
import { GlobalScoreService } from '../../services/GlobalScoreService.js';
import { normalizeSubmitterUserId } from '../../services/SubmissionContextService.js';
import { mapLegacyPlatform } from '../../utils/scoreProvenance.js';

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
        // v2.43.0 — S22 Phase 1 recon risk #2: this route previously accepted
        // req.body with NO Zod validation at all. UpdateGameRoomSchema covers
        // exactly the fields GameRoomService.update whitelists, plus the
        // blocklist refine on name/slug.
        const validationResult = validate(UpdateGameRoomSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const updated = await GameRoomService.update(req.params.roomId as string, validationResult.data);
        if (!updated) return res.status(404).json({ error: 'Room not found' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (PUT /api/admin/rooms/:roomId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.delete('/rooms/:roomId', async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const room = await GameRoomService.getById(roomId);
        const deleted = await GameRoomService.delete(roomId);
        if (!deleted) return res.status(404).json({ error: 'Room not found' });

        // Explicit audit write — the app-level auditLog middleware is mounted
        // BEFORE this router's requireAuth sets req.user, so it never fires
        // here (see ROADMAP.md "Audit"). Destructive op, so it gets one.
        await AuditService.log({
            actor: req.user!.discordId || req.user!.username || req.user!.localAdminId || 'admin',
            action: 'room.delete',
            target_type: 'room',
            target_id: roomId,
            details: JSON.stringify({ name: room?.name ?? null, slug: room?.slug ?? null }),
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE /api/admin/rooms/:roomId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /api/admin/rooms/:roomId/suspend — S22 Phase 2 (v2.44.0) — body:
 * { reason?: string }. Idempotent 200: suspending an already-suspended room
 * just refreshes suspended_by/reason rather than 409ing (a super-admin
 * editing the reason shouldn't need to unsuspend first).
 */
router.post('/rooms/:roomId/suspend', async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const room = await GameRoomService.getById(roomId);
        if (!room) return res.status(404).json({ error: 'Room not found' });

        const validationResult = validate(SuspendRoomSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const actor = req.user!.discordId || req.user!.localAdminId || 'admin';
        await GameRoomService.suspend(roomId, actor, validationResult.data.reason ?? null);
        logInfo(`Room suspended: ${room.name} (${room.slug}) by ${actor}`);

        // Explicit audit write — auditMiddleware does NOT fire on router routes.
        await AuditService.log({
            actor,
            action: 'room.suspend',
            target_type: 'room',
            target_id: roomId,
            details: JSON.stringify({ name: room.name, slug: room.slug, reason: validationResult.data.reason ?? null }),
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST /api/admin/rooms/:roomId/suspend):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/** POST /api/admin/rooms/:roomId/unsuspend — S22 Phase 2 (v2.44.0). Idempotent. */
router.post('/rooms/:roomId/unsuspend', async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const room = await GameRoomService.getById(roomId);
        if (!room) return res.status(404).json({ error: 'Room not found' });

        await GameRoomService.unsuspend(roomId);
        const actor = req.user!.discordId || req.user!.localAdminId || 'admin';
        logInfo(`Room unsuspended: ${room.name} (${room.slug}) by ${actor}`);

        // Explicit audit write — auditMiddleware does NOT fire on router routes.
        await AuditService.log({
            actor,
            action: 'room.unsuspend',
            target_type: 'room',
            target_id: roomId,
            details: JSON.stringify({ name: room.name, slug: room.slug }),
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST /api/admin/rooms/:roomId/unsuspend):', error);
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

        // Explicit audit write — auditMiddleware does NOT fire on router routes.
        // Identity op (granting server-wide super-admin) — always logged.
        await AuditService.log({
            actor: req.user!.discordId || req.user!.username || req.user!.localAdminId || 'admin',
            action: 'superadmin.add',
            target_type: 'super_admin',
            target_id: resolvedId,
            details: JSON.stringify({ username: username || input.trim() }),
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST /api/admin/super-admins):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.delete('/super-admins/:discordId', async (req, res) => {
    try {
        const targetId = req.params.discordId as string;
        const deleted = await AdminService.removeSuperAdmin(targetId);
        if (!deleted) return res.status(404).json({ error: 'Super admin not found' });

        // Explicit audit write — auditMiddleware does NOT fire on router routes.
        await AuditService.log({
            actor: req.user!.discordId || req.user!.username || req.user!.localAdminId || 'admin',
            action: 'superadmin.remove',
            target_type: 'super_admin',
            target_id: targetId,
            details: '{}',
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

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

        // Explicit audit write — auditMiddleware does NOT fire on router routes.
        // Most destructive op in the admin surface (replaces the live DB); logged
        // before the response since the process restarts moments later.
        await AuditService.log({
            actor: req.user!.discordId || req.user!.username || req.user!.localAdminId || 'admin',
            action: 'backup.restore',
            target_type: 'backup',
            target_id: validationResult.data.name,
            details: '{}',
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

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
// requireSuperAdmin. NOT auto-audited — the app-level auditLog middleware is
// mounted before this router's own auth sets req.user (see ROADMAP.md
// "Audit"), so it never fires here; audited explicitly below instead.
router.delete('/backups/:name', async (req, res) => {
    try {
        const validationResult = validate(BackupRestoreParamsSchema, { name: req.params.name as string });
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        await deleteBackup(validationResult.data.name);

        await AuditService.log({
            actor: req.user!.discordId || req.user!.username || req.user!.localAdminId || 'admin',
            action: 'backup.delete',
            target_type: 'backup',
            target_id: validationResult.data.name,
            details: '{}',
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

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

            // Explicit audit write — auditMiddleware does NOT fire on router
            // routes. Settings change: keys only, never values (none of these
            // are secrets, but this mirrors the doctrine for /settings below).
            await AuditService.log({
                actor: req.user!.discordId || req.user!.username || req.user!.localAdminId || 'admin',
                action: 'backup.config_update',
                target_type: 'settings',
                target_id: 'backup',
                details: JSON.stringify({ keys: Object.keys(toSave) }),
                ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
                correlation_id: req.correlationId || '',
            });
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

        // Explicit audit write — auditMiddleware does NOT fire on router routes.
        // Global settings can include secrets (ENCRYPTED_SETTING_KEYS) — log the
        // KEYS changed only, never the values, so a secret's plaintext can never
        // leak into audit_log.
        await AuditService.log({
            actor: req.user!.discordId || req.user!.username || req.user!.localAdminId || 'admin',
            action: 'settings.update',
            target_type: 'settings',
            target_id: 'global',
            details: JSON.stringify({ keys: Object.keys(settings) }),
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

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

/**
 * IGDB bulk seed. Unlike the other sync endpoints this one can run for hours,
 * so it gets two guards the others don't:
 *
 *  - Single-flight. A second POST while a run is genuinely in flight (status
 *    `running` with a fresh heartbeat) is refused with 409 and the job's
 *    details, rather than starting a duplicate crawl that would race the first
 *    one through the same upserts. A `running` row whose process died is not
 *    in flight and does not block.
 *  - Live credential probe. Presence of TWITCH_CLIENT_ID/SECRET says nothing
 *    about whether Twitch will accept them; a bad pair used to return 202
 *    "started" and then fail in the background where the admin never saw it.
 *    We now fetch/refresh the token BEFORE answering, and hand back Twitch's
 *    own error text on rejection.
 *
 * `restart: true` in the body abandons any resumable checkpoint and crawls
 * from the beginning.
 */
router.post('/catalogue/sync-igdb', async (req, res) => {
    if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
        return res.status(400).json({
            error: 'TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must be configured for IGDB import. Add them under Global Settings → Configuration.',
        });
    }

    const active = await SyncLogService.getActiveRun('igdb');
    if (active) {
        return res.status(409).json({
            error: 'An IGDB import is already running. Wait for it to finish, or let it fail over before starting another.',
            job: {
                id: active.id,
                started_at: active.started_at,
                heartbeat_at: active.heartbeat_at ?? null,
                pages_done: active.pages_done ?? 0,
                records_fetched: active.records_fetched ?? 0,
                expected_total: active.expected_total ?? null,
                records_imported: active.records_imported ?? 0,
                records_updated: active.records_updated ?? 0,
                records_skipped: active.records_skipped ?? 0,
            },
        });
    }

    try {
        await IGDBImportService.getAccessToken();
    } catch (error) {
        return res.status(400).json({
            error: `IGDB credentials were rejected: ${(error as Error).message}`,
        });
    }

    const restart = (req.body as { restart?: boolean } | undefined)?.restart === true;
    void (async () => {
        try {
            await IGDBImportService.importFromIGDB({ restart });
        } catch (error) {
            logError('Background IGDB sync error:', error);
        }
    })();
    res.status(202).json({ success: true, started: true, source: 'igdb', restart });
});

/**
 * RetroAchievements master-list sync (contract §2).
 *
 * Refreshes `ra_games` — our searchable shadow of RA's per-console game lists
 * — across every console in `RA_CONSOLE_ENGINE_MAP`. This imports NOTHING into
 * the catalogue; it only makes games findable in the add-game flows, where the
 * admin's selection is what triggers the actual import.
 *
 * Validates the key upfront and answers 400 with an actionable message rather
 * than 202-then-fail-silently — the same fix the OPDB/IGDB routes carry.
 * Single-flight via the `sync_logs` running/heartbeat lifecycle: a second
 * click while a crawl is live gets 409 plus the live job, not a competing
 * crawl.
 */
router.post('/catalogue/sync-ra-masterlist', async (_req, res) => {
    if (!RAApiClient.isConfigured()) {
        return res.status(400).json({
            error: 'RA_API_KEY is not configured. Add it under Global Settings → Configuration; ' +
                'any free RetroAchievements account can mint one at ' +
                'https://retroachievements.org/controlpanel.php.',
        });
    }

    const active = await SyncLogService.getActiveRun(RA_SYNC_SOURCE);
    if (active) {
        return res.status(409).json({
            error: 'A RetroAchievements master-list sync is already running.',
            job: {
                id: active.id,
                started_at: active.started_at,
                heartbeat_at: active.heartbeat_at ?? null,
                pages_done: active.pages_done ?? 0,
                records_fetched: active.records_fetched ?? 0,
            },
        });
    }

    void (async () => {
        try {
            await RAMasterListService.syncAll();
        } catch (error) {
            logError('Background RA master-list sync error:', error);
        }
    })();
    res.status(202).json({ success: true, started: true, source: RA_SYNC_SOURCE });
});

/**
 * Super-admin twin of the RA master-list search (contract §2). Same handler as
 * the room and public surfaces; the router-level requireAuth + requireSuperAdmin
 * is the only difference.
 */
router.get('/ra-catalogue/search', raSearchHandler);

/**
 * Super-admin twin of the RA import (contract §3). NOT auto-audited — the
 * app-level `auditLog` middleware is mounted before this router's own auth
 * sets req.user, so it never fires on any router route (see ROADMAP.md
 * "Audit"; a prior version of this comment claimed otherwise). `raImportHandler`
 * is shared across three mount points (super-admin here, room-admin in
 * rooms.ts, public) with different auth — left out of the explicit-audit sweep
 * since none of the three callers has a single well-defined "admin actor" to
 * attribute a catalogue-wide write to; tracked as a gap, not silently fixed.
 */
router.post('/ra-catalogue/import/:raGameId', raImportHandler);

/** Master-list freshness, for the Catalogue admin page's sync panel. */
router.get('/ra-catalogue/status', async (_req, res) => {
    try {
        res.json({
            ...(await RAMasterListService.getStatus()),
            configured: RAApiClient.isConfigured(),
        });
    } catch (error) {
        logError('API Error (GET admin/ra-catalogue/status):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
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

        // Explicit audit write — auditMiddleware does NOT fire on router routes.
        await AuditService.log({
            actor: req.user!.discordId || req.user!.username || req.user!.localAdminId || 'admin',
            action: 'catalogue.merge',
            target_type: 'global_game',
            target_id: targetId,
            details: JSON.stringify({ sourceId, scoresMoved: result.scoresMoved }),
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

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

        // Explicit audit write — auditMiddleware does NOT fire on router routes.
        // Skip the dry-run preview (no mutation) — only the destructive run.
        if (!dryRun) {
            await AuditService.log({
                actor: req.user!.discordId || req.user!.username || req.user!.localAdminId || 'admin',
                action: 'catalogue.merge_ipdb_duplicates',
                target_type: 'global_game',
                target_id: 'bulk',
                details: JSON.stringify(result),
                ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
                correlation_id: req.correlationId || '',
            });
        }

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

        // Explicit audit write — auditMiddleware does NOT fire on router routes.
        if (stripped > 0) {
            await AuditService.log({
                actor: req.user!.discordId || req.user!.username || req.user!.localAdminId || 'admin',
                action: 'catalogue.dedup_strip',
                target_type: 'global_game',
                target_id: 'bulk',
                details: JSON.stringify({ stripped, skipped, ids }),
                ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
                correlation_id: req.correlationId || '',
            });
        }

        res.json({ stripped, skipped, results });
    } catch (error) {
        logError('API Error (POST /api/admin/catalogue/dedup-audit/strip):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.delete('/catalogue/games/:id', async (req, res) => {
    try {
        const gameId = req.params.id as string;
        const deleted = await GlobalGameService.delete(gameId);
        if (!deleted) return res.status(404).json({ error: 'Game not found' });

        // Explicit audit write — auditMiddleware does NOT fire on router routes.
        await AuditService.log({
            actor: req.user!.discordId || req.user!.username || req.user!.localAdminId || 'admin',
            action: 'catalogue.delete',
            target_type: 'global_game',
            target_id: gameId,
            details: '{}',
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

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

        // Explicit audit write — the app-level auditLog middleware is mounted
        // BEFORE this router's requireAuth sets req.user, so it never fires
        // here (a prior version of this comment claimed otherwise — wrong,
        // see ROADMAP.md "Audit").
        await AuditService.log({
            actor: reviewerId,
            action: 'catalogue.pending_reject',
            target_type: 'global_game',
            target_id: gameId,
            details: JSON.stringify({ reason: reason || null }),
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

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

        // Explicit audit write — the app-level auditLog middleware is mounted
        // BEFORE this router's requireAuth sets req.user, so it never fires
        // here (a prior version of this comment claimed otherwise — wrong,
        // see ROADMAP.md "Audit").
        await AuditService.log({
            actor: req.user!.discordId || req.user!.username || req.user!.localAdminId || 'admin',
            action: 'catalogue.pending_merge',
            target_type: 'global_game',
            target_id: targetGameId,
            details: JSON.stringify({ mergedFrom: gameId, scoresMoved: result.scoresMoved }),
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

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
        const reportId = req.params.reportId as string;
        const actor = req.user!.discordId || req.user!.username || 'admin';
        const ok = await ScoreReportService.dismiss(reportId, actor);
        if (!ok) return res.status(404).json({ error: 'Report not found or already resolved' });

        // Explicit audit write — auditMiddleware does NOT fire on router routes.
        await AuditService.log({
            actor, action: 'score_report.dismiss', target_type: 'score_report', target_id: reportId,
            details: '{}',
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST /api/admin/score-reports/:reportId/dismiss):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/** POST /api/admin/score-reports/:reportId/soft-delete */
router.post('/score-reports/:reportId/soft-delete', async (req, res) => {
    try {
        const reportId = req.params.reportId as string;
        const actor = req.user!.discordId || req.user!.username || 'admin';
        const ok = await ScoreReportService.softDeleteScore(reportId, actor);
        if (!ok) return res.status(404).json({ error: 'Report not found' });

        // Explicit audit write — auditMiddleware does NOT fire on router routes.
        await AuditService.log({
            actor, action: 'score_report.soft_delete', target_type: 'score_report', target_id: reportId,
            details: '{}',
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST /api/admin/score-reports/:reportId/soft-delete):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/** POST /api/admin/score-reports/:reportId/hard-delete */
router.post('/score-reports/:reportId/hard-delete', async (req, res) => {
    try {
        const reportId = req.params.reportId as string;
        const actor = req.user!.discordId || req.user!.username || 'admin';
        const ok = await ScoreReportService.hardDeleteScore(reportId, actor);
        if (!ok) return res.status(404).json({ error: 'Report not found' });

        // Explicit audit write — auditMiddleware does NOT fire on router routes.
        await AuditService.log({
            actor, action: 'score_report.hard_delete', target_type: 'score_report', target_id: reportId,
            details: '{}',
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST /api/admin/score-reports/:reportId/hard-delete):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/** POST /api/admin/score-reports/:reportId/ban — body: { durationDays?: number|null, reason?: string } */
router.post('/score-reports/:reportId/ban', async (req, res) => {
    try {
        const validationResult = validate(BanActionSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const { durationDays, reason, contentAction } = validationResult.data;

        const reportId = req.params.reportId as string;
        const report = await ScoreReportService.getById(reportId);
        if (!report) return res.status(404).json({ error: 'Report not found' });

        // m6 (S22 Phase 1 adversarial review) — a score synced FROM iScored
        // carries a synthetic `iscored:<username>` player_id (no login
        // identity behind it, see GlobalScoreService's fan-out doctrine).
        // Banning that id writes a user_bans row that can never match any
        // real session — a silent no-op that looks like it worked. Reject
        // explicitly instead.
        // S23.6: only meaningful for a global report — a room report's identity
        // comes from `score_history.submitted_by_user_id`, and `banUser`
        // refuses that case itself (anonymous row → no identity to ban).
        if (report.score_source !== 'room_history') {
            const db = await getDatabase();
            const scoreRow = await db.get<{ player_id: string | null }>(
                'SELECT player_id FROM global_scores WHERE id = ?', report.score_id,
            );
            if (scoreRow?.player_id?.startsWith('iscored:')) {
                return res.status(400).json({
                    error: "Cannot ban an iScored-synced name — it has no login identity to ban. Use Soft Delete or Hard Delete instead.",
                });
            }
        }

        const actor = req.user!.discordId || req.user!.username || 'admin';
        const ok = await ScoreReportService.banUser(
            reportId,
            actor,
            durationDays ?? null,
            reason,
            contentAction ?? 'hide',
        );
        if (typeof ok === 'object') return res.status(400).json({ error: ok.error });
        if (!ok) return res.status(404).json({ error: 'Report not found' });

        // Explicit audit write — auditMiddleware does NOT fire on router routes.
        await AuditService.log({
            actor, action: 'score_report.ban', target_type: 'score_report', target_id: reportId,
            details: JSON.stringify({ durationDays: durationDays ?? null, reason: reason ?? null }),
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST /api/admin/score-reports/:reportId/ban):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Content Moderation Reports (v2.43.0 — S22 Phase 1) ---
// Rooms/player-name reports land in content_reports (ContentReportService);
// the pre-existing score-reports queue above is reused untouched. This
// section wires the new table into the same super-admin surface.

/** GET /api/admin/reports?status=pending|resolved&type=room|player_name&limit&offset */
router.get('/reports', async (req, res) => {
    try {
        const status = req.query.status === 'resolved' ? 'resolved' : 'pending';
        const type = req.query.type === 'room' || req.query.type === 'player_name'
            ? req.query.type
            : undefined;
        const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
        const offset = parseInt(req.query.offset as string) || 0;
        const reports = await ContentReportService.list({ status, type, limit, offset });
        res.json(reports);
    } catch (error) {
        logError('API Error (GET /api/admin/reports):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/** GET /api/admin/reports/pending-count — sum of open content_reports + open score_reports (one badge). */
router.get('/reports/pending-count', async (req, res) => {
    try {
        const db = await getDatabase();
        const [contentCount, scoreRow] = await Promise.all([
            ContentReportService.pendingCount(),
            db.get<{ n: number }>('SELECT COUNT(*) AS n FROM score_reports WHERE resolved_at IS NULL'),
        ]);
        res.json({ pending: contentCount + (scoreRow?.n ?? 0) });
    } catch (error) {
        logError('API Error (GET /api/admin/reports/pending-count):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/** POST /api/admin/reports/:id/dismiss */
router.post('/reports/:id/dismiss', async (req, res) => {
    try {
        const id = parseInt(req.params.id as string, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid report id' });
        const actor = req.user!.discordId || req.user!.username || 'admin';
        const ok = await ContentReportService.dismiss(id, actor);
        if (!ok) return res.status(404).json({ error: 'Report not found or already resolved' });

        // Explicit audit write — auditMiddleware does NOT fire on router routes.
        await AuditService.log({
            actor, action: 'content_report.dismiss', target_type: 'content_report', target_id: String(id),
            details: '{}',
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST /api/admin/reports/:id/dismiss):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/** POST /api/admin/reports/:id/resolve — body: { resolution: string } */
router.post('/reports/:id/resolve', async (req, res) => {
    try {
        const id = parseInt(req.params.id as string, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid report id' });
        const validationResult = validate(ResolveContentReportSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const actor = req.user!.discordId || req.user!.username || 'admin';
        const ok = await ContentReportService.resolve(
            id, actor, validationResult.data.resolution,
        );
        if (!ok) return res.status(404).json({ error: 'Report not found or already resolved' });

        // Explicit audit write — auditMiddleware does NOT fire on router routes.
        await AuditService.log({
            actor, action: 'content_report.resolve', target_type: 'content_report', target_id: String(id),
            details: JSON.stringify({ resolution: validationResult.data.resolution }),
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST /api/admin/reports/:id/resolve):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Comment Reports (v2.47.0 — S22 follow-ups Workstream 2) ---
// Super-admin-only queue, matching the Content Moderation Reports section
// above. Room-admin visibility is future work (contract decision 6).

/** GET /api/admin/comment-reports?status=pending|resolved&limit&offset */
router.get('/comment-reports', async (req, res) => {
    try {
        const status = req.query.status === 'resolved' ? 'resolved' : 'pending';
        const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
        const offset = parseInt(req.query.offset as string) || 0;
        const reports = await CommentReportService.list({ status, limit, offset });
        res.json(reports);
    } catch (error) {
        logError('API Error (GET /api/admin/comment-reports):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/** POST /api/admin/comment-reports/:id/dismiss — resolve only, no content action. */
router.post('/comment-reports/:id/dismiss', async (req, res) => {
    try {
        const id = parseInt(req.params.id as string, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid report id' });
        const actor = req.user!.discordId || req.user!.username || 'admin';
        const ok = await CommentReportService.dismiss(id, actor);
        if (!ok) return res.status(404).json({ error: 'Report not found or already resolved' });

        // Explicit audit write — auditMiddleware does NOT fire on router routes.
        await AuditService.log({
            actor, action: 'comment_report.dismiss', target_type: 'comment_report', target_id: String(id),
            details: '{}',
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST /api/admin/comment-reports/:id/dismiss):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/** POST /api/admin/comment-reports/:id/remove — deletes the reported comment AND resolves the report. */
router.post('/comment-reports/:id/remove', async (req, res) => {
    try {
        const id = parseInt(req.params.id as string, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid report id' });
        const actor = req.user!.discordId || req.user!.username || 'admin';
        const ok = await CommentReportService.remove(id, actor);
        if (!ok) return res.status(404).json({ error: 'Report not found or already resolved' });

        // Explicit audit write — auditMiddleware does NOT fire on router routes.
        await AuditService.log({
            actor, action: 'comment_report.remove', target_type: 'comment_report', target_id: String(id),
            details: '{}',
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST /api/admin/comment-reports/:id/remove):', error);
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
        const validationResult = validate(CreateBanSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const { discordUserId, durationDays, reason, contentAction } = validationResult.data;

        // S22 Phase 2 (v2.44.0) — same guard as the score-report ban route
        // (m6, S22 Phase 1): an `iscored:*` synthetic id has no login
        // identity behind it — a ban row naming one can never match a real
        // session, silently no-opping. Verified Phase 1 only added this check
        // to POST /score-reports/:reportId/ban; this direct-ban route (used
        // by the Reports page's standalone add-ban form and "Ban identity"
        // quick action) needed it too.
        if (discordUserId.startsWith('iscored:')) {
            return res.status(400).json({
                error: "Cannot ban an iScored-synced name — it has no login identity to ban.",
            });
        }

        // m5 fix (S22 Phase 2 adversarial review) — refuse self-ban. Compares
        // both the raw id AND the canonical resolution of both sides, so a
        // super-admin can't route around this by naming a Google/Discord
        // alias linked to their own canonical identity instead of their
        // literal token id. Only meaningful for a discordId-bearing actor —
        // a local-admin (password) super-admin has no discordId and isn't a
        // possible ban target (bans are keyed on provider ids).
        const actorId = req.user!.discordId;
        if (actorId) {
            const { IdentityLinkService } = await import('../../services/IdentityLinkService.js');
            const [actorCanonical, targetCanonical] = await Promise.all([
                IdentityLinkService.resolveCanonical(actorId),
                IdentityLinkService.resolveCanonical(discordUserId),
            ]);
            if (actorId === discordUserId || actorCanonical === targetCanonical) {
                return res.status(400).json({ error: 'You cannot ban your own account.' });
            }
        }

        const actor = req.user!.discordId || req.user!.username || 'admin';
        const ban = await ScoreReportService.ban(
            discordUserId,
            actor,
            durationDays ?? null,
            reason,
            null,
            contentAction ?? 'hide',
        );

        // Explicit audit write — auditMiddleware does NOT fire on router routes.
        await AuditService.log({
            actor, action: 'user.ban', target_type: 'user', target_id: discordUserId,
            details: JSON.stringify({ durationDays: durationDays ?? null, reason: reason ?? null }),
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

        res.status(201).json(ban);
    } catch (error) {
        logError('API Error (POST /api/admin/bans):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/** POST /api/admin/bans/:banId/lift */
router.post('/bans/:banId/lift', async (req, res) => {
    try {
        const banId = req.params.banId as string;
        const actor = req.user!.discordId || req.user!.username || 'admin';
        const result = await ScoreReportService.lift(banId, actor);
        if (!result.lifted) return res.status(404).json({ error: 'Ban not found or already lifted' });

        // Explicit audit write — auditMiddleware does NOT fire on router routes.
        await AuditService.log({
            actor, action: 'user.unban', target_type: 'ban', target_id: banId,
            details: JSON.stringify({ restoredCount: result.restoredCount }),
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

        res.json({ success: true, restoredCount: result.restoredCount });
    } catch (error) {
        logError('API Error (POST /api/admin/bans/:banId/lift):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Admin display-name override (S22 Phase 2, v2.44.0) ---

/**
 * PATCH /api/admin/users/:userId/display-name — body: { displayName: string | null }.
 * `null` clears the override (render falls back to username/id). Non-null
 * re-validates through the exact SAME checks as self-service —
 * `UserProfileService.setDisplayName` already accepts an arbitrary target
 * `discordUserId` (it's not hardcoded to `req.user`), so this route calls it
 * directly rather than duplicating length/blocklist/uniqueness logic in a
 * parallel path. 404s when the target has no `user_profiles` row — this
 * endpoint resets/overrides an EXISTING user's display name, it doesn't
 * create a profile for an id nobody has ever logged in as.
 */
router.patch('/users/:userId/display-name', async (req, res) => {
    try {
        const userId = req.params.userId as string;
        const validationResult = validate(AdminSetDisplayNameSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const db = await getDatabase();
        const existing = await db.get('SELECT discord_user_id FROM user_profiles WHERE discord_user_id = ?', userId);
        if (!existing) return res.status(404).json({ error: 'No profile found for this user' });

        const { UserProfileService } = await import('../../services/UserProfileService.js');
        const next = await UserProfileService.setDisplayName(userId, validationResult.data.displayName);

        // Display name change ripples through every leaderboard render —
        // same invalidation as the self-service PATCH /users/me/profile.
        const { LeaderboardService } = await import('../../services/LeaderboardService.js');
        const { GlobalLeaderboardService } = await import('../../services/GlobalLeaderboardService.js');
        await LeaderboardService.invalidateAll();
        await GlobalLeaderboardService.invalidateAll();

        // Explicit audit write — auditMiddleware does NOT fire on router
        // routes. Moderation-relevant: overrides another user's identity.
        await AuditService.log({
            actor: req.user!.discordId || req.user!.username || req.user!.localAdminId || 'admin',
            action: 'user.display_name_override',
            target_type: 'user',
            target_id: userId,
            details: JSON.stringify({ displayName: next }),
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

        res.json({ display_name: next });
    } catch (error) {
        const e = error as Error & { code?: string; reason?: string };
        if (e.code === 'DISPLAY_NAME_TAKEN') {
            return res.status(409).json({ error: 'Display name not available', reason: e.reason });
        }
        if (e.code === 'NAME_NOT_ALLOWED') {
            return res.status(400).json({ error: e.message, code: e.code });
        }
        logError('API Error (PATCH /api/admin/users/:userId/display-name):', error);
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
        const scoreId = req.params.scoreId as string;
        const ok = await GlobalScoreService.restore(scoreId);
        if (!ok) return res.status(404).json({ error: 'Score not found' });

        // Explicit audit write — auditMiddleware does NOT fire on router routes.
        await AuditService.log({
            actor: req.user!.discordId || req.user!.username || req.user!.localAdminId || 'admin',
            action: 'global_score.restore', target_type: 'global_score', target_id: scoreId,
            details: '{}',
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST /api/admin/global-scores/:scoreId/restore):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/** DELETE /api/admin/global-scores/:scoreId?hard=true */
router.delete('/global-scores/:scoreId', async (req, res) => {
    try {
        const scoreId = req.params.scoreId as string;
        const hard = req.query.hard === 'true' || req.query.hard === '1';
        const actor = req.user!.discordId || req.user!.username || 'admin';
        const ok = hard
            ? await GlobalScoreService.hardDelete(scoreId)
            : await GlobalScoreService.softDelete(scoreId, actor);
        if (!ok) return res.status(404).json({ error: 'Score not found' });

        // Explicit audit write — auditMiddleware does NOT fire on router routes.
        await AuditService.log({
            actor, action: hard ? 'global_score.hard_delete' : 'global_score.soft_delete',
            target_type: 'global_score', target_id: scoreId,
            details: '{}',
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

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
                   s.platform, s.engine, s.device,
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
                    submitted_by_anonymous_name, merged_from_anonymous_identity_id,
                    platform, engine, device
                ) VALUES (?, ?, ?, ?, ?, ?, 'game_room', ?, 0, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)`,
                id, s.global_game_id, s.discord_user_id, s.iscored_username,
                s.score, s.photo_url || null, s.game_room_id,
                s.timestamp || new Date().toISOString(),
                s.game_room_id, submittedBy, submittedBy ? null : s.iscored_username,
                // v2.53.0 (ADR 0016): this backfill previously dropped provenance
                // entirely, so every row it created was NULL on all three columns.
                // Carry the source row's values across; where the source has none,
                // fall back to the source's legacy platform, then to the explicit
                // 'unknown' sentinel — never NULL.
                s.platform ?? null,
                s.engine || mapLegacyPlatform(s.platform).engine,
                s.device || mapLegacyPlatform(s.platform).device
            );
            stats.submissionsBackfilled++;
        }

        // Step 4: Backfill community_scores → global_scores
        const communityScores = await dbConn.all(`
            SELECT cs.id, cs.game_name, cs.game_room_id, cs.iscored_username,
                   cs.discord_user_id, cs.score, cs.photo_url, cs.created_at,
                   cs.platform, cs.engine, cs.device
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
                    submitted_by_anonymous_name, merged_from_anonymous_identity_id,
                    platform, engine, device
                ) VALUES (?, ?, ?, ?, ?, ?, 'game_room', ?, 0, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)`,
                id, globalGameId, cs.discord_user_id || 'COMMUNITY',
                cs.iscored_username, cs.score, cs.photo_url || null,
                cs.game_room_id, cs.created_at || new Date().toISOString(),
                cs.game_room_id, submittedBy, submittedBy ? null : cs.iscored_username,
                // v2.53.0 (ADR 0016): see the submissions pass above — provenance
                // is carried across instead of being dropped.
                cs.platform ?? null,
                cs.engine || mapLegacyPlatform(cs.platform).engine,
                cs.device || mapLegacyPlatform(cs.platform).device
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
