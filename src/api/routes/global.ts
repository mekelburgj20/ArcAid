import { Router } from 'express';
import multer from 'multer';
import { logError, logInfo } from '../../utils/logger.js';
import { requireAuth, requireDiscordUser, requireSuperAdmin, requireNotBanned, requireNotBannedGlobal, optionalDiscordUser } from '../middleware.js';
import { writeLimiter, globalSubmitLimiter, authLimiter, roomCreateLimiter, raSearchLimiter, raImportLimiter, witnessIngestLimiter } from '../rateLimit.js';
import { raSearchHandler, raImportHandler } from '../raCatalogueHandlers.js';
import { validate } from '../validate.js';
import { isAllowedImage } from '../uploadValidation.js';
import { withUploadErrors } from '../uploadMiddleware.js';
import { UpdatePreferencesSchema, SetRoomThemeSchema, PushSubscriptionSchema, PushUnsubscribeSchema, MAX_SCORE, PublicCreateRoomSchema, GlobalScoreSubmissionSchema, CreateThrowdownSchema, ThrowdownScoreSchema } from '../schemas.js';
import { SettingsService } from '../../services/SettingsService.js';
import { GameRoomService } from '../../services/GameRoomService.js';
import { GlobalGameService } from '../../services/GlobalGameService.js';
import { GlobalScoreService } from '../../services/GlobalScoreService.js';
import { GlobalLeaderboardService } from '../../services/GlobalLeaderboardService.js';
import { GlobalPinService } from '../../services/GlobalPinService.js';
import { GlobalRatingService } from '../../services/GlobalRatingService.js';
import { GlobalCommentService } from '../../services/GlobalCommentService.js';
import { ScoreRankService, type SubmitRankResult } from '../../services/ScoreRankService.js';
import { emitScoreNewGlobal, getIO } from '../websocket.js';
import { getDatabase } from '../../database/database.js';
import { getVersionInfo } from '../../utils/version.js';
import { AuditService } from '../../services/AuditService.js';
import { AccountDeletionService, LastSuperAdminError } from '../../services/AccountDeletionService.js';
import { WebPushService } from '../../services/WebPushService.js';
import { NotificationService, PREF_TYPE_KEYS, WEB_PUSH_TYPES } from '../../services/NotificationService.js';
import { DiscordReachabilityService } from '../../services/DiscordReachabilityService.js';
import { DmNudgeService } from '../../services/DmNudgeService.js';
import { isDiscordUserId } from '../../utils/identityProvider.js';
import { deleteScorePhotoFiles } from '../../utils/scorePhotoCleanup.js';
import { CARD_CATEGORY_ORDER } from '../../utils/scoreProvenance.js';
import type { AxisRules } from '../../utils/platformRules.js';

const router = Router();

const globalScoreUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 30 * 1024 * 1024 }, // 30MB — matches room submission cap
    fileFilter: (req, file, cb) => {
        const ok = ['image/png', 'image/apng', 'image/jpeg', 'image/webp'].includes(file.mimetype);
        if (ok) return cb(null, true);
        req._uploadRejectedFile = { mimetype: file.mimetype, originalname: file.originalname };
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
        // v2.130.0 — write only what was sent. `ui_theme` and `appearance` are
        // independently optional (schema rejects a body carrying neither), so
        // the Appearance control never has to round-trip, and possibly clobber,
        // the admin's theme choice and vice versa.
        const { ui_theme, appearance, share_to_global } = validationResult.data;
        if (ui_theme !== undefined) await PreferencesService.setTheme(userId, ui_theme);
        if (appearance !== undefined) await PreferencesService.setAppearance(userId, appearance);
        if (share_to_global !== undefined) await PreferencesService.setShareToGlobal(userId, share_to_global);
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

// ---------------------------------------------------------------------------
// P8 — Arcaid Witness (device pairing + launch-time ingest).
//
// TWO audiences with different auth models:
//   - PLAYER routes (`/me/witness/*`, requireDiscordUser) — mint a pairing
//     code, list/unpair cabinets. Normal Bearer auth.
//   - DEVICE routes (`/witness/*`, witnessIngestLimiter, NO auth) — the
//     on-device app pairs and reports over synchronous GETs (the AtGames SDK
//     offers no POST). The device token in the query string IS the auth; it is
//     never logged (handlers reference codes/ids only), rate-limited per
//     device id, and only ever grants writes to that device's own trail.
// The verify-join that scores these observations is a later phase — these
// endpoints just capture what the device reports.
// ---------------------------------------------------------------------------

router.post('/me/witness/pairing-code', requireDiscordUser, async (req, res) => {
    try {
        const { WitnessService } = await import('../../services/WitnessService.js');
        const result = await WitnessService.createPairingCode(req.user!.discordId!);
        res.json(result);
    } catch (error) {
        logError('API Error (POST /api/me/witness/pairing-code):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/me/witness/devices', requireDiscordUser, async (req, res) => {
    try {
        const { WitnessService } = await import('../../services/WitnessService.js');
        res.json(await WitnessService.listDevices(req.user!.discordId!));
    } catch (error) {
        logError('API Error (GET /api/me/witness/devices):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.delete('/me/witness/devices/:deviceId', requireDiscordUser, async (req, res) => {
    try {
        const { WitnessService } = await import('../../services/WitnessService.js');
        const ok = await WitnessService.revokeDevice(req.user!.discordId!, req.params.deviceId as string);
        if (!ok) return res.status(404).json({ error: 'No such cabinet paired to your account' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE /api/me/witness/devices/:deviceId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Device: redeem a pairing code, receive the device token (returned ONCE).
// `token` accepted via query only here; the device stores what it gets back.
router.get('/witness/pair', witnessIngestLimiter, async (req, res) => {
    try {
        const { WitnessService, WitnessPairError } = await import('../../services/WitnessService.js');
        const code = typeof req.query.code === 'string' ? req.query.code : '';
        const device = typeof req.query.device === 'string' ? req.query.device : '';
        const username = typeof req.query.username === 'string' ? req.query.username : null;
        try {
            const { token } = await WitnessService.redeemPairingCode(code, device, username);
            return res.json({ ok: true, token });
        } catch (err) {
            if (err instanceof WitnessPairError) {
                return res.status(400).json({ ok: false, error: err.message, code: err.code });
            }
            throw err;
        }
    } catch (error) {
        // Deliberately terse — no query echo, so a logged error never carries a code.
        logError('API Error (GET /api/witness/pair)');
        res.status(500).json({ ok: false, error: 'Internal Server Error' });
    }
});

// Device: report one witnessed table session. Token via `token` query param OR
// `x-witness-token` header (whichever the on-device SDK's httpGet supports).
router.get('/witness/report', witnessIngestLimiter, async (req, res) => {
    try {
        const { WitnessService } = await import('../../services/WitnessService.js');
        const device = typeof req.query.device === 'string' ? req.query.device : '';
        const token = (typeof req.query.token === 'string' && req.query.token)
            || (typeof req.headers['x-witness-token'] === 'string' ? req.headers['x-witness-token'] as string : '');
        const table = typeof req.query.table === 'string' ? req.query.table : '';
        const launchTs = Number(req.query.launch);
        const exitTs = req.query.exit !== undefined ? Number(req.query.exit) : null;
        const durationSec = req.query.dur !== undefined ? Number(req.query.dur) : null;
        // `via=retro` marks a session derived from on-disk traces after the
        // fact. Only that exact literal is honoured; everything else is a live
        // report (the service enforces it too — this is not the only caller).
        const via = typeof req.query.via === 'string' ? req.query.via : null;

        const ok = await WitnessService.recordObservation({
            atgamesUniqueId: device, token, tableName: table, launchTs, exitTs, durationSec, via,
        });
        // One 401 for unknown device / bad token / revoked — never says which.
        if (!ok) return res.status(401).json({ ok: false });
        res.json({ ok: true });
    } catch (error) {
        logError('API Error (GET /api/witness/report)');
        res.status(500).json({ ok: false });
    }
});

// Device: the round-start CHECK-IN (tier 2, ADR 0021). The device asserts only
// "the Witness is open right now"; the TIMESTAMP IS THE SERVER'S, deliberately —
// a client-supplied time would turn the whole attestation into a self-report.
// Same auth and same bare 401 as /witness/report.
router.get('/witness/checkin', witnessIngestLimiter, async (req, res) => {
    try {
        const { WitnessService } = await import('../../services/WitnessService.js');
        const device = typeof req.query.device === 'string' ? req.query.device : '';
        const token = (typeof req.query.token === 'string' && req.query.token)
            || (typeof req.headers['x-witness-token'] === 'string' ? req.headers['x-witness-token'] as string : '');

        const result = await WitnessService.recordCheckin(device, token);
        if (!result) return res.status(401).json({ ok: false });
        res.json({ ok: true, ts: result.ts });
    } catch (error) {
        logError('API Error (GET /api/witness/checkin)');
        res.status(500).json({ ok: false });
    }
});

// Per-room theme overrides ("Theme for this room only", v2.132.0).
// Keyed by game_rooms.id and NOT per device — see PreferencesService.RoomThemes.
//
// `?roomId=` opts into the one-shot lift of the pre-v2.132 per-device
// `UI_THEME` override onto that room. It is a side effect on a GET, which is
// deliberate and safe: it is idempotent (there is nothing left to lift on the
// second call), it is the only moment we know which room the viewer meant,
// and it keeps the room-page read to a single request.
router.get('/me/room-themes', requireDiscordUser, async (req, res) => {
    try {
        const { PreferencesService } = await import('../../services/PreferencesService.js');
        const roomId = typeof req.query.roomId === 'string' ? req.query.roomId : undefined;
        const roomThemes = await PreferencesService.getRoomThemes(req.user!.discordId!, roomId);
        res.json({ roomThemes });
    } catch (error) {
        logError('API Error (GET /api/me/room-themes):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.put('/me/room-themes/:roomId', requireDiscordUser, async (req, res) => {
    try {
        const validationResult = validate(SetRoomThemeSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const { PreferencesService } = await import('../../services/PreferencesService.js');
        const roomThemes = await PreferencesService.setRoomTheme(
            req.user!.discordId!,
            req.params.roomId as string,
            validationResult.data.theme,
        );
        res.json({ roomThemes });
    } catch (error) {
        logError('API Error (PUT /api/me/room-themes/:roomId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Tutorial status (first-login player tour, v2.48.0 — docs/contracts/first-login-tutorial-contract.md).
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
        // (b) unlinked-player affordances — FriendsService.addFriend distinguishes
        // "no such player" (addFriendById's legacy "Could not find" + addFriend's
        // "No player found") from "player exists but hasn't linked Discord"
        // (marked via error.code, since both still read as 404 to the client).
        if (
            error?.code === 'PLAYER_UNLINKED' ||
            error?.message?.includes('Could not find') ||
            error?.message?.includes('No player found')
        ) {
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

// --- My Stats (v2.82.0 — Identity arc Phase 3) ---

/**
 * A room-leg Personal Best row (`StatsService.getPersonalBestsForIdentities`)
 * or a Global-leg row (`GlobalLeaderboardService.getDirectBestsForIdentities`),
 * normalized to one shape the FE renders without branching on `source`.
 */
interface MyStatsBestRow {
    source: 'room' | 'global';
    game_name: string;
    best_score: number;
    rank: number;
    total_players: number;
    achieved_at: string;
    room_id?: string;
    room_slug?: string;
    room_name?: string;
    /** Room leg only (owner revision, screenshot review) — FE shows this in
     *  place of the `room_name` text caption when present, nullable when the
     *  room has no logo. Never set on global rows. */
    room_logo_url?: string | null;
    global_game_id?: string;
}

export type MyStatsRoomBestRaw = { game_name: string; best_score: number; room_rank: number; total_players: number; achieved_at: string; room_id: string; room_slug: string; room_name: string; room_logo_url: string | null };
export type MyStatsGlobalBestRaw = { game_name: string; best_score: number; rank: number; total_players: number; achieved_at: string; global_game_id: string };

/**
 * Cross-board game identity: `LOWER(game_name)` — the name-keying doctrine
 * used everywhere else in this repo (catalogue dedup step 4, room game tags,
 * `RoomScoresService`, etc.). Accepted trade-off: two same-named catalogue
 * twins (e.g. two distinct "Medieval Madness" global_games rows) collapse
 * onto one Personal Bests row instead of two. No normalization beyond
 * lowercase — this is intentionally the cheap/consistent version, not
 * `normalizeGameName`'s punctuation-aware fold.
 */
function myStatsGameKey(gameName: string): string {
    return gameName.toLowerCase();
}

/**
 * v2.83.0 (owner semantics revision, 2026-08-07) — Personal Bests is no
 * longer "every board you've ever set a best on"; it's "your single best per
 * game, and where you set it." Reworked from the v2.82.0 `combineMyStatsBests`
 * merge-and-sort into an actual cross-board collapse, computed in TypeScript
 * over the (bounded ≤1000+1000 row) SQL leg outputs — the two legs' SQL is
 * untouched, this is purely a post-processing step.
 *
 * **All scope:** one row per distinct game across every board (every room's
 * board + the direct-Global board) — the row for the board where the
 * player's best on that game is highest. A tie across boards (same max score
 * on 2+ boards) is broken by earliest `achieved_at`, matching the repo's
 * `score DESC, created_at ASC` recompute doctrine used elsewhere (e.g.
 * `insertHistoryScore`/wipe-recompute paths).
 *
 * **Room scope:** a game appears ONLY if this room's own board-best for that
 * game equals the overall max across every board (ties count as a match —
 * if two boards share the max, both claim the game). A game whose overall
 * best lives on a different board (another room, or direct-Global) is
 * excluded entirely, even though the player has scored it in this room too.
 * The emitted row is still this room's own row (its own rank/total_players
 * on its own board), not the winning board's row.
 *
 * Exported for direct unit testing — this is the one place the new semantics
 * live, and it needs to be verifiable without a DB.
 */
export function collapseToOverallBests(
    roomBests: MyStatsRoomBestRaw[],
    globalBests: MyStatsGlobalBestRaw[],
    scope: 'all' | string,
): MyStatsBestRow[] {
    type Candidate = MyStatsBestRow & { _key: string };

    const roomRows: Candidate[] = roomBests.map((b): Candidate => ({
        source: 'room',
        game_name: b.game_name,
        best_score: b.best_score,
        rank: b.room_rank,
        total_players: b.total_players,
        achieved_at: b.achieved_at,
        room_id: b.room_id,
        room_slug: b.room_slug,
        room_name: b.room_name,
        room_logo_url: b.room_logo_url,
        _key: myStatsGameKey(b.game_name),
    }));
    const globalRows: Candidate[] = globalBests.map((b): Candidate => ({
        source: 'global',
        game_name: b.game_name,
        best_score: b.best_score,
        rank: b.rank,
        total_players: b.total_players,
        achieved_at: b.achieved_at,
        global_game_id: b.global_game_id,
        _key: myStatsGameKey(b.game_name),
    }));

    const byKey = new Map<string, Candidate[]>();
    for (const row of [...roomRows, ...globalRows]) {
        const bucket = byKey.get(row._key);
        if (bucket) bucket.push(row);
        else byKey.set(row._key, [row]);
    }

    const results: MyStatsBestRow[] = [];

    for (const rows of byKey.values()) {
        let overallMax = -Infinity;
        for (const r of rows) if (r.best_score > overallMax) overallMax = r.best_score;

        if (scope === 'all') {
            // Single winning row: highest score, ties broken by earliest
            // achieved_at (SQLite datetime strings sort lexically, so plain
            // string comparison matches the SQL-side doctrine exactly).
            let winner: Candidate | undefined;
            for (const r of rows) {
                if (r.best_score !== overallMax) continue;
                if (!winner || r.achieved_at < winner.achieved_at) winner = r;
            }
            if (winner) {
                const { _key, ...row } = winner;
                results.push(row);
            }
        } else {
            // Room scope: emit every row belonging to THIS room whose own
            // board-best ties the overall max. (At most one such row per
            // game — the SQL leg already collapses to one row per
            // (room, game) — but the filter is written generally.)
            for (const r of rows) {
                if (r.source !== 'room' || r.room_id !== scope) continue;
                if (r.best_score !== overallMax) continue;
                const { _key, ...row } = r;
                results.push(row);
            }
        }
    }

    // Same ordering rule as the v2.82.0 merge: rank ASC, then game_name ASC.
    // The FE never re-sorts.
    results.sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        return a.game_name.localeCompare(b.game_name);
    });
    return results;
}

/**
 * GET /api/me/stats?scope=all|<roomId> — My Stats (v2.83.0 owner semantics
 * revision, Identity arc Phase 3).
 *
 * `scope` omitted or `'all'` -> one row per distinct game across EVERY board
 * (every room's board + the direct-Global board), showing the player's
 * single best score anywhere and the board it was set on (contract:
 * "direct-Global bests appear in All with a 'Global' provenance chip" — no
 * separate Global scope). `scope=<roomId>` -> only games where THIS room's
 * board-best ties the overall best across every board — a game whose best
 * lives elsewhere is excluded entirely, even if the player has also scored
 * it in this room. Gated behind `RoomMembershipService.isMember` — a
 * non-member 403s rather than leaking a room the viewer can't otherwise see
 * (approval/suspended rooms).
 *
 * Both SQL legs are ALWAYS fetched UNSCOPED (no `gameRoomId` filter) —
 * room scope still needs the full cross-board picture to know where each
 * game's overall best actually lives; `collapseToOverallBests` does the
 * scope-specific filtering afterward. `totalScores` in the overview keeps
 * its OLD room-filtered/direct-only behavior (unchanged by this revision) —
 * it counts raw score EVENTS, not distinct-game bests, so the collapse does
 * not apply to it.
 *
 * Identity = `IdentityCandidateService.forUser(tokenId)` — the token's own
 * id expanded through the login-identity link graph AND its `user_mappings`
 * iScored aliases. Unlinked room display-name claims are deliberately NOT
 * included (contract: beta-acceptable).
 */
router.get('/me/stats', requireDiscordUser, async (req, res) => {
    try {
        const tokenId = req.user!.discordId!;
        const scope = typeof req.query.scope === 'string' && req.query.scope ? req.query.scope : 'all';
        const isAllScope = scope === 'all';

        const { RoomMembershipService } = await import('../../services/RoomMembershipService.js');

        if (!isAllScope) {
            const isMember = await RoomMembershipService.isMember(tokenId, scope);
            if (!isMember) {
                res.status(403).json({ error: 'Not a member of this room' });
                return;
            }
        }

        const { IdentityCandidateService } = await import('../../services/IdentityCandidateService.js');
        const { StatsService } = await import('../../services/StatsService.js');

        const candidates = await IdentityCandidateService.forUser(tokenId);
        const roomScopeId = isAllScope ? undefined : scope;

        const [roomBests, globalBests, memberRooms, roomScoreCount, globalScoreCount] = await Promise.all([
            // Always unscoped — the collapse needs every room's board to
            // determine where the overall best lives, even in room scope.
            StatsService.getPersonalBestsForIdentities(candidates),
            GlobalLeaderboardService.getDirectBestsForIdentities(candidates),
            RoomMembershipService.listRoomsForUser(tokenId),
            // totalScores tile: unchanged room-filter / direct-only behavior.
            StatsService.countScoresForIdentities(candidates.playerKeys, roomScopeId),
            isAllScope ? GlobalLeaderboardService.countDirectScoresForIdentities(candidates.playerKeys) : Promise.resolve(0),
        ]);

        const personalBests = collapseToOverallBests(roomBests as MyStatsRoomBestRaw[], globalBests as MyStatsGlobalBestRaw[], scope);

        res.json({
            scope,
            overview: {
                gamesWithBest: personalBests.length,
                memberRooms: memberRooms.length,
                totalScores: roomScoreCount + globalScoreCount,
            },
            personalBests,
        });
    } catch (error) {
        logError('API Error (GET /api/me/stats):', error);
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

// --- Notification Settings (Discord HQ arc, v2.72.0, contract Section 2) ---
//
// One storage, two surfaces. The `/arcaid-notifications` Discord command and
// this endpoint read and write the SAME `user_preferences.notification_prefs`
// blob through the same `NotificationService.mergePrefs` writer, so a pref set
// in Discord renders here and vice versa. That parity is the whole point: the
// players this arc serves — the ones in Discord-less rooms — cannot reach the
// slash command at all, and until now had no way to configure notifications.
//
// Beyond the prefs, the response carries the Discord DM deliverability verdict
// so the page can be honest rather than hopeful: a checkbox promising DMs to
// someone who shares no guild with the bot is a lie the old UI told by omission.

/** Shape both GET and PUT return, so the FE has one parser. */
async function buildNotificationSettings(userId: string) {
    const db = await getDatabase();
    const row = await db.get(
        'SELECT notification_prefs FROM user_preferences WHERE discord_user_id = ?',
        userId,
    );
    let prefs: Record<string, unknown> = {};
    if (row?.notification_prefs) {
        try { prefs = JSON.parse(row.notification_prefs); } catch { prefs = {}; }
    }

    const isDiscord = isDiscordUserId(userId);
    const [reachability, globalGuildId, inviteUrl] = await Promise.all([
        DiscordReachabilityService.canDm(userId),
        DiscordReachabilityService.getGlobalGuildId(),
        DiscordReachabilityService.getInviteUrl(),
    ]);

    return {
        prefs,
        /** The five per-type opt-in keys, so the FE never hardcodes the list. */
        types: [...PREF_TYPE_KEYS],
        /** Subset of `types` that the browser-push channel can also carry. */
        webPushTypes: [...WEB_PUSH_TYPES],
        discord: {
            /** False for a `google:*` identity — no Discord account, no DMs. */
            available: isDiscord,
            reachable: reachability.reachable,
            via: reachability.via,
            viaRoomName: reachability.viaRoomName,
            gatewayReady: reachability.gatewayReady,
            /**
             * Whether the one-click connect flow can be offered. Requires the
             * HQ guild AND the OAuth app credentials — without either, the FE
             * renders no button and makes no reachability promises.
             */
            connectAvailable: isDiscord
                && !!globalGuildId
                && !!process.env.DISCORD_CLIENT_ID
                && !!process.env.DISCORD_CLIENT_SECRET,
            /** Manual-join fallback; null when the owner hasn't set one. */
            inviteUrl,
        },
        nudge: await DmNudgeService.get(userId),
    };
}

router.get('/me/notification-settings', requireDiscordUser, async (req, res) => {
    try {
        res.json(await buildNotificationSettings(req.user!.discordId!));
    } catch (error) {
        logError('API Error (GET /api/me/notification-settings):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.put('/me/notification-settings', requireDiscordUser, async (req, res) => {
    try {
        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({ error: 'Body must be a JSON object' });
        }
        // Same allowlisted merge as the legacy PUT /me/notification-preferences:
        // only the five typed booleans are honoured, so a caller-crafted body
        // can never set `webPush`, `_hvFooterShown`, or forge/clear `_dmNudge`.
        const body = req.body.prefs ?? req.body;
        const updates = {
            ...NotificationService.typedPrefUpdates(body),
            // v2.125.0 — the Arcaid Chat Responses mute rides in the same blob
            // but is extracted separately, because `typedPrefUpdates` promises
            // "the typed DM opt-ins and nothing else" and widening it would let
            // a crafted body reach the keys it exists to exclude.
            ...NotificationService.chatResponsePrefUpdate(body),
        };
        await NotificationService.mergePrefs(req.user!.discordId!, updates);
        res.json(await buildNotificationSettings(req.user!.discordId!));
    } catch (error) {
        logError('API Error (PUT /api/me/notification-settings):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- DM nudge (Discord HQ arc, v2.72.0, contract Section 4) ---
//
// Lightweight endpoint for the site-wide banner, kept separate from the
// settings payload above so the layout can poll it without pulling prefs +
// three settings reads + a guild fetch on every page.


/**
 * Room-scoped Discord link status for the site-wide nudge banner.
 *
 * Answers "is this viewer set up to receive this room's Discord features?" —
 * NOT "did they sign in with Google", which is wrong in both directions: a
 * Google login that has been LINKED canonicalizes to the Discord snowflake and
 * works fine, while a Discord login sharing no guild with the bot receives
 * nothing at all. Reachability is the real question, so reachability is what
 * this asks.
 *
 * Returns null whenever there is nothing honest to say — the room has no
 * Discord integration, the viewer is already fine, or we could not determine
 * the answer. Uncertainty must never produce a nudge: telling someone to fix a
 * problem they may not have is how a warning earns a reflexive dismissal.
 */
async function buildRoomDiscordLinkStatus(userId: string, roomId: string): Promise<{
    state: 'no_discord' | 'not_in_guild';
    roomName: string | null;
    inviteUrl: string | null;
} | null> {
    const { GameRoomSettingsService } = await import('../../services/GameRoomSettingsService.js');

    const enabled = await GameRoomSettingsService.get(roomId, 'DISCORD_ENABLED');
    if (enabled === 'false') return null;

    // Room admin switch (2026-08-17): a room can have Discord linked for
    // announcements while not caring whether individual players are reachable.
    // Default ON, disabled with 'false' — same shape as ROOM_LISTED, so the
    // absence of a row means "on" and no backfill is needed.
    const remindersOn = await GameRoomSettingsService.get(roomId, 'DISCORD_LINK_REMINDERS');
    if (remindersOn === 'false') return null;
    const guildId = await GameRoomSettingsService.get(roomId, 'DISCORD_GUILD_ID');
    if (!guildId) return null;

    // Player's own permanent opt-out for this room. Checked before any guild
    // work so a player who said "never" costs nothing to serve.
    const { DiscordLinkNudgeService } = await import('../../services/DiscordLinkNudgeService.js');
    if (await DiscordLinkNudgeService.hasOptedOut(userId, roomId)) return null;

    const db = await getDatabase();
    const room = await db.get('SELECT name FROM game_rooms WHERE id = ?', roomId);
    const roomName = room?.name ?? null;
    const rawInvite = (await GameRoomSettingsService.get(roomId, 'DISCORD_INVITE_URL'))?.trim() || null;
    const inviteUrl = rawInvite && rawInvite.toLowerCase().startsWith('https://') ? rawInvite : null;

    // No Discord identity at all — the fix is to LINK one. A linked Google
    // login never reaches here: it canonicalizes to the snowflake at login.
    if (!isDiscordUserId(userId)) {
        return { state: 'no_discord', roomName, inviteUrl };
    }

    const reach = await DiscordReachabilityService.canDm(userId);
    if (!reach.gatewayReady) return null;   // indeterminate — say nothing
    if (reach.reachable) return null;       // DMs already land — nothing to fix

    // Has Discord but shares no guild with the bot. Linking is NOT the fix
    // here; joining the server is. Distinct copy, distinct action.
    return { state: 'not_in_guild', roomName, inviteUrl };
}

router.get('/me/dm-nudge', requireDiscordUser, async (req, res) => {
    try {
        // Optional `roomId` folds this room's Discord link status into the same
        // response, so the banner still costs the layout exactly one request.
        const roomId = typeof req.query.roomId === 'string' && req.query.roomId ? req.query.roomId : null;
        const userId = req.user!.discordId!;
        res.json({
            nudge: await DmNudgeService.get(userId),
            discordLink: roomId ? await buildRoomDiscordLinkStatus(userId, roomId).catch(() => null) : null,
        });
    } catch (error) {
        logError('API Error (GET /api/me/dm-nudge):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * Permanent, per-room opt-out from the Discord link banner — the "don't remind
 * me again" checkbox. Distinct from the banner's dismiss button, which is a
 * 30-day snooze held in the browser. This one is stored server-side so the
 * choice follows the player across devices.
 */
router.post('/me/dm-nudge/discord-link/opt-out', requireDiscordUser, async (req, res) => {
    try {
        const roomId = typeof req.body?.roomId === 'string' ? req.body.roomId.trim() : '';
        if (!roomId) return res.status(400).json({ error: 'roomId is required' });
        const { DiscordLinkNudgeService } = await import('../../services/DiscordLinkNudgeService.js');
        await DiscordLinkNudgeService.optOut(req.user!.discordId!, roomId);
        res.json({ ok: true });
    } catch (error) {
        logError('API Error (POST /api/me/dm-nudge/discord-link/opt-out):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/me/dm-nudge/dismiss', requireDiscordUser, async (req, res) => {
    try {
        await DmNudgeService.clear(req.user!.discordId!);
        res.json({ ok: true });
    } catch (error) {
        logError('API Error (POST /api/me/dm-nudge/dismiss):', error);
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
router.post('/submission-drafts/:stateParam', writeLimiter, withUploadErrors(globalScoreUpload.single('photo')), async (req, res) => {
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
        // v2.53.0 (ADR 0016) — the picker selection is now a pair. Staged
        // verbatim; the commit paths below re-validate it against the game's
        // scope before any write, so a stale draft can't smuggle an incoherent
        // pair past the same checks the direct submit routes run.
        const engine = typeof req.body?.engine === 'string' && req.body.engine.trim() ? req.body.engine.trim() : null;
        const device = typeof req.body?.device === 'string' && req.body.device.trim() ? req.body.device.trim() : null;

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
            engine,
            device,
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

        // v2.53.0 (ADR 0016) — BOTH draft-commit paths previously skipped
        // validation entirely: whatever the stage endpoint stored went straight
        // to the DB, so a stale or hand-crafted draft could write a platform the
        // game never had. Re-validate here, against the same scope the direct
        // submit routes use, before anything is written.
        const { ScoreProvenanceService } = await import('../../services/ScoreProvenanceService.js');
        const provenance = draft.target.kind === 'global'
            ? await ScoreProvenanceService.validateForGlobalGame(draft.target.globalGameId, draft.engine, draft.device)
            : await ScoreProvenanceService.validateForRoomGame(draft.target.roomId, draft.target.gameName, draft.engine, draft.device);
        if (!provenance.ok) return res.status(400).json({ error: provenance.error });
        const { engine, device, platform } = provenance;

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

            // v2.79.0 (v2.54.0 deferral, settled) — the draft's `playerName` was
            // typed by the user BEFORE they logged in, so it's exactly the kind
            // of client-supplied name the username lock discards everywhere
            // else. Resolve the caller's canonical room name server-side (same
            // helper the direct room submit routes use) and write THAT as the
            // score's name. The self-claim sweep below deliberately keeps using
            // the typed `draft.playerName` as its match key — that's the name
            // any pre-login anon identity would have been recorded under, so
            // sweeping by the canonical name instead would miss the claim.
            const { UserProfileService } = await import('../../services/UserProfileService.js');
            const resolvedName = await UserProfileService.resolveSubmitName({
                discordUserId: discordId,
                roomId,
                jwtUsername: req.user?.username ?? null,
            });

            const { CommunityScoreService } = await import('../../services/CommunityScoreService.js');
            const result = await CommunityScoreService.submitScore(
                roomId,
                gameName,
                resolvedName,
                draft.score,
                discordId,
                photoUrl ?? undefined,
                { excludeFromGlobal: draft.excludeFromGlobal, platform, engine, device },
            );
            const effectiveUsername = result.displayName;

            // Mirror submit-score route: upsert into submissions if an active/completed tournament game matches.
            const db = await getDatabase();
            const activeGame = await db.get(`
                SELECT g.id, g.tournament_id FROM games g
                JOIN tournaments t ON t.id = g.tournament_id
                WHERE LOWER(g.name) = LOWER(?) AND t.game_room_id = ?
                  AND g.status IN ('ACTIVE', 'COMPLETED')
                ORDER BY CASE g.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, g.created_at DESC
                LIMIT 1
            `, gameName, roomId);
            if (activeGame) {
                const submissionId = `${activeGame.id}-${effectiveUsername.toLowerCase()}`;
                const existing = await db.get('SELECT score FROM submissions WHERE id = ?', submissionId);
                if (!existing || draft.score > existing.score) {
                    await db.run(
                        `INSERT OR REPLACE INTO submissions (
                            id, game_id, discord_user_id, iscored_username, score, photo_url, timestamp,
                            submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
                            submitted_by_anonymous_name, merged_from_anonymous_identity_id, platform,
                            engine, device
                         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
                        submissionId, activeGame.id, discordId, effectiveUsername, draft.score, photoUrl || null, new Date().toISOString(),
                        roomId, activeGame.tournament_id || null, discordId,
                        platform, engine, device,
                    );
                    const { LeaderboardService } = await import('../../services/LeaderboardService.js');
                    await LeaderboardService.invalidate(activeGame.id);
                }
            }
        } else {
            // global target — derive mimeType from the draft's stored extension so
            // PNG/WebP drafts don't masquerade as JPEG after the OAuth round-trip.
            const { GlobalScoreService } = await import('../../services/GlobalScoreService.js');
            // v2.79.0 (v2.54.0 deferral, settled) — same rationale as the
            // tournament/freeplay branch above: `draft.playerName` was typed
            // before login, so resolve the canonical name server-side instead.
            // Unlike the direct `/global/scores` route, this does not
            // additionally register the resolved name as a NEW `user_mappings`
            // alias — that alias-claim dance is its own piece of logic and out
            // of scope here; resolveSubmitName's JWT-username fallback still
            // gives a stable, non-spoofable name.
            const { UserProfileService } = await import('../../services/UserProfileService.js');
            const resolvedGlobalName = await UserProfileService.resolveSubmitName({
                discordUserId: discordId,
                jwtUsername: req.user?.username ?? null,
            });
            const draftExt = draft.photoPath ? path.extname(draft.photoPath).slice(1).toLowerCase() : '';
            const photoMimeType = photoBuffer
                ? (draftExt === 'png' ? 'image/png'
                    : draftExt === 'webp' ? 'image/webp'
                    : 'image/jpeg')
                : undefined;
            await GlobalScoreService.submit({
                globalGameId: draft.target.globalGameId,
                playerId: discordId,
                iscoredUsername: resolvedGlobalName,
                score: draft.score,
                photoBuffer: photoBuffer ?? undefined,
                photoMimeType,
                originType: 'global',
                excludeFromGlobal: draft.excludeFromGlobal,
                platform,
                engine,
                device,
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
        const allRooms = await GameRoomService.getPublic();
        const db = await getDatabase();
        const { GameRoomSettingsService } = await import('../../services/GameRoomSettingsService.js');

        // v2.80.0 — ROOM_LISTED (unlisted rooms). Default-on idiom: absent or
        // 'true' stays listed, only an explicit 'false' drops it. This route is
        // deliberately unauthenticated (see the security-review comment below)
        // so an unlisted room is dropped for EVERY caller, not per-viewer — the
        // room stays reachable via its direct URL (getBySlug/portal) and to its
        // members (GET /api/me/rooms reads room_members, not this endpoint).
        const listedFlags = await GameRoomSettingsService.getManyForRooms(
            allRooms.map((r) => r.id),
            ['ROOM_LISTED'],
        );
        const rooms = allRooms.filter((room) => listedFlags.get(room.id)?.ROOM_LISTED !== 'false');

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
// Throwdowns (v2.136.0, ADR 0018)
//
// Player-created, room-less challenges. These live on the GLOBAL router
// precisely because they have no room to be scoped by — `/api/rooms/:roomId/...`
// has nowhere to put them.
//
// A Throwdown is a `format='event'` tournament with `game_room_id IS NULL`, so
// everything below delegates to the same event machinery a hosted Tournament
// Event uses. Nothing here reimplements boards, standings or the window rule.
// ============================================================================

/**
 * POST /api/throwdowns — create one. Two questions: game and duration.
 *
 * Rate-limited like other authenticated writes. The blocklist applies to the
 * game name because it is free text that ends up in a shareable link preview.
 */
router.post('/throwdowns', writeLimiter, requireDiscordUser, requireNotBannedGlobal, async (req, res) => {
    try {
        const validationResult = validate(CreateThrowdownSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const { gameName, durationMinutes, engine, device, rematchOf } = validationResult.data;

        const { ThrowdownService, ThrowdownError } = await import('../../services/ThrowdownService.js');
        try {
            const throwdown = await ThrowdownService.create(req.user!.discordId!, {
                gameName, durationMinutes, engine, device, rematchOf,
            });
            res.status(201).json({ success: true, ...throwdown, url: `/throwdown/${throwdown.code}` });
        } catch (err) {
            if (err instanceof ThrowdownError) {
                // REMATCH_EXISTS is not really a failure — someone beat this
                // player to it, and the useful response is the link they should
                // be joining instead. 409 + the existing code.
                return res.status(err.code === 'REMATCH_EXISTS' ? 409 : 400).json({
                    error: err.message,
                    code: err.code,
                    ...(err.existingCode ? { existingCode: err.existingCode, url: `/throwdown/${err.existingCode}` } : {}),
                });
            }
            throw err;
        }
    } catch (error) {
        logError('API Error (POST /api/throwdowns):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * GET /api/throwdowns/:code — the public read, shaped like
 * `GET /api/rooms/:roomId/events/:id` so the SAME front-end component renders
 * both. Deliberately open: the link IS the access control.
 */
router.get('/throwdowns/:code', optionalDiscordUser, async (req, res) => {
    try {
        const { ThrowdownService } = await import('../../services/ThrowdownService.js');
        const event = await ThrowdownService.getByCode(req.params.code as string);
        if (!event) return res.status(404).json({ error: 'Throwdown not found' });

        const { EventService } = await import('../../services/EventService.js');
        const { EventResultService } = await import('../../services/EventResultService.js');

        const now = new Date();
        const rounds = await EventService.getRounds(event.id);
        const boards = await EventResultService.getBoards(event.id);
        const standings = await EventResultService.computeStandings(event.id);

        res.json({
            event: {
                id: event.id,
                name: event.name,
                state: EventService.deriveState(event, rounds, now),
                aggregateMethod: event.aggregate_method,
                minElapsedSec: event.min_elapsed_sec,
                endGraceSec: event.end_grace_sec,
                startDate: event.start_date,
                endDate: event.end_date,
                finishedAt: event.event_finished_at,
                throwdownCode: event.throwdown_code,
            },
            now: now.toISOString(),
            // A Throwdown has no roster; the shape is kept so the shared
            // component does not need a second code path.
            checkin: { opensAt: null, closesAt: null, required: false, count: 0, viewerCheckedIn: false },
            rounds: boards ?? [],
            standings: standings ?? null,
            viewer: {
                canCheckIn: false,
                reason: req.user?.discordId ? null : 'LOGIN_REQUIRED',
                canSubmit: !!req.user?.discordId,
            },
        });
    } catch (error) {
        logError('API Error (GET /api/throwdowns/:code):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /api/throwdowns/:code/scores — submit into a Throwdown.
 *
 * The window is enforced by `checkThrowdownSubmission`, the room-less sibling of
 * the gate every room submit path uses; both resolve the window through one
 * shared helper so they cannot disagree about the buzzer.
 */
router.post('/throwdowns/:code/scores', globalSubmitLimiter, requireDiscordUser, requireNotBannedGlobal, async (req, res) => {
    try {
        const validationResult = validate(ThrowdownScoreSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const { score, engine, device } = validationResult.data;

        const { ThrowdownService } = await import('../../services/ThrowdownService.js');
        const event = await ThrowdownService.getByCode(req.params.code as string);
        if (!event) return res.status(404).json({ error: 'Throwdown not found' });

        const { checkThrowdownSubmission } = await import('../../services/EventSubmissionGate.js');
        const gate = await checkThrowdownSubmission({
            tournamentId: event.id, userId: req.user!.discordId!,
        });
        if (!gate.ok || !gate.event) {
            return res.status(409).json({ error: gate.message, code: gate.code });
        }

        // Display name comes from the player's global profile — there is no room
        // to run a first-claim-wins name check against.
        const { UserProfileService } = await import('../../services/UserProfileService.js');
        const displayName = await UserProfileService.getDisplayName(req.user!.discordId!);
        const username = displayName || req.user!.username || 'Player';

        const { ThrowdownScoreService } = await import('../../services/ThrowdownScoreService.js');
        const result = await ThrowdownScoreService.submit({
            tournamentId: event.id,
            gameId: gate.event.gameId,
            gameName: gate.event.gameName,
            userId: req.user!.discordId!,
            username,
            score,
            engine, device,
        });

        res.status(201).json({ success: true, ...result, displayName: username });
    } catch (error) {
        logError('API Error (POST /api/throwdowns/:code/scores):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/** GET /api/me/throwdowns — the creator's own list, for their profile. */
router.get('/me/throwdowns', requireDiscordUser, async (req, res) => {
    try {
        const { ThrowdownService } = await import('../../services/ThrowdownService.js');
        const rows = await ThrowdownService.listForCreator(req.user!.discordId!);
        res.json(rows.map(t => ({
            id: t.id,
            name: t.name,
            code: t.throwdown_code,
            startDate: t.start_date,
            endDate: t.end_date,
            finishedAt: t.event_finished_at,
            url: `/throwdown/${t.throwdown_code}`,
        })));
    } catch (error) {
        logError('API Error (GET /api/me/throwdowns):', error);
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
 * GET /api/global/ra-catalogue/search — public RetroAchievements master-list
 * search (contract §2).
 *
 * Deliberately UNAUTHENTICATED. It reads only our cached copy of RA's
 * per-console game lists, which RA publishes freely, and the Global Scoreboard
 * needs it in the search empty state where the viewer may well be a guest —
 * gating it would mean a guest cannot even SEE that Donkey Kong is available
 * to add. What is gated is the import (`requireDiscordUser`); a guest sees the
 * row with a log-in prompt instead of a button.
 *
 * `raSearchLimiter` (30/min/IP) caps it — see the limiter's own note.
 */
router.get('/global/ra-catalogue/search', raSearchLimiter, raSearchHandler);

/**
 * POST /api/global/ra-catalogue/import/:raGameId — PLAYER-triggered import
 * (owner decision, contract §3).
 *
 * A player on the Global Scoreboard who cannot find Donkey Kong must be able
 * to add it: players are demand too, and demand is what approves a game under
 * this model. So the bar is `requireDiscordUser` — ANY logged-in identity, the
 * same bar as global score submission. A guest gets a log-in prompt from the
 * UI rather than a button, and never reaches this handler.
 *
 * Two limiters, deliberately: `writeLimiter` is the ordinary per-IP write cap,
 * and `raImportLimiter` adds 5/hour PER USER because an import is both an RA
 * fair-use cost and a write to the shared catalogue that a super-admin may
 * later have to review. `raImportLimiter` sits AFTER requireDiscordUser so it
 * can key on the Discord id rather than degrading to IP.
 *
 * The importing identity is recorded on `global_games.ra_imported_by` — with
 * players able to add games, moderation needs an attributable actor.
 */
router.post(
    '/global/ra-catalogue/import/:raGameId',
    writeLimiter, requireDiscordUser, raImportLimiter, requireNotBannedGlobal,
    raImportHandler,
);

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
 * v2.74.0 (S24.7) — TTL cache for the SHARED half of `GET /global/scoreboard`.
 *
 * The list route is the public /scoreboard page's only data source and was
 * entirely uncached: every anonymous page load and every "Load more" ran the
 * grouped count query, the grouped data query, the hero's two aggregate
 * queries and a top-scores window pass over the whole page's games.
 *
 * ## What is deliberately NOT cached
 *
 * - **Authenticated requests.** A logged-in viewer's payload carries
 *   `pinned_at` (which changes the SQL itself), `is_pinned`, `my_rank`,
 *   `my_score` and `neighbors`. Those are per-user by definition, and caching
 *   a per-user variant keyed on the query string alone would serve one user's
 *   ranks to another. `sort=pinned` is covered by the same rule — it only
 *   reaches `getTopGames` as a pin sort when there IS a viewer.
 * - **Searches.** The key space is unbounded (every keystroke of the ⌘K
 *   palette is a distinct query) so the hit rate is near zero while the memory
 *   cost is not.
 *
 * The hero rides in the same entry: it is part of the offset-0 payload and is
 * derived from the identical filter set, so it can never disagree with the
 * grid it sits above.
 *
 * ## Invalidation
 *
 * TTL only. The cached thing is a global aggregate (popularity, score counts,
 * top-5 previews) where 30s of staleness is invisible, and the FE already
 * bumps counts optimistically off the `score:new:global` socket event, which
 * papers over the window client-side. A write-path invalidation hook would be
 * a lot of coupling for an aggregate nobody watches to the second.
 */
const SCOREBOARD_CACHE_TTL_MS = 30_000;
/**
 * Hard cap on distinct cached variants. The key space is bounded by the filter
 * combinations the UI can produce (sort × scope × type × platforms × category ×
 * page), but `platforms` is a free-form comma list, so a cap keeps a crafted
 * request loop from growing this without bound. Oldest-inserted is evicted
 * first — Map preserves insertion order.
 */
const SCOREBOARD_CACHE_MAX_ENTRIES = 200;
const scoreboardCache = new Map<string, { payload: unknown; expiresAt: number }>();
/**
 * The database handle the cached payloads were derived from.
 *
 * In production this is set once and never changes, so the check below is a
 * reference compare. In tests every `setupTestDb()` mints a fresh in-memory
 * handle, and without this the cache — keyed on the query string alone — would
 * serve one test's scoreboard to the next. Tying the cache's lifetime to the
 * data it was computed FROM is also just the honest invariant.
 */
let scoreboardCacheDb: unknown = null;

async function reconcileScoreboardCacheDb(): Promise<void> {
    const db = await getDatabase();
    if (db !== scoreboardCacheDb) {
        scoreboardCache.clear();
        scoreboardCacheDb = db;
    }
}

/**
 * The cache key, or null when this request must not be cached.
 * Built from the FULL query tuple — a param that changes the response and is
 * missing here would serve the wrong page.
 */
function scoreboardCacheKey(req: { query: Record<string, any> }, viewerId: string | null): string | null {
    if (viewerId) return null;
    const search = (req.query.search as string) || '';
    if (search.trim()) return null;
    return [
        req.query.sort ?? '',
        req.query.scope ?? '',
        req.query.limit ?? '',
        req.query.offset ?? '',
        req.query.type ?? '',
        req.query.platforms ?? '',
        req.query.hasScores ?? '',
        req.query.category ?? '',
        req.query.groupBy ?? '',
    ].join('|');
}

function readScoreboardCache(key: string): unknown | null {
    const entry = scoreboardCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        scoreboardCache.delete(key);
        return null;
    }
    return entry.payload;
}

function writeScoreboardCache(key: string, payload: unknown): void {
    if (scoreboardCache.size >= SCOREBOARD_CACHE_MAX_ENTRIES) {
        // Sweep anything already expired before falling back to oldest-first.
        const now = Date.now();
        for (const [k, v] of scoreboardCache) {
            if (v.expiresAt <= now) scoreboardCache.delete(k);
        }
        while (scoreboardCache.size >= SCOREBOARD_CACHE_MAX_ENTRIES) {
            const oldest = scoreboardCache.keys().next();
            if (oldest.done) break;
            scoreboardCache.delete(oldest.value);
        }
    }
    scoreboardCache.set(key, { payload, expiresAt: Date.now() + SCOREBOARD_CACHE_TTL_MS });
}

/** Test hook — drops every cached variant. */
export function __clearGlobalScoreboardCache(): void {
    scoreboardCache.clear();
    scoreboardCacheDb = null;
}

/**
 * GET /api/global/scoreboard — paginated CARD list + per-card score aggregates.
 *
 * v2.59.0 (ADR 0016 P4): a row is a `(game, fidelity category)` card, not a
 * game. `total` and pagination count cards; `top_scores`, `my_rank`,
 * `my_score` and `neighbors` are all scoped inside the card's category. Pins
 * stay keyed on the GAME, so every card of a pinned game reports `is_pinned`.
 * All catalogue games still appear, even with zero scores (one uncategorised
 * card each). Default sort is `popular` (recency-weighted score count).
 *
 * Query params:
 *   ?sort=popular|most_scores|highest_rated|most_recent|name_asc|pinned
 *   &scope=global|<roomId>
 *   &limit=30&offset=0
 *   &search=&type=&platforms=vpx,real,...
 *   &category=real|simulation|arcade_style|video|unspecified (P4 — the chip;
 *     omitted/`all` returns every card)
 *   &groupBy=game (P4 — collapse back to one row per game. The ⌘K palette
 *     searches GAMES: a game matches if any of its cards would.)
 *   &hasScores=1|true (scores-page-redesign: bound global scope to games
 *     WITH at least one live score — room Scoreboard's "Global" tab lens.
 *     Omitted/false leaves the standalone /scoreboard catalogue browse
 *     unchanged, including zero-score games.)
 *
 * v2.52.0 (A4) — `optionalDiscordUser`, NOT `requireAuth`/`requireDiscordUser`.
 * This route is the public /scoreboard page's only data source and must keep
 * answering token-less requests; the middleware decodes a Bearer token when one
 * is sent and is a pure no-op otherwise.
 *
 * WITH a valid token, each row additionally carries `is_pinned`, `my_rank`,
 * `my_score` and `neighbors`. WITHOUT one, the response is byte-identical to
 * the pre-A4 shape — no new keys, no nulls leaking in. That is a tested
 * invariant, because a key that only appears for some viewers is exactly the
 * kind of thing that silently changes a cache key or a client's `Object.keys`
 * assumptions.
 *
 * v2.57.0 (A5a) — the response gains ONE additive top-level key, `hero`, on
 * `offset === 0` only (see below). Per-game row shapes are untouched.
 */
router.get('/global/scoreboard', optionalDiscordUser, async (req, res) => {
    try {
        const viewerId = req.user?.discordId ?? null;
        // v2.74.0 (S24.7) — anonymous-only TTL cache, checked before any work.
        const cacheKey = scoreboardCacheKey(req, viewerId);
        if (cacheKey) {
            await reconcileScoreboardCacheDb();
            const hit = readScoreboardCache(cacheKey);
            if (hit) {
                res.json(hit);
                return;
            }
        }
        const requestedSort = (req.query.sort as 'popular' | 'most_scores' | 'highest_rated' | 'most_recent' | 'name_asc' | 'pinned') || 'popular';
        // `pinned` needs a viewer to mean anything. Anonymous requests degrade
        // to `popular` rather than 400ing — a shared `?sort=pinned` link opened
        // logged-out should render a scoreboard, not an error.
        const sort = (requestedSort === 'pinned' && !viewerId) ? 'popular' : requestedSort;
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
        // P4 — the category chip. Unknown values are dropped rather than 400ing:
        // a stale bookmark should render the full board, not an error page.
        const rawCategory = (req.query.category as string) || '';
        const category = CARD_CATEGORY_ORDER.includes(rawCategory) ? rawCategory : undefined;
        const groupBy = req.query.groupBy === 'game' ? 'game' as const : 'card' as const;

        const result = await GlobalLeaderboardService.getTopGames({
            sort, scope, limit, offset, search, type, platforms, hasScores, category, groupBy,
            ...(viewerId ? { pinnedUserId: viewerId } : {}),
        });

        // v2.57.0 (A5a) — the hero card. Page-1 content only: it is one card at
        // grid position 1, so computing it for every "Load more" page would be
        // work nobody renders. `offset > 0` omits the key ENTIRELY (not `null`),
        // which is what lets the client treat "key present" as "this is page 1".
        //
        // Same filters as the grid by construction — `getHeroGame` builds its
        // WHERE/JOIN through the shared `buildCatalogueFilters`.
        const hero = offset === 0
            ? await GlobalLeaderboardService.getHeroGame({ scope, search, type, platforms, category })
            : null;
        const heroId = hero?.global_game_id ?? null;

        // Enrich each card with top 10 leaderboard entries for previews. The
        // hero rides along in the id list even when it isn't on this page, so
        // its rows / rank / pin state cost no extra round-trips.
        //
        // P4 — the lookup key is `card_id`, so two cards of the same game get
        // their own category's rows. The QUERY still takes game ids (it returns
        // every category in one pass), hence the de-duplicated id list.
        const gameIds = [...new Set(result.data.map((g: any) => g.global_game_id as string))];
        const contextIds = (heroId && !gameIds.includes(heroId)) ? [...gameIds, heroId] : gameIds;
        const topScores = await GlobalLeaderboardService.getTopScoresForCards(contextIds, 10, scope);
        const enriched = result.data.map((g: any) => ({
            ...g,
            top_scores: topScores[g.card_id] || [],
        }));
        const heroBase = hero ? { ...hero, top_scores: topScores[hero.card_id] || [] } : null;
        /** `hero` appears only on page 1; there it may legitimately be null. */
        const heroKey = (value: any) => (offset === 0 ? { hero: value } : {});

        if (!viewerId) {
            const payload = { ...result, data: enriched, ...heroKey(heroBase) };
            if (cacheKey) writeScoreboardCache(cacheKey, payload);
            res.json(payload);
            return;
        }

        // --- Per-viewer context (authenticated only) ---
        // P4 — keyed by `card_id`: a viewer can be 3rd on one category card of
        // a game and 9th on another, and each card must show its own number.
        const myRanks = await GlobalLeaderboardService.getViewerCardRanks(contextIds, viewerId, scope);

        // `neighbors` = ranks my_rank-1 … my_rank+1, each carrying an explicit
        // `rank`. It exists so A5's density toggle flips client-side with no
        // refetch; it is shipped now because it is the same query and splitting
        // it would mean touching this path twice.
        //
        // The full ranked list is only pulled for cards ON THIS PAGE that the
        // viewer actually has a score on — normally a handful. `myRanks` covers
        // every category of every context game, so intersecting with the
        // rendered cards is what keeps that bounded.
        const pageCards = new Map<string, { gameId: string; category: string | null }>();
        for (const g of result.data as any[]) {
            pageCards.set(g.card_id, { gameId: g.global_game_id, category: g.category });
        }
        if (hero) pageCards.set(hero.card_id, { gameId: hero.global_game_id, category: hero.category });

        const neighborsByCard: Record<string, any[]> = {};
        await Promise.all([...pageCards.entries()]
            .filter(([key]) => myRanks[key])
            .map(async ([key, card]) => {
                const rank = myRanks[key]!.rank;
                const full = await GlobalLeaderboardService.getForCard(card.gameId, card.category, scope);
                neighborsByCard[key] = full.filter(e => e.rank >= rank - 1 && e.rank <= rank + 1);
            }));

        const pinned = await GlobalPinService.pinnedIdsAmong(viewerId, contextIds);

        /**
         * The four per-viewer keys, identical for a grid row and for the hero.
         * `is_pinned` is looked up by GAME (pinning is a property of the game,
         * so all its cards agree); the rest are looked up by CARD.
         */
        const withViewerContext = (g: any) => {
            const mine = myRanks[g.card_id];
            return {
                ...g,
                is_pinned: pinned.has(g.global_game_id),
                my_rank: mine?.rank ?? null,
                my_score: mine?.score ?? null,
                neighbors: neighborsByCard[g.card_id] ?? [],
            };
        };

        res.json({
            ...result,
            data: enriched.map(withViewerContext),
            ...heroKey(heroBase ? withViewerContext(heroBase) : null),
        });
    } catch (error) {
        logError('API Error (GET /api/global/scoreboard):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * GET /api/global/pins — the viewer's pinned games (v2.52.0, A4).
 *
 * Returns everything the "My Pins" rail chip renders, so opening /scoreboard
 * logged in costs one extra request, not one-per-pin. Ordered newest pin first.
 */
router.get('/global/pins', requireDiscordUser, async (req, res) => {
    try {
        const pins = await GlobalPinService.list(req.user!.discordId!);
        res.json({ pins });
    } catch (error) {
        logError('API Error (GET /api/global/pins):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /api/global/games/:globalGameId/pin — pin a game (v2.52.0, A4).
 *
 * Idempotent: re-pinning is a 200 no-op. Seeds `last_known_rank` with the
 * viewer's current rank on the game (NULL when they have no score yet).
 * Pins are unlimited — there is deliberately no cap here.
 */
router.post('/global/games/:globalGameId/pin', writeLimiter, requireDiscordUser, async (req, res) => {
    try {
        const globalGameId = req.params.globalGameId as string;
        const result = await GlobalPinService.pin(req.user!.discordId!, globalGameId);
        if (!result) return res.status(404).json({ error: 'Game not found' });
        res.json(result);
    } catch (error) {
        logError('API Error (POST /api/global/games/:globalGameId/pin):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * DELETE /api/global/games/:globalGameId/pin — unpin (v2.52.0, A4).
 * Idempotent; unpinning something that was never pinned is a 200 no-op.
 */
router.delete('/global/games/:globalGameId/pin', writeLimiter, requireDiscordUser, async (req, res) => {
    try {
        const globalGameId = req.params.globalGameId as string;
        const result = await GlobalPinService.unpin(req.user!.discordId!, globalGameId);
        res.json(result);
    } catch (error) {
        logError('API Error (DELETE /api/global/games/:globalGameId/pin):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * GET /api/global/scoreboard/:globalGameId — leaderboard for a single game,
 * scoped to ONE fidelity category (v2.63.0).
 *
 * Query params: `?scope=global|<roomId>&offset=0&limit=50&category=<id>`
 *
 * Pre-v2.63 this returned one COMBINED list per game. That was the ADR 0016
 * comparability defect surviving on the page a player actually reads: the
 * scoreboard had already split a mixed game into a Simulation card and an
 * Arcade-Style card, and clicking either landed on a board that mixed the two
 * back together. Cards may share a game page; their SCORES may not share a
 * table.
 *
 * The response therefore ships three things instead of one:
 *   • `categories` — every board the game has, biggest first. The tab strip.
 *   • `category`   — the board actually served (never echoed blindly; always
 *                    the resolved one, so the client can trust it).
 *   • `data`       — that board's rows, paged.
 *
 * Resolution: an unknown, absent, or empty `category` falls back to
 * `categories[0]`, i.e. the biggest board, rather than 400ing — a stale
 * bookmark, a card deep-link whose board has since been emptied, and a plain
 * `/games/:id` visit must all render a leaderboard. A game with no scores
 * resolves to `null` and returns an empty `data`, which is the existing
 * zero-score claim state.
 *
 * Single-category games are byte-compatible with the pre-v2.63 response for
 * `data` / `total` / `hasMore`: with one board, "that board" and "everything"
 * are the same rows. `GlobalGameDetail` is the only consumer.
 */
router.get('/global/scoreboard/:globalGameId', async (req, res) => {
    try {
        const globalGameId = req.params.globalGameId as string;
        const scope = (req.query.scope as string) || 'global';
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const offset = parseInt(req.query.offset as string) || 0;
        const requestedCategory = (req.query.category as string) || '';

        const game = await GlobalGameService.getById(globalGameId);
        if (!game) return res.status(404).json({ error: 'Game not found' });

        const categories = await GlobalLeaderboardService.getCardCategories(globalGameId, scope);
        // Membership in THIS game's boards, not merely in the taxonomy: a valid
        // category id the game has no scores in would otherwise render an empty
        // table under a tab that isn't on screen.
        const category = categories.some(c => c.category === requestedCategory)
            ? requestedCategory
            : (categories[0]?.category ?? null);

        const rankings = await GlobalLeaderboardService.getForCard(globalGameId, category, scope);
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
            categories,
            category,
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
 *     // ADR 0016 catalogue phase §4 — `global_games.features`. The catalogue
 *     // fold moved availability facts (`vpxs`, `vr`, `atgames`, `bam`) out of
 *     // `platforms`, and the DEVICE half of the picker was derived from them:
 *     // a `vpxs` platform id used to imply the AtGames device. The client needs
 *     // the features to keep deriving it. Room tags contribute platforms only.
 *     features: string[],
 *     // ADR 0016 P2 §2 — two axes. Legacy-shaped stored rules are lifted by
 *     // `parseTournamentRules`, so the client only ever sees this shape.
 *     tournamentRules: {
 *       engines: { required: string[]; excluded: string[] },
 *       devices: { required: string[]; excluded: string[] },
 *     } | null
 *   }
 *
 * Public endpoint — no auth. The submit handlers re-validate, so an attacker
 * pre-fetching platforms gains nothing.
 */
router.get('/submit/platforms', async (req, res) => {
    try {
        const { roomId, gameName, globalGameId } = req.query as Record<string, string | undefined>;
        const db = await getDatabase();
        const {
            parsePlatformsList, resolveSubmittablePlatforms, parseTournamentRules,
            normalizeCataloguePlatformId,
        } = await import('../../utils/platformRules.js');

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
        //
        // The fold is `normalizeCataloguePlatformId`, NOT the old taxonomy's
        // `normalizePlatform`: this is the resolver SubmissionSheet calls to
        // build its picker, and a catalogue engine id must reach it unchanged
        // (`normalizePlatform` would re-legacy `fx` → `pinball_fx`). Legacy
        // catalogue ids and free-form room tags fold exactly as before.
        const normalizeAndDedupe = (raw: string[]): string[] => {
            const seen = new Set<string>();
            const out: string[] = [];
            for (const p of raw) {
                const id = normalizeCataloguePlatformId(p);
                if (!id || seen.has(id)) continue;
                seen.add(id);
                out.push(id);
            }
            return out;
        };

        // Global submit context — bare globalGameId, no room.
        if (globalGameId && !roomId) {
            const game = await db.get(
                'SELECT platforms, features FROM global_games WHERE id = ? AND status = ? LIMIT 1',
                globalGameId, 'approved',
            );
            if (!game) return res.status(404).json({ error: 'Game not found' });
            const platforms = normalizeAndDedupe(parsePlatformsList(game.platforms || '[]'));
            const features = parsePlatformsList(game.features || '[]');
            return res.json({ platforms, submittable: platforms, features, tournamentRules: null });
        }

        // Room-scoped context — tournament submit OR freeplay. Effective set =
        // catalogue platforms ∪ room-specific tags (see ADR 0008).
        if (roomId && gameName) {
            const gg = await db.get(
                'SELECT platforms, features FROM global_games WHERE LOWER(name) = LOWER(?) AND status = ? LIMIT 1',
                gameName, 'approved',
            );
            const cataloguePlatforms = gg ? parsePlatformsList(gg.platforms || '[]') : [];
            // NOT run through `normalizeAndDedupe` — that is an alias table over
            // platform ids, and a feature is not a platform.
            const features = gg ? parsePlatformsList(gg.features || '[]') : [];
            const { RoomGameTagsService } = await import('../../services/RoomGameTagsService.js');
            const roomTags = await RoomGameTagsService.getTagsForGameName(roomId, gameName);
            let effective: string[] = [...cataloguePlatforms, ...roomTags];
            effective = normalizeAndDedupe(effective);

            // Active tournament narrows the picker via platform_rules.
            // `t.id` is selected so a malformed blob can be warned about by name.
            const activeGame = await db.get(`
                SELECT t.id AS tournament_id, t.platform_rules FROM games g
                JOIN tournaments t ON t.id = g.tournament_id
                WHERE LOWER(g.name) = LOWER(?) AND t.game_room_id = ? AND g.status = 'ACTIVE'
                LIMIT 1
            `, gameName, roomId) as { tournament_id: string; platform_rules: string | null } | undefined;

            // `null` means "no active tournament for this game" — distinct from
            // "a tournament with empty rules", and the FE contract keeps it.
            //
            // `restrictedText` (v2.70.0) — this used to be stripped, on the
            // reasoning that it is the REJECTION message and not picker input.
            // That reasoning still holds for the picker: `SubmissionSheet`
            // builds its options from the two axes and must not start
            // rendering prose, and `rooms.ts`'s activate-game handler remains
            // the place the text is served as an error. What changed is that
            // the axes are no longer the only consumer — `GameInfoPopup`'s
            // "What's allowed" section exists to answer "may I even play this,
            // and how" BEFORE opening the sheet, and the admin's own wording of
            // the restriction is the most useful thing on that panel. The two
            // axes say which chips are allowed; this says why. Shipping it is
            // additive: the FE already parsed it defensively, so no client
            // change was needed to light it up.
            let rules: { engines: AxisRules; devices: AxisRules; restrictedText?: string } | null = null;
            if (activeGame?.platform_rules) {
                const parsed = parseTournamentRules(activeGame.platform_rules, activeGame.tournament_id);
                rules = { engines: parsed.engines, devices: parsed.devices, restrictedText: parsed.restrictedText };
            }

            const submittable = resolveSubmittablePlatforms(effective, rules);
            return res.json({ platforms: effective, submittable, features, tournamentRules: rules });
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
 * Body: multipart/form-data with { globalGameId, score, excludeFromGlobal?, photo }
 *
 * v2.54.0 username lock: the request's `displayName` field is IGNORED (older
 * clients still post it; `GlobalScoreSubmissionSchema` no longer declares it, so
 * Zod strips it rather than rejecting). This route is `requireDiscordUser`, so
 * the submitter is always authenticated and their name is resolved server-side
 * via `UserProfileService.resolveSubmitName` (user_mappings alias →
 * user_profiles.display_name → JWT username claim → id). Pre-lock, an arbitrary
 * typed name became the scoreboard name AND was registered as a permanent
 * `user_mappings` alias for the account. Renames now go through Account
 * Settings (`PATCH /api/users/me/profile`).
 */
router.post('/global/scores', globalSubmitLimiter, requireDiscordUser, requireNotBanned, withUploadErrors(globalScoreUpload.single('photo')), async (req, res) => {
    try {
        // v2.53.0: promoted from hand-rolled inline parsing to the shared Zod
        // schema, so the global path validates the same shape as the three
        // room-scoped submit routes.
        const validationResult = validate(GlobalScoreSubmissionSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const { globalGameId, score, excludeFromGlobal } = validationResult.data;

        if (!req.file) {
            return res.status(400).json({ error: 'A photo is required with global score submissions.' });
        }
        if (!isAllowedImage(req.file.buffer)) {
            return res.status(400).json({ error: 'Invalid image file' });
        }

        const game = await GlobalGameService.getById(globalGameId);
        if (!game || game.status !== 'approved') {
            return res.status(404).json({ error: 'Game not found' });
        }

        // v2.53.0: validate the engine/device pair against the game's catalogue
        // scope and derive the legacy platform the read paths still consume.
        const { ScoreProvenanceService } = await import('../../services/ScoreProvenanceService.js');
        const provenance = await ScoreProvenanceService.validateForGlobalGame(
            globalGameId, validationResult.data.engine, validationResult.data.device,
        );
        if (!provenance.ok) return res.status(400).json({ error: provenance.error });
        const { engine, device, platform } = provenance;

        // v2.54.0 username lock — resolve the submitter's canonical name
        // server-side. Precedence (see UserProfileService.resolveSubmitName):
        // existing user_mappings alias > user_profiles.display_name > JWT
        // username claim > raw id. The request body has no say.
        const db = await getDatabase();
        const { UserProfileService } = await import('../../services/UserProfileService.js');
        const iscoredUsername = await UserProfileService.resolveSubmitName({
            discordUserId: req.user!.discordId!,
            jwtUsername: req.user!.username ?? null,
        });

        // Register the resolved name as this account's alias so the global
        // leaderboard's `iscored:*` display joins resolve it. Only a canonical
        // name can reach this now — the old path claimed whatever the user typed.
        // No-ops when they already hold the alias (that's branch 1 of the
        // resolver). If the name happens to be owned by a DIFFERENT account
        // (only reachable via the JWT-username fallback, i.e. a user with
        // neither an alias nor a chosen display name), we skip the write rather
        // than 409 — the user can no longer pick a different name in the modal,
        // so failing the submit would be a dead end. `ON CONFLICT DO NOTHING`
        // makes the skip automatic; the pre-check exists only for the log line.
        if (req.user!.discordId) {
            const clash = await db.get<{ discord_user_id: string }>(
                `SELECT discord_user_id FROM user_mappings
                 WHERE LOWER(iscored_username) = LOWER(?) AND discord_user_id != ?`,
                iscoredUsername, req.user!.discordId
            );
            if (clash) {
                logInfo(`global submit: alias '${iscoredUsername}' already held by ${clash.discord_user_id}; skipping claim for ${req.user!.discordId}`);
            } else {
                const inserted = await db.run(
                    `INSERT INTO user_mappings (discord_user_id, iscored_username)
                     VALUES (?, ?)
                     ON CONFLICT(iscored_username) DO NOTHING`,
                    req.user!.discordId, iscoredUsername
                );
                // v2.127.0 — every user_mappings writer runs the alias-link
                // effects (fold synthetic memberships, re-attribute unowned
                // synced rows, hydrate the profile). Gated on `changes`:
                // DO NOTHING makes a repeat submit a no-op.
                if (inserted?.changes) {
                    const { IdentityAliasEffectsService } = await import('../../services/IdentityAliasEffectsService.js');
                    await IdentityAliasEffectsService.onAliasLinked(req.user!.discordId, iscoredUsername);
                }
            }
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
                engine,
                device,
            });

            emitScoreNewGlobal({
                globalGameId,
                gameName: game.display_name || game.name,
                playerName: iscoredUsername,
                score,
                engine,
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
 *
 * v2.86.0 — identity masking mirrors the room comment GET
 * (rooms.ts's `/:roomId/games/:gameName/comments`): raw `discord_user_id`
 * exposed every author's id to any caller, which the DELETE route trusted
 * for author-only authorization — a stranger could read an id here and
 * replay it there. Null out every row's `discord_user_id` except the
 * caller's own (when a Bearer token is present); the FE's delete-button gate
 * (`discordUser?.discordId === c.discord_user_id`) still works because the
 * caller's own id survives the mask.
 */
router.get('/global/games/:id/comments', optionalDiscordUser, async (req, res) => {
    try {
        const globalGameId = req.params.id as string;
        const type = req.query.type as 'comment' | 'tip' | undefined;
        const comments = await GlobalCommentService.getComments(globalGameId, type);
        const callerId = req.user?.discordId;
        const masked = (comments as any[]).map(c => ({
            ...c,
            discord_user_id: callerId && c.discord_user_id === callerId ? c.discord_user_id : null,
        }));
        res.json(masked);
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
 * DELETE /api/global/games/:id/comments/:commentId — delete own comment, or
 * any comment if super_admin. Requires Discord login.
 *
 * v2.86.0: added (1) a super_admin moderation bypass — this route previously
 * had no admin tier at all, unlike its room-comment counterpart; and (2) a
 * scope check that the comment's `global_game_id` actually matches the `:id`
 * path param (404 on mismatch) — previously any authenticated author could
 * delete their own comment by id regardless of which game's URL they hit,
 * i.e. `:id` was accepted but never verified against the comment row.
 */
router.delete('/global/games/:id/comments/:commentId', requireDiscordUser, requireNotBanned, async (req, res) => {
    try {
        const globalGameId = req.params.id as string;
        const commentId = parseInt(req.params.commentId as string, 10);
        const comment = await GlobalCommentService.getCommentById(commentId);
        if (!comment) return res.status(404).json({ error: 'Comment not found' });
        if (comment.global_game_id !== globalGameId) return res.status(404).json({ error: 'Comment not found' });
        const isSuper = req.user!.role === 'super_admin';
        if (!isSuper && comment.discord_user_id !== req.user!.discordId) {
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
