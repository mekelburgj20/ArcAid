import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import fs from 'fs';
import path from 'path';
import { createServer } from 'http';
import { EventEmitter } from 'events';
import { initWebSocket } from './websocket.js';
import { getDatabase } from '../database/database.js';
import { logInfo, logError } from '../utils/logger.js';
import { authLimiter, generalLimiter, ogPreviewLimiter } from './rateLimit.js';
import { correlationId } from './correlationId.js';
import { maybeBuildOgShell, isPreviewBot } from './ogMeta.js';

// Route modules
import authRouter from './routes/auth.js';
import roomsRouter from './routes/rooms.js';
import adminRouter from './routes/admin.js';
import globalRouter from './routes/global.js';
import usersRouter from './routes/users.js';

export const serverEvents = new EventEmitter();

/**
 * S19 — Cache-Control policy for the built admin-ui frontend, applied via
 * express.static's `setHeaders`.
 *
 * - `sw.js` / `index.html` / `manifest.json` -> no-cache (ETag revalidation
 *   stays on, express defaults). These MUST be revalidated on every load —
 *   sw.js is how an installed PWA discovers a new BUILD_ID, index.html
 *   references the current content-hashed bundle, and manifest.json's icon
 *   paths can change the same way (added v2.45.1 — see below).
 * - Anything under `/assets/` (Vite's content-hashed output) -> immutable,
 *   1-year max-age. Safe because the filename changes whenever the content
 *   does.
 * - Everything else in public/ (icons, fonts, favicons, ...) -> a modest
 *   explicit max-age (v2.45.1). Previously these got NO explicit header at
 *   all, so browsers fell back to heuristic freshness off Last-Modified —
 *   when v2.45.0 overwrote arcaid-logo.png/arcaid-icon-*.png in place (same
 *   filenames, new content), that heuristic served the stale cached bytes
 *   for days, and the PWA icon cache compounded it (a delete+reinstall still
 *   showed the old icon). The actual fix for that release is shipping new
 *   filenames per asset (see CHANGELOG); this max-age is defense in depth so
 *   a *future* same-name overwrite goes stale for at most a day instead of
 *   indefinitely.
 *
 * Exported so the backend test suite can mount this against a fixture dist
 * directory without booting the full server (DB/websocket/Discord).
 */
export function frontendStaticOptions(frontendPath: string): NonNullable<Parameters<typeof express.static>[1]> {
    return {
        setHeaders: (res, filePath) => {
            const rel = path.relative(frontendPath, filePath);
            if (rel === 'sw.js' || rel === 'index.html' || rel === 'manifest.json') {
                res.setHeader('Cache-Control', 'no-cache');
            } else if (rel.startsWith(`assets${path.sep}`)) {
                res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            } else {
                res.setHeader('Cache-Control', 'public, max-age=86400');
            }
        },
    };
}

/**
 * Resolve default room for backward-compat aliases.
 * Returns the first game room's ID, or null if none exist.
 */
async function getDefaultRoomId(): Promise<string | null> {
    const db = await getDatabase();
    const row = await db.get('SELECT id FROM game_rooms ORDER BY created_at ASC LIMIT 1');
    return row?.id || null;
}

/**
 * Middleware that injects the default room ID into (req.params as any).roomId.
 * Used for backward-compat aliases that redirect legacy unscoped endpoints
 * to the room-scoped router.
 */
function injectDefaultRoom(req: express.Request, res: express.Response, next: express.NextFunction) {
    getDefaultRoomId().then(roomId => {
        if (!roomId) {
            // No rooms configured — fall through (legacy behavior)
            return next('route');
        }
        (req.params as any).roomId = roomId;
        next();
    }).catch(err => {
        logError('Failed to resolve default room:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    });
}

export function startApiServer(port: number = 3001) {
    const app = express();

    // Trust proxy (Caddy/nginx in front of Docker)
    app.set('trust proxy', 1);

    // --- Security Headers ---
    app.use(helmet({
        contentSecurityPolicy: false,  // CSP handled by frontend build
        crossOriginEmbedderPolicy: false,  // Allow embedded resources
    }));

    // --- Correlation ID ---
    app.use(correlationId);

    // --- CORS ---
    const allowedOrigins = process.env.CORS_ORIGIN
        ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
        : undefined; // undefined = allow all (dev mode)

    app.use(cors(allowedOrigins ? {
        origin: allowedOrigins,
        credentials: true,
    } : undefined));

    app.use(express.json());

    // --- Serve Style Images (static, no rate limit, cached 7 days) ---
    const stylesPath = path.join(process.cwd(), 'data', 'styles');
    app.use('/api/styles/images', express.static(stylesPath, { maxAge: '7d' }));

    // --- Serve Room Assets (backgrounds, logos — static, cached 7 days) ---
    const roomAssetsPath = path.join(process.cwd(), 'data', 'room-assets');
    app.use('/api/room-assets', express.static(roomAssetsPath, { maxAge: '7d' }));

    // --- Serve Score Photos (static, cached 7 days) ---
    const scorePhotosPath = path.join(process.cwd(), 'data', 'score-photos');
    app.use('/api/score-photos', express.static(scorePhotosPath, { maxAge: '7d' }));

    // --- Serve Catalogue Images (cover art from OPDB/VPS/IGDB/Wizard imports) ---
    const catalogueImagesPath = path.join(process.cwd(), 'data', 'catalogue-images');
    app.use('/api/catalogue-images', express.static(catalogueImagesPath, { maxAge: '30d' }));

    // --- Rate Limiting ---
    app.use('/api/', generalLimiter);
    app.use('/api/auth', authLimiter);

    // Audit Logging note: the app-level `auditLog` middleware (formerly
    // mounted here) was removed in the 2026-08 audit-log sweep. It is mounted
    // BEFORE every router's own requireAuth/requireDiscordUser sets req.user,
    // so it early-returned on every single request and never audited
    // anything in production (see ROADMAP.md "Audit" and
    // src/api/auditMiddleware.ts). Every admin write that needs an audit
    // trail now calls `AuditService.log` explicitly at its call site.

    // --- Mount Routers ---
    app.use('/api/auth', authRouter);
    app.use('/api/rooms', roomsRouter);
    app.use('/api/admin', adminRouter);
    app.use('/api/users', usersRouter);
    app.use('/api', globalRouter);

    // --- Backward Compatibility Aliases ---
    // Legacy unscoped URLs like /api/leaderboard → /api/rooms router with default room injected.
    // Each legacy path mounts a handler that resolves the default room and rewrites the URL
    // to include both the roomId and the original path segment (which Express strips on mount).

    const legacyPaths = [
        'tournaments', 'leaderboard', 'dashboard', 'history',
        'rankings', 'ranking-groups', 'game_library', 'ratings',
        'stats', 'games', 'scheduler',
    ];

    for (const segment of legacyPaths) {
        app.use(`/api/${segment}`, (req, res, next) => {
            getDefaultRoomId().then(roomId => {
                if (!roomId) return next('route');
                // Rebuild full path: /:roomId/:segment + any sub-path
                const subPath = req.url === '/' ? '' : req.url;
                req.url = `/${roomId}/${segment}${subPath}`;
                roomsRouter(req, res, next);
            }).catch(err => {
                logError('Legacy alias error:', err);
                res.status(500).json({ error: 'Internal Server Error' });
            });
        });
    }
    // Admin merge-player (under /api/admin/merge-player → rooms/:roomId/admin/merge-player)
    app.use('/api/admin/merge-player', (req, res, next) => {
        getDefaultRoomId().then(roomId => {
            if (!roomId) return res.status(404).json({ error: 'No game rooms configured' });
            (req.params as any).roomId = roomId;
            req.url = `/${roomId}/admin/merge-player`;
            roomsRouter(req, res, next);
        }).catch(() => res.status(500).json({ error: 'Internal Server Error' }));
    });

    // Legacy settings endpoints
    app.get('/api/settings', (req, res, next) => {
        getDefaultRoomId().then(roomId => {
            if (!roomId) return next('route');
            (req.params as any).roomId = roomId;
            req.url = `/${roomId}/settings`;
            roomsRouter(req, res, next);
        }).catch(() => res.status(500).json({ error: 'Internal Server Error' }));
    });
    app.post('/api/settings', (req, res, next) => {
        getDefaultRoomId().then(roomId => {
            if (!roomId) return next('route');
            (req.params as any).roomId = roomId;
            req.url = `/${roomId}/settings`;
            roomsRouter(req, res, next);
        }).catch(() => res.status(500).json({ error: 'Internal Server Error' }));
    });

    // Portal (special: falls back to settings-based for legacy single-room setups)
    app.get('/api/portal', async (req, res) => {
        const roomId = await getDefaultRoomId();
        if (roomId) {
            (req.params as any).roomId = roomId;
            req.url = `/${roomId}/portal`;
            return roomsRouter(req, res, () => {});
        }
        // Fall back to settings-based portal for legacy single-room setups
        try {
            const { SettingsService } = await import('../services/SettingsService.js');
            const name = await SettingsService.get('GAME_ROOM_NAME');
            const slug = await SettingsService.get('GAME_ROOM_SLUG');
            const uiTheme = await SettingsService.get('UI_THEME');
            if (!slug) {
                return res.json({ slug: null, name: null, ui_theme: uiTheme || 'dark' });
            }
            res.json({ slug, name: name || slug, ui_theme: uiTheme || 'dark' });
        } catch (error) {
            logError('API Error (/api/portal):', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // Legacy log/backup endpoints redirect to admin router
    app.get('/api/logs', (req, res, next) => {
        req.url = '/logs';
        adminRouter(req, res, next);
    });
    app.get('/api/logs/stream', (req, res, next) => {
        req.url = '/logs/stream';
        adminRouter(req, res, next);
    });
    app.get('/api/backups', (req, res, next) => {
        req.url = '/backups';
        adminRouter(req, res, next);
    });
    app.post('/api/backups', (req, res, next) => {
        req.url = '/backups';
        adminRouter(req, res, next);
    });
    app.post('/api/backups/:name/restore', (req, res, next) => {
        req.url = `/backups/${req.params.name}/restore`;
        adminRouter(req, res, next);
    });

    // --- Serve React Frontend (Production) ---
    const frontendPath = path.join(process.cwd(), 'admin-ui', 'dist');
    if (fs.existsSync(frontendPath)) {
        logInfo('Found built Admin UI, serving static files.');
        app.use(express.static(frontendPath, frontendStaticOptions(frontendPath)));

        app.get(/^(?!\/api).*/, (req, res, next) => {
            // S16: the catch-all sits outside the /api generalLimiter and a
            // preview-bot UA now triggers DB lookups — cap that surface.
            // Humans never enter the limiter.
            if (isPreviewBot(req.get('user-agent'))) {
                ogPreviewLimiter(req, res, next);
                return;
            }
            next();
        }, async (req, res) => {
            // S19: the SPA shell is index.html regardless of which branch below
            // serves it — must always revalidate (see frontendStaticOptions).
            // Set explicitly (not just relying on express.static, since this
            // catch-all handler builds the response itself) and disable
            // sendFile's own Cache-Control so it can't override this.
            res.setHeader('Cache-Control', 'no-cache');

            // S16: link-preview crawlers on shareable routes get the shell with
            // OG tags injected; everyone else (and any failure) gets the
            // unmodified shell.
            const ogShell = await maybeBuildOgShell(req, frontendPath);
            if (ogShell) {
                res.type('html').send(ogShell);
                return;
            }
            res.sendFile(path.join(frontendPath, 'index.html'), { cacheControl: false });
        });
    }

    // Create HTTP server and attach Socket.io
    const httpServer = createServer(app);
    initWebSocket(httpServer);

    httpServer.listen(port, '0.0.0.0', () => {
        logInfo(`Admin API Server listening on port ${port}`);
    });
}
