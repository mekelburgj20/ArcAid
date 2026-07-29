import { Router } from 'express';
import multer from 'multer';
import { logError, logInfo } from '../../utils/logger.js';
import { requireAuth, requireDiscordUser, requireSuperAdmin, requireNotBanned, requireNotBannedGlobal } from '../middleware.js';
import { writeLimiter, globalSubmitLimiter, authLimiter, roomCreateLimiter } from '../rateLimit.js';
import { validate } from '../validate.js';
import { isAllowedImage } from '../uploadValidation.js';
import { UpdatePreferencesSchema, PushSubscriptionSchema, PushUnsubscribeSchema, MAX_SCORE, PublicCreateRoomSchema } from '../schemas.js';
import { SettingsService } from '../../services/SettingsService.js';
import { GameRoomService } from '../../services/GameRoomService.js';
import { GlobalGameService } from '../../services/GlobalGameService.js';
import { GlobalScoreService } from '../../services/GlobalScoreService.js';
import { GlobalLeaderboardService } from '../../services/GlobalLeaderboardService.js';
import { GlobalRatingService } from '../../services/GlobalRatingService.js';
import { GlobalCommentService } from '../../services/GlobalCommentService.js';
import { ScoreRankService, type SubmitRankResult } from '../../services/ScoreRankService.js';
import { emitScoreNewGlobal, getIO } from '../websocket.js';
import { getDatabase } from '../../database/database.js';
import { getVersionInfo } from '../../utils/version.js';
import { AuditService } from '../../services/AuditService.js';
import { AccountDeletionService, LastSuperAdminError } from '../../services/AccountDeletionService.js';
import { WebPushService } from '../../services/WebPushService.js';
import { NotificationService } from '../../services/NotificationService.js';
import { deleteScorePhotoFiles } from '../../utils/scorePhotoCleanup.js';

const router = Router();

const globalScoreUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 30 * 1024 * 1024 }, // 30MB — matches room submission cap
    fileFilter: (_req, file, cb) => {
        const ok = ['image/png', 'image/apng', 'image/jpeg', 'image/webp'].includes(file.mimetype);
        if (ok) return cb(null, true);
        cb(new Error('Only PNG, APNG, JPEG, or WebP images allowed.'));
    },
});

// System status — comprehensive health check
router.get('/status', async (req, res) => {
    try {
        const isSetup = await SettingsService.isSetupComplete();
        const checks: Record<string, { status: string; detail?: string }> = {};

        // Database check
        try {
            const db = await getDatabase();
            const row = await db.get('SELECT COUNT(*) as count FROM game_rooms');
            checks.database = { status: 'ok', detail: `${row?.count ?? 0} room(s)` };
        } catch (err) {
            checks.database = { status: 'error', detail: err instanceof Error ? err.message : 'unknown' };
        }

        // Discord bot check
        const hasDiscord = !!(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_CLIENT_ID);
        checks.discord = hasDiscord
            ? { status: 'ok', detail: 'configured' }
            : { status: 'unconfigured', detail: 'credentials not set' };

        // iScored check
        const hasIScored = !!(process.env.ISCORED_USERNAME && process.env.ISCORED_PASSWORD);
        checks.iscored = hasIScored
            ? { status: 'ok', detail: 'configured' }
            : { status: 'unconfigured', detail: 'credentials not set' };

        // Overall status
        const hasError = Object.values(checks).some(c => c.status === 'error');

        res.json({
            status: hasError ? 'degraded' : 'online',
            needsSetup: !isSetup,
            uptime: Math.floor(process.uptime()),
            version: getVersionInfo(),
            checks,
        });
    } catch (error) {
        logError('API Error (/api/status):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// App version + build metadata (S10 in-app version display). Public, harmless —
// version from root package.json, commit/builtAt baked at image build. NOT the
// SW CACHE_NAME.
router.get('/version', (_req, res) => {
    res.json(getVersionInfo());
});

// User preferences
router.get('/me/preferences', requireAuth, async (req, res) => {
    try {
        const userId = req.user!.discordId || req.user!.localAdminId || 'admin-password';
        const { PreferencesService } = await import('../../services/PreferencesService.js');
        const prefs = await PreferencesService.getAll(userId);
        res.json(prefs);
    } catch (error) {
        logError('API Error (GET /api/me/preferences):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/me/preferences', requireAuth, async (req, res) => {
    try {
        const validationResult = validate(UpdatePreferencesSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const userId = req.user!.discordId || req.user!.localAdminId || 'admin-password';
        const { PreferencesService } = await import('../../services/PreferencesService.js');
        await PreferencesService.setTheme(userId, validationResult.data.ui_theme);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST /api/me/preferences):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Scoreboard display preferences (per-user overrides for room defaults)
// ?device=mobile|desktop  (optional — defaults to desktop)
router.get('/me/scoreboard-preferences', requireDiscordUser, async (req, res) => {
    try {
        const { PreferencesService } = await import('../../services/PreferencesService.js');
        const device = (req.query.device as string) === 'mobile' ? 'mobile' as const : 'desktop' as const;
        const prefs = await PreferencesService.getScoreboardPrefs(req.user!.discordId!, device);
        res.json(prefs);
    } catch (error) {
        logError('API Error (GET /api/me/scoreboard-preferences):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/me/scoreboard-preferences', requireDiscordUser, async (req, res) => {
    try {
        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({ error: 'Body must be a JSON object of preference keys' });
        }
        const { PreferencesService } = await import('../../services/PreferencesService.js');
        const device = (req.query.device as string) === 'mobile' ? 'mobile' as const : 'desktop' as const;
        const merged = await PreferencesService.setScoreboardPrefs(req.user!.discordId!, req.body, device);
        res.json(merged);
    } catch (error) {
        logError('API Error (POST /api/me/scoreboard-preferences):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Tutorial status (first-login player tour, v2.48.0 — tmp/first-login-tutorial-contract.md).
// Dedicated nullable timestamp column via PreferencesService, not a JSON blob.
router.get('/me/tutorial-status', requireDiscordUser, async (req, res) => {
    try {
        const { PreferencesService } = await import('../../services/PreferencesService.js');
        const seenAt = await PreferencesService.getTutorialSeenAt(req.user!.discordId!);
        res.json({ seenAt });
    } catch (error) {
        logError('API Error (GET /api/me/tutorial-status):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/me/tutorial-status', requireDiscordUser, async (req, res) => {
    try {
        const { PreferencesService } = await import('../../services/PreferencesService.js');
        const seenAt = await PreferencesService.markTutorialSeen(req.user!.discordId!);
        res.json({ seenAt });
    } catch (error) {
        logError('API Error (POST /api/me/tutorial-status):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Friends ---

router.get('/me/friends', requireDiscordUser, async (req, res) => {
    try {
        const { FriendsService } = await import('../../services/FriendsService.js');
        const friends = await FriendsService.getFriends(req.user!.discordId!);
        res.json(friends);
    } catch (error) {
        logError('API Error (GET /api/me/friends):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/me/friends', requireDiscordUser, requireNotBanned, async (req, res) => {
    try {
        const { discordUsername, friendUserId } = req.body;
        const { FriendsService } = await import('../../services/FriendsService.js');

        let result: { friendUserId: string };
        if (typeof friendUserId === 'string' && friendUserId.trim()) {
            result = await FriendsService.addFriendById(req.user!.discordId!, friendUserId.trim());
        } else if (typeof discordUsername === 'string' && discordUsername.trim()) {
            result = await FriendsService.addFriend(req.user!.discordId!, discordUsername.trim());
        } else {
            return res.status(400).json({ error: 'discordUsername or friendUserId is required' });
        }
        res.status(201).json(result);
    } catch (error: any) {
        if (error?.message?.includes('Could not find')) {
            return res.status(404).json({ error: error.message });
        }
        if (error?.message?.includes('Cannot add yourself')) {
            return res.status(400).json({ error: error.message });
        }
        logError('API Error (POST /api/me/friends):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.delete('/me/friends/:friendUserId', requireDiscordUser, async (req, res) => {
    try {
        const { FriendsService } = await import('../../services/FriendsService.js');
        await FriendsService.removeFriend(req.user!.discordId!, req.params.friendUserId as string);
        res.json({ ok: true });
    } catch (error) {
        logError('API Error (DELETE /api/me/friends):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- My Rooms (Sprint 7 / plan Q8 → b) ---

router.get('/me/rooms', requireDiscordUser, async (req, res) => {
    try {
        const { RoomMembershipService } = await import('../../services/RoomMembershipService.js');
        const rooms = await RoomMembershipService.listRoomsForUser(req.user!.discordId!);
        res.json(rooms);
    } catch (error) {
        logError('API Error (GET /api/me/rooms):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Explicit join/leave (v2.38.0 — join-leave contract). Both idempotent: joining
// an already-member room or leaving a non-member room is a 200 no-op, not an
// error. Leave never touches game_room_admins — see RoomMembershipService.removeMember.
router.post('/me/rooms/:roomId', requireDiscordUser, requireNotBanned, async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const room = await GameRoomService.getById(roomId);
        if (!room) return res.status(404).json({ error: 'Room not found' });

        // m2 fix (S22 Phase 2 adversarial review) — a suspended room must
        // refuse self-join the same as it refuses everything else.
        const { RoomAccessService } = await import('../../services/RoomAccessService.js');
        if (await RoomAccessService.isSuspended(roomId)) {
            return res.status(403).json({ error: 'This room has been suspended pending review.', code: 'ROOM_SUSPENDED' });
        }

        // v2.39.0 (approval rooms) — plain self-join is an 'open'-policy-only
        // shortcut. An 'approval' room must go through the request/approve
        // queue (POST .../join-request) instead.
        if ((await RoomAccessService.getJoinPolicy(roomId)) === 'approval') {
            return res.status(403).json({ error: 'This room requires approval to join', code: 'APPROVAL_REQUIRED' });
        }

        const { RoomMembershipService } = await import('../../services/RoomMembershipService.js');
        await RoomMembershipService.addMember(req.user!.discordId!, roomId, 'self_join');

        // addMember swallows its own DB errors (fire-and-forget contract for its
        // other callers — ScoreHistoryService et al — is intentional and must stay
        // that way). This explicit join route can't make the same trade: re-query
        // to confirm the row actually landed before reporting success. Caught a
        // real bug during implementation — a stale CHECK constraint silently
        // rejected the insert while the route still returned { success: true }.
        const joined = await RoomMembershipService.isMember(req.user!.discordId!, roomId);
        if (!joined) {
            logError('API Error (POST /api/me/rooms/:roomId): addMember did not persist', new Error(`join failed for user=${req.user!.discordId} room=${roomId}`));
            return res.status(500).json({ error: 'Internal Server Error' });
        }
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST /api/me/rooms/:roomId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.delete('/me/rooms/:roomId', requireDiscordUser, async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const { RoomMembershipService } = await import('../../services/RoomMembershipService.js');
        await RoomMembershipService.removeMember(req.user!.discordId!, roomId);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE /api/me/rooms/:roomId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// v2.39.0 — approval rooms. Request to join an 'approval'-policy room.
// 400 for 'open' rooms (they use the plain self-join POST above instead).
// Idempotent: already-member -> 200 {status:'member'}; existing pending
// request -> 200 {status:'pending'} (the partial unique index backstops
// races too). A prior denial does not block a fresh request.
router.post('/me/rooms/:roomId/join-request', requireDiscordUser, requireNotBanned, async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const room = await GameRoomService.getById(roomId);
        if (!room) return res.status(404).json({ error: 'Room not found' });

        const { RoomAccessService } = await import('../../services/RoomAccessService.js');
        if ((await RoomAccessService.getJoinPolicy(roomId)) !== 'approval') {
            return res.status(400).json({ error: 'This room does not require approval to join' });
        }

        // v2.40.0 (D1) — best-effort username backfill so the admin join-
        // requests queue can resolve a name instead of a raw Discord/Google
        // ID (display_name stays user-chosen/unset; username is the fallback).
        // Uses the JWT's username claim (same displayName value login already
        // computed) — not a network call, so safe to run inline here.
        // Guard: never persist a username that IS the raw id — a refreshed
        // token degrades its username claim to the discord id when the user
        // has no display_name, and writing that here would clobber a good
        // stored username with the id (v2.40.1 regression fix).
        // m2 (S22 Phase 1) — also skip when the JWT's username claim is
        // blocklisted: unlike the login upserts (which also refresh
        // avatar and so always write, nulling a blocked name), this backfill
        // ONLY writes username — writing NULL here would clobber a
        // perfectly good previously-stored value with a stale/blocked claim.
        // Skipping the write entirely leaves any existing stored value
        // untouched, which is the safer choice for an insert-or-update that
        // only touches this one column.
        const { containsBlockedTerm } = await import('../../utils/contentBlocklist.js');
        if (req.user!.username && req.user!.username !== req.user!.discordId && !containsBlockedTerm(req.user!.username)) {
            const db = await getDatabase();
            await db.run(
                `INSERT INTO user_profiles (discord_user_id, username) VALUES (?, ?)
                 ON CONFLICT(discord_user_id) DO UPDATE SET
                    username = excluded.username,
                    updated_at = datetime('now')`,
                req.user!.discordId, req.user!.username,
            );
        }

        const { JoinRequestService } = await import('../../services/JoinRequestService.js');
        const status = await JoinRequestService.request(roomId, req.user!.discordId!);
        res.json({ status });
    } catch (error) {
        logError('API Error (POST /api/me/rooms/:roomId/join-request):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Notification Preferences ---

router.get('/me/notification-preferences', requireDiscordUser, async (req, res) => {
    try {
        const db = await getDatabase();
        const row = await db.get('SELECT notification_prefs FROM user_preferences WHERE discord_user_id = ?', req.user!.discordId!);
        res.json(row?.notification_prefs ? JSON.parse(row.notification_prefs) : {});
    } catch (error) {
        logError('API Error (GET /api/me/notification-preferences):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.put('/me/notification-preferences', requireDiscordUser, async (req, res) => {
    try {
        const prefs = req.body;
        if (!prefs || typeof prefs !== 'object') {
            return res.status(400).json({ error: 'Body must be a JSON object' });
        }
        // Merge ONLY the five typed opt-in booleans — never replace the JSON
        // wholesale. A stale multi-tab draft (or any caller-crafted body) can
        // therefore never clobber cross-feature keys living in the same blob
        // (S15 webPush channel flag, the one-time footer marker). Returns the
        // full merged object so the FE state reflects those keys too.
        const updates = NotificationService.typedPrefUpdates(prefs);
        const merged = await NotificationService.mergePrefs(req.user!.discordId!, updates);
        res.json(merged);
    } catch (error) {
        logError('API Error (PUT /api/me/notification-preferences):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Web Push (S15) ---

// Public by design: the VAPID public key is what browsers need to subscribe.
// `key: null` = push not configured on this server (FE hides the toggle).
router.get('/push/vapid-public-key', async (_req, res) => {
    try {
        res.json({ key: await WebPushService.getPublicKey() });
    } catch (error) {
        logError('API Error (GET /api/push/vapid-public-key):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/me/push-subscriptions', requireDiscordUser, writeLimiter, async (req, res) => {
    try {
        const parsed = PushSubscriptionSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: 'Invalid subscription payload' });
        }
        const { endpoint, keys } = parsed.data;
        const userId = req.user!.discordId!;
        const db = await getDatabase();
        // Endpoints are globally unique (Push API spec) — a browser
        // re-subscribing under a different account moves the row.
        await db.run(
            `INSERT INTO push_subscriptions (discord_user_id, endpoint, p256dh, auth)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(endpoint) DO UPDATE SET
                discord_user_id = excluded.discord_user_id,
                p256dh = excluded.p256dh,
                auth = excluded.auth`,
            userId, endpoint, keys.p256dh, keys.auth
        );
        // Subscribing IS the channel opt-in — merge webPush:true into the
        // user's notification_prefs JSON server-side (single-writer helper;
        // the PUT route's typed-keys allowlist means no other writer can
        // clobber this flag).
        await NotificationService.mergePrefs(userId, { webPush: true });
        res.json({ ok: true });
    } catch (error) {
        logError('API Error (POST /api/me/push-subscriptions):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Device-level unsubscribe — removes ONE endpoint (this browser), own rows
// only. The webPush channel flag deliberately stays set: other subscribed
// devices keep receiving, and with zero rows left the dispatch no-ops.
router.delete('/me/push-subscriptions', requireDiscordUser, writeLimiter, async (req, res) => {
    try {
        const parsed = PushUnsubscribeSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: 'Invalid unsubscribe payload' });
        }
        const db = await getDatabase();
        const result = await db.run(
            'DELETE FROM push_subscriptions WHERE endpoint = ? AND discord_user_id = ?',
            parsed.data.endpoint, req.user!.discordId!
        );
        res.json({ ok: true, removed: result?.changes ?? 0 });
    } catch (error) {
        logError('API Error (DELETE /api/me/push-subscriptions):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Account Deletion (anonymize-and-keep-scores) ---
//
// Removes all PERSONAL data (Discord identity, avatar, display name, proof
// photos, mappings, prefs, sessions, comments, ratings, friendships) but KEEPS
// each score row under its game handle (iscored_username) so leaderboards and
// rankings stay intact — the score is de-identified, not deleted. The full
// per-table plan (transaction, FK ordering, photo unlink, cache bust) lives in
// AccountDeletionService.anonymizeUser.
//
// AuditService.log MUST be called explicitly here: the app-level auditLog
// middleware (server.ts) runs before any route middleware sets req.user, so it
// early-returns without wrapping res.json and never auto-audits these routes.

/**
 * DELETE /api/me/account — self-service account deletion. The target Discord
 * user id is taken ONLY from the verified token (req.user), never from the body.
 */
router.delete('/me/account', requireDiscordUser, async (req, res) => {
    const discordUserId = req.user!.discordId!;
    try {
        const result = await AccountDeletionService.anonymizeUser(discordUserId, { actor: 'self' });

        await AuditService.log({
            actor: discordUserId,
            action: 'account.delete',
            target_type: 'user',
            target_id: discordUserId,
            details: JSON.stringify(result),
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

        // Global broadcast so every open scoreboard / leaderboard / kiosk drops
        // the now-anonymized identity without waiting for a natural refresh. The
        // account spans potentially many rooms + the global board, so this is a
        // room-agnostic emit (handlers refetch on any leaderboard:updated).
        getIO()?.emit('leaderboard:updated', { gameId: '' });

        res.json({ success: true, ...result });
    } catch (error) {
        if (error instanceof LastSuperAdminError) {
            return res.status(409).json({ error: 'Cannot delete the only super admin account. Transfer super-admin to another user first.' });
        }
        logError('API Error (DELETE /api/me/account):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * DELETE /api/admin/users/:discordUserId — admin-assisted account deletion.
 * Same anonymize-and-keep-scores flow as the self-service route; the acting
 * super-admin's id is recorded for audit. Gated explicitly with
 * requireAuth + requireSuperAdmin (the global router carries no router-level
 * auth). The /api/admin mount resolves this via fall-through.
 */
router.delete('/admin/users/:discordUserId', requireAuth, requireSuperAdmin, async (req, res) => {
    const targetDiscordUserId = req.params.discordUserId as string;
    const actorDiscordId = req.user!.discordId;
    try {
        const result = await AccountDeletionService.anonymizeUser(targetDiscordUserId, {
            actor: 'admin',
            actorDiscordId,
        });

        await AuditService.log({
            actor: actorDiscordId || req.user!.username || req.user!.localAdminId || 'unknown',
            action: 'account.delete',
            target_type: 'user',
            target_id: targetDiscordUserId,
            details: JSON.stringify(result),
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

        getIO()?.emit('leaderboard:updated', { gameId: '' });

        res.json({ success: true, ...result });
    } catch (error) {
        if (error instanceof LastSuperAdminError) {
            return res.status(409).json({ error: 'Cannot delete the only super admin account. Transfer super-admin to another user first.' });
        }
        logError('API Error (DELETE /api/admin/users/:discordUserId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Public Invite Endpoints ---

// Get invite info (no auth)
router.get('/invite/:token', async (req, res) => {
    try {
        const { AdminService } = await import('../../services/AdminService.js');
        const invite = await AdminService.getInviteByToken(req.params.token as string);
        if (!invite) return res.status(404).json({ error: 'Invite not found' });
        if (invite.accepted_at) return res.status(410).json({ error: 'This invite has already been used' });
        if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'This invite has expired' });

        const { GameRoomService } = await import('../../services/GameRoomService.js');
        const room = await GameRoomService.getById(invite.game_room_id);

        res.json({
            display_name: invite.display_name,
            room_name: room?.name || 'Unknown Room',
            room_slug: room?.slug || '',
            expires_at: invite.expires_at,
        });
    } catch (error) {
        logError('API Error (GET /api/invite/:token):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Accept invite (no auth). authLimiter (5/min/IP): this mints a room_admin
// account, so it belongs at the auth tier, not the 100/min general backstop.
router.post('/invite/:token/accept', authLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || typeof username !== 'string' || username.trim().length === 0) {
            return res.status(400).json({ error: 'Username is required' });
        }
        if (!password || typeof password !== 'string' || password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const { AdminService } = await import('../../services/AdminService.js');
        const admin = await AdminService.acceptInvite(req.params.token as string, username.trim(), password);

        // Get room slug for redirect
        const { GameRoomService } = await import('../../services/GameRoomService.js');
        const room = await GameRoomService.getById(admin.game_room_id);

        res.json({ success: true, room_slug: room?.slug || '' });
    } catch (error: any) {
        if (error.message === 'Invite not found') return res.status(404).json({ error: error.message });
        if (error.message === 'Invite already used') return res.status(410).json({ error: error.message });
        if (error.message === 'Invite expired') return res.status(410).json({ error: error.message });
        if (error.message === 'Username already exists for this room') return res.status(409).json({ error: error.message });
        logError('API Error (POST /api/invite/:token/accept):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Style Catalogue (read-only, requires auth) ---
router.get('/styles', requireAuth, async (req, res) => {
    try {
        const { StyleCatalogueService } = await import('../../services/StyleCatalogueService.js');
        const q = typeof req.query.q === 'string' ? req.query.q : '';
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const offset = parseInt(req.query.offset as string) || 0;
        const result = await StyleCatalogueService.search(q, limit, offset);
        res.json(result);
    } catch (error) {
        logError('API Error (GET /api/styles):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/styles/:id', requireAuth, async (req, res) => {
    try {
        const { StyleCatalogueService } = await import('../../services/StyleCatalogueService.js');
        const style = await StyleCatalogueService.getById(req.params.id as string);
        if (!style) return res.status(404).json({ error: 'Style not found' });
        res.json(style);
    } catch (error) {
        logError('API Error (GET /api/styles/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Portal info by slug (public — used by Scoreboard, GameAvailability, etc.)
//
// v2.39.0 (approval rooms): this is the LIVE portal endpoint — admin-ui's
// lib/portal.ts::getPortal() is the sole FE consumer used by every public
// page, so join_policy + viewer_status live here (not the room-scoped
// rooms.ts portal, which has no FE consumers — see the note there). Stays
// unauthenticated / always 200: the room's existence, name, logo and theme
// must render even for a non-member on an 'approval' room so the join-gate
// screen has something to show.
router.get('/portal', async (req, res) => {
    try {
        const slug = req.query.slug as string;
        if (!slug) return res.status(400).json({ error: 'slug query parameter is required' });
        const room = await GameRoomService.getBySlug(slug);
        if (!room) return res.status(404).json({ error: 'Room not found' });

        // S22 Phase 2 (v2.44.0) — a suspended room returns a minimal shape
        // (no settings/config/scores) so the public FE can render the
        // suspended shell instead of the room's normal content. Checked
        // before any of the settings/theme/join-policy reads below — none of
        // that is needed for the minimal response.
        if (room.suspended_at) {
            return res.json({ suspended: true, name: room.name, slug: room.slug });
        }

        const { GameRoomSettingsService } = await import('../../services/GameRoomSettingsService.js');
        const { PickAwardGate } = await import('../../services/PickAwardGate.js');
        const { RoomAccessService } = await import('../../services/RoomAccessService.js');
        const uiTheme = await GameRoomSettingsService.get(room.id, 'UI_THEME');
        const adminTheme = await GameRoomSettingsService.get(room.id, 'ADMIN_THEME');
        const pickAwardEnabled = await PickAwardGate.isEnabled(room.id);
        // v2.35.0 (Google login) — cheap additive field so public pages can
        // decide whether to show the "sign in with Discord for DMs/picks"
        // nudge next to the new Google login option, without a second fetch.
        const discordEnabledRaw = await GameRoomSettingsService.get(room.id, 'DISCORD_ENABLED');

        const joinPolicy = await RoomAccessService.getJoinPolicy(room.id);
        const authHeader = req.headers['authorization'];
        const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
        const payload = bearer ? (await import('../auth.js')).verifyToken(bearer) : null;
        const viewerStatus = await RoomAccessService.getViewerStatus(payload, room.id);

        res.json({
            id: room.id,
            roomId: room.id,
            slug: room.slug,
            name: room.name,
            description: room.description || '',
            logo_url: room.logo_url || null,
            ui_theme: uiTheme || 'dark',
            admin_theme: adminTheme || 'dark',
            is_public: !!room.is_public,
            pick_award_enabled: pickAwardEnabled,
            discord_enabled: discordEnabledRaw !== 'false',
            join_policy: joinPolicy,
            viewer_status: viewerStatus,
        });
    } catch (error) {
        logError('API Error (GET /api/portal):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Sprint 10 / plan §15 — submission drafts (5-min TTL). Server-side fallback
// for the anonymous-claim OAuth handoff; the client stores the same blob in
// sessionStorage as the primary path. Keyed on the OAuth `state` param so
// DiscordCallback can replay across browser tabs or devices.
router.post('/submission-drafts/:stateParam', writeLimiter, globalScoreUpload.single('photo'), async (req, res) => {
    try {
        const stateParam = req.params.stateParam as string;
        if (!stateParam || stateParam.length > 128) return res.status(400).json({ error: 'invalid stateParam' });
        const targetRaw = typeof req.body?.target === 'string' ? req.body.target : '';
        if (!targetRaw) return res.status(400).json({ error: 'target is required' });
        let target;
        try { target = JSON.parse(targetRaw); } catch { return res.status(400).json({ error: 'target must be JSON' }); }

        const playerName = typeof req.body?.playerName === 'string' ? req.body.playerName : null;
        const scoreRaw = req.body?.score;
        const score = scoreRaw !== undefined && scoreRaw !== null && scoreRaw !== ''
            ? Number.parseInt(String(scoreRaw), 10)
            : null;
        // S11: reject an out-of-range finite score at the staging boundary — the
        // schemas' MAX_SCORE cap doesn't reach this inline-parsed draft path.
        if (Number.isFinite(score) && (score! < 0 || score! > MAX_SCORE)) {
            return res.status(400).json({ error: 'Invalid score' });
        }
        const excludeFromGlobal = req.body?.excludeFromGlobal === 'true' || req.body?.excludeFromGlobal === true;
        const platform = typeof req.body?.platform === 'string' && req.body.platform.trim() ? req.body.platform.trim() : null;

        if (req.file && !isAllowedImage(req.file.buffer)) {
            return res.status(400).json({ error: 'Invalid image file' });
        }

        const photoBuffer = req.file?.buffer ?? null;
        const photoExt = req.file
            ? (req.file.mimetype === 'image/png' || req.file.mimetype === 'image/apng') ? 'png'
            : req.file.mimetype === 'image/webp' ? 'webp'
            : 'jpg'
            : undefined;

        const { SubmissionDraftService } = await import('../../services/SubmissionDraftService.js');
        await SubmissionDraftService.create(stateParam, target, {
            playerName,
            score: Number.isFinite(score) ? score : null,
            photoBuffer,
            photoExt,
            excludeFromGlobal,
            platform,
        });
        res.status(201).json({ ok: true });
    } catch (error) {
        logError('API Error (POST /api/submission-drafts):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/submission-drafts/:stateParam', async (req, res) => {
    try {
        const { SubmissionDraftService } = await import('../../services/SubmissionDraftService.js');
        const draft = await SubmissionDraftService.get(req.params.stateParam as string);
        if (!draft) return res.status(404).json({ error: 'draft not found or expired' });
        res.json({
            target: draft.target,
            playerName: draft.playerName,
            score: draft.score,
            excludeFromGlobal: draft.excludeFromGlobal,
            hasPhoto: !!draft.photoPath,
            createdAt: draft.createdAt,
            expiresAt: draft.expiresAt,
        });
    } catch (error) {
        logError('API Error (GET /api/submission-drafts):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.delete('/submission-drafts/:stateParam', writeLimiter, async (req, res) => {
    try {
        const { SubmissionDraftService } = await import('../../services/SubmissionDraftService.js');
        await SubmissionDraftService.consume(req.params.stateParam as string);
        res.json({ ok: true });
    } catch (error) {
        logError('API Error (DELETE /api/submission-drafts):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Sprint 10 — commit a server-stored draft as the now-authenticated user.
// Called by SubmissionSheet on OAuth return. The draft's target drives dispatch:
// tournament/freeplay go through CommunityScoreService + the usual fan-out +
// submissions upsert; global goes through GlobalScoreService.submit.
router.post('/submission-drafts/:stateParam/commit', requireDiscordUser, requireNotBanned, async (req, res) => {
    try {
        const stateParam = req.params.stateParam as string;
        const { SubmissionDraftService } = await import('../../services/SubmissionDraftService.js');
        const draft = await SubmissionDraftService.get(stateParam);
        if (!draft) return res.status(404).json({ error: 'draft not found or expired' });

        const discordId = req.user?.discordId;
        if (!discordId) return res.status(401).json({ error: 'authentication required' });
        if (draft.score === null || draft.score === undefined) return res.status(400).json({ error: 'draft missing score' });
        if (!draft.playerName) return res.status(400).json({ error: 'draft missing player name' });

        // v2.49.0 (room-tier bans) — the room id for a tournament/freeplay
        // draft lives in `draft.target.roomId`, not `req.params`, so the
        // `requireNotBanned` middleware above only caught the GLOBAL-ban
        // case. Re-check room-aware once the draft (and its target room) is
        // known, before any write happens. Global-target drafts have no room
        // to check against — the middleware's global check already covers them.
        if (draft.target.kind === 'tournament' || draft.target.kind === 'freeplay') {
            const { BanService } = await import('../../services/BanService.js');
            const roomBanCheck = await BanService.isIdentityBanned(discordId, draft.target.roomId);
            if (roomBanCheck.banned) {
                return res.status(403).json({ error: 'This account is banned.' });
            }
        }

        const fs = await import('fs');
        const path = await import('path');
        const photoBuffer = draft.photoPath && fs.existsSync(draft.photoPath) ? fs.readFileSync(draft.photoPath) : null;

        if (draft.target.kind === 'tournament' || draft.target.kind === 'freeplay') {
            const roomId = draft.target.roomId;
            const gameName = draft.target.gameName;

            // Persist photo to the room's score-photos dir so it survives draft cleanup.
            let photoUrl: string | null = null;
            if (photoBuffer) {
                const ext = path.extname(draft.photoPath!).slice(1) || 'jpg';
                const filename = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
                const dir = path.join(process.cwd(), 'data', 'score-photos', roomId);
                fs.mkdirSync(dir, { recursive: true });
                const outPath = path.join(dir, filename);
                fs.writeFileSync(outPath, photoBuffer);
                photoUrl = `/api/score-photos/${roomId}/${filename}`;
            }

            const { CommunityScoreService } = await import('../../services/CommunityScoreService.js');
            await CommunityScoreService.submitScore(
                roomId,
                gameName,
                draft.playerName,
                draft.score,
                discordId,
                photoUrl ?? undefined,
                { excludeFromGlobal: draft.excludeFromGlobal, platform: draft.platform },
            );

            // Mirror submit-score route: upsert into submissions if an active/completed tournament game matches.
            const db = await getDatabase();
            const activeGame = await db.get(`
                SELECT g.id, g.tournament_id FROM games g
                JOIN tournaments t ON t.id = g.tournament_id
                WHERE LOWER(g.name) = LOWER(?) AND t.game_room_id = ?
                  AND g.status IN ('ACTIVE', 'COMPLETED')
                LIMIT 1
            `, gameName, roomId);
            if (activeGame) {
                const submissionId = `${activeGame.id}-${draft.playerName.toLowerCase()}`;
                const existing = await db.get('SELECT score FROM submissions WHERE id = ?', submissionId);
                if (!existing || draft.score > existing.score) {
                    await db.run(
                        `INSERT OR REPLACE INTO submissions (
                            id, game_id, discord_user_id, iscored_username, score, photo_url, timestamp,
                            submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
                            submitted_by_anonymous_name, merged_from_anonymous_identity_id, platform
                         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
                        submissionId, activeGame.id, discordId, draft.playerName, draft.score, photoUrl || null, new Date().toISOString(),
                        roomId, activeGame.tournament_id || null, discordId,
                        draft.platform,
                    );
                    const { LeaderboardService } = await import('../../services/LeaderboardService.js');
                    await LeaderboardService.invalidate(activeGame.id);
                }
            }
        } else {
            // global target — derive mimeType from the draft's stored extension so
            // PNG/WebP drafts don't masquerade as JPEG after the OAuth round-trip.
            const { GlobalScoreService } = await import('../../services/GlobalScoreService.js');
            const draftExt = draft.photoPath ? path.extname(draft.photoPath).slice(1).toLowerCase() : '';
            const photoMimeType = photoBuffer
                ? (draftExt === 'png' ? 'image/png'
                    : draftExt === 'webp' ? 'image/webp'
                    : 'image/jpeg')
                : undefined;
            await GlobalScoreService.submit({
                globalGameId: draft.target.globalGameId,
                playerId: discordId,
                iscoredUsername: draft.playerName,
                score: draft.score,
                photoBuffer: photoBuffer ?? undefined,
                photoMimeType,
                originType: 'global',
                excludeFromGlobal: draft.excludeFromGlobal,
                platform: draft.platform,
            } as Parameters<typeof GlobalScoreService.submit>[0]);
        }

        // Sprint 11 self-claim (plan §15 / sprint-02-merge-model §4.2):
        // after the draft commits, scan for active anonymous identities in the
        // target room whose nickname matches the submitted name. Each match
        // creates a self-claim merge_records row (admin == target) so the
        // user's prior anon scores roll up under their Discord account.
        // Best-effort: errors are logged but do not fail the submission.
        if ((draft.target.kind === 'tournament' || draft.target.kind === 'freeplay') && draft.playerName) {
            try {
                const claimRoomId = draft.target.roomId;
                const db = await getDatabase();
                const identities = await db.all(
                    `SELECT id FROM anonymous_identities
                     WHERE status = 'active'
                       AND (room_id = ? OR room_id IS NULL)
                       AND LOWER(server_nickname) = LOWER(?)`,
                    claimRoomId, draft.playerName,
                );
                if (identities.length > 0) {
                    const { MergeService } = await import('../../services/MergeService.js');
                    const { RoomEventService } = await import('../../services/RoomEventService.js');
                    for (const ai of identities) {
                        try {
                            const preview = await MergeService.previewMerge(claimRoomId, ai.id, discordId);
                            if (preview.totalMovingRows === 0) continue;
                            const out = await MergeService.recordMerge({
                                roomId: claimRoomId,
                                anonymousIdentityId: ai.id,
                                targetDiscordUserId: discordId,
                                adminDiscordUserId: discordId, // self-claim
                                reason: 'self-claim via OAuth',
                                previewHash: preview.previewHash,
                            });
                            RoomEventService.log(claimRoomId, 'identity_merge', {
                                mergeId: out.mergeId,
                                anonymousIdentityId: ai.id,
                                targetUserId: discordId,
                                movedRows: out.movedRows,
                                source: 'self-claim',
                            }).catch(() => {});
                        } catch (err) {
                            logError('self-claim merge failed', err);
                        }
                    }
                }
            } catch (err) {
                logError('self-claim sweep failed', err);
            }
        }

        await SubmissionDraftService.consume(stateParam);
        res.json({ ok: true });
    } catch (error) {
        if ((error as Error & { code?: string })?.code === 'NAME_NOT_ALLOWED') {
            return res.status(400).json({ error: (error as Error).message, code: 'NAME_NOT_ALLOWED' });
        }
        logError('API Error (POST /api/submission-drafts/:stateParam/commit):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Sprint 13 (plan §10.3) — commit a stored draft anonymously. Called when the
// user cancels OAuth and chooses "Submit as guest" in the PendingSubmissionWatcher
// modal. Tournament + freeplay targets go through CommunityScoreService without
// a discordUserId; global targets are rejected (global submissions require auth).
router.post('/submission-drafts/:stateParam/commit-as-guest', writeLimiter, async (req, res) => {
    try {
        const stateParam = req.params.stateParam as string;
        const { SubmissionDraftService } = await import('../../services/SubmissionDraftService.js');
        const draft = await SubmissionDraftService.get(stateParam);
        if (!draft) return res.status(404).json({ error: 'draft not found or expired' });

        if (draft.score === null || draft.score === undefined) return res.status(400).json({ error: 'draft missing score' });
        if (!draft.playerName) return res.status(400).json({ error: 'draft missing player name' });
        if (draft.target.kind === 'global') return res.status(400).json({ error: 'global submissions require Discord login' });

        const fs = await import('fs');
        const path = await import('path');
        const photoBuffer = draft.photoPath && fs.existsSync(draft.photoPath) ? fs.readFileSync(draft.photoPath) : null;

        const roomId = draft.target.roomId;
        const gameName = draft.target.gameName;

        let photoUrl: string | null = null;
        if (photoBuffer) {
            const ext = path.extname(draft.photoPath!).slice(1) || 'jpg';
            const filename = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
            const dir = path.join(process.cwd(), 'data', 'score-photos', roomId);
            fs.mkdirSync(dir, { recursive: true });
            const outPath = path.join(dir, filename);
            fs.writeFileSync(outPath, photoBuffer);
            photoUrl = `/api/score-photos/${roomId}/${filename}`;
        }

        const { CommunityScoreService } = await import('../../services/CommunityScoreService.js');
        await CommunityScoreService.submitScore(
            roomId,
            gameName,
            draft.playerName,
            draft.score,
            undefined, // guest submission — no Discord user id
            photoUrl ?? undefined,
            { excludeFromGlobal: draft.excludeFromGlobal, platform: draft.platform },
        );

        await SubmissionDraftService.consume(stateParam);
        res.json({ ok: true });
    } catch (error) {
        if ((error as Error & { code?: string })?.code === 'NAME_NOT_ALLOWED') {
            return res.status(400).json({ error: (error as Error).message, code: 'NAME_NOT_ALLOWED' });
        }
        logError('API Error (POST /api/submission-drafts/:stateParam/commit-as-guest):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Global page config (public — theme for /scoreboard, /catalogue, /games/*, landing page)
router.get('/global/config', async (_req, res) => {
    try {
        const theme = await SettingsService.get('GLOBAL_PAGE_THEME');
        res.json({
            theme: theme || 'dark',
        });
    } catch (error) {
        logError('API Error (GET /api/global/config):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Public room listing with stats
router.get('/rooms', async (req, res) => {
    try {
        const rooms = await GameRoomService.getPublic();
        const db = await getDatabase();
        const { GameRoomSettingsService } = await import('../../services/GameRoomSettingsService.js');

        const enriched = await Promise.all(rooms.map(async (room) => {
            const logoUrl = room.logo_url || null;
            // v2.39.0 — safe/non-secret: lets landing-page cards branch the
            // bookmark toggle into "Request to join" without a second fetch.
            const { RoomAccessService } = await import('../../services/RoomAccessService.js');
            const joinPolicy = await RoomAccessService.getJoinPolicy(room.id);

            // Security review fix (pre-merge, v2.39.0) — this endpoint is
            // fully unauthenticated (no requireAuth/optional-decode today), so
            // per-viewer membership would mean adding auth decoding to a route
            // that's never needed it. Simplest-correct + safest default: an
            // 'approval'-policy room strips activity counts + the Discord
            // invite link for EVERY caller of this public list, unconditionally
            // (not just guests) — those are exactly the "stats"/contact-info
            // categories the contract bars for non-members, and a member
            // browsing the landing page has other ways to see the room's real
            // numbers (the room's own pages, once inside). name/slug/logo/
            // description/join_policy stay so the "Request to join" card is
            // still discoverable and renders normally. Skips the two count
            // queries entirely for approval rooms — nothing computes them just
            // to throw them away.
            if (joinPolicy === 'approval') {
                return {
                    ...room,
                    logo_url: logoUrl,
                    activeGames: 0,
                    activePlayers: 0,
                    discordInviteUrl: null,
                    join_policy: joinPolicy,
                };
            }

            // Count active games (games → tournaments → room)
            const activeGames = await db.get(
                `SELECT COUNT(*) as count FROM games g
                 JOIN tournaments t ON g.tournament_id = t.id
                 WHERE t.game_room_id = ? AND g.status = 'ACTIVE'`,
                room.id
            );
            // Count unique players
            const activePlayers = await db.get(
                `SELECT COUNT(DISTINCT LOWER(s.iscored_username)) as count FROM submissions s
                 JOIN games g ON s.game_id = g.id
                 JOIN tournaments t ON g.tournament_id = t.id
                 WHERE t.game_room_id = ?
                   AND s.orphaned_at IS NULL`,
                room.id
            );
            const discordInvite = await GameRoomSettingsService.get(room.id, 'DISCORD_INVITE_URL');

            return {
                ...room,
                logo_url: logoUrl,
                activeGames: activeGames?.count || 0,
                activePlayers: activePlayers?.count || 0,
                discordInviteUrl: discordInvite || null,
                join_policy: joinPolicy,
            };
        }));

        res.json(enriched);
    } catch (error) {
        logError('API Error (GET /api/rooms):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /api/rooms — public self-serve room creation (v2.33.0).
 *
 * requireDiscordUser accepts any logged-in Discord identity, including plain
 * 'player' role tokens — that's intentional, the guardrails below (kill
 * switch, per-user cap, rate limit, reserved slugs) are the actual gate, not
 * the auth role. Creator is granted 'owner' in game_room_admins atomically
 * with the room insert (GameRoomService.create's ownerDiscordId param), and
 * the room is always created in 'standalone' mode (Discord/iScored off) —
 * mode is NOT accepted from the client payload.
 */
router.post('/rooms', requireDiscordUser, requireNotBanned, roomCreateLimiter, async (req, res) => {
    try {
        const discordId = req.user?.discordId;
        if (!discordId) {
            res.status(401).json({ error: 'Discord login required' });
            return;
        }

        // S22 Phase 2 (v2.44.0) ban enforcement on room creation now lives in
        // the shared `requireNotBanned` middleware above (v2.47.0, S22
        // follow-ups Workstream 1 — aligned per contract instruction).

        const killSwitch = await SettingsService.get('PUBLIC_ROOM_CREATION_ENABLED');
        if (killSwitch === 'false') {
            res.status(403).json({ error: 'Public room creation is currently disabled' });
            return;
        }

        const validationResult = validate(PublicCreateRoomSchema, req.body);
        if ('error' in validationResult) {
            res.status(400).json({ error: validationResult.error });
            return;
        }
        const data = validationResult.data;

        const db = await getDatabase();
        // Cap check is read-outside-transaction: concurrent requests from one user can
        // overshoot to ~5 rooms one time (bounded by the 3/hr limiter), then lock at >=3.
        // Acceptable while the cap is anti-squatting, not billing — serialize before reuse.
        const ownedCount = await db.get<{ count: number }>(
            `SELECT COUNT(*) as count FROM game_room_admins WHERE discord_user_id = ? AND role = 'owner'`,
            discordId,
        );
        if ((ownedCount?.count || 0) >= 3) {
            res.status(403).json({ error: 'Room limit reached (3). Contact the site admin if you need more.' });
            return;
        }

        const existing = await GameRoomService.getBySlug(data.slug);
        if (existing) {
            res.status(409).json({ error: 'That URL is taken' });
            return;
        }

        const room = await GameRoomService.create({
            ...data,
            mode: 'standalone',
            ownerDiscordId: discordId,
        });

        logInfo(`Public room creation: ${data.name} (${data.slug}) by Discord user ${discordId}`);
        res.json({ success: true, room: { id: room.id, slug: room.slug, name: room.name } });
    } catch (error) {
        logError('API Error (POST /api/rooms):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ============================================================================
// Global Scoreboard + Catalogue (public, no auth needed for reads)
// ============================================================================

/**
 * GET /api/global/games — search/browse the global catalogue.
 * Cursor-based pagination, 20 per page.
 * Query params: ?search=&type=&platforms=vpx,vpxs&status=approved&cursor=xxx&limit=20
 */
router.get('/global/games', async (req, res) => {
    try {
        const search = (req.query.search as string) || '';
        const type = (req.query.type as string) || undefined;
        const platformsRaw = (req.query.platforms as string) || '';
        // v2.5.0: this is a public endpoint — never honor a caller-supplied
        // `?status=` so pending/rejected rows can't leak. Admins use
        // `/admin/catalogue/games` (super-admin auth) for unfiltered access.
        const status = 'approved';
        const cursor = (req.query.cursor as string) || undefined;
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

        const platforms = platformsRaw
            ? platformsRaw.split(',').map(p => p.trim()).filter(Boolean)
            : undefined;

        const result = await GlobalGameService.search(search, {
            type,
            platforms,
            status,
            limit,
            cursor,
        });

        res.json(result);
    } catch (error) {
        logError('API Error (GET /api/global/games):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * GET /api/global/games/:id — single game detail (full metadata).
 */
router.get('/global/games/:id', async (req, res) => {
    try {
        const game = await GlobalGameService.getById(req.params.id as string);
        if (!game) return res.status(404).json({ error: 'Game not found' });
        if (game.status !== 'approved') {
            return res.status(404).json({ error: 'Game not found' });
        }

        // Parse JSON fields so clients don't have to
        const parsed = {
            ...game,
            platforms: JSON.parse(game.platforms || '[]'),
            themes: JSON.parse(game.themes || '[]'),
            designers: JSON.parse(game.designers || '[]'),
            features: JSON.parse(game.features || '[]'),
            table_authors: JSON.parse(game.table_authors || '[]'),
            table_download_urls: game.table_download_urls ? JSON.parse(game.table_download_urls) : [],
            tutorial_urls: game.tutorial_urls ? JSON.parse(game.tutorial_urls) : [],
            rules_urls: game.rules_urls ? JSON.parse(game.rules_urls) : [],
        };

        res.json(parsed);
    } catch (error) {
        logError('API Error (GET /api/global/games/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * GET /api/global/recent-scores — lightweight feed of recent global scores
 * with game name + image for the landing page ticker. No auth required.
 * Returns up to 20 entries.
 */
router.get('/global/recent-scores', async (req, res) => {
    try {
        const db = await getDatabase();
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
        const rows = await db.all(`
            SELECT
                gs.id,
                gs.score,
                gs.iscored_username,
                gs.submitted_at,
                gs.player_id as discord_user_id,
                gg.id as global_game_id,
                gg.name as game_name,
                gg.display_name,
                gg.local_image_path,
                gg.wheel_image_path,
                gg.image_url,
                up.avatar_hash,
                up.avatar_url,
                up.display_name as player_display_name
            FROM global_scores gs
            JOIN global_games gg ON gg.id = gs.global_game_id
            LEFT JOIN user_mappings um ON (
                -- iscored:* synthetic ids resolve to a real Discord user via
                -- user_mappings.iscored_username (case-insensitive).
                gs.player_id LIKE 'iscored:%'
                AND LOWER(um.iscored_username) = LOWER(gs.iscored_username)
            )
            LEFT JOIN user_profiles up ON up.discord_user_id = COALESCE(gs.submitted_by_user_id, um.discord_user_id, gs.player_id)
            WHERE gs.deleted_at IS NULL
              AND gs.orphaned_at IS NULL
              AND gs.exclude_from_global = 0
            GROUP BY gs.id
            ORDER BY gs.submitted_at DESC
            LIMIT ?
        `, limit);
        res.json(rows);
    } catch (error) {
        logError('API Error (GET /api/global/recent-scores):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * GET /api/global/scoreboard — paginated catalogue + per-game score aggregates.
 * All catalogue games appear, even with zero scores. Default sort is `popular`
 * (recency-weighted score count). Query params:
 *   ?sort=popular|most_scores|highest_rated|most_recent|name_asc
 *   &scope=global|<roomId>
 *   &limit=30&offset=0
 *   &search=&type=&platforms=vpx,real,...
 *   &hasScores=1|true (scores-page-redesign: bound global scope to games
 *     WITH at least one live score — room Scoreboard's "Global" tab lens.
 *     Omitted/false leaves the standalone /scoreboard catalogue browse
 *     unchanged, including zero-score games.)
 */
router.get('/global/scoreboard', async (req, res) => {
    try {
        const sort = (req.query.sort as 'popular' | 'most_scores' | 'highest_rated' | 'most_recent' | 'name_asc') || 'popular';
        const scope = (req.query.scope as string) || 'global';
        const limit = Math.min(parseInt(req.query.limit as string) || 30, 200);
        const offset = parseInt(req.query.offset as string) || 0;
        const search = (req.query.search as string) || undefined;
        const type = (req.query.type as string) || undefined;
        const platformsRaw = (req.query.platforms as string) || '';
        const platforms = platformsRaw
            ? platformsRaw.split(',').map(p => p.trim()).filter(Boolean)
            : undefined;
        // B3: room Scoreboard's "Global" tab bounds the catalogue to games WITH
        // scores. Standalone /scoreboard never sends this — behavior unchanged.
        const hasScores = req.query.hasScores === '1' || req.query.hasScores === 'true';

        const result = await GlobalLeaderboardService.getTopGames({
            sort, scope, limit, offset, search, type, platforms, hasScores,
        });

        // Enrich each game with top 10 leaderboard entries for card previews
        const gameIds = result.data.map((g: any) => g.global_game_id);
        const topScores = await GlobalLeaderboardService.getTopScoresForGames(gameIds, 10, scope);
        const enriched = result.data.map((g: any) => ({
            ...g,
            top_scores: topScores[g.global_game_id] || [],
        }));

        res.json({ ...result, data: enriched });
    } catch (error) {
        logError('API Error (GET /api/global/scoreboard):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * GET /api/global/scoreboard/:globalGameId — full leaderboard for a single game.
 * Query params: ?scope=global|<roomId>&offset=0&limit=50
 */
router.get('/global/scoreboard/:globalGameId', async (req, res) => {
    try {
        const globalGameId = req.params.globalGameId as string;
        const scope = (req.query.scope as string) || 'global';
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const offset = parseInt(req.query.offset as string) || 0;

        const game = await GlobalGameService.getById(globalGameId);
        if (!game) return res.status(404).json({ error: 'Game not found' });

        const rankings = await GlobalLeaderboardService.getForGame(globalGameId, scope);
        const paged = rankings.slice(offset, offset + limit);

        res.json({
            game: {
                id: game.id,
                name: game.display_name || game.name,
                manufacturer: game.manufacturer,
                year: game.year,
                type: game.type,
                image_url: game.local_image_path || game.image_url,
            },
            data: paged,
            total: rankings.length,
            hasMore: offset + limit < rankings.length,
        });
    } catch (error) {
        logError('API Error (GET /api/global/scoreboard/:globalGameId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * GET /api/global/me/display-name — returns the Discord user's saved display
 * name (iscored_username in user_mappings), or null if they've never set one.
 * Used by the submit modal to pre-fill the display-name field.
 */
router.get('/global/me/display-name', requireDiscordUser, async (req, res) => {
    try {
        const db = await getDatabase();
        const mapping = await db.get(
            'SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?',
            req.user!.discordId
        );
        res.json({ displayName: mapping?.iscored_username || null });
    } catch (error) {
        logError('API Error (GET /api/global/me/display-name):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * GET /api/submit/platforms — resolver used by the SubmissionSheet picker.
 *
 * Three contexts, distinguished by query params:
 *   - tournament/freeplay (room scope): ?roomId=X&gameName=Y
 *       Resolves effective platforms for a game in this room (room library +
 *       per-room custom platforms), then intersects with the active tournament's
 *       platform_rules if there is one.
 *   - global submit:                    ?globalGameId=Z
 *       Returns global_games.platforms verbatim — no tournament rules apply.
 *
 * Response shape:
 *   {
 *     platforms: string[],       // game's effective platform set (pre-rule intersection)
 *     submittable: string[],     // platforms the player can actually pick from
 *     tournamentRules: { required: string[]; excluded: string[] } | null
 *   }
 *
 * Public endpoint — no auth. The submit handlers re-validate, so an attacker
 * pre-fetching platforms gains nothing.
 */
router.get('/submit/platforms', async (req, res) => {
    try {
        const { roomId, gameName, globalGameId } = req.query as Record<string, string | undefined>;
        const db = await getDatabase();
        const { parsePlatformsList, resolveSubmittablePlatforms } = await import('../../utils/platformRules.js');
        const { normalizePlatform } = await import('../../utils/platformMapping.js');

        // m3 fix (S22 Phase 2 adversarial review) — this route sits outside
        // rooms.ts (so it doesn't pass through roomVisibilityGate) and is the
        // resolver SubmissionSheet calls to build the platform picker; a
        // suspended room's picker must refuse the same as its submit
        // endpoints do. Approval-room behavior is deliberately untouched
        // (this route has never gated on join_policy — accepted pre-existing
        // posture) — only suspension gates here.
        if (roomId) {
            const { RoomAccessService } = await import('../../services/RoomAccessService.js');
            if (await RoomAccessService.isSuspended(roomId)) {
                return res.status(403).json({ error: 'This room has been suspended pending review.', code: 'ROOM_SUSPENDED' });
            }
        }

        // v2.5.1: alias-fold + dedupe so the picker never shows VPX/vpx/vpxs
        // duplicates. Stored data may have legacy mixed-case strings; client
        // surfaces should only ever see canonical IDs.
        const normalizeAndDedupe = (raw: string[]): string[] => {
            const seen = new Set<string>();
            const out: string[] = [];
            for (const p of raw) {
                const id = normalizePlatform(p);
                if (!id || seen.has(id)) continue;
                seen.add(id);
                out.push(id);
            }
            return out;
        };

        // Global submit context — bare globalGameId, no room.
        if (globalGameId && !roomId) {
            const game = await db.get(
                'SELECT platforms FROM global_games WHERE id = ? AND status = ? LIMIT 1',
                globalGameId, 'approved',
            );
            if (!game) return res.status(404).json({ error: 'Game not found' });
            const platforms = normalizeAndDedupe(parsePlatformsList(game.platforms || '[]'));
            return res.json({ platforms, submittable: platforms, tournamentRules: null });
        }

        // Room-scoped context — tournament submit OR freeplay. Effective set =
        // catalogue platforms ∪ room-specific tags (see ADR 0008).
        if (roomId && gameName) {
            const gg = await db.get(
                'SELECT platforms FROM global_games WHERE LOWER(name) = LOWER(?) AND status = ? LIMIT 1',
                gameName, 'approved',
            );
            const cataloguePlatforms = gg ? parsePlatformsList(gg.platforms || '[]') : [];
            const { RoomGameTagsService } = await import('../../services/RoomGameTagsService.js');
            const roomTags = await RoomGameTagsService.getTagsForGameName(roomId, gameName);
            let effective: string[] = [...cataloguePlatforms, ...roomTags];
            effective = normalizeAndDedupe(effective);

            // Active tournament narrows the picker via platform_rules.
            const activeGame = await db.get(`
                SELECT t.platform_rules FROM games g
                JOIN tournaments t ON t.id = g.tournament_id
                WHERE LOWER(g.name) = LOWER(?) AND t.game_room_id = ? AND g.status = 'ACTIVE'
                LIMIT 1
            `, gameName, roomId) as { platform_rules: string | null } | undefined;

            let rules: { required: string[]; excluded: string[] } | null = null;
            if (activeGame?.platform_rules) {
                try {
                    const parsed = JSON.parse(activeGame.platform_rules);
                    rules = {
                        required: Array.isArray(parsed.required) ? parsed.required : [],
                        excluded: Array.isArray(parsed.excluded) ? parsed.excluded : [],
                    };
                } catch { /* keep rules = null */ }
            }

            const submittable = resolveSubmittablePlatforms(effective, rules);
            return res.json({ platforms: effective, submittable, tournamentRules: rules });
        }

        return res.status(400).json({ error: 'Provide either globalGameId, OR roomId + gameName' });
    } catch (error) {
        logError('API Error (GET /submit/platforms):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /api/global/scores — direct global score submission.
 * Requires Discord login, photo, and a valid approved global_game_id.
 * Body: multipart/form-data with { globalGameId, score, displayName, excludeFromGlobal?, photo }
 *
 * `displayName` is the name shown on the scoreboard. If omitted, falls back
 * through user_mappings → Discord username → discordId. When provided, it is
 * persisted to user_mappings so future submissions default to it.
 */
router.post('/global/scores', globalSubmitLimiter, requireDiscordUser, requireNotBanned, globalScoreUpload.single('photo'), async (req, res) => {
    try {
        const globalGameId = req.body.globalGameId;
        const scoreRaw = req.body.score;
        const excludeFromGlobal = req.body.excludeFromGlobal === 'true' || req.body.excludeFromGlobal === true;
        const displayNameRaw = typeof req.body.displayName === 'string' ? req.body.displayName.trim() : '';
        const platform = typeof req.body.platform === 'string' ? req.body.platform.trim() : '';

        if (!globalGameId || typeof globalGameId !== 'string') {
            return res.status(400).json({ error: 'globalGameId is required' });
        }
        const score = parseInt(scoreRaw, 10);
        if (!Number.isFinite(score) || score < 0 || score > MAX_SCORE) {
            return res.status(400).json({ error: 'A valid non-negative score is required' });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'A photo is required with global score submissions.' });
        }
        if (!isAllowedImage(req.file.buffer)) {
            return res.status(400).json({ error: 'Invalid image file' });
        }
        if (displayNameRaw.length > 50) {
            return res.status(400).json({ error: 'Display name must be 50 characters or fewer.' });
        }
        if (!platform) {
            return res.status(400).json({ error: 'platform is required' });
        }

        const game = await GlobalGameService.getById(globalGameId);
        if (!game || game.status !== 'approved') {
            return res.status(404).json({ error: 'Game not found' });
        }

        // v2.5.0: validate platform is one of the game's catalogued platforms.
        const { parsePlatformsList } = await import('../../utils/platformRules.js');
        const gamePlatforms = parsePlatformsList(game.platforms || '[]');
        if (!gamePlatforms.some(p => p.toUpperCase() === platform.toUpperCase())) {
            return res.status(400).json({
                error: `Platform "${platform}" is not catalogued for this game. Allowed: ${gamePlatforms.join(', ') || '(none)'}`,
            });
        }

        // Resolve the iscored username / display name for the logged-in Discord user.
        // Precedence: explicit form field > existing user_mappings row > Discord
        // username from the JWT > raw discordId (legacy fallback).
        const db = await getDatabase();
        let iscoredUsername = displayNameRaw;
        if (!iscoredUsername) {
            const mapping = await db.get(
                'SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?',
                req.user!.discordId
            );
            iscoredUsername = mapping?.iscored_username || req.user!.username || req.user!.discordId || 'Unknown';
        }

        // Persist the display name so future submissions pre-fill with it.
        // `user_mappings.iscored_username` has a UNIQUE index — if this name is
        // already taken by a different Discord user, reject before the INSERT
        // would fail, returning a clear 409 instead of a cryptic DB error.
        if (displayNameRaw && req.user!.discordId) {
            const clash = await db.get<{ discord_user_id: string }>(
                `SELECT discord_user_id FROM user_mappings
                 WHERE LOWER(iscored_username) = LOWER(?) AND discord_user_id != ?`,
                displayNameRaw, req.user!.discordId
            );
            if (clash) {
                return res.status(409).json({ error: 'That display name is already taken. Pick another.' });
            }
            // user_mappings is now many-to-one. The pre-check above already rejected
            // the case where this name is owned by a different Discord user, so a
            // conflict here only fires when this same user has already claimed the
            // alias — DO NOTHING is a clean no-op.
            await db.run(
                `INSERT INTO user_mappings (discord_user_id, iscored_username)
                 VALUES (?, ?)
                 ON CONFLICT(iscored_username) DO NOTHING`,
                req.user!.discordId, displayNameRaw
            );
        }

        try {
            const saved = await GlobalScoreService.submit({
                globalGameId,
                playerId: req.user!.discordId!,
                iscoredUsername,
                score,
                photoBuffer: req.file.buffer,
                photoMimeType: req.file.mimetype,
                originType: 'global',
                excludeFromGlobal,
                platform,
            });

            emitScoreNewGlobal({
                globalGameId,
                gameName: game.display_name || game.name,
                playerName: iscoredUsername,
                score,
            });

            // Submit-moment rank ("you are #N of M"). Best-effort, computed
            // strictly after submit() commits so it can never fail the insert.
            // If excludeFromGlobal was set the row never reaches the public
            // exclude_from_global=0 board, so rank display is skipped (the
            // submitter chose not to appear there).
            let rank: SubmitRankResult | null = null;
            if (!excludeFromGlobal) {
                try {
                    // submitted_by_user_id is a migration-added column present at
                    // runtime (submit() SELECT *'s it) but absent from the typed
                    // GlobalScore interface — read it via cast.
                    const submittedByUserId = (saved as { submitted_by_user_id?: string | null }).submitted_by_user_id ?? null;
                    const partitionKey =
                        submittedByUserId ??
                        `iscored:${(saved.iscored_username ?? saved.player_id ?? '').toLowerCase()}`;
                    rank = await ScoreRankService.computeGlobalRank({
                        globalGameId,
                        partitionKey,
                        submittedScore: score,
                        excludeGlobalScoreId: saved.id,
                    });
                } catch {
                    rank = null;
                }
            }

            res.status(201).json({ ...saved, rank });
        } catch (err: any) {
            if (err?.message === 'BANNED') {
                return res.status(403).json({ error: 'Your account is banned from submitting global scores.' });
            }
            throw err;
        }
    } catch (error) {
        logError('API Error (POST /api/global/scores):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * DELETE /api/me/global-scores/:scoreId — user deletes one of their own scores.
 * Soft-delete only; the row stays for audit/restore. Verifies the authenticated
 * Discord user owns the score before delegating to GlobalScoreService.softDelete.
 */
router.delete('/me/global-scores/:scoreId', requireDiscordUser, async (req, res) => {
    try {
        const scoreId = req.params.scoreId as string;
        const score = await GlobalScoreService.getById(scoreId);
        if (!score || score.deleted_at) {
            return res.status(404).json({ error: 'Score not found' });
        }
        if (score.player_id !== req.user!.discordId) {
            return res.status(403).json({ error: 'You can only delete your own scores' });
        }
        const ok = await GlobalScoreService.softDelete(scoreId, req.user!.discordId!);
        if (!ok) return res.status(404).json({ error: 'Score not found' });
        // S12 photo-on-delete: unlink the proof photo FILE from disk. softDelete
        // keeps the row (audit/restore) but the photo is personal data and must
        // not linger. Best-effort + idempotent — a missing/foreign path no-ops.
        deleteScorePhotoFiles([score.photo_url]);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE /api/me/global-scores/:scoreId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * DELETE /api/me/global-scores/game/:globalGameId — delete ALL of the
 * authenticated user's scores for a specific game (soft-delete).
 */
router.delete('/me/global-scores/game/:globalGameId', requireDiscordUser, async (req, res) => {
    try {
        const globalGameId = req.params.globalGameId as string;
        const discordId = req.user!.discordId!;
        const db = (await import('../../database/database.js')).getDatabase;
        const dbConn = await db();

        const scores = await dbConn.all(
            `SELECT id, photo_url FROM global_scores WHERE global_game_id = ? AND player_id = ? AND deleted_at IS NULL`,
            globalGameId, discordId
        );
        if (scores.length === 0) {
            return res.status(404).json({ error: 'No scores found' });
        }

        // S12 photo-on-delete: collect the proof photos of the rows we actually
        // soft-delete, then unlink the FILES best-effort (idempotent helper).
        const photoUrls: Array<string | null | undefined> = [];
        for (const s of scores) {
            const ok = await GlobalScoreService.softDelete(s.id, discordId);
            if (ok) photoUrls.push(s.photo_url);
        }
        deleteScorePhotoFiles(photoUrls);

        res.json({ success: true, deleted: scores.length });
    } catch (error) {
        logError('API Error (DELETE /api/me/global-scores/game/:globalGameId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /api/global/scores/:scoreId/report — flag a score.
 * Rate-limited via writeLimiter, requires Discord login.
 */
router.post('/global/scores/:scoreId/report', writeLimiter, requireDiscordUser, requireNotBanned, async (req, res) => {
    try {
        const scoreId = req.params.scoreId as string;
        const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null;

        const db = await getDatabase();
        const score = await db.get('SELECT id FROM global_scores WHERE id = ? AND deleted_at IS NULL', scoreId);
        if (!score) return res.status(404).json({ error: 'Score not found' });

        // Don't let a user report the same score twice while a prior report is open
        const existing = await db.get(
            `SELECT id FROM score_reports
             WHERE score_id = ? AND reporter_discord_id = ? AND resolved_at IS NULL`,
            scoreId, req.user!.discordId
        );
        if (existing) {
            return res.status(409).json({ error: 'You have already reported this score.' });
        }

        const crypto = await import('crypto');
        const reportId = crypto.randomUUID();
        await db.run(
            `INSERT INTO score_reports (id, score_id, reporter_discord_id, reason)
             VALUES (?, ?, ?, ?)`,
            reportId, scoreId, req.user!.discordId, reason
        );

        logInfo(`Score ${scoreId} reported by ${req.user!.discordId}`);
        res.status(201).json({ id: reportId });
    } catch (error) {
        logError('API Error (POST /api/global/scores/:scoreId/report):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * Report-a-problem (v2.25.0) — file a report against a catalogue game's
 * metadata. Discord-authed (identity for abuse control); the server snapshots
 * the disputed field's current value. Lands in the super-admin queue on
 * /admin/catalogue.
 */
router.post('/global/games/:id/feedback', writeLimiter, requireDiscordUser, requireNotBanned, async (req, res) => {
    try {
        const parsed = (await import('../schemas.js')).GameFeedbackSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid report' });
        }
        const { GameFeedbackService } = await import('../../services/GameFeedbackService.js');
        const { id } = await GameFeedbackService.create({
            globalGameId: req.params.id as string,
            reporterDiscordId: req.user!.discordId!,
            field: parsed.data.field,
            suggestedValue: parsed.data.suggested_value,
            note: parsed.data.note,
        });
        logInfo(`Game ${req.params.id} feedback (${parsed.data.field}) filed by ${req.user!.discordId}`);
        res.status(201).json({ id });
    } catch (error) {
        const code = (error as Error & { code?: string })?.code;
        if (code === 'GAME_NOT_FOUND') return res.status(404).json({ error: 'Game not found' });
        if (code === 'DUPLICATE_REPORT') {
            return res.status(409).json({ error: 'You already have an open report on this field — an admin will review it.' });
        }
        if (code === 'REPORT_LIMIT') {
            return res.status(429).json({ error: 'You have too many open reports. Please wait for an admin to review them.' });
        }
        logError('API Error (POST /api/global/games/:id/feedback):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ─── Content Moderation Reports (v2.43.0 — S22 Phase 1) ───
// Deliberately in global.ts, NOT rooms.ts: room reports must work for
// non-members of approval rooms (who can see name/logo via the public
// portal) — the room's view-visibility gate must never block reporting.

/**
 * POST /api/global/rooms/:roomId/report — flag a room. Discord/Google-authed
 * (requireDiscordUser passes for either — ids are namespaced through the
 * same claims), rate-limited.
 *
 * v2.49.0 fix-round (#1) — uses `requireNotBannedGlobal`, NOT `requireNotBanned`.
 * `:roomId` here is the room being REPORTED, not an acting context — a
 * `requireNotBanned` mount would let a room admin ban a user to block them
 * from ever escalating that room to super-admins, which the room-bans
 * contract's decision 5 explicitly forbids (a room ban must never block
 * moderation escalation). A GLOBAL ban still blocks reporting (an actually
 * banned identity shouldn't get to file reports at all); a ban scoped to
 * THIS room does not. Audited the other `requireNotBanned` mounts in this
 * file and rooms.ts — every other `:roomId` param names the room the request
 * ACTS in (join, submit, comment, admin-write), so this is the only route
 * with this shape.
 */
router.post('/global/rooms/:roomId/report', writeLimiter, requireDiscordUser, requireNotBannedGlobal, async (req, res) => {
    try {
        const parsed = (await import('../schemas.js')).RoomReportSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid report' });
        }
        const { ContentReportService } = await import('../../services/ContentReportService.js');
        const { id } = await ContentReportService.submitRoomReport({
            roomId: req.params.roomId as string,
            reporterUserId: req.user!.discordId!,
            reason: parsed.data.reason,
        });
        logInfo(`Room ${req.params.roomId} reported by ${req.user!.discordId}`);
        res.status(200).json({ ok: true, id });
    } catch (error) {
        const code = (error as Error & { code?: string })?.code;
        if (code === 'ROOM_NOT_FOUND') return res.status(404).json({ error: 'Room not found' });
        if (code === 'DUPLICATE_REPORT') {
            return res.status(409).json({ error: "You've already reported this room." });
        }
        if (code === 'REPORT_LIMIT') {
            return res.status(429).json({ error: 'You have too many open reports. Please wait for an admin to review them.' });
        }
        logError('API Error (POST /api/global/rooms/:roomId/report):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /api/global/report-name — flag a player name (room-scoped or global
 * surface). `targetUserId`, when known, keys dedup on identity; otherwise
 * keys on (room, name-as-typed).
 */
router.post('/global/report-name', writeLimiter, requireDiscordUser, requireNotBanned, async (req, res) => {
    try {
        const parsed = (await import('../schemas.js')).NameReportSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid report' });
        }
        const { ContentReportService } = await import('../../services/ContentReportService.js');
        const { id } = await ContentReportService.submitNameReport({
            roomId: parsed.data.roomId,
            targetUserId: parsed.data.targetUserId,
            targetName: parsed.data.targetName,
            reporterUserId: req.user!.discordId!,
            reason: parsed.data.reason,
        });
        logInfo(`Player name "${parsed.data.targetName}" reported by ${req.user!.discordId}`);
        res.status(200).json({ ok: true, id });
    } catch (error) {
        const code = (error as Error & { code?: string })?.code;
        if (code === 'ROOM_NOT_FOUND') return res.status(404).json({ error: 'Room not found' });
        if (code === 'DUPLICATE_REPORT') {
            return res.status(409).json({ error: "You've already reported this name." });
        }
        if (code === 'REPORT_LIMIT') {
            return res.status(429).json({ error: 'You have too many open reports. Please wait for an admin to review them.' });
        }
        logError('API Error (POST /api/global/report-name):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /api/global/comments/:id/report — flag a room-scoped game comment
 * (`game_comments`, CommentService). v2.47.0 (S22 follow-ups Workstream 2).
 * Deliberately in global.ts, NOT rooms.ts, same rationale as the room/name
 * report routes above — the comment id alone disambiguates, no roomId
 * needed on the path.
 */
router.post('/global/comments/:id/report', writeLimiter, requireDiscordUser, requireNotBanned, async (req, res) => {
    try {
        const commentId = parseInt(req.params.id as string, 10);
        if (!Number.isFinite(commentId)) return res.status(400).json({ error: 'Invalid comment id' });

        const parsed = (await import('../schemas.js')).CommentReportSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid report' });
        }
        const { CommentReportService } = await import('../../services/CommentReportService.js');
        const { id } = await CommentReportService.create({
            commentId,
            reporterDiscordId: req.user!.discordId!,
            reason: parsed.data.reason,
        });
        logInfo(`Comment ${commentId} reported by ${req.user!.discordId}`);
        res.status(200).json({ ok: true, id });
    } catch (error) {
        const code = (error as Error & { code?: string })?.code;
        if (code === 'COMMENT_NOT_FOUND') return res.status(404).json({ error: 'Comment not found' });
        if (code === 'DUPLICATE_REPORT') {
            return res.status(409).json({ error: "You've already reported this comment." });
        }
        if (code === 'REPORT_LIMIT') {
            return res.status(429).json({ error: 'You have too many open reports. Please wait for an admin to review them.' });
        }
        logError('API Error (POST /api/global/comments/:id/report):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ─── Global Game Ratings ───

/**
 * GET /api/global/games/:id/rating — get avg rating + optional user rating
 */
router.get('/global/games/:id/rating', async (req, res) => {
    try {
        const globalGameId = req.params.id as string;
        // Optionally accept a Discord user via Authorization header
        let discordUserId: string | undefined;
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
            try {
                const { verifyToken } = await import('../auth.js');
                const payload = verifyToken(authHeader.slice(7));
                if (payload?.discordId) discordUserId = payload.discordId;
            } catch { /* no valid token — fine, just skip user rating */ }
        }
        const info = await GlobalRatingService.getGameRating(globalGameId, discordUserId);
        res.json(info);
    } catch (error) {
        logError('API Error (GET /api/global/games/:id/rating):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /api/global/games/:id/rating — set user's rating (1-5). Requires Discord login.
 */
router.post('/global/games/:id/rating', writeLimiter, requireDiscordUser, requireNotBanned, async (req, res) => {
    try {
        const globalGameId = req.params.id as string;
        const rating = parseInt(req.body.rating, 10);
        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({ error: 'Rating must be 1-5' });
        }
        await GlobalRatingService.setRating(globalGameId, req.user!.discordId!, rating);
        const info = await GlobalRatingService.getGameRating(globalGameId, req.user!.discordId!);
        res.json(info);
    } catch (error) {
        logError('API Error (POST /api/global/games/:id/rating):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * GET /api/global/ratings — bulk ratings for scoreboard page.
 * Optionally includes user ratings if Bearer token provided.
 */
router.get('/global/ratings', async (req, res) => {
    try {
        let discordUserId: string | undefined;
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
            try {
                const { verifyToken } = await import('../auth.js');
                const payload = verifyToken(authHeader.slice(7));
                if (payload?.discordId) discordUserId = payload.discordId;
            } catch { /* skip user ratings */ }
        }
        const result = await GlobalRatingService.getBulkRatings(discordUserId);
        res.json(result);
    } catch (error) {
        logError('API Error (GET /api/global/ratings):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ─── Global Game Comments ───

/**
 * GET /api/global/games/:id/comments — get comments/tips for a global game.
 * Query params: ?type=comment|tip
 */
router.get('/global/games/:id/comments', async (req, res) => {
    try {
        const globalGameId = req.params.id as string;
        const type = req.query.type as 'comment' | 'tip' | undefined;
        const comments = await GlobalCommentService.getComments(globalGameId, type);
        res.json(comments);
    } catch (error) {
        logError('API Error (GET /api/global/games/:id/comments):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /api/global/games/:id/comments — add a comment or tip. Requires Discord login.
 */
router.post('/global/games/:id/comments', writeLimiter, requireDiscordUser, requireNotBanned, async (req, res) => {
    try {
        const globalGameId = req.params.id as string;
        const { type, body, display_name } = req.body;
        if (!type || !['comment', 'tip'].includes(type)) {
            return res.status(400).json({ error: 'type must be "comment" or "tip"' });
        }
        if (!body || typeof body !== 'string' || body.length < 1 || body.length > 500) {
            return res.status(400).json({ error: 'body must be 1-500 characters' });
        }
        if (!display_name || typeof display_name !== 'string' || display_name.length < 1 || display_name.length > 50) {
            return res.status(400).json({ error: 'display_name must be 1-50 characters' });
        }
        const comment = await GlobalCommentService.addComment(
            globalGameId, req.user!.discordId!, display_name, type, body
        );
        res.status(201).json(comment);
    } catch (error) {
        logError('API Error (POST /api/global/games/:id/comments):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * DELETE /api/global/games/:id/comments/:commentId — delete own comment. Requires Discord login.
 */
router.delete('/global/games/:id/comments/:commentId', requireDiscordUser, requireNotBanned, async (req, res) => {
    try {
        const commentId = parseInt(req.params.commentId as string, 10);
        const comment = await GlobalCommentService.getCommentById(commentId);
        if (!comment) return res.status(404).json({ error: 'Comment not found' });
        if (comment.discord_user_id !== req.user!.discordId) {
            return res.status(403).json({ error: 'Not authorized' });
        }
        await GlobalCommentService.deleteComment(commentId);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE /api/global/games/:id/comments/:commentId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

export default router;
