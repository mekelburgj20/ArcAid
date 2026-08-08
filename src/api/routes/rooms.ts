import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { getDatabase } from '../../database/database.js';
import { logInfo, logError, logWarn } from '../../utils/logger.js';
import { requireAuth, requireRoomAccess, requireDiscordUser, optionalDiscordUser, optionalUser, roomVisibilityGate, requireNotBanned } from '../middleware.js';
import { validate } from '../validate.js';
import { isProviderUserId } from '../../utils/identityProvider.js';
import {
    CreateTournamentSchema, UpdateTournamentSchema, ToggleTournamentActiveSchema,
    SettingsSchema,
    HistoryQuerySchema, MergePlayerSchema,
    CreateRankingGroupSchema, UpdateRankingGroupSchema,
    CreateLocalAdminSchema,
    AssignStyleSchema,
    AssignImageSchema,
    StyleUploadSchema,
    CommunityScoreSchema,
    ScoreSubmissionSchema,
    FreeplayScoreSchema,
    GameProposalSchema,
    ImportCsvPreviewSchema,
    ImportCsvCommitSchema,
    ScoreImportRowSchema,
    ScoreImportPreviewSchema,
    ScoreImportCommitSchema,
    GameCommentSchema,
    PickGameSchema,
    ReorderQueueSchema,
    UpdateGameStateSchema,
    DeleteGameStateSchema,
    SyncIScoredActionSchema,
    RoomScoresQuerySchema,
    CreateBanSchema,
} from '../schemas.js';
import { writeLimiter, pickLimiter, pickAlertsLimiter, guestContentLimiter } from '../rateLimit.js';
import { isAllowedImage } from '../uploadValidation.js';
import { TournamentEngine } from '../../engine/TournamentEngine.js';
// IScoredClient is constructed inside IScoredSessionRegistry; routes acquire
// sessions via the registry, never directly.
import {
    passesplatformRules, parsePlatformsList, parseTournamentRules,
    hasAnyPlatformRules, legacyPlatformsForEngine, deviceMatchTokens,
    emptyTournamentRules, type TournamentRules,
} from '../../utils/platformRules.js';
import { deleteScorePhotoFiles } from '../../utils/scorePhotoCleanup.js';
import { catalogueTypeMatchesTournamentMode } from '../../utils/tournamentMode.js';
import { normalizeSubmitterUserId } from '../../services/SubmissionContextService.js';
import { TournamentService } from '../../services/TournamentService.js';
import { GameLibraryService } from '../../services/GameLibraryService.js';
import { RoomGameTagsService } from '../../services/RoomGameTagsService.js';
import { raSearchHandler, raImportHandler } from '../raCatalogueHandlers.js';
import { GameRoomSettingsService } from '../../services/GameRoomSettingsService.js';
import { GameRoomService } from '../../services/GameRoomService.js';
import { AdminService } from '../../services/AdminService.js';
import { getDashboardData } from '../../services/DashboardService.js';
import { RatingService } from '../../services/RatingService.js';
import { RoomScoresService } from '../../services/RoomScoresService.js';
import { TournamentScoresService } from '../../services/TournamentScoresService.js';
import { ScoreProvenanceService } from '../../services/ScoreProvenanceService.js';
import { AuditService } from '../../services/AuditService.js';

const router = Router({ mergeParams: true });

const roomAssetUpload = multer({
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

/**
 * v2.54.0 username lock — shared by the three web submit handlers
 * (`/submit-score`, `/freeplay-score`, `/community-scores`).
 *
 * v2.79.0 (login mandate): all three handlers now sit behind `requireDiscordUser`,
 * so `req.user.discordId` is always present (covers Google logins too, via the
 * namespaced `google:*` ids) — the guest/free-text branch this helper used to
 * have is gone. The client-supplied name is DISCARDED and
 * `UserProfileService.resolveSubmitName` returns the caller's canonical room
 * name (`room_members.display_name` → `user_profiles.display_name` → JWT
 * `username` claim → id). Renames go through Account Settings, not the score
 * modal.
 *
 * Still returns a discriminated union (rather than a bare `string`) to match
 * `ensureProvenanceAllowed`'s shape and keep callers' `if (!x.ok) return ...`
 * pattern uniform.
 */
async function resolveSubmitUsername(
    req: { user?: { discordId?: string; username?: string } },
    roomId: string,
): Promise<{ ok: true; username: string } | { ok: false; error: string }> {
    const discordUserId = req.user!.discordId!;
    const { UserProfileService } = await import('../../services/UserProfileService.js');
    return {
        ok: true,
        username: await UserProfileService.resolveSubmitName({
            discordUserId,
            roomId,
            jwtUsername: req.user?.username ?? null,
        }),
    };
}

/**
 * v2.53.0 (ADR 0016): server-side re-validation of a submission's `engine` +
 * `device` pair, and derivation of the legacy `platform` value the read paths
 * still consume.
 *
 * Replaces `ensurePlatformAllowed`, which returned `null` for "allowed" — a
 * shape in which a partially-validated result is indistinguishable from
 * success. `ScoreProvenanceService.validate` returns a discriminated union
 * instead, so an unvalidated axis cannot fall through: callers can only reach
 * the resolved values through `ok: true`, and every early return is an
 * explicit `ok: false` with a user-facing message.
 */
async function ensureProvenanceAllowed(opts: {
    roomId: string;
    gameName: string;
    engine: string;
    device: string;
}) {
    return ScoreProvenanceService.validateForRoomGame(
        opts.roomId, opts.gameName, opts.engine, opts.device,
    );
}

// --- Public endpoints (no auth) ---

// Portal info
//
// NOTE (v2.39.0 recon): this room-scoped portal has no FE consumers — every
// public page resolves slug->room via the SEPARATE slug-keyed `GET /api/portal`
// in global.ts (see admin-ui/src/lib/portal.ts), which is where join_policy +
// viewer_status actually need to live for the FE join-gate to work (done
// there too). Updated here as well for parity/back-compat in case anything
// starts calling this room-scoped form.
router.get('/:roomId/portal', async (req, res) => {
    try {
        const db = await getDatabase();
        const room = await GameRoomService.getById(req.params.roomId as string);
        if (!room) return res.status(404).json({ error: 'Room not found' });

        // S22 Phase 2 (v2.44.0) — parity with the slug-keyed GET /api/portal
        // in global.ts. This room-scoped variant has no FE consumers today
        // (see the note above), but kept consistent in case that changes.
        if (room.suspended_at) {
            return res.json({ suspended: true, name: room.name, slug: room.slug });
        }

        const uiTheme = await GameRoomSettingsService.get(room.id, 'UI_THEME');
        const adminTheme = await GameRoomSettingsService.get(room.id, 'ADMIN_THEME');
        const { RoomAccessService } = await import('../../services/RoomAccessService.js');
        const joinPolicy = await RoomAccessService.getJoinPolicy(room.id);
        const authHeader = req.headers['authorization'];
        const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
        const { verifyToken } = await import('../auth.js');
        const payload = bearer ? verifyToken(bearer) : null;
        const viewerStatus = await RoomAccessService.getViewerStatus(payload, room.id);
        res.json({
            slug: room.slug,
            name: room.name,
            description: room.description || '',
            logo_url: room.logo_url || null,
            ui_theme: uiTheme || 'dark',
            admin_theme: adminTheme || 'dark',
            join_policy: joinPolicy,
            viewer_status: viewerStatus,
        });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/portal):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Scoreboard config (public — returns SCOREBOARD_*, LOGO_*, KIOSK_*, and GLOBAL_CARD_* settings)
// v2.39.0 — deliberately NOT adding JOIN_POLICY here: the portal endpoints
// (this file + global.ts) are the single source of truth for join_policy so
// FE branching doesn't have two places to check.
router.get('/:roomId/scoreboard-config', async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        // m1 fix (S22 Phase 2 adversarial review) — this route registers
        // BEFORE roomVisibilityGate (same structural bypass as portal above),
        // so a suspended room's scoreboard-config was reachable by anyone.
        // Approval-room behavior is intentionally untouched — only suspension
        // gates here.
        const { RoomAccessService } = await import('../../services/RoomAccessService.js');
        if (await RoomAccessService.isSuspended(roomId)) {
            return res.status(403).json({ error: 'This room has been suspended pending review.', code: 'ROOM_SUSPENDED' });
        }
        const allSettings = await GameRoomSettingsService.getAll(roomId);
        const config: Record<string, string> = {};
        // DISCORD_ENABLED is an explicit inclusion (not prefix-matched like the
        // rest of this list) — FE call sites read `config.DISCORD_ENABLED` from
        // THIS endpoint's response for Discord-integration-aware UI.
        const EXPLICIT_KEYS = ['DISCORD_ENABLED'];
        for (const [key, value] of Object.entries(allSettings)) {
            if (key.startsWith('SCOREBOARD_') || key.startsWith('LOGO_') || key.startsWith('KIOSK_') || key.startsWith('GLOBAL_CARD_') || EXPLICIT_KEYS.includes(key)) {
                config[key] = value;
            }
        }
        res.json(config);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/scoreboard-config):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// v2.39.0 — the ONE gate seam. Everything registered below this line for a
// given :roomId is subject to the approval-room view gate; portal +
// scoreboard-config above stay reachable for everyone by virtue of being
// registered first (Express never falls through to this middleware for a
// request either of those handlers already answered).
router.use('/:roomId', roomVisibilityGate);

// Members / Players (v2.42.0) — registered AFTER roomVisibilityGate so this
// is automatically public for 'open' rooms and members/admins/super-only for
// 'approval' rooms, same as every other route below the gate. requireAuth is
// deliberately NOT added — the gate IS the access control (mirrors how
// leaderboard/stats public reads are unauthenticated).
router.get('/:roomId/members', async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const { RoomRosterService } = await import('../../services/RoomRosterService.js');
        // Response is a bare array (contract D1) — the FE independently reads
        // join_policy off `getPortal(slug)` (already fetched/cached by
        // PublicLayout, zero extra network cost) to decide labels/columns,
        // so this endpoint doesn't need to duplicate that field.
        const { members } = await RoomRosterService.getRoster(roomId);
        res.json(members);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/members):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Game info by ID (public — used by QR code score submission page)
router.get('/:roomId/games/:gameId/info', async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const gameId = req.params.gameId as string;
        const db = await getDatabase();
        const game = await db.get(`
            SELECT g.id, g.name, g.status
            FROM games g
            JOIN tournaments t ON g.tournament_id = t.id
            WHERE g.id = ? AND t.game_room_id = ?
        `, gameId, roomId);
        if (!game) return res.status(404).json({ error: 'Game not found' });
        const requirePhoto = await GameRoomSettingsService.get(roomId, 'REQUIRE_SCORE_PHOTO');
        res.json({ id: game.id, name: game.name, status: game.status, requirePhoto: requirePhoto === 'true' });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/games/:gameId/info):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Leaderboard
router.get('/:roomId/leaderboard', async (req, res) => {
    try {
        const { LeaderboardService } = await import('../../services/LeaderboardService.js');
        const leaderboards = await LeaderboardService.getActiveLeaderboards(req.params.roomId as string);

        // Identify the viewer from a player token, then resolve their FULL
        // identity — discord_user_id + ALL mapped iScored aliases — so the
        // viewerEntry matches the same partition the leaderboard collapses by
        // (COALESCE(submitted_by_user_id, 'iscored:'||LOWER(iscored_username))).
        // S4 fix: pre-S4 this matched one arbitrary alias, so multi-alias users
        // (and users whose row collapsed under their discord_user_id) saw no rank.
        let viewerDiscordId: string | null = null;
        const viewerAliases = new Set<string>();
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
            try {
                const { verifyToken } = await import('../auth.js');
                const payload = verifyToken(authHeader.slice(7));
                if (payload?.discordId) {
                    viewerDiscordId = payload.discordId as string;
                    const db = await getDatabase();
                    const aliasRows = await db.all(
                        'SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?',
                        payload.discordId
                    ) as Array<{ iscored_username: string }>;
                    for (const a of aliasRows) viewerAliases.add(a.iscored_username.toLowerCase());
                    if (payload.username) viewerAliases.add((payload.username as string).toLowerCase());
                }
            } catch {
                // Invalid token — ignore, viewer is anonymous
            }
        }

        if (viewerDiscordId) {
            const annotated = leaderboards.map((lb: any) => {
                const viewerEntry = lb.rankings.find((r: any) =>
                    r.discord_user_id === viewerDiscordId
                    || viewerAliases.has((r.iscored_username || '').toLowerCase())
                ) || null;
                return { ...lb, viewerEntry };
            });
            return res.json(annotated);
        }

        res.json(leaderboards);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/leaderboard):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * Returns the canonical-id list of platforms available to tournament rules
 * in this room: catalogue platforms ∪ room-specific tags. Powers the
 * tournament platform-rules picker (Must / Must Not be available on).
 */
router.get('/:roomId/platforms/available', async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const db = await getDatabase();
        const rows = await db.all(`
            SELECT DISTINCT j.value AS platform
            FROM global_games gg, json_each(gg.platforms) j
            WHERE gg.status = 'approved' AND j.value != ''
            ORDER BY platform
        `) as Array<{ platform: string }>;
        // `normalizeCataloguePlatformId`, NOT the old taxonomy's
        // `normalizePlatform`: an engine id in the catalogue (or in a room tag)
        // must survive this fold intact — `fx` would otherwise be re-legacied
        // to `pinball_fx` on its way into the tournament rules picker. Legacy
        // ids normalize exactly as before.
        const { normalizeCataloguePlatformId } = await import('../../utils/platformRules.js');
        const seen = new Set<string>();
        const out: string[] = [];
        for (const r of rows) {
            const id = normalizeCataloguePlatformId(r.platform);
            if (!id || seen.has(id)) continue;
            seen.add(id);
            out.push(id);
        }
        // Union with room-specific custom tags.
        const tags = await RoomGameTagsService.getDistinctTagsForRoom(roomId);
        for (const tag of tags) {
            const id = normalizeCataloguePlatformId(tag);
            if (!id || seen.has(id)) continue;
            seen.add(id);
            out.push(id);
        }
        res.json({ platforms: out.sort() });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/platforms/available):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/:roomId/leaderboard/:gameId', async (req, res) => {
    try {
        const { LeaderboardService } = await import('../../services/LeaderboardService.js');
        const gameId = req.params.gameId as string;
        const qs = (key: string): string | null => {
            const v = req.query[key];
            return typeof v === 'string' && v.trim() ? v.trim() : null;
        };
        // v2.58.0 (ADR 0016): `?engine=` / `?device=` are authoritative.
        const engineFilter = qs('engine');
        const deviceFilter = qs('device');
        // v2.5.0 `?platform=` survives as a deprecated alias — bookmarks, OG
        // links and older Discord messages carry it. It resolves through
        // LEGACY_PLATFORM_MAP to the same two axes, so it can no longer disagree
        // with what the tab strip offers. Ignored when either new param is given.
        const platformFilter = (engineFilter || deviceFilter) ? null : qs('platform');

        const rankings = (engineFilter || deviceFilter)
            ? await LeaderboardService.getForGameByProvenance(gameId, { engine: engineFilter, device: deviceFilter })
            : platformFilter
                ? await LeaderboardService.getForGameByPlatform(gameId, platformFilter)
                : await LeaderboardService.getForGame(gameId);

        // Distinct provenance always returned so the FE can render its tab strip
        // regardless of which view the user is currently looking at.
        const { engines: distinctEngines, devices: distinctDevices } =
            await LeaderboardService.getDistinctProvenance(gameId);
        const distinctPlatforms = await LeaderboardService.getDistinctPlatforms(gameId);

        const db = await getDatabase();
        const game = await db.get(`
            SELECT g.name as game_name, t.name as tournament_name,
                   COALESCE(gg.local_image_path, gg.wheel_image_path, gg.image_url) AS image_url
            FROM games g
            LEFT JOIN tournaments t ON g.tournament_id = t.id
            LEFT JOIN global_games gg ON LOWER(gg.name) = LOWER(g.name) AND gg.status = 'approved'
            WHERE g.id = ?
        `, gameId);

        res.json({
            gameId,
            gameName: game?.game_name || 'Unknown',
            tournamentName: game?.tournament_name || 'Untracked',
            imageUrl: game?.image_url || null,
            rankings,
            /**
             * v2.58.0 (ADR 0016): `engine` + `device` (and `distinctEngines` /
             * `distinctDevices`) are the AUTHORITATIVE provenance fields.
             * `platform` / `distinctPlatforms` are deprecated aliases derived
             * from them — they exist so bookmarked `?platform=` links and any
             * unmigrated client keep working, and are removed once tournament
             * rules stop reading the legacy column.
             */
            provenanceAuthority: 'engine_device',
            engine: engineFilter,
            device: deviceFilter,
            distinctEngines,
            distinctDevices,
            platform: platformFilter,
            distinctPlatforms,
        });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/leaderboard/:gameId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/:roomId/leaderboard/:gameId/submissions', async (req, res) => {
    try {
        const gameId = req.params.gameId as string;
        const db = await getDatabase();
        const submissions = await db.all(`
            SELECT id, iscored_username, score, timestamp, photo_url
            FROM submissions
            WHERE game_id = ?
              AND orphaned_at IS NULL
            ORDER BY LOWER(iscored_username), score DESC
        `, gameId);
        res.json(submissions);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/leaderboard/:gameId/submissions):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Rankings
router.get('/:roomId/rankings', async (req, res) => {
    try {
        const { RankingService } = await import('../../services/RankingService.js');
        const data = await RankingService.getActiveWithRankings(req.params.roomId as string);
        res.json(data);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/rankings):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/:roomId/ranking-groups', async (req, res) => {
    try {
        const { RankingService } = await import('../../services/RankingService.js');
        const groups = await RankingService.getAll(req.params.roomId as string);
        res.json(groups);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/ranking-groups):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/:roomId/ranking-groups/:id', async (req, res) => {
    try {
        const { RankingService } = await import('../../services/RankingService.js');
        const group = await RankingService.getById(req.params.id as string);
        if (!group) return res.status(404).json({ error: 'Ranking group not found' });
        res.json(group);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/ranking-groups/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/:roomId/ranking-groups/:id/rankings', async (req, res) => {
    try {
        const { RankingService } = await import('../../services/RankingService.js');
        const group = await RankingService.getById(req.params.id as string);
        if (!group) return res.status(404).json({ error: 'Ranking group not found' });
        const rankings = await RankingService.getRankings(req.params.id as string);
        res.json({ group, rankings });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/ranking-groups/:id/rankings):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Game availability — public, shows cooldown status per tournament
router.get('/:roomId/game-availability/:tournamentId', async (req, res) => {
    try {
        const db = await getDatabase();
        const roomId = req.params.roomId as string;
        const tournamentId = req.params.tournamentId as string;

        // Verify tournament belongs to this room
        const tournament = await db.get(
            'SELECT id, name, type, mode, platform_rules, eligibility_days FROM tournaments WHERE id = ? AND game_room_id = ?',
            tournamentId, roomId
        );
        if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

        // Get eligibility window from tournament
        const eligibilityDays = tournament.eligibility_days ?? 120;

        const lookbackDate = new Date();
        lookbackDate.setDate(lookbackDate.getDate() - eligibilityDays);
        const lookbackString = lookbackDate.toISOString();

        // Get all approved catalogue games filtered by tournament platform rules.
        //
        // v2.84.0 — the SQL is a PRE-filter; `passesplatformRules` below is the
        // authority. Parity with POST /pick-game and the Discord `/pick-game`
        // autocomplete, both of which gate on catalogue platforms ∪ the room's
        // game tags: a tag lives in `room_game_tags`, outside `global_games`, so
        // a game qualifying ONLY through a tag cannot be expressed in the
        // catalogue WHERE clause. Before this, such a game was missing from the
        // web Picks list even though picking it succeeded.
        //
        // The `required` clauses therefore go into `requiredFilter` (widened by
        // the room's tagged game names below, so SQL can only ever return a
        // SUPERSET of the JS answer), while `excludedFilter` stays applied
        // unconditionally — `excluded` is a submission-level filter that
        // `passesplatformRules` deliberately ignores (ADR 0009), and this
        // endpoint's long-standing quirk of hiding excluded-platform games is
        // preserved exactly.
        let rules: TournamentRules = emptyTournamentRules();
        let requiredFilter = '';
        let excludedFilter = '';
        const requiredParams: string[] = [];
        const excludedParams: string[] = [];
        try {
            rules = parseTournamentRules(tournament);
            // v2.58.0 (ADR 0016) — exact JSON membership instead of `LIKE '%p%'`.
            //
            // `gg.platforms` is a JSON array, and raw substring matching read it
            // as one opaque string: `'%vpx%'` also matched `vpxs`/`vpxs_manual`,
            // and — the damaging one — `'%pinball_fx%'` swept in
            // `pinball_fx_classic`, `pinball_fx_midnight` and
            // `pinball_fx_classic_vr`, so an "FX only" tournament silently
            // offered FX Classic titles. `NOT LIKE` had the mirror-image defect,
            // over-excluding.
            //
            // `json_each` compares elements exactly. Each rule token is expanded
            // to the legacy id set it denotes first, so the genuine matches the
            // old pattern caught by luck (`vpx` ↔ `vpxs` — the same engine per
            // ADR 0016) are kept deliberately and NO game that qualifies today
            // stops qualifying.
            //
            // v2.60.0 (ADR 0016 P2 §2) — rules are now two axes. Each is
            // expanded through its own legacy-id map and the two `required`
            // clauses are ANDed, matching `passesplatformRules`.
            //
            // ADR 0016 catalogue phase §4 — the DEVICE axis now reads `features`
            // too. Once the fold moves availability out of `platforms`, an
            // AtGames-available VPX table says `platforms:['vpx'],
            // features:['vpxs']`, and a platforms-only clause would admit zero
            // games for the single most common production rule
            // (`required:['atgames']`, hazard H-C). Each device expands to a
            // platform token set AND a feature token set, ORed — so a pre-fold
            // row matches on the first and a folded row on the second, and the
            // gate answers the same either way. This is the SQL twin of
            // `deviceMatchesGame`; the two are pinned to each other by test.
            const membership = (column: string, tokens: string[]) => `EXISTS (
                SELECT 1 FROM json_each(gg.${column}) je
                WHERE LOWER(je.value) IN (${tokens.map(() => '?').join(',')})
            )`;
            /** One rule token → its match clause, plus the params it binds. */
            const clauseFor = (sets: Array<[string, string[]]>, params: string[]): string | null => {
                const parts: string[] = [];
                for (const [column, tokens] of sets) {
                    if (tokens.length === 0) continue;
                    parts.push(membership(column, tokens));
                    params.push(...tokens);
                }
                return parts.length > 0 ? `(${parts.join(' OR ')})` : null;
            };
            const engineSets = (v: string): Array<[string, string[]]> =>
                [['platforms', legacyPlatformsForEngine(v)]];
            const deviceSets = (v: string): Array<[string, string[]]> => {
                const t = deviceMatchTokens(v);
                return [['platforms', t.platforms], ['features', t.features]];
            };
            const addRequired = (values: string[], sets: (v: string) => Array<[string, string[]]>) => {
                if (values.length === 0) return;
                const clauses: string[] = [];
                for (const v of values) {
                    const clause = clauseFor(sets(v), requiredParams);
                    if (clause) clauses.push(clause);
                }
                if (clauses.length > 0) requiredFilter += ` AND (${clauses.join(' OR ')})`;
            };
            const addExcluded = (values: string[], sets: (v: string) => Array<[string, string[]]>) => {
                for (const v of values) {
                    const clause = clauseFor(sets(v), excludedParams);
                    if (clause) excludedFilter += ` AND NOT ${clause}`;
                }
            };
            addRequired(rules.engines.required, engineSets);
            addRequired(rules.devices.required, deviceSets);
            addExcluded(rules.engines.excluded, engineSets);
            addExcluded(rules.devices.excluded, deviceSets);
        } catch { /* no platform filtering */ }

        // This room's per-game tag map (name-keyed, ONE query — the same batched
        // helper the Discord autocomplete and autopick use). Feeds both the
        // eligibility union and the `room_tags` field on every row.
        const tagMap = await RoomGameTagsService.getTagMapByGameNameForRoom(roomId);
        // Stored catalogue paths → public HTTP URLs. The one helper every other
        // image-shipping read path uses (LeaderboardService, RoomScoresService,
        // DashboardService, ogMeta) — never re-derive the mapping locally.
        const { normalizeImageUrl } = await import('../../services/LeaderboardService.js');

        // Widen the candidate set by the room's tagged game names so a game that
        // qualifies only through a tag survives the SQL pre-filter and reaches
        // the JS gate. Skipped when there are no `required` clauses (everything
        // already matches) or the room has no tags.
        let candidateFilter = requiredFilter;
        const candidateParams: string[] = [...requiredParams];
        if (requiredFilter && tagMap.size > 0) {
            const taggedNames = [...tagMap.keys()];
            candidateFilter = ` AND ((1 = 1${requiredFilter}) OR LOWER(gg.name) IN (${taggedNames.map(() => '?').join(',')}))`;
            candidateParams.push(...taggedNames);
        }

        // `MIN(...)` per column mirrors the Discord autocomplete / autopick
        // catalogue read (pickgame.ts, TimeoutManager): the GROUP BY collapses
        // catalogue variants of one name and a single row has to stand for it.
        //
        // `MIN(COALESCE(local_image_path, wheel_image_path, image_url))` applies
        // the catalogue's image precedence per ROW first, so the winning value
        // is one row's art rather than a mix — and, MIN skipping NULLs, a
        // variant that HAS art still supplies it for the whole name group.
        const catalogueRows = await db.all(`
            SELECT MIN(gg.name) AS name,
                   MIN(gg.id) AS global_game_id,
                   MIN(gg.type) AS mode,
                   MIN(gg.manufacturer) AS manufacturer,
                   MIN(gg.year) AS year,
                   MIN(gg.platforms) AS platforms,
                   MIN(gg.features) AS features,
                   MIN(COALESCE(gg.local_image_path, gg.wheel_image_path, gg.image_url)) AS image_url
            FROM global_games gg
            WHERE gg.status = 'approved'${candidateFilter}${excludedFilter}
            GROUP BY LOWER(gg.name)
            ORDER BY name
        `, ...candidateParams, ...excludedParams);

        // The authoritative gate — identical to pickgame.ts's autocomplete
        // filter: tournament mode, then platform rules over catalogue ∪ room
        // tags with `features` carrying the device axis (ADR 0016 §4).
        const libraryGames = catalogueRows.filter((r: any) => {
            if (!catalogueTypeMatchesTournamentMode(r.mode, tournament.mode)) return false;
            const cataloguePlatforms = parsePlatformsList(r.platforms || '[]');
            const tags = tagMap.get(String(r.name).toLowerCase()) ?? [];
            return passesplatformRules(
                [...cataloguePlatforms, ...tags], rules, parsePlatformsList(r.features || '[]'),
            );
        });

        // Get recently played games in this tournament within the lookback window
        const recentGames = await db.all(`
            SELECT g.name, g.start_date, g.end_date, g.status,
                   (SELECT s.iscored_username FROM submissions s WHERE s.game_id = g.id AND s.orphaned_at IS NULL ORDER BY s.score DESC LIMIT 1) as winner_name,
                   (SELECT s.score FROM submissions s WHERE s.game_id = g.id AND s.orphaned_at IS NULL ORDER BY s.score DESC LIMIT 1) as winner_score
            FROM games g
            WHERE g.tournament_id = ?
              AND g.start_date >= ?
              AND g.status != 'QUEUED'
            ORDER BY g.start_date DESC
        `, tournamentId, lookbackString);

        // Get all-time high scores per game name (across all tournaments in this room)
        const allTimeHighs = await db.all(`
            SELECT LOWER(g.name) as game_key, s.score as high_score, s.iscored_username as high_score_player
            FROM submissions s
            JOIN games g ON g.id = s.game_id
            WHERE g.tournament_id IN (SELECT id FROM tournaments WHERE game_room_id = ?)
              AND s.orphaned_at IS NULL
              AND s.score = (
                SELECT MAX(s2.score) FROM submissions s2
                JOIN games g2 ON g2.id = s2.game_id
                WHERE LOWER(g2.name) = LOWER(g.name)
                  AND s2.orphaned_at IS NULL
                  AND g2.tournament_id IN (SELECT id FROM tournaments WHERE game_room_id = ?)
              )
            GROUP BY LOWER(g.name)
        `, roomId, roomId);

        const highScoreMap = new Map<string, { score: number; player: string }>();
        for (const row of allTimeHighs) {
            highScoreMap.set(row.game_key, { score: row.high_score, player: row.high_score_player });
        }

        // Build a map of game name → most recent play info (case-insensitive, also match variants)
        const recentMap = new Map<string, { playedDate: string; endDate: string | null; status: string; winnerName: string | null; winnerScore: number | null }>();
        for (const g of recentGames) {
            // Use base name (strip variant suffix for matching)
            const baseName = g.name.split(' ').length > 1
                ? g.name // keep full name for map
                : g.name;
            const key = baseName.toLowerCase();
            if (!recentMap.has(key)) {
                recentMap.set(key, {
                    playedDate: g.start_date,
                    endDate: g.end_date,
                    status: g.status,
                    winnerName: g.winner_name,
                    winnerScore: g.winner_score,
                });
            }
        }

        // Build availability list
        const now = new Date();
        const availability = libraryGames.map((lg: any) => {
            const key = lg.name.toLowerCase();
            // Check exact match and variant match (name + ' ...')
            const recent = recentMap.get(key) ||
                [...recentMap.entries()].find(([k]) => k.startsWith(key + ' ') || key.startsWith(k + ' '))?.[1];

            const highScore = highScoreMap.get(key) ||
                [...highScoreMap.entries()].find(([k]) => k.startsWith(key + ' ') || key.startsWith(k + ' '))?.[1];

            // Catalogue metadata + this room's tags, so the Picks page can
            // render tag chips, filter/search entirely client-side, and open a
            // GameQuickView (which needs the catalogue id and its art). Purely
            // additive — every pre-existing field keeps its name and meaning.
            const meta = {
                global_game_id: lg.global_game_id,
                image_url: normalizeImageUrl(lg.image_url),
                manufacturer: lg.manufacturer ?? null,
                year: lg.year ?? null,
                platforms: parsePlatformsList(lg.platforms || '[]'),
                features: parsePlatformsList(lg.features || '[]'),
                room_tags: tagMap.get(key) ?? [],
            };

            if (recent) {
                const playedDate = new Date(recent.playedDate);
                const availableDate = new Date(playedDate);
                availableDate.setDate(availableDate.getDate() + eligibilityDays);
                const daysUntilAvailable = Math.max(0, Math.ceil((availableDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));

                return {
                    name: lg.name,
                    available: daysUntilAvailable <= 0,
                    daysUntilAvailable,
                    lastPlayedDate: recent.playedDate,
                    lastEndDate: recent.endDate,
                    lastStatus: recent.status,
                    winnerName: recent.winnerName,
                    winnerScore: recent.winnerScore,
                    allTimeHigh: highScore?.score ?? null,
                    allTimeHighPlayer: highScore?.player ?? null,
                    ...meta,
                };
            }

            return {
                name: lg.name,
                available: true,
                daysUntilAvailable: 0,
                lastPlayedDate: null,
                lastEndDate: null,
                lastStatus: null,
                winnerName: null,
                winnerScore: null,
                allTimeHigh: highScore?.score ?? null,
                allTimeHighPlayer: highScore?.player ?? null,
                ...meta,
            };
        });

        res.json({
            tournament: { id: tournament.id, name: tournament.name, type: tournament.type, mode: tournament.mode },
            eligibilityDays,
            games: availability,
        });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/game-availability/:tournamentId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Pick status — returns pending picks and queued games for the logged-in Discord user
router.get('/:roomId/pick-status', requireDiscordUser, async (req, res) => {
    try {
        const db = await getDatabase();
        const roomId = req.params.roomId as string;
        const discordId = req.user!.discordId!;

        // Unfulfilled win picks (placeholder name). LEFT JOIN to the won game
        // so the FE can render which slot each pending pick is for — one user
        // can hold multiple pending picks per tournament when winning multiple
        // slots in a single maintenance run (e.g. WG-VPXS max=2).
        //
        // v2.77.0 — the tournament filters mirror PickAlertService exactly
        // (`is_active = 1` + the winner_picks gate, NULL = enabled per
        // PickAwardGate's legacy default). Pre-fix this query had neither, so a
        // placeholder left behind by an archived or gate-off tournament
        // rendered an "Awaiting your pick" banner with no badge and no way to
        // act on it — the modal can only target tournaments that still rotate.
        // Badge and page must agree by construction.
        const pendingPicks = await db.all(`
            SELECT g.id as pick_slot_id, g.tournament_id, t.name as tournament_name,
                   g.picker_type, g.picker_designated_at,
                   g.won_game_id, COALESCE(won.display_name, won.name) as won_game_name
            FROM games g
            JOIN tournaments t ON g.tournament_id = t.id
            LEFT JOIN games won ON won.id = g.won_game_id
            WHERE t.game_room_id = ? AND g.status = 'QUEUED'
              AND g.name = '[Pending Pick]' AND g.picker_discord_id = ?
              AND t.is_active = 1
              AND (t.winner_picks IS NULL OR t.winner_picks != 0)
            ORDER BY g.picker_designated_at ASC, g.rowid ASC
        `, roomId, discordId);

        // Named queued games picked by this user
        const queuedGames = await db.all(`
            SELECT g.id, g.name as game_name, g.tournament_id, t.name as tournament_name, g.queue_order
            FROM games g
            JOIN tournaments t ON g.tournament_id = t.id
            WHERE t.game_room_id = ? AND g.status = 'QUEUED'
              AND g.name != '[Pending Pick]' AND g.picker_discord_id = ?
            ORDER BY g.queue_order ASC, g.rowid ASC
        `, roomId, discordId);

        // Also get tournaments for this room so the UI knows what's available
        const tournaments = await db.all(
            'SELECT id, name, type, mode, max_active_games, platform_rules FROM tournaments WHERE game_room_id = ? AND is_active = 1 ORDER BY display_order',
            roomId
        );

        // Pick-award gate state (plan §5) — room-scoped, controls UI enablement.
        // v2.56.0: resolves as "any tournament in this room has winner-picks on".
        const { PickAwardGate } = await import('../../services/PickAwardGate.js');
        const pickAwardEnabled = await PickAwardGate.isEnabled(roomId);

        res.json({ pendingPicks, queuedGames, tournaments, pickAwardEnabled });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/pick-status):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * Picks nav-badge probe — "does this player need to do something about picks?"
 *
 * Deliberately a sibling of /pick-status rather than more keys on it. The nav
 * calls this on EVERY room-page navigation for every signed-in viewer, while
 * /pick-status is a page payload (full pending/queued/tournament lists) fetched
 * once when the Picks page mounts. Keeping them apart means the nav ships only
 * counts, gets its own tighter rate limit, and can't be made expensive by
 * growth in the Picks page's payload.
 */
// Limiter sits AFTER requireDiscordUser so it can key on req.user.discordId
// (same requirement as globalSubmitLimiter). Unauthenticated floods are
// short-circuited by the 401 ahead of it and still covered by generalLimiter.
router.get('/:roomId/pick-alerts', requireDiscordUser, pickAlertsLimiter, async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const discordId = req.user!.discordId!;
        const { PickAlertService } = await import('../../services/PickAlertService.js');
        const alerts = await PickAlertService.getAlerts(roomId, discordId);
        res.json(alerts);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/pick-alerts):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Pick/queue a game — requires Discord login
router.post('/:roomId/pick-game', pickLimiter, requireDiscordUser, requireNotBanned, async (req, res) => {
    try {
        const validationResult = validate(PickGameSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const db = await getDatabase();
        const roomId = req.params.roomId as string;
        const discordId = req.user!.discordId!;
        const { tournamentId, gameName } = validationResult.data;

        // 1. Verify tournament belongs to this room and is active
        const tournament = await db.get(
            'SELECT id, name, type, mode, max_active_games, platform_rules, game_room_id, eligibility_days FROM tournaments WHERE id = ? AND game_room_id = ? AND is_active = 1',
            tournamentId, roomId
        );
        if (!tournament) return res.status(404).json({ error: 'Tournament not found or inactive' });

        // 1a. Pick-award gate (plan §5 / §8). Mirrors the Discord-command gate so the web
        //     pick path can't re-enable a flow that admins have opted out of.
        //     v2.56.0 — per-tournament only (tournaments.winner_picks); the
        //     room-level ENABLE_GAME_PICK_AWARD switch is gone.
        const { PickAwardGate } = await import('../../services/PickAwardGate.js');
        const pickEnabled = await PickAwardGate.isEnabled(tournament.game_room_id, tournament.id);
        if (!pickEnabled) return res.status(403).json({ error: 'Winner picks is turned off for this tournament' });

        // 2. Look up game in catalogue.
        const gameLibEntry = await db.get(
            `SELECT name, type AS mode, platforms, features FROM global_games
             WHERE LOWER(name) = LOWER(?) AND status = 'approved' LIMIT 1`,
            gameName,
        );
        if (!gameLibEntry) return res.status(404).json({ error: `Game "${gameName}" not found in the catalogue` });

        // 3. Check mode match. `catalogueTypeMatchesTournamentMode` bridges the
        //    tournament-mode vocabulary ('videogame') against the catalogue-type
        //    vocabulary ('video_game' | 'arcade') — see src/utils/tournamentMode.ts.
        if (!catalogueTypeMatchesTournamentMode(gameLibEntry.mode, tournament.mode)) {
            return res.status(400).json({ error: `Game mode "${gameLibEntry.mode}" does not match tournament mode "${tournament.mode}"` });
        }

        // 4. Check platform rules. Game's effective platforms = catalogue ∪ room tags.
        //    Parsed ONCE — the gate and its rejection message must come from the
        //    same read of the blob, or the two drift apart.
        const platformRules = parseTournamentRules(tournament);

        const cataloguePlatforms = parsePlatformsList(gameLibEntry.platforms || '[]');
        const roomTags = await RoomGameTagsService.getTagsForGameName(roomId, gameName);
        const gamePlatforms = Array.from(new Set([...cataloguePlatforms, ...roomTags]));
        // Features carry the device-axis availability the fold moved out of
        // `platforms` (ADR 0016 catalogue phase §4). Room tags are platforms
        // only — they have never expressed availability.
        const gameFeatures = parsePlatformsList(gameLibEntry.features || '[]');

        if (!passesplatformRules(gamePlatforms, platformRules, gameFeatures)) {
            const restrictedText = platformRules.restrictedText;
            return res.status(400).json({
                error: restrictedText || 'This game is not available for this tournament type (platform restriction)',
            });
        }

        // 5. Check cooldown (eligibility)
        const engine = TournamentEngine.getInstance();
        const isEligible = await engine.isGameEligible(tournamentId, gameLibEntry.name);
        if (!isEligible) {
            // Calculate remaining cooldown days for the error message
            const eligibilityDays = tournament.eligibility_days ?? 120;

            const lastPlayed = await db.get(
                `SELECT start_date FROM games WHERE tournament_id = ? AND name = ? COLLATE NOCASE AND status != 'QUEUED' ORDER BY start_date DESC LIMIT 1`,
                tournamentId, gameLibEntry.name
            );
            let daysRemaining = eligibilityDays;
            if (lastPlayed?.start_date) {
                const playedDate = new Date(lastPlayed.start_date);
                const availableDate = new Date(playedDate);
                availableDate.setDate(availableDate.getDate() + eligibilityDays);
                daysRemaining = Math.max(1, Math.ceil((availableDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
            }

            return res.status(400).json({
                error: `"${gameLibEntry.name}" is in cooldown for ${daysRemaining} more day${daysRemaining === 1 ? '' : 's'}`,
            });
        }

        // 6. Check queue limit (max 5 per user per tournament)
        const queueCount = await db.get(
            `SELECT COUNT(*) as count FROM games
             WHERE tournament_id = ? AND status = 'QUEUED'
               AND picker_discord_id = ? AND name != '[Pending Pick]'`,
            tournamentId, discordId
        );
        if ((queueCount?.count ?? 0) >= 5) {
            return res.status(400).json({ error: 'Queue limit reached (max 5 games per tournament)' });
        }

        // 6a. Sprint 6.5: a successful pick action establishes room membership.
        const { RoomMembershipService } = await import('../../services/RoomMembershipService.js');
        await RoomMembershipService.addMember(discordId, roomId, 'submission');

        // 7. Check for pending pick slot (user won and has picking rights)
        const pendingPick = await db.get(
            `SELECT id FROM games WHERE tournament_id = ? AND status = 'QUEUED' AND name = '[Pending Pick]' AND picker_discord_id = ?`,
            tournamentId, discordId
        );

        const styleId = gameLibEntry.style_id || undefined;
        const maxSlots = tournament.max_active_games ?? 1;
        const activeGames = await engine.getActiveGames(tournamentId);
        const hasOpenSlot = activeGames.length < maxSlots;

        if (pendingPick) {
            // User has a win pick — fulfil it
            if (hasOpenSlot) {
                // Activate immediately — create on iScored if enabled
                const { GameRoomSettingsService: GRS } = await import('../../services/GameRoomSettingsService.js');
                const iscoredEnabled = (await GRS.get(roomId, 'ISCORED_ENABLED')) !== 'false';
                const hasCredentials = iscoredEnabled && !!(process.env.ISCORED_USERNAME && process.env.ISCORED_PASSWORD);

                let iscoredId: string | undefined;
                if (hasCredentials) {
                    const { getIScoredCredsForRoom } = await import('../../utils/iscoredCreds.js');
                    const credsForPick = await getIScoredCredsForRoom(roomId);
                    if (credsForPick) {
                        const { IScoredSessionRegistry } = await import('../../engine/IScoredSessionRegistry.js');
                        iscoredId = await IScoredSessionRegistry.getInstance().withSession(credsForPick, async (client) => {
                            const id = await client.createGame(gameLibEntry.name, styleId);
                            await client.setGameTags(id, tournament.type);
                            await client.setGameStatus(id, { locked: false, hidden: false });
                            return id;
                        });
                    }
                }

                // Delete the pending pick placeholder and activate the real game
                await db.run('DELETE FROM games WHERE id = ?', pendingPick.id);
                await engine.activateGame(tournamentId, gameLibEntry.name, styleId, iscoredId, false);

                // Reorder iScored lineup in background, scoped to this room.
                if (hasCredentials) {
                    engine.reorderIScoredLineup(roomId).catch(() => {});
                }

                logInfo(`Web pick (activated): ${req.user!.username} picked ${gameLibEntry.name} for ${tournament.name}`);
                return res.json({ status: 'activated', gameName: gameLibEntry.name, tournamentName: tournament.name });
            } else {
                // All slots full — update placeholder to real game name (will activate at next maintenance)
                await db.run(
                    'UPDATE games SET name = ?, style_id = ? WHERE id = ?',
                    gameLibEntry.name, styleId || null, pendingPick.id
                );

                logInfo(`Web pick (queued, slots full): ${req.user!.username} picked ${gameLibEntry.name} for ${tournament.name}`);
                return res.json({ status: 'queued', gameName: gameLibEntry.name, tournamentName: tournament.name });
            }
        } else {
            // No pending pick — queue the game for next time
            await engine.queueGame(tournamentId, gameLibEntry.name, styleId, undefined, discordId);

            logInfo(`Web pick (queued): ${req.user!.username} queued ${gameLibEntry.name} for ${tournament.name}`);
            return res.json({ status: 'queued', gameName: gameLibEntry.name, tournamentName: tournament.name });
        }
    } catch (error) {
        logError('API Error (POST rooms/:roomId/pick-game):', error);
        res.status(500).json({ error: error instanceof Error ? error.message : 'Internal Server Error' });
    }
});

// Delete a queued game — requires Discord login + ownership
router.delete('/:roomId/queue/:gameId', requireDiscordUser, requireNotBanned, async (req, res) => {
    try {
        const db = await getDatabase();
        const roomId = req.params.roomId as string;
        const gameId = req.params.gameId as string;
        const discordId = req.user!.discordId!;

        const game = await db.get(
            `SELECT g.id, g.picker_discord_id, t.game_room_id
             FROM games g JOIN tournaments t ON g.tournament_id = t.id
             WHERE g.id = ? AND g.status = 'QUEUED' AND g.name != '[Pending Pick]'`,
            gameId
        );
        if (!game) return res.status(404).json({ error: 'Queued game not found' });
        if (game.game_room_id !== roomId) return res.status(403).json({ error: 'Game does not belong to this room' });
        if (game.picker_discord_id !== discordId) return res.status(403).json({ error: 'You can only remove your own queued games' });

        await db.run('DELETE FROM games WHERE id = ?', gameId);
        logInfo(`Queue delete: ${req.user!.username} removed queued game ${gameId}`);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE rooms/:roomId/queue/:gameId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Reorder queued games — requires Discord login + ownership
router.put('/:roomId/queue/reorder', requireDiscordUser, requireNotBanned, async (req, res) => {
    try {
        const validationResult = validate(ReorderQueueSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const db = await getDatabase();
        const roomId = req.params.roomId as string;
        const discordId = req.user!.discordId!;
        const { gameIds } = validationResult.data;

        // Verify all games belong to this user in this room
        for (const gameId of gameIds) {
            const game = await db.get(
                `SELECT g.id, g.picker_discord_id, t.game_room_id
                 FROM games g JOIN tournaments t ON g.tournament_id = t.id
                 WHERE g.id = ? AND g.status = 'QUEUED' AND g.name != '[Pending Pick]'`,
                gameId
            );
            if (!game || game.game_room_id !== roomId || game.picker_discord_id !== discordId) {
                return res.status(403).json({ error: 'Invalid game in reorder list' });
            }
        }

        // Update queue_order based on position in array
        await db.exec('BEGIN TRANSACTION');
        try {
            for (let i = 0; i < gameIds.length; i++) {
                await db.run('UPDATE games SET queue_order = ? WHERE id = ?', i + 1, gameIds[i]);
            }
            await db.exec('COMMIT');
        } catch (err) {
            await db.exec('ROLLBACK').catch(() => {});
            throw err;
        }

        logInfo(`Queue reorder: ${req.user!.username} reordered ${gameIds.length} queued games`);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (PUT rooms/:roomId/queue/reorder):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Stats
router.get('/:roomId/stats/players', async (req, res) => {
    try {
        const { StatsService } = await import('../../services/StatsService.js');
        const players = await StatsService.getAllPlayerStats(req.params.roomId as string);
        res.json(players);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/stats/players):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/:roomId/stats/player/:identifier', async (req, res) => {
    try {
        const { StatsService } = await import('../../services/StatsService.js');
        const identifier = decodeURIComponent(req.params.identifier as string);
        const roomId = req.params.roomId as string;
        const isProviderId = isProviderUserId(identifier);
        const stats = isProviderId
            ? await StatsService.getPlayerStats(identifier, roomId)
            : await StatsService.getPlayerStatsByUsername(identifier, roomId);
        if (!stats) return res.status(404).json({ error: 'Player not found' });
        res.json(stats);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/stats/player/:identifier):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Enhanced stats
router.get('/:roomId/stats/enhanced/players', async (req, res) => {
    try {
        const { StatsService } = await import('../../services/StatsService.js');
        const players = await StatsService.getEnhancedAllPlayerStats(req.params.roomId as string);
        res.json(players);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/stats/enhanced/players):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// v2.1.0: Stats page Combo overview — 4 cards at the top of /:slug/stats.
router.get('/:roomId/stats/overview', async (req, res) => {
    try {
        const { StatsService } = await import('../../services/StatsService.js');
        const overview = await StatsService.getRoomOverview(req.params.roomId as string);
        res.json(overview);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/stats/overview):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Sprint 7: per-game activity stats for the public Stats page (Games view)
router.get('/:roomId/stats/games-activity', async (req, res) => {
    try {
        const { StatsService } = await import('../../services/StatsService.js');
        const games = await StatsService.getGameActivityStats(req.params.roomId as string);
        res.json(games);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/stats/games-activity):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/:roomId/stats/enhanced/player/:identifier', async (req, res) => {
    try {
        const { StatsService } = await import('../../services/StatsService.js');
        const identifier = decodeURIComponent(req.params.identifier as string);
        const roomId = req.params.roomId as string;
        const isProviderId = isProviderUserId(identifier);
        const stats = isProviderId
            ? await StatsService.getEnhancedPlayerStats(identifier, roomId)
            : await StatsService.getEnhancedPlayerStatsByUsername(identifier, roomId);
        if (!stats) return res.status(404).json({ error: 'Player not found' });
        res.json(stats);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/stats/enhanced/player/:identifier):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// S14 social loops — head-to-head player comparison (public, no middleware —
// mirrors the other stats routes).
router.get('/:roomId/stats/compare', async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const a = typeof req.query.a === 'string' ? req.query.a.trim() : '';
        const b = typeof req.query.b === 'string' ? req.query.b.trim() : '';
        if (!a || !b) {
            return res.status(400).json({ error: 'Query params "a" and "b" are required' });
        }
        if (a === b) {
            return res.status(400).json({ error: '"a" and "b" must be different players' });
        }
        const { StatsService } = await import('../../services/StatsService.js');
        const result = await StatsService.comparePlayersHeadToHead(roomId, a, b);
        res.json(result);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/stats/compare):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// All-time player rankings for a game
router.get('/:roomId/stats/game/:name/players', async (req, res) => {
    try {
        const { StatsService } = await import('../../services/StatsService.js');
        const gameName = decodeURIComponent(req.params.name as string);
        const roomId = req.params.roomId as string;
        const rankings = await StatsService.getGamePlayerRankings(gameName, roomId);
        res.json(rankings);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/stats/game/:name/players):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Per-game player stats
router.get('/:roomId/stats/game/:name/player/:identifier', async (req, res) => {
    try {
        const { StatsService } = await import('../../services/StatsService.js');
        const gameName = decodeURIComponent(req.params.name as string);
        const identifier = decodeURIComponent(req.params.identifier as string);
        const roomId = req.params.roomId as string;
        const stats = await StatsService.getPlayerGameStats(identifier, gameName, roomId);
        if (!stats) return res.status(404).json({ error: 'No stats found for this player and game' });
        res.json(stats);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/stats/game/:name/player/:identifier):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Batched score counts per player across multiple games in one call — the scoreboard
// renders up to ~50 cards per page and each used to call the single-game route below
// on mount, brushing the per-IP rate limiter (v2.18.1 incident, see CHANGELOG).
// GET /:roomId/score-counts?gameIds=id1,id2,...  ->  { counts: { [gameId]: { [player]: count } } }
// GET /:roomId/score-counts?gameNames=name1,name2,...  ->  { counts: { [gameName]: { [player]: count } } }
// (both may be supplied together; response keys are the raw gameIds/gameNames the caller
// sent, merged into one map). gameNames covers cards whose id is a catalogue id rather
// than a games-table id (non-active games) — the caller falls back to name-keyed lookup.
// Registered before the single-game route below for readability; the two paths don't
// actually shadow each other (Express matches on path segments, not query strings, and
// this route has no trailing /:gameId segment), so ordering isn't load-bearing here.
router.get('/:roomId/score-counts', async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const rawGameIds = typeof req.query.gameIds === 'string' ? req.query.gameIds : '';
        const gameIds = Array.from(new Set(
            rawGameIds.split(',').map(id => id.trim()).filter(id => id.length > 0)
        )).slice(0, 100);
        const rawGameNames = typeof req.query.gameNames === 'string' ? req.query.gameNames : '';
        const gameNames = Array.from(new Set(
            rawGameNames.split(',').map(name => name.trim()).filter(name => name.length > 0)
        )).slice(0, 100);

        if (gameIds.length === 0 && gameNames.length === 0) {
            return res.status(400).json({ error: 'gameIds and/or gameNames query parameter is required (comma-separated)' });
        }

        const db = await getDatabase();

        const counts: Record<string, Record<string, number>> = {};

        if (gameIds.length > 0) {
            // Look up game names so we can also match score_history entries with game_id=NULL
            // (e.g. community scores logged without a game_id) — same fallback the single-game
            // route below uses via ScoreHistoryService.getPlayerScoreCounts.
            const gameRows = await db.all(
                `SELECT id, name FROM games WHERE id IN (${gameIds.map(() => '?').join(',')})`,
                ...gameIds
            );
            const nameById = new Map<string, string>();
            for (const row of gameRows) {
                nameById.set(String((row as any).id), (row as any).name);
            }

            const valuesParams: any[] = [];
            for (const gameId of gameIds) {
                valuesParams.push(gameId, nameById.get(gameId) ?? null);
            }

            const rows = await db.all(
                `WITH requested(req_game_id, req_game_name) AS (
                    VALUES ${gameIds.map(() => '(?, ?)').join(', ')}
                 )
                 SELECT r.req_game_id as req_game_id, LOWER(sh.iscored_username) as player_key, COUNT(*) as cnt
                 FROM requested r
                 JOIN score_history sh
                   ON sh.game_room_id = ?
                  AND (sh.game_id = r.req_game_id
                       OR (sh.game_id IS NULL AND r.req_game_name IS NOT NULL AND LOWER(sh.game_name) = LOWER(r.req_game_name)))
                 GROUP BY r.req_game_id, LOWER(sh.iscored_username)
                 HAVING cnt > 1`,
                ...valuesParams, roomId
            );

            for (const gameId of gameIds) {
                counts[gameId] = {};
            }
            for (const row of rows) {
                const r = row as any;
                const gid = String(r.req_game_id);
                if (!counts[gid]) counts[gid] = {};
                counts[gid][r.player_key] = r.cnt;
            }
        }

        if (gameNames.length > 0) {
            const nameRows = await db.all(
                `WITH requested(req_game_name) AS (
                    VALUES ${gameNames.map(() => '(?)').join(', ')}
                 )
                 SELECT r.req_game_name as req_game_name, LOWER(sh.iscored_username) as player_key, COUNT(*) as cnt
                 FROM requested r
                 JOIN score_history sh
                   ON sh.game_room_id = ?
                  AND LOWER(sh.game_name) = LOWER(r.req_game_name)
                 GROUP BY r.req_game_name, LOWER(sh.iscored_username)
                 HAVING cnt > 1`,
                ...gameNames, roomId
            );

            for (const gameName of gameNames) {
                if (!counts[gameName]) counts[gameName] = {};
            }
            for (const row of nameRows) {
                const r = row as any;
                // req_game_name is the bound parameter value echoed back verbatim by the
                // VALUES clause — exactly the string the caller sent, no re-casing needed.
                const name = String(r.req_game_name);
                if (!counts[name]) counts[name] = {};
                counts[name][r.player_key] = r.cnt;
            }
        }

        res.json({ counts });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/score-counts):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Score counts per player for a game (for showing expand button only when multiple scores exist)
router.get('/:roomId/score-counts/:gameId', async (req, res) => {
    try {
        const { ScoreHistoryService } = await import('../../services/ScoreHistoryService.js');
        const roomId = req.params.roomId as string;
        const gameId = req.params.gameId as string;
        const counts = await ScoreHistoryService.getPlayerScoreCounts(roomId, gameId);
        res.json(counts);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/score-counts/:gameId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Score history for a player on a specific game
router.get('/:roomId/score-history/:gameName/player/:identifier', async (req, res) => {
    try {
        const { ScoreHistoryService } = await import('../../services/ScoreHistoryService.js');
        const gameName = decodeURIComponent(req.params.gameName as string);
        const identifier = decodeURIComponent(req.params.identifier as string);
        const roomId = req.params.roomId as string;
        const history = await ScoreHistoryService.getPlayerGameHistory(roomId, gameName, identifier);
        res.json(history);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/score-history/:gameName/player/:identifier):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// All score history for a game
router.get('/:roomId/score-history/:gameName', async (req, res) => {
    try {
        const { ScoreHistoryService } = await import('../../services/ScoreHistoryService.js');
        const gameName = decodeURIComponent(req.params.gameName as string);
        const roomId = req.params.roomId as string;
        const history = await ScoreHistoryService.getGameHistory(roomId, gameName);
        res.json(history);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/score-history/:gameName):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Score submissions for a specific tournament game instance
router.get('/:roomId/score-history/game/:gameId', async (req, res) => {
    try {
        const { ScoreHistoryService } = await import('../../services/ScoreHistoryService.js');
        const roomId = req.params.roomId as string;
        const gameId = req.params.gameId as string;
        const submissions = await ScoreHistoryService.getGameSubmissions(roomId, gameId);
        res.json(submissions);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/score-history/game/:gameId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Delete a single score event. Authorization is per-row:
//   - super_admin → any row in any room
//   - room_admin  → any row in a room they admin
//   - player      → only rows they own (submitted_by_user_id matches their discordId)
// Restricted to source IN ('tournament','sync') — community deletes need a
// separate cascade into community_scores that isn't built yet. After deletion
// we recompute the corresponding submissions row from the remaining
// score_history (delete if none left, else update score+timestamp). The
// leaderboard cache for this game is invalidated either way.
router.delete('/:roomId/score-history/:historyId', requireDiscordUser, async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const historyId = parseInt(req.params.historyId as string, 10);
        if (!Number.isFinite(historyId)) return res.status(400).json({ error: 'Invalid history id' });

        const { ScoreHistoryService } = await import('../../services/ScoreHistoryService.js');
        const row = await ScoreHistoryService.getDeletableRow(historyId);
        if (!row) return res.status(404).json({ error: 'Score not found' });
        if (row.game_room_id !== roomId) return res.status(404).json({ error: 'Score not found in this room' });
        if (row.source !== 'tournament' && row.source !== 'sync') {
            return res.status(400).json({ error: 'Only tournament/sync scores can be deleted via this endpoint' });
        }

        const isSuper = req.user!.role === 'super_admin';
        const isRoomAdmin = req.user!.role === 'room_admin' && req.user!.gameRoomIds.includes(roomId);
        const isOwner = !!row.submitted_by_user_id && row.submitted_by_user_id === req.user!.discordId;
        if (!isSuper && !isRoomAdmin && !isOwner) {
            return res.status(403).json({ error: 'You can only delete your own scores' });
        }

        // S23.6 — the delete/photo-cleanup/tombstone/recompute/broadcast
        // sequence now lives in ScoreHistoryService.deleteEvent so the
        // score-report resolution path shares it verbatim.
        await ScoreHistoryService.deleteEvent(
            row, req.user!.discordId || req.user!.username || 'self',
        );

        // Activity log: only when an admin used this. Self-delete is mundane
        // and would noise up the room timeline.
        if (isSuper || isRoomAdmin) {
            const { RoomEventService } = await import('../../services/RoomEventService.js');
            RoomEventService.log(roomId, 'score_deleted', {
                gameId: row.game_id,
                gameName: row.game_name,
                player: row.iscored_username,
                score: row.score,
                historyId,
                actor: isSuper ? 'super_admin' : 'room_admin',
            }).catch(() => {});
        }

        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE rooms/:roomId/score-history/:historyId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * S23.7 — verified-score loop (minimal floor).
 *
 * Marks a `score_history` row as admin-verified. Deliberately NOT on the dead
 * legacy `scores` table (zero readers/writers). No auto-verification, no bulk
 * verify, no player-facing "request verification" — this exists so the future
 * self-EDIT question ("can an edit raise a verified score?") is answerable.
 *
 * Room-admin only (`requireAuth + requireRoomAccess`), unlike the sibling
 * DELETE route which also allows self-service on your own row: verifying your
 * own score would defeat the point.
 */
router.post('/:roomId/score-history/:historyId/verify', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const historyId = parseInt(req.params.historyId as string, 10);
        if (!Number.isFinite(historyId)) return res.status(400).json({ error: 'Invalid history id' });

        const db = await getDatabase();
        const row = await db.get(
            'SELECT id, game_room_id, game_name, iscored_username, score FROM score_history WHERE id = ?',
            historyId,
        );
        if (!row) return res.status(404).json({ error: 'Score not found' });
        if (row.game_room_id !== roomId) return res.status(404).json({ error: 'Score not found in this room' });

        const actor = req.user!.discordId || req.user!.username || 'admin';
        await db.run(
            `UPDATE score_history SET verified_by = ?, verified_at = datetime('now') WHERE id = ?`,
            actor, historyId,
        );

        // Explicit audit write — auditMiddleware does NOT fire on router routes.
        await AuditService.log({
            actor,
            action: 'score_verified',
            target_type: 'score_history',
            target_id: String(historyId),
            details: JSON.stringify({
                roomId, gameName: row.game_name,
                player: row.iscored_username, score: row.score,
            }),
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

        const updated = await db.get(
            'SELECT verified_by, verified_at FROM score_history WHERE id = ?', historyId,
        );
        res.json({ success: true, verified_by: updated?.verified_by, verified_at: updated?.verified_at });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/score-history/:historyId/verify):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/** S23.7 — clears the verification set by the route above. */
router.post('/:roomId/score-history/:historyId/unverify', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const historyId = parseInt(req.params.historyId as string, 10);
        if (!Number.isFinite(historyId)) return res.status(400).json({ error: 'Invalid history id' });

        const db = await getDatabase();
        const row = await db.get(
            'SELECT id, game_room_id, game_name, iscored_username, score FROM score_history WHERE id = ?',
            historyId,
        );
        if (!row) return res.status(404).json({ error: 'Score not found' });
        if (row.game_room_id !== roomId) return res.status(404).json({ error: 'Score not found in this room' });

        const actor = req.user!.discordId || req.user!.username || 'admin';
        await db.run(
            'UPDATE score_history SET verified_by = NULL, verified_at = NULL WHERE id = ?',
            historyId,
        );

        await AuditService.log({
            actor,
            action: 'score_unverified',
            target_type: 'score_history',
            target_id: String(historyId),
            details: JSON.stringify({
                roomId, gameName: row.game_name,
                player: row.iscored_username, score: row.score,
            }),
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/score-history/:historyId/unverify):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * S23.6 — room-scoped score report. The global sibling is
 * `POST /api/global/scores/:scoreId/report` (global.ts); this one points at a
 * `score_history` row instead of a `global_scores` row, which is why
 * `score_reports` grew a `score_source` discriminator (migration 134).
 */
router.post('/:roomId/score-history/:historyId/report', writeLimiter, requireDiscordUser, requireNotBanned, async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const historyId = parseInt(req.params.historyId as string, 10);
        if (!Number.isFinite(historyId)) return res.status(400).json({ error: 'Invalid history id' });
        const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null;

        const db = await getDatabase();
        // Must belong to this room and not be orphaned (an orphaned row's game
        // is gone, so there's nothing an admin could act on).
        const row = await db.get(
            'SELECT id FROM score_history WHERE id = ? AND game_room_id = ? AND orphaned_at IS NULL',
            historyId, roomId,
        );
        if (!row) return res.status(404).json({ error: 'Score not found' });

        // Don't let a user report the same score twice while a prior report is open
        const existing = await db.get(
            `SELECT id FROM score_reports
             WHERE score_id = ? AND score_source = 'room_history'
               AND reporter_discord_id = ? AND resolved_at IS NULL`,
            String(historyId), req.user!.discordId,
        );
        if (existing) {
            return res.status(409).json({ error: 'You have already reported this score.' });
        }

        const cryptoMod = await import('crypto');
        const reportId = cryptoMod.randomUUID();
        await db.run(
            `INSERT INTO score_reports (id, score_id, reporter_discord_id, reason, score_source, game_room_id)
             VALUES (?, ?, ?, ?, 'room_history', ?)`,
            reportId, String(historyId), req.user!.discordId, reason, roomId,
        );

        logInfo(`score_history#${historyId} (room ${roomId}) reported by ${req.user!.discordId}`);
        res.status(201).json({ id: reportId });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/score-history/:historyId/report):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/:roomId/stats/game/:name', async (req, res) => {
    try {
        const { StatsService } = await import('../../services/StatsService.js');
        const stats = await StatsService.getGameStats(
            decodeURIComponent(req.params.name as string),
            req.params.roomId as string
        );
        if (!stats) return res.status(404).json({ error: 'Game not found' });
        res.json(stats);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/stats/game/:name):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Community scores
router.get('/:roomId/community-scores/recent', async (req, res) => {
    try {
        const { CommunityScoreService } = await import('../../services/CommunityScoreService.js');
        const activity = await CommunityScoreService.getRecentActivity(req.params.roomId as string);
        res.json(activity);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/community-scores/recent):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/:roomId/community-scores/:gameName', async (req, res) => {
    try {
        const { CommunityScoreService } = await import('../../services/CommunityScoreService.js');
        const gameName = decodeURIComponent(req.params.gameName as string);
        const roomId = req.params.roomId as string;
        const leaderboard = await CommunityScoreService.getGameLeaderboard(roomId, gameName);
        res.json(leaderboard);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/community-scores/:gameName):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Lightweight top-N leaders for a game (used by Freeplay contextual leaders)
router.get('/:roomId/community-scores/:gameName/leaders', async (req, res) => {
    try {
        const { CommunityScoreService } = await import('../../services/CommunityScoreService.js');
        const gameName = decodeURIComponent(req.params.gameName as string);
        const roomId = req.params.roomId as string;
        const limit = Math.min(parseInt(req.query.limit as string) || 5, 20);
        const leaderboard = await CommunityScoreService.getGameLeaderboard(roomId, gameName);
        res.json(leaderboard.slice(0, limit));
    } catch (error) {
        logError('API Error (GET rooms/:roomId/community-scores/:gameName/leaders):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/:roomId/community-scores/:gameName', writeLimiter, requireDiscordUser, requireNotBanned, async (req, res) => {
    try {
        const validationResult = validate(CommunityScoreSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const { CommunityScoreService } = await import('../../services/CommunityScoreService.js');
        const gameName = decodeURIComponent(req.params.gameName as string);
        const roomId = req.params.roomId as string;
        const { score, photo_url } = validationResult.data;

        // v2.79.0 (login mandate) — requireDiscordUser guarantees req.user.discordId
        // here, so resolveSubmitUsername always takes the authed branch: the
        // client-supplied `username` is ignored entirely and the canonical
        // room name is resolved server-side (v2.54.0 username lock).
        const resolvedName = await resolveSubmitUsername(req, roomId);
        if (!resolvedName.ok) return res.status(400).json({ error: resolvedName.error });

        // v2.53.0: re-validate the engine/device pair server-side against the
        // game's resolved scope, and DERIVE the legacy platform from it (any
        // client-supplied `platform` is ignored — the pair is authoritative).
        const provenance = await ensureProvenanceAllowed({
            roomId, gameName,
            engine: validationResult.data.engine,
            device: validationResult.data.device,
        });
        if (!provenance.ok) return res.status(400).json({ error: provenance.error });
        const { engine, device, platform } = provenance;

        // Security: attribution derives from the verified token, never the
        // request body — the request body doesn't even carry a discord_user_id
        // field (see CommunityScoreSchema).
        const result = await CommunityScoreService.submitScore(roomId, gameName, resolvedName.username, score, req.user!.discordId, photo_url, { platform, engine, device });

        // v2.2.2: sync to iScored when this matches an ACTIVE tournament game.
        // photo_url is a pre-existing URL (not an upload), so no persistentPhotoPath
        // — Playwright fallback will skip the photo copy. API path still syncs.
        const { syncScoreToIScored } = await import('../../services/IScoredSubmitSync.js');
        syncScoreToIScored({
            roomId,
            gameName,
            username: result.displayName,
            score,
            platform,
        });

        res.status(201).json(result);
    } catch (error) {
        if ((error as Error & { code?: string })?.code === 'NAME_NOT_ALLOWED') {
            return res.status(400).json({ error: (error as Error).message, code: 'NAME_NOT_ALLOWED' });
        }
        logError('API Error (POST rooms/:roomId/community-scores/:gameName):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// v2.79.0 (login mandate) — the v2.2.5 `POST /:roomId/submit/name-check`
// pre-submit guest collision check was removed along with the SubmissionSheet
// guest flow that was its only caller. `RoomNameClaimService.checkAvailability`
// survives as a service method.

// Score submission with photo upload (public, rate-limited)
// v2.79.0 (login mandate) — every submitter must be logged in (Discord or Google).
router.post('/:roomId/submit-score/:gameName', writeLimiter, requireDiscordUser, requireNotBanned, roomAssetUpload.single('photo'), async (req, res) => {
    try {
        const validationResult = validate(ScoreSubmissionSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const roomId = req.params.roomId as string;
        const gameName = decodeURIComponent(req.params.gameName as string);
        const { score } = validationResult.data;
        const excludeFromGlobal = req.body.excludeGlobal === 'true' || req.body.excludeGlobal === true;

        // v2.54.0 username lock — see the community-scores handler above.
        // requireDiscordUser guarantees an authed submitter, so the posted
        // `username` (if any) is ignored and the canonical name resolved.
        const resolvedName = await resolveSubmitUsername(req, roomId);
        if (!resolvedName.ok) return res.status(400).json({ error: resolvedName.error });

        // v2.53.0: engine/device validated + legacy platform derived (see the
        // community-scores handler above).
        const provenance = await ensureProvenanceAllowed({
            roomId, gameName,
            engine: validationResult.data.engine,
            device: validationResult.data.device,
        });
        if (!provenance.ok) return res.status(400).json({ error: provenance.error });
        const { engine, device, platform } = provenance;

        // Check if photo is required
        const requirePhoto = await GameRoomSettingsService.get(roomId, 'REQUIRE_SCORE_PHOTO');
        if (requirePhoto === 'true' && !req.file) {
            return res.status(400).json({ error: 'A photo is required with score submissions.' });
        }

        // S11: magic-byte validation — multer only sees the client-supplied MIME
        // type (spoofable), so reject non-image bytes before persisting. Photo is
        // optional here, so only validate when one was actually uploaded.
        if (req.file && !isAllowedImage(req.file.buffer)) {
            return res.status(400).json({ error: 'Invalid image file' });
        }

        // Save photo to persistent storage if provided
        let photoUrl: string | undefined;
        let persistentPhotoPath: string | undefined;
        if (req.file) {
            const ext = (req.file.mimetype === 'image/png' || req.file.mimetype === 'image/apng') ? 'png' : req.file.mimetype === 'image/webp' ? 'webp' : 'jpg';
            const filename = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
            const dir = path.join(process.cwd(), 'data', 'score-photos', roomId);
            fs.mkdirSync(dir, { recursive: true });
            persistentPhotoPath = path.join(dir, filename);
            fs.writeFileSync(persistentPhotoPath, req.file.buffer);
            photoUrl = `/api/score-photos/${roomId}/${filename}`;
        }

        // Save to community_scores + score_history. Fan-out to global_scores
        // is handled inside CommunityScoreService.submitScore (best-effort).
        // The service routes username through RoomNameClaimService and returns
        // the resolved displayName (possibly suffixed e.g. "Bob_2").
        const { CommunityScoreService } = await import('../../services/CommunityScoreService.js');
        const result = await CommunityScoreService.submitScore(
            roomId, gameName, resolvedName.username, score, req.user!.discordId, photoUrl, { excludeFromGlobal, platform, engine, device }
        );
        const effectiveUsername = result.displayName;

        // Log activity event
        const { RoomEventService } = await import('../../services/RoomEventService.js');
        RoomEventService.log(roomId, 'score_submission', { gameName, username: effectiveUsername, score }).catch(() => {});

        // Also upsert into submissions so the main leaderboard reflects the highest score.
        // Use the resolved displayName so the submission ID and stored name match
        // the community/score_history rows — keeps the leaderboard grouping clean.
        const db = await getDatabase();
        const activeGame = await db.get(`
            SELECT g.id, g.tournament_id FROM games g
            JOIN tournaments t ON t.id = g.tournament_id
            WHERE LOWER(g.name) = LOWER(?) AND t.game_room_id = ?
              AND g.status IN ('ACTIVE', 'COMPLETED')
            LIMIT 1
        `, gameName, roomId);
        if (activeGame) {
            const submissionId = `${activeGame.id}-${effectiveUsername.toLowerCase()}`;
            const existing = await db.get('SELECT score FROM submissions WHERE id = ?', submissionId);
            if (!existing || score > existing.score) {
                // v2.79.0 (login mandate): every submitter is authed now, so
                // submitted_by_user_id is always set — no anonymous fallback.
                const submittedByUserId = normalizeSubmitterUserId(req.user!.discordId);
                await db.run(
                    `INSERT OR REPLACE INTO submissions (
                        id, game_id, discord_user_id, iscored_username, score, photo_url, timestamp,
                        submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
                        submitted_by_anonymous_name, merged_from_anonymous_identity_id, platform,
                        engine, device
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
                    submissionId, activeGame.id, 'COMMUNITY', effectiveUsername, score, photoUrl || null, new Date().toISOString(),
                    roomId, activeGame.tournament_id || null, submittedByUserId, platform,
                    engine, device,
                );
                const { LeaderboardService } = await import('../../services/LeaderboardService.js');
                await LeaderboardService.invalidate(activeGame.id);
            }
        }

        // v2.2.2: iScored sync extracted to a shared helper so all three web
        // submission paths sync identically. Pass the resolved displayName so the
        // name on iScored matches the name on ArcAid's scoreboard.
        const { syncScoreToIScored } = await import('../../services/IScoredSubmitSync.js');
        syncScoreToIScored({
            roomId,
            gameName,
            username: effectiveUsername,
            score,
            persistentPhotoPath,
            platform,
        });

        res.status(201).json(result);
    } catch (error) {
        if ((error as Error & { code?: string })?.code === 'NAME_NOT_ALLOWED') {
            return res.status(400).json({ error: (error as Error).message, code: 'NAME_NOT_ALLOWED' });
        }
        logError('API Error (POST rooms/:roomId/submit-score/:gameName):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /:roomId/freeplay-score — submit a freeplay score for any game in the
 * global catalogue, attributed to this room. The game does NOT need to be an
 * active tournament game in the room. Photo required.
 *
 * Saves to community_scores + score_history (room-scoped views) and fans out
 * to global_scores (subject to room GLOBAL_SCOREBOARD_ENABLED and user exclude_global).
 */
// v2.79.0 (login mandate) — every submitter must be logged in (Discord or Google).
router.post('/:roomId/freeplay-score', writeLimiter, requireDiscordUser, requireNotBanned, roomAssetUpload.single('photo'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        // v2.5.0: switched from inline checks to FreeplayScoreSchema so all
        // three web submit paths share validation shape (incl. required
        // `platform` field).
        const validationResult = validate(FreeplayScoreSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const { globalGameId, score, excludeGlobal: excludeFromGlobal } = validationResult.data;

        // v2.54.0 username lock — see the community-scores handler above.
        // requireDiscordUser guarantees an authed submitter, so the posted
        // `username` (if any) is ignored and the canonical name resolved.
        const resolvedName = await resolveSubmitUsername(req, roomId);
        if (!resolvedName.ok) return res.status(400).json({ error: resolvedName.error });

        // Photo is required for freeplay (no tournament cross-check, so evidence matters)
        if (!req.file) {
            return res.status(400).json({ error: 'A photo is required for freeplay score submissions.' });
        }

        // S11: magic-byte validation (see submit-score). Photo is guaranteed
        // present here by the guard above, so validate unconditionally.
        if (!isAllowedImage(req.file.buffer)) {
            return res.status(400).json({ error: 'Invalid image file' });
        }

        // Resolve the game from the global catalogue
        const db = await getDatabase();
        const globalGame = await db.get(
            'SELECT id, name FROM global_games WHERE id = ? AND status = \'approved\'',
            globalGameId
        );
        if (!globalGame) {
            return res.status(404).json({ error: 'Game not found in the global catalogue' });
        }

        // v2.53.0: validate engine/device + derive the legacy platform for this
        // game in this room (uses the canonical name, since freeplay catalogue
        // lookups go by name not id from here on).
        const provenance = await ensureProvenanceAllowed({
            roomId,
            gameName: globalGame.name,
            engine: validationResult.data.engine,
            device: validationResult.data.device,
        });
        if (!provenance.ok) return res.status(400).json({ error: provenance.error });
        const { engine, device, platform } = provenance;

        // Persist photo
        const ext = (req.file.mimetype === 'image/png' || req.file.mimetype === 'image/apng') ? 'png' : req.file.mimetype === 'image/webp' ? 'webp' : 'jpg';
        const filename = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
        const dir = path.join(process.cwd(), 'data', 'score-photos', roomId);
        fs.mkdirSync(dir, { recursive: true });
        const persistentPhotoPath = path.join(dir, filename);
        fs.writeFileSync(persistentPhotoPath, req.file.buffer);
        const photoUrl = `/api/score-photos/${roomId}/${filename}`;

        // Save to community_scores (room-scoped) — uses the global_games.name for
        // consistent cross-referencing. CommunityScoreService will also fan-out to
        // global_scores via GlobalScoreService, respecting exclude_from_global.
        // Returns resolved displayName when the requested username collided.
        const { CommunityScoreService } = await import('../../services/CommunityScoreService.js');
        const result = await CommunityScoreService.submitScore(
            roomId,
            globalGame.name,
            resolvedName.username,
            score,
            req.user!.discordId,
            photoUrl,
            { excludeFromGlobal, platform, engine, device }
        );

        // v2.2.0: use the resolved displayName (possibly suffixed) for activity
        // logging and the submissions upsert, so leaderboard groupings match
        // what's stored in community_scores/score_history.
        const effectiveUsername = result.displayName;

        // Log activity
        const { RoomEventService } = await import('../../services/RoomEventService.js');
        RoomEventService.log(roomId, 'freeplay_score_submission', {
            globalGameId,
            gameName: globalGame.name,
            username: effectiveUsername,
            score,
        }).catch(() => {});

        // v2.0.3: if this room has an ACTIVE/COMPLETED tournament game matching
        // this name, upsert into submissions too so the Tournament card
        // reflects the score. Matches the behavior of /submit-score — the path
        // a user takes to submit shouldn't change whether the score counts
        // toward the active tournament.
        const activeGame = await db.get(`
            SELECT g.id, g.tournament_id FROM games g
            JOIN tournaments t ON t.id = g.tournament_id
            WHERE LOWER(g.name) = LOWER(?) AND t.game_room_id = ?
              AND g.status IN ('ACTIVE', 'COMPLETED')
            LIMIT 1
        `, globalGame.name, roomId);
        if (activeGame) {
            const submissionId = `${activeGame.id}-${effectiveUsername.toLowerCase()}`;
            const existing = await db.get('SELECT score FROM submissions WHERE id = ?', submissionId);
            if (!existing || score > existing.score) {
                // v2.79.0 (login mandate): every submitter is authed now, so
                // submitted_by_user_id is always set — no anonymous fallback.
                const { normalizeSubmitterUserId } = await import('../../services/SubmissionContextService.js');
                const submittedByUserId = normalizeSubmitterUserId(req.user!.discordId);
                await db.run(
                    `INSERT OR REPLACE INTO submissions (
                        id, game_id, discord_user_id, iscored_username, score, photo_url, timestamp,
                        submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
                        submitted_by_anonymous_name, merged_from_anonymous_identity_id, platform,
                        engine, device
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
                    submissionId, activeGame.id, 'COMMUNITY', effectiveUsername, score, photoUrl, new Date().toISOString(),
                    roomId, activeGame.tournament_id || null, submittedByUserId, platform,
                    engine, device,
                );
                const { LeaderboardService } = await import('../../services/LeaderboardService.js');
                await LeaderboardService.invalidate(activeGame.id);
            }
        }

        // v2.2.2: sync to iScored too when the freeplay target matches an ACTIVE
        // tournament game. Closes the "freeplay scores never reach iScored" gap.
        const { syncScoreToIScored } = await import('../../services/IScoredSubmitSync.js');
        syncScoreToIScored({
            roomId,
            gameName: globalGame.name,
            username: effectiveUsername,
            score,
            persistentPhotoPath,
            platform,
        });

        res.status(201).json({
            id: result.id,
            gameName: globalGame.name,
            displayName: result.displayName,
            suffixed: result.suffixed,
            requested: result.requested,
        });
    } catch (error) {
        if ((error as Error & { code?: string })?.code === 'NAME_NOT_ALLOWED') {
            return res.status(400).json({ error: (error as Error).message, code: 'NAME_NOT_ALLOWED' });
        }
        logError('API Error (POST rooms/:roomId/freeplay-score):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ─── Lobby Feed ───

// Public feed — no auth required, optional player token for friend events
router.get('/:roomId/lobby/feed', async (req, res) => {
    try {
        const { LobbyFeedService } = await import('../../services/LobbyFeedService.js');
        const roomId = req.params.roomId as string;
        const limit = parseInt(req.query.limit as string) || 20;
        const before = req.query.before as string | undefined;
        const typesParam = req.query.types as string | undefined;
        const types = typesParam ? typesParam.split(',').filter(Boolean) : undefined;

        // If viewer is authenticated, pass their ID for targeted events (friend scores)
        const viewerUserId = req.user?.discordId;

        const feed = await LobbyFeedService.getFeed(roomId, {
            limit: Math.min(limit, 50),
            before,
            types,
            viewerUserId,
        });

        res.json(feed);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/lobby/feed):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Admin curated feed posts
router.post('/:roomId/lobby/feed', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { LobbyFeedService } = await import('../../services/LobbyFeedService.js');
        const roomId = req.params.roomId as string;
        const { type, title, subtitle } = req.body;

        if (!type || !title) {
            return res.status(400).json({ error: 'type and title are required' });
        }

        if (!['admin_message', 'admin_shoutout'].includes(type)) {
            return res.status(400).json({ error: 'type must be admin_message or admin_shoutout' });
        }

        const id = await LobbyFeedService.emit({
            gameRoomId: roomId,
            type,
            source: 'admin',
            icon: type === 'admin_shoutout' ? '⭐' : '📢',
            title,
            subtitle,
        });

        res.status(201).json({ id });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/lobby/feed):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Room Scores — every score ever set in this room, best-per-player-per-game
// across sources (score_history alone; see RoomScoresService). Public, no
// middleware (mirrors /:roomId/leaderboard) but decodes an OPTIONAL Bearer
// player token best-effort to attach a per-card viewerEntry — never 401s.
// v2.0.x renamed from /:roomId/community-leaderboards (scores-page-redesign);
// the only repo consumer (GamesTabView.tsx) is being replaced in the same
// redesign, so no back-compat alias.
router.get('/:roomId/room-scores', async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const validationResult = validate(RoomScoresQuerySchema, req.query);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const { sort, limit, offset, search } = validationResult.data;

        // Identify the viewer from a player token (same alias-resolution
        // block as /:roomId/leaderboard) so viewerEntry matches the same
        // partition the ranking query collapses by
        // (COALESCE(submitted_by_user_id, 'iscored:'||LOWER(iscored_username))).
        let viewerDiscordId: string | null = null;
        const viewerAliases = new Set<string>();
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
            try {
                const { verifyToken } = await import('../auth.js');
                const payload = verifyToken(authHeader.slice(7));
                if (payload?.discordId) {
                    viewerDiscordId = payload.discordId as string;
                    const db = await getDatabase();
                    const aliasRows = await db.all(
                        'SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?',
                        payload.discordId
                    ) as Array<{ iscored_username: string }>;
                    for (const a of aliasRows) viewerAliases.add(a.iscored_username.toLowerCase());
                    if (payload.username) viewerAliases.add((payload.username as string).toLowerCase());
                }
            } catch {
                // Invalid token — ignore, viewer is anonymous
            }
        }

        const result = await RoomScoresService.getRoomScores(roomId, {
            sort,
            limit,
            offset,
            search,
            viewer: viewerDiscordId ? { discordId: viewerDiscordId, aliases: viewerAliases } : undefined,
        });

        res.json(result);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/room-scores):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ── Lobby Content (announcements, shelf, config) ──

// Public: active announcements
router.get('/:roomId/lobby/announcements', async (req, res) => {
    try {
        const { AnnouncementService } = await import('../../services/AnnouncementService.js');
        const announcements = await AnnouncementService.getActive(req.params.roomId as string);
        res.json(announcements);
    } catch (error) {
        logError('API Error (GET lobby/announcements):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Admin: all announcements (includes expired/scheduled)
router.get('/:roomId/lobby/announcements/all', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { AnnouncementService } = await import('../../services/AnnouncementService.js');
        const announcements = await AnnouncementService.getAll(req.params.roomId as string);
        res.json(announcements);
    } catch (error) {
        logError('API Error (GET lobby/announcements/all):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Admin: create announcement
router.post('/:roomId/lobby/announcements', requireAuth, requireRoomAccess('roomId'), requireNotBanned, async (req, res) => {
    try {
        const { title, body, image_url, cta_url, cta_label, type, event_datetime, display_from, display_until, sort_order } = req.body;
        if (!title) return res.status(400).json({ error: 'title is required' });
        const { AnnouncementService } = await import('../../services/AnnouncementService.js');
        const announcement = await AnnouncementService.create(req.params.roomId as string, {
            title, body, image_url, cta_url, cta_label, type, event_datetime, display_from, display_until, sort_order,
        });
        res.status(201).json(announcement);
    } catch (error) {
        logError('API Error (POST lobby/announcements):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Admin: update announcement
router.put('/:roomId/lobby/announcements/:id', requireAuth, requireRoomAccess('roomId'), requireNotBanned, async (req, res) => {
    try {
        const { AnnouncementService } = await import('../../services/AnnouncementService.js');
        const updated = await AnnouncementService.update(req.params.id as string, req.body);
        if (!updated) return res.status(404).json({ error: 'Not found' });
        res.json(updated);
    } catch (error) {
        logError('API Error (PUT lobby/announcements/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Admin: delete announcement
router.delete('/:roomId/lobby/announcements/:id', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { AnnouncementService } = await import('../../services/AnnouncementService.js');
        await AnnouncementService.delete(req.params.id as string);
        res.json({ ok: true });
    } catch (error) {
        logError('API Error (DELETE lobby/announcements/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Public: community shelf items
router.get('/:roomId/lobby/shelf', async (req, res) => {
    try {
        const { CommunityShelfService } = await import('../../services/CommunityShelfService.js');
        const items = await CommunityShelfService.getAll(req.params.roomId as string);
        res.json(items);
    } catch (error) {
        logError('API Error (GET lobby/shelf):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Admin: add shelf item
router.post('/:roomId/lobby/shelf', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { url, title, type, thumbnail, description, sort_order } = req.body;
        if (!url || !title) return res.status(400).json({ error: 'url and title are required' });
        const { CommunityShelfService } = await import('../../services/CommunityShelfService.js');
        const item = await CommunityShelfService.create(req.params.roomId as string, {
            url, title, type, thumbnail, description, sort_order,
        });
        res.status(201).json(item);
    } catch (error) {
        logError('API Error (POST lobby/shelf):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Admin: update shelf item
router.put('/:roomId/lobby/shelf/:id', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { CommunityShelfService } = await import('../../services/CommunityShelfService.js');
        const updated = await CommunityShelfService.update(req.params.id as string, req.body);
        if (!updated) return res.status(404).json({ error: 'Not found' });
        res.json(updated);
    } catch (error) {
        logError('API Error (PUT lobby/shelf/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Admin: delete shelf item
router.delete('/:roomId/lobby/shelf/:id', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { CommunityShelfService } = await import('../../services/CommunityShelfService.js');
        await CommunityShelfService.delete(req.params.id as string);
        res.json({ ok: true });
    } catch (error) {
        logError('API Error (DELETE lobby/shelf/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Admin: reorder shelf items
router.put('/:roomId/lobby/shelf-reorder', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { orderedIds } = req.body;
        if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds array is required' });
        const { CommunityShelfService } = await import('../../services/CommunityShelfService.js');
        await CommunityShelfService.reorder(req.params.roomId as string, orderedIds);
        res.json({ ok: true });
    } catch (error) {
        logError('API Error (PUT lobby/shelf-reorder):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Public: lobby config (social links, pinned message, feed settings)
router.get('/:roomId/lobby/config', async (req, res) => {
    try {
        const { GameRoomSettingsService } = await import('../../services/GameRoomSettingsService.js');
        const roomId = req.params.roomId as string;
        const [socialLinks, pinnedMessage, feedSettings, defaultLanding] = await Promise.all([
            GameRoomSettingsService.get(roomId, 'LOBBY_SOCIAL_LINKS'),
            GameRoomSettingsService.get(roomId, 'LOBBY_PINNED_MESSAGE'),
            GameRoomSettingsService.get(roomId, 'LOBBY_FEED_SETTINGS'),
            GameRoomSettingsService.get(roomId, 'LOBBY_DEFAULT_LANDING'),
        ]);
        res.json({
            socialLinks: socialLinks ? JSON.parse(socialLinks) : [],
            pinnedMessage: pinnedMessage ? JSON.parse(pinnedMessage) : null,
            feedSettings: feedSettings ? JSON.parse(feedSettings) : null,
            defaultLanding: defaultLanding === 'true',
        });
    } catch (error) {
        logError('API Error (GET lobby/config):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Admin: save lobby config
router.put('/:roomId/lobby/config', requireAuth, requireRoomAccess('roomId'), requireNotBanned, async (req, res) => {
    try {
        const { GameRoomSettingsService } = await import('../../services/GameRoomSettingsService.js');
        const roomId = req.params.roomId as string;
        const { socialLinks, pinnedMessage, feedSettings, defaultLanding } = req.body;
        if (socialLinks !== undefined) {
            await GameRoomSettingsService.set(roomId, 'LOBBY_SOCIAL_LINKS', JSON.stringify(socialLinks));
        }
        if (pinnedMessage !== undefined) {
            await GameRoomSettingsService.set(roomId, 'LOBBY_PINNED_MESSAGE', JSON.stringify(pinnedMessage));
        }
        if (feedSettings !== undefined) {
            await GameRoomSettingsService.set(roomId, 'LOBBY_FEED_SETTINGS', JSON.stringify(feedSettings));
        }
        if (defaultLanding !== undefined) {
            await GameRoomSettingsService.set(roomId, 'LOBBY_DEFAULT_LANDING', defaultLanding ? 'true' : 'false');
        }
        res.json({ ok: true });
    } catch (error) {
        logError('API Error (PUT lobby/config):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Game comments & tips
router.get('/:roomId/games/:gameName/comments', optionalDiscordUser, async (req, res) => {
    try {
        const { CommentService } = await import('../../services/CommentService.js');
        const gameName = decodeURIComponent(req.params.gameName as string);
        const roomId = req.params.roomId as string;
        const type = req.query.type as 'comment' | 'tip' | undefined;
        const comments = await CommentService.getComments(roomId, gameName, type);
        // S11: never disclose other users' author ids. The delete route authorizes
        // an anon author by their `x-user-id`, so exposing every row's user_id here
        // let a stranger read an id and replay it to delete that comment. Mask each
        // row to the caller: their own id survives (so the FE can show its delete
        // control), everyone else's becomes null.
        // M4 fix (S22 follow-ups adversarial review) — every pre-existing comment
        // was stored under the anon x-user-id, so a logged-in author's own row
        // won't match their discordId. Build a candidate identity set (both ids,
        // filtered of empty/'anon') and treat a match against EITHER as "own" —
        // otherwise logged-in users lose the delete control on their own old
        // comments and see a Flag button on themselves instead.
        const callerIds = [req.user?.discordId, req.headers['x-user-id'] as string | undefined]
            .filter((id): id is string => !!id && id !== 'anon');
        const masked = (comments as any[]).map(c => ({
            ...c,
            user_id: callerIds.includes(c.user_id) ? c.user_id : null,
        }));
        res.json(masked);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/games/:gameName/comments):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// v2.86.0 — comments now require Discord login (closes anonymous spam +
// the banned-user anon bypass; see requireNotBanned's per-submit doc for why
// an anonymous writer was never bannable). Author is the token's discordId
// ONLY — the x-user-id/'anon' fallback that used to attribute guest posts is
// gone, since a request can no longer reach this handler without a Discord
// identity.
router.post('/:roomId/games/:gameName/comments', guestContentLimiter, requireDiscordUser, requireNotBanned, async (req, res) => {
    try {
        const validationResult = validate(GameCommentSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const { CommentService } = await import('../../services/CommentService.js');
        const gameName = decodeURIComponent(req.params.gameName as string);
        const roomId = req.params.roomId as string;
        const userId = req.user!.discordId!;
        const { display_name, type, body } = validationResult.data;
        const comment = await CommentService.addComment(roomId, gameName, userId, display_name, type, body);
        res.status(201).json(comment);
    } catch (error) {
        logError('API Error (POST rooms/:roomId/games/:gameName/comments):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// v2.86.0 — uses `optionalUser` (not `optionalDiscordUser`) so a
// password/local-admin token (no discordId) still populates req.user and can
// hit the super_admin/room_admin authz tiers below. The author-match tier
// still reads the x-user-id header for legacy anon-authored rows (comments
// posted before login became mandatory) — those authors keep delete rights
// on their own old comments.
router.delete('/:roomId/games/:gameName/comments/:id', guestContentLimiter, optionalUser, async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const { CommentService } = await import('../../services/CommentService.js');
        const commentId = parseInt(req.params.id as string, 10);
        if (!Number.isFinite(commentId)) return res.status(400).json({ error: 'Invalid comment id' });
        const comment = await CommentService.getCommentById(commentId);
        if (!comment) return res.status(404).json({ error: 'Comment not found' });
        // Room-scope first: comment ids are global sequential integers, so refuse
        // to act on a comment that lives in another room (cross-tenant delete).
        if (comment.game_room_id !== roomId) return res.status(404).json({ error: 'Comment not found in this room' });

        // Tiered authz mirroring the score-history delete (rooms.ts:995):
        //   super_admin → any comment; room_admin → any comment in their room;
        //   author → only their own. optionalDiscordUser populated
        //   req.user for logged-in viewers; guests fall through with req.user
        //   undefined and can only match as author via their anon x-user-id.
        const isSuper = req.user?.role === 'super_admin';
        const isRoomAdmin = req.user?.role === 'room_admin' && req.user.gameRoomIds.includes(roomId);
        // M4 fix (S22 follow-ups adversarial review) — match against EITHER the
        // logged-in discordId or the anon x-user-id (candidate set), same as the
        // GET masking above: pre-existing comments were stored under the anon id,
        // so a logged-in author must still be able to delete their own old rows.
        // Never let the 'anon' sentinel (or an empty identity) authorize a delete —
        // otherwise anyone sending `x-user-id: anon` could wipe every header-less
        // comment. A real author always has a non-empty, non-sentinel id.
        const callerIds = [req.user?.discordId, req.headers['x-user-id'] as string | undefined]
            .filter((id): id is string => !!id && id !== 'anon');
        const isAuthor = callerIds.includes(comment.user_id);
        if (!isSuper && !isRoomAdmin && !isAuthor) {
            return res.status(403).json({ error: 'Not authorized' });
        }
        await CommentService.deleteComment(commentId);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE rooms/:roomId/games/:gameName/comments/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Game library search (autocomplete)
router.get('/:roomId/game_library/search', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const q = req.query.q as string;
        if (!q || typeof q !== 'string' || !q.trim()) {
            res.json([]);
            return;
        }
        const results = await GameLibraryService.search(q.trim());
        res.json(results);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/game_library/search):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- RetroAchievements on-demand import (contract §2/§3) ---
//
// Room-admin surface. The handler bodies are shared with the super-admin and
// public twins (see src/api/raCatalogueHandlers.ts) — only the middleware
// differs. Search is a read of our own cached master list; the import WRITES
// to the shared catalogue and is auto-audited by the app-level `auditLog` on
// a 2xx POST.
router.get('/:roomId/ra-catalogue/search', requireAuth, requireRoomAccess('roomId'), raSearchHandler);
router.post(
    '/:roomId/ra-catalogue/import/:raGameId',
    writeLimiter, requireAuth, requireRoomAccess('roomId'), requireNotBanned,
    raImportHandler,
);

// Game library (room-scoped view).
//
// v2.5.1: rooms no longer maintain a curated subset — every room sees the full
// approved global catalogue. v2.6.0: legacy `game_library` table is dropped;
// reads come straight from `global_games WHERE status='approved'`.
//
// One row per catalogue entry — variants of the same name (e.g. "Carnival
// (Bally, 1948)" vs "(Sega, 1971)") render as distinct rows. The FE
// disambiguates with the manufacturer/year sub-line so the user can tell
// them apart. Stable secondary sort on `(year, manufacturer)` so variants
// of a given name appear oldest-first.
router.get('/:roomId/game_library', async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const db = await getDatabase();
        // SELECT also pulls the JSON metadata fields used for the FE's free-
        // text search bar (designers, themes, table_authors, aliases). They
        // ship as parsed arrays so the FE doesn't double-parse per row.
        const rows = await db.all(`
            SELECT
                id,
                name,
                COALESCE(display_name, name) AS display_name,
                type,
                manufacturer,
                year,
                platforms,
                designers,
                themes,
                table_authors,
                aliases,
                COALESCE(local_image_path, wheel_image_path, image_url) AS image_url
            FROM global_games
            WHERE status = 'approved'
            ORDER BY name COLLATE NOCASE ASC,
                     COALESCE(year, 9999) ASC,
                     COALESCE(manufacturer, '') COLLATE NOCASE ASC
        `);
        // Per-room tag map keyed by global_game_id (one query, joined client-side
        // to avoid an N+1 LEFT JOIN against `room_game_tags`).
        const tagMap = await RoomGameTagsService.getTagMapForRoom(roomId);
        const parseJsonArray = (raw: any): string[] => {
            if (!raw) return [];
            try {
                const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
                return Array.isArray(v) ? v.filter((x: any) => typeof x === 'string' && x) : [];
            } catch { return []; }
        };
        // Shim into the GameRow shape the FE expects (extra fields are additive).
        res.json(rows.map((r: any) => ({
            id: r.id,
            name: r.name,
            display_name: r.display_name,
            manufacturer: r.manufacturer || null,
            year: r.year || null,
            mode: r.type === 'video_game' ? 'videogame' : 'pinball',
            platforms: r.platforms || '[]',
            image_url: r.image_url || null,
            room_tags: tagMap.get(r.id) ?? [],
            designers: parseJsonArray(r.designers),
            themes: parseJsonArray(r.themes),
            table_authors: parseJsonArray(r.table_authors),
            catalogue_aliases: parseJsonArray(r.aliases),
            // v2.5.1 stubs — these per-row override fields lived on game_library;
            // dropped in v2.6.0. FE renders fallbacks.
            aliases: '',
            style_id: '',
            css_title: '',
            css_initials: '',
            css_scores: '',
            css_box: '',
            bg_color: '',
        })));
    } catch (error) {
        logError('API Error (GET rooms/:roomId/game_library):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Per-room game tags (custom platform overlay). See ADR 0008. ---

router.get('/:roomId/games/:globalGameId/tags', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const globalGameId = req.params.globalGameId as string;
        const tags = await RoomGameTagsService.getTagsForGame(roomId, globalGameId);
        res.json({ tags });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/games/:globalGameId/tags):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/:roomId/games/:globalGameId/tags', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const globalGameId = req.params.globalGameId as string;
        const tag = typeof req.body?.tag === 'string' ? req.body.tag : '';
        if (!tag.trim() || tag.length > 50) {
            return res.status(400).json({ error: 'tag must be 1–50 chars' });
        }
        await RoomGameTagsService.addTag(roomId, globalGameId, tag);
        res.json({ success: true, tags: await RoomGameTagsService.getTagsForGame(roomId, globalGameId) });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/games/:globalGameId/tags):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.delete('/:roomId/games/:globalGameId/tags/:tag', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const globalGameId = req.params.globalGameId as string;
        const tag = decodeURIComponent(req.params.tag as string);
        await RoomGameTagsService.removeTag(roomId, globalGameId, tag);
        res.json({ success: true, tags: await RoomGameTagsService.getTagsForGame(roomId, globalGameId) });
    } catch (error) {
        logError('API Error (DELETE rooms/:roomId/games/:globalGameId/tags/:tag):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/:roomId/games/bulk-tag', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const { globalGameIds, tag } = req.body ?? {};
        if (!Array.isArray(globalGameIds) || globalGameIds.length === 0) {
            return res.status(400).json({ error: 'globalGameIds must be a non-empty array' });
        }
        if (globalGameIds.length > 500) {
            return res.status(400).json({ error: 'globalGameIds capped at 500 per call' });
        }
        if (typeof tag !== 'string' || !tag.trim() || tag.length > 50) {
            return res.status(400).json({ error: 'tag must be 1–50 chars' });
        }
        const added = await RoomGameTagsService.bulkAddTag(roomId, globalGameIds, tag);
        res.json({ success: true, added });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/games/bulk-tag):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/:roomId/games/bulk-untag', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const { globalGameIds, tag } = req.body ?? {};
        if (!Array.isArray(globalGameIds) || globalGameIds.length === 0) {
            return res.status(400).json({ error: 'globalGameIds must be a non-empty array' });
        }
        if (globalGameIds.length > 500) {
            return res.status(400).json({ error: 'globalGameIds capped at 500 per call' });
        }
        if (typeof tag !== 'string' || !tag.trim()) {
            return res.status(400).json({ error: 'tag is required' });
        }
        const removed = await RoomGameTagsService.bulkRemoveTag(roomId, globalGameIds, tag);
        res.json({ success: true, removed });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/games/bulk-untag):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ---------------------------------------------------------------------------
// v2.5.0 — per-room game-library proposal flow (replaces the legacy
// "Import VPS" / "Import Wizard" buttons; those duplicate global catalogue work).
//
// Add-Game UX: type a name → /proposals returns dedup matches (exact + possible)
// → user picks one of three commit paths:
//   (a) /use_global       → link to an existing approved global_games row
//   (b) /room_only        → add ONLY to this room's library (no global submission)
//   (c) /submit_to_global → create a pending global_games row + link from this room
//
// (Step 2 cleanup: all writes go to global_games only — game_library +
// game_room_game_library are being torn down.)
// `global_game_id` is set when known; NULL for
// the room-only override path.
// ---------------------------------------------------------------------------

/**
 * POST /:roomId/game_library/proposals — read-only dedup preview.
 * Returns { exact: GlobalGame|null, possible: GlobalGame[] } so the FE can
 * render an "is this it?" / "did you mean one of these?" UI.
 */
router.post('/:roomId/game_library/proposals', requireAuth, requireRoomAccess('roomId'), requireNotBanned, async (req, res) => {
    try {
        const validationResult = validate(GameProposalSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const { GlobalGameService } = await import('../../services/GlobalGameService.js');
        const result = await GlobalGameService.findCandidates(validationResult.data);
        res.json(result);
    } catch (error) {
        logError('API Error (POST rooms/:roomId/game_library/proposals):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /:roomId/game_library/submit_to_global — create a pending global_games
 * row. Once approved by a super-admin via /admin/catalogue/approvals, the
 * game appears in every room's library (which is now the catalogue).
 *
 * Returns 409 when an exact catalogue match exists — the proposal preview
 * should have caught this, but we re-check server-side as defense in depth.
 */
router.post('/:roomId/game_library/submit_to_global', requireAuth, requireRoomAccess('roomId'), requireNotBanned, async (req, res) => {
    try {
        const validationResult = validate(GameProposalSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const roomId = req.params.roomId as string;
        const { name, manufacturer, year, type, platforms } = validationResult.data;

        const { GlobalGameService } = await import('../../services/GlobalGameService.js');
        const candidates = await GlobalGameService.findCandidates({
            name, manufacturer: manufacturer ?? null, year: year ?? null, type, platforms,
        });
        if (candidates.exact) {
            return res.status(409).json({
                error: 'A matching game already exists in the catalogue.',
                exact: candidates.exact,
            });
        }

        const db = await getDatabase();
        // Build a pending global_games row inline (GlobalGameService.upsert
        // would auto-mark it 'approved' — we want 'pending' here, with the
        // submission metadata fields populated).
        const crypto = await import('crypto');
        const newId = crypto.randomUUID();
        const now = new Date().toISOString();
        const submittedByUserId = req.user?.discordId || req.user?.username || null;

        // ADR 0016 catalogue phase §5 — fold here too. This route bypasses
        // `GlobalGameService.upsert` on purpose (upsert forces `approved`; a
        // room proposal must land as `pending`), so it also bypasses the fold
        // upsert applies. A room admin's browser sends whatever id list its
        // platform picker offered, which is legacy for any client older than
        // this release — folding upgrades it instead of seeding the catalogue
        // with the shape the migration just cleaned up.
        const { foldCataloguePlatforms } = await import('../../utils/scoreProvenance.js');
        const proposedFold = foldCataloguePlatforms(platforms || []);
        // migration 130: this route bypasses `GlobalGameService.upsert` (see
        // above), so it also has to write the dedup key itself — a proposal
        // row with a NULL key still dedups correctly but falls into
        // `findByNormalizedName`'s scan branch instead of the index.
        const { normalizeGameName } = await import('../../utils/catalogueUtils.js');
        await db.run(
            `INSERT INTO global_games (
                id, name, normalized_name, manufacturer, year, type, platforms, features, status,
                submitted_by_user_id, submitted_by_room_id, submitted_at, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
            newId,
            name,
            normalizeGameName(name || ''),
            manufacturer ?? null,
            year ?? null,
            type,
            JSON.stringify([...proposedFold.engines, ...proposedFold.dropped]),
            JSON.stringify(proposedFold.features),
            submittedByUserId,
            roomId,
            now,
            now,
        );

        res.status(201).json({ ok: true, gameName: name, globalGameId: newId, status: 'pending' });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/game_library/submit_to_global):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /:roomId/game_library/import-csv-preview — read-only categorisation
 * of a parsed CSV. Bins each row into one of:
 *   - auto_link:    exact match found → already in catalogue, nothing to commit
 *   - auto_submit:  no match at all   → commit will submit_to_global
 *   - needs_review: possible matches  → user picks per-row in the UI
 *
 * Client-side parsing pattern: the FE parses CSV in-browser and posts JSON.
 * The FE holds the preview response in memory and replays the array on
 * commit — no server-side ephemeral session storage needed.
 */
router.post('/:roomId/game_library/import-csv-preview', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const validationResult = validate(ImportCsvPreviewSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const { GlobalGameService } = await import('../../services/GlobalGameService.js');

        type Bucket = 'auto_link' | 'auto_submit' | 'needs_review';
        const rows = await Promise.all(validationResult.data.games.map(async (input, index) => {
            const candidates = await GlobalGameService.findCandidates({
                name: input.name,
                manufacturer: input.manufacturer ?? null,
                year: input.year ?? null,
                type: input.type,
                platforms: input.platforms,
            });
            let bucket: Bucket;
            let suggestedDecision: 'submit_to_global' | null;
            if (candidates.exact) {
                bucket = 'auto_link';
                suggestedDecision = null;
            } else if (candidates.possible.length === 0) {
                bucket = 'auto_submit';
                suggestedDecision = 'submit_to_global';
            } else {
                bucket = 'needs_review';
                suggestedDecision = null;
            }
            return { index, input, candidates, bucket, suggestedDecision };
        }));

        const summary = {
            auto_link:    rows.filter(r => r.bucket === 'auto_link').length,
            auto_submit:  rows.filter(r => r.bucket === 'auto_submit').length,
            needs_review: rows.filter(r => r.bucket === 'needs_review').length,
            total:        rows.length,
        };

        res.json({ rows, summary });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/game_library/import-csv-preview):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /:roomId/game_library/import-csv-commit — applies submit_to_global
 * decisions from the preview UI. Auto_link rows (already in catalogue) are
 * skipped client-side; only pending submissions reach this handler.
 *
 * Per-row best-effort: a single bad row doesn't roll back the others.
 * Returns aggregate counts plus a per-row error list when any rows failed,
 * so the FE can offer a "retry just the failures" UX. If a candidate appears
 * in the catalogue between preview and commit (race with another admin), we
 * skip the row instead of creating a duplicate pending entry.
 */
router.post('/:roomId/game_library/import-csv-commit', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const validationResult = validate(ImportCsvCommitSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const roomId = req.params.roomId as string;
        const submittedByUserId = req.user?.discordId || req.user?.username || null;

        const db = await getDatabase();
        const cryptoMod = await import('crypto');
        const { GlobalGameService } = await import('../../services/GlobalGameService.js');

        const counts = { submitted_pending: 0, skipped: 0, errors: 0 };
        const errors: Array<{ index: number; error: string }> = [];

        for (let i = 0; i < validationResult.data.games.length; i++) {
            const entry = validationResult.data.games[i]!;
            const { input } = entry;
            const platformsJson = JSON.stringify(input.platforms || []);

            try {
                // Defense-in-depth: re-check dedup at commit time. If an exact match has
                // appeared since the preview ran (e.g. another admin's submission), skip
                // rather than creating a duplicate pending row.
                const candidates = await GlobalGameService.findCandidates({
                    name: input.name,
                    manufacturer: input.manufacturer ?? null,
                    year: input.year ?? null,
                    type: input.type,
                    platforms: input.platforms,
                });
                if (candidates.exact) {
                    counts.skipped++;
                    continue;
                }
                const newId = cryptoMod.randomUUID();
                const now = new Date().toISOString();
                // migration 130 — same reason as submit_to_global above.
                const { normalizeGameName } = await import('../../utils/catalogueUtils.js');
                await db.run(
                    `INSERT INTO global_games (
                        id, name, normalized_name, manufacturer, year, type, platforms, status,
                        submitted_by_user_id, submitted_by_room_id, submitted_at, created_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
                    newId,
                    input.name,
                    normalizeGameName(input.name || ''),
                    input.manufacturer ?? null,
                    input.year ?? null,
                    input.type,
                    platformsJson,
                    submittedByUserId,
                    roomId,
                    now,
                    now,
                );
                counts.submitted_pending++;
            } catch (err) {
                counts.errors++;
                errors.push({ index: i, error: (err as Error).message });
            }
        }

        res.json({ ok: counts.errors === 0, counts, errors: errors.length ? errors : undefined });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/game_library/import-csv-commit):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ---------------------------------------------------------------------------
// S23.4 — bulk historical score import (preview → commit).
//
// Shape copies the game-CSV importer above: the FE parses the file in-browser
// with PapaParse and posts JSON; the preview response is held in browser memory
// and replayed on commit. No server-side ephemeral session.
//
// Deliberate NON-behaviours (S23.4 rulings). These rows are historical
// all-time scores an admin is backfilling, not live submissions:
//   - `source='community'`. `score_history.source` has a CHECK constraint of
//     ('tournament','community','sync'); adding a fourth value means rebuilding
//     the biggest table in the DB. 'sync' is wrong because doctrine forces
//     engine/device to 'unknown' for synced rows (ADR 0016 P2) while CSV rows
//     carry real admin-supplied provenance. 'community' = "recorded outside a
//     tournament window", which is exactly what these are.
//   - NO tournament linkage (`submitted_during_tournament_id` stays NULL via
//     `skipTournamentLink`) — otherwise a backfill would silently land on
//     whatever tournament happens to be running right now.
//   - NO Global Scoreboard fan-out. Rows are names, not authenticated users, so
//     `submitted_by_user_id` is NULL; `fanOutFromRoomSubmission`'s guest gate
//     would drop them anyway, but the import path never calls it at all.
//   - NO iScored sync, NO lobby-feed events, NO score toasts — a bulk import
//     must not spam the feed. One `leaderboard:updated` per affected game at
//     the end instead.
// ---------------------------------------------------------------------------

type ScoreImportBucket = 'ok' | 'needs_review' | 'error';

/**
 * Shared per-row resolution for the two routes below. Resolves the game against
 * the global catalogue (which IS the room library, ADR 0007), validates the
 * engine/device pair against that game's scope in this room, and parses the
 * date. Returns the bucket plus everything the commit loop needs.
 */
async function resolveScoreImportRow(roomId: string, raw: unknown): Promise<{
    bucket: ScoreImportBucket;
    error?: string;
    /** Populated for 'ok' rows. */
    resolved?: {
        gameName: string;
        globalGameId: string;
        playerName: string;
        score: number;
        createdAt: string | null;
        engine: string;
        device: string;
        platform: string | null;
        photoUrl: string | null;
    };
    /** Populated for 'needs_review' — the ambiguous catalogue candidates. */
    candidates?: Array<{ id: string; name: string; manufacturer: string | null; year: number | null }>;
}> {
    const parsed = ScoreImportRowSchema.safeParse(raw);
    if (!parsed.success) {
        return { bucket: 'error', error: parsed.error.issues[0]?.message || 'Invalid row' };
    }
    const input = parsed.data;

    const db = await getDatabase();
    const matches = await db.all(
        `SELECT id, name, manufacturer, year FROM global_games
         WHERE LOWER(name) = LOWER(?) AND status = 'approved'
         ORDER BY created_at ASC`,
        input.game_name.trim(),
    );
    if (matches.length === 0) {
        return { bucket: 'error', error: `No catalogue game named "${input.game_name}"` };
    }
    if (matches.length > 1) {
        // The composite identity index lets same-name games from different
        // manufacturers/years coexist (ADR 0004), so a bare name can be
        // genuinely ambiguous. The admin disambiguates in the UI.
        return { bucket: 'needs_review', candidates: matches, error: 'Multiple catalogue games share this name' };
    }
    const game = matches[0]!;

    const { ScoreProvenanceService } = await import('../../services/ScoreProvenanceService.js');
    const scope = await ScoreProvenanceService.resolveForRoomGame(roomId, game.name);
    const provenance = ScoreProvenanceService.validate(scope, input.engine, input.device);
    if (!provenance.ok) return { bucket: 'error', error: provenance.error };

    let createdAt: string | null = null;
    if (input.date && input.date.trim()) {
        const d = new Date(input.date.trim());
        if (Number.isNaN(d.getTime())) {
            return { bucket: 'error', error: `Unparseable date "${input.date}"` };
        }
        createdAt = d.toISOString();
    }

    return {
        bucket: 'ok',
        resolved: {
            gameName: game.name,
            globalGameId: game.id,
            playerName: input.player_name.trim(),
            score: input.score,
            createdAt,
            engine: provenance.engine,
            device: provenance.device,
            platform: provenance.platform,
            photoUrl: input.photo_url?.trim() || null,
        },
    };
}

/**
 * POST /:roomId/scores/import-csv-preview — read-only binning of parsed rows.
 * Nothing is written. `needs_review` means the game name matched more than one
 * catalogue entry; `error` means the row can't be imported as written.
 */
router.post('/:roomId/scores/import-csv-preview', requireAuth, requireRoomAccess('roomId'), requireNotBanned, async (req, res) => {
    try {
        const validationResult = validate(ScoreImportPreviewSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const roomId = req.params.roomId as string;

        const rows = [];
        for (let i = 0; i < validationResult.data.rows.length; i++) {
            const outcome = await resolveScoreImportRow(roomId, validationResult.data.rows[i]);
            rows.push({ index: i, input: validationResult.data.rows[i], ...outcome });
        }

        const summary = {
            ok: rows.filter(r => r.bucket === 'ok').length,
            needs_review: rows.filter(r => r.bucket === 'needs_review').length,
            error: rows.filter(r => r.bucket === 'error').length,
            total: rows.length,
        };
        res.json({ rows, summary });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/scores/import-csv-preview):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /:roomId/scores/import-csv-commit — writes the rows.
 *
 * Drift guard: rather than the identity-preview `previewHash` 409 pattern, this
 * re-resolves every row server-side at commit time (the same discipline the
 * game-CSV commit uses). Cheaper to reason about, and a row that went ambiguous
 * or invalid since the preview is reported per-row instead of failing the batch.
 *
 * Per-row best-effort: one bad row doesn't roll back the others.
 */
router.post('/:roomId/scores/import-csv-commit', requireAuth, requireRoomAccess('roomId'), requireNotBanned, async (req, res) => {
    try {
        const validationResult = validate(ScoreImportCommitSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const roomId = req.params.roomId as string;
        const actor = req.user?.discordId || req.user?.username || 'admin';

        const db = await getDatabase();
        const { ScoreHistoryService } = await import('../../services/ScoreHistoryService.js');

        const counts = { imported: 0, skipped: 0, errors: 0 };
        const errors: Array<{ index: number; error: string }> = [];
        const touchedGameIds = new Set<string>();

        for (let i = 0; i < validationResult.data.rows.length; i++) {
            try {
                const outcome = await resolveScoreImportRow(roomId, validationResult.data.rows[i]);
                if (outcome.bucket !== 'ok' || !outcome.resolved) {
                    counts.skipped++;
                    errors.push({ index: i, error: outcome.error || 'Row not importable' });
                    continue;
                }
                const r = outcome.resolved;

                // A `games` row exists only when this catalogue game is
                // currently pinned or in a tournament for this room. When it
                // is, keep `submissions` (best-per-player-per-game, keyed on
                // games.id) consistent with the new history row. When it isn't,
                // score_history alone is the correct and complete write — the
                // same shape freeplay/community submissions have.
                const gameRow = await db.get(
                    `SELECT g.id FROM games g
                     LEFT JOIN tournaments t ON t.id = g.tournament_id
                     WHERE LOWER(g.name) = LOWER(?)
                       AND COALESCE(t.game_room_id, g.game_room_id) = ?
                     ORDER BY CASE g.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, g.created_at DESC
                     LIMIT 1`,
                    r.gameName, roomId,
                );

                if (gameRow?.id) {
                    await db.run(
                        `INSERT INTO submissions (
                            id, game_id, discord_user_id, iscored_username, score, photo_url, timestamp,
                            submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
                            submitted_by_anonymous_name, merged_from_anonymous_identity_id, platform,
                            engine, device
                         )
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?)
                         ON CONFLICT(id) DO UPDATE SET
                            score = MAX(score, excluded.score),
                            photo_url = COALESCE(excluded.photo_url, submissions.photo_url),
                            platform = COALESCE(excluded.platform, submissions.platform),
                            engine = COALESCE(NULLIF(excluded.engine, 'unknown'), submissions.engine, 'unknown'),
                            device = COALESCE(NULLIF(excluded.device, 'unknown'), submissions.device, 'unknown')`,
                        `${gameRow.id}-${r.playerName.toLowerCase()}`, gameRow.id, 'SYSTEM',
                        r.playerName, r.score, r.photoUrl, r.createdAt || new Date().toISOString(),
                        roomId, r.playerName, r.platform, r.engine, r.device,
                    );
                    touchedGameIds.add(gameRow.id);
                }

                await ScoreHistoryService.log({
                    gameName: r.gameName,
                    gameRoomId: roomId,
                    gameId: gameRow?.id,
                    username: r.playerName,
                    score: r.score,
                    photoUrl: r.photoUrl ?? undefined,
                    source: 'community',
                    // Historical backfill — never attach to a live tournament.
                    skipTournamentLink: true,
                    anonymousName: r.playerName,
                    platform: r.platform,
                    engine: r.engine,
                    device: r.device,
                });

                // Backdating: ScoreHistoryService.log always stamps
                // created_at = now. When the CSV supplied a date, correct the
                // row we just wrote so the history reads chronologically.
                if (r.createdAt) {
                    await db.run(
                        `UPDATE score_history SET created_at = ?
                         WHERE id = (SELECT MAX(id) FROM score_history
                                     WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?)
                                       AND LOWER(iscored_username) = LOWER(?) AND score = ?)`,
                        r.createdAt, roomId, r.gameName, r.playerName, r.score,
                    );
                }

                counts.imported++;
            } catch (err) {
                counts.errors++;
                errors.push({ index: i, error: (err as Error).message });
            }
        }

        // One broadcast per affected game (no per-row toasts — see the block
        // comment above).
        if (touchedGameIds.size > 0) {
            const { LeaderboardService } = await import('../../services/LeaderboardService.js');
            const { emitLeaderboardUpdated } = await import('../websocket.js');
            for (const gameId of touchedGameIds) {
                await LeaderboardService.invalidate(gameId);
                emitLeaderboardUpdated(roomId, { gameId });
            }
        }

        // Explicit audit write — auditMiddleware does NOT fire on router routes.
        await AuditService.log({
            actor,
            action: 'scores_bulk_imported',
            target_type: 'game_room',
            target_id: roomId,
            details: JSON.stringify({
                submitted: validationResult.data.rows.length,
                imported: counts.imported,
                skipped: counts.skipped,
                errors: counts.errors,
            }),
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

        logInfo(`Bulk score import for room ${roomId} by ${actor}: ${counts.imported} imported, ${counts.skipped} skipped, ${counts.errors} errors`);
        res.json({ ok: counts.errors === 0 && counts.skipped === 0, counts, errors: errors.length ? errors : undefined });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/scores/import-csv-commit):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Ratings
// v2.86.0 — room-scoped (migration 139): a game's rating aggregate no longer
// bleeds across rooms sharing a name. Reads stay open; "your rating"
// personalization prefers the Bearer token's identity (votes are keyed on
// discordId now), falling back to x-user-id for tokenless callers — without
// the token path, a Discord-authed admin rating from the library page (whose
// api.ts client sends the admin token + an anon uuid) would never see their
// own stars again after a reload.
router.get('/:roomId/ratings', optionalDiscordUser, async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const ratings = await RatingService.getAllRatings(roomId);
        const userId = req.user?.discordId || (req.headers['x-user-id'] as string) || '';
        const userRatings = userId ? await RatingService.getUserRatings(roomId, userId) : {};
        res.json({ ratings, userRatings });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/ratings):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/:roomId/ratings/:gameName', optionalDiscordUser, async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const gameName = decodeURIComponent(req.params.gameName as string);
        const userId = req.user?.discordId || (req.headers['x-user-id'] as string) || '';
        const info = await RatingService.getGameRating(roomId, gameName, userId || undefined);
        res.json(info);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/ratings/:gameName):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// v2.86.0 — requires Discord login; voter is the token's discordId, not the
// client-supplied x-user-id (which made rating ballot-stuffing trivial —
// clear localStorage, vote again).
router.post('/:roomId/ratings/:gameName', guestContentLimiter, requireDiscordUser, requireNotBanned, async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const gameName = decodeURIComponent(req.params.gameName as string);
        const userId = req.user!.discordId!;
        const rating = Number(req.body?.rating);
        if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1-5' });
        await RatingService.setRating(roomId, gameName, userId, rating);
        const info = await RatingService.getGameRating(roomId, gameName, userId);
        res.json(info);
    } catch (error) {
        logError('API Error (POST rooms/:roomId/ratings/:gameName):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Dashboard
router.get('/:roomId/dashboard', async (req, res) => {
    try {
        const data = await getDashboardData(req.params.roomId as string);
        res.json(data);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/dashboard):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// History
router.get('/:roomId/history', async (req, res) => {
    try {
        const validationResult = validate(HistoryQuerySchema, req.query);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const { page, limit, tournament_id, type } = validationResult.data;
        const offset = (page - 1) * limit;
        const db = await getDatabase();

        const conditions: string[] = ["g.status IN ('COMPLETED', 'ARCHIVED')"];
        const params: unknown[] = [];

        // Room filter via tournament
        conditions.push('t.game_room_id = ?');
        params.push(req.params.roomId as string);

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
                g.id AS game_id,
                t.id AS tournament_id,
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
                WHERE orphaned_at IS NULL
            ) s ON s.game_id = g.id AND s.rn = 1
            WHERE ${whereClause}
            ORDER BY g.end_date DESC
            LIMIT ? OFFSET ?`,
            ...params, limit, offset
        );

        res.json({ results, total, page, limit });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/history):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Per-tournament score boards (public) — every score submitted DURING one
// tournament, one board per game it featured. Backs `/:slug/tournaments/:id`,
// the click-through target of each History row. See TournamentScoresService for
// why this keys on `submitted_during_tournament_id` and never joins `games` on
// `score_history.game_id`.
router.get('/:roomId/tournaments/:tournamentId/scores', async (req, res) => {
    try {
        const data = await TournamentScoresService.getTournamentScores(
            req.params.roomId as string,
            req.params.tournamentId as string,
        );
        // Missing and wrong-room are the same 404 — a tournament id must not be
        // probeable from a room it doesn't belong to.
        if (!data) return res.status(404).json({ error: 'Tournament not found' });
        res.json(data);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/tournaments/:tournamentId/scores):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Auth + room access endpoints ---

// Settings (room-scoped)
router.get('/:roomId/settings', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const settings = await GameRoomSettingsService.getAll(req.params.roomId as string);
        const { maskEncryptedValues } = await import('../../utils/secrets.js');
        res.json(maskEncryptedValues(settings));
    } catch (error) {
        logError('API Error (GET rooms/:roomId/settings):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/:roomId/settings', requireAuth, requireRoomAccess('roomId'), requireNotBanned, async (req, res) => {
    try {
        const validationResult = validate(SettingsSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const roomId = req.params.roomId as string;
        await GameRoomSettingsService.saveMany(roomId, validationResult.data);

        // Log activity event
        const { RoomEventService } = await import('../../services/RoomEventService.js');
        RoomEventService.log(roomId, 'settings_change', { keys: Object.keys(validationResult.data) }).catch(() => {});

        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/settings):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Tournaments
router.get('/:roomId/tournaments', async (req, res) => {
    try {
        const rows = await TournamentService.getAll(req.params.roomId as string);
        res.json(rows);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/tournaments):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/:roomId/tournaments', requireAuth, requireRoomAccess('roomId'), requireNotBanned, async (req, res) => {
    try {
        const validationResult = validate(CreateTournamentSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const data = { ...validationResult.data, game_room_id: req.params.roomId as string };
        await TournamentService.create(data);
        const { Scheduler } = await import('../../engine/Scheduler.js');
        await Scheduler.getInstance().reload();
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/tournaments):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.put('/:roomId/tournaments/:id', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const validationResult = validate(UpdateTournamentSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const data = { ...validationResult.data, game_room_id: req.params.roomId as string };
        await TournamentService.update(req.params.id as string, data);
        const { Scheduler } = await import('../../engine/Scheduler.js');
        await Scheduler.getInstance().reload();
        res.json({ success: true });
    } catch (error) {
        logError('API Error (PUT rooms/:roomId/tournaments/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// S7 — focused pause/resume toggle. Flips tournaments.is_active and reloads the
// Scheduler (which registers/removes the maintenance cron). Preferred over PUT
// so the FE pause button doesn't round-trip the whole config (no clobber of a
// concurrent edit). Audit is automatic (PATCH → target_type 'tournament').
router.patch('/:roomId/tournaments/:id/active', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const tournamentId = req.params.id as string;
        const validationResult = validate(ToggleTournamentActiveSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const db = await getDatabase();
        const tournament = await db.get('SELECT game_room_id FROM tournaments WHERE id = ?', tournamentId);
        if (!tournament || tournament.game_room_id !== roomId) {
            return res.status(404).json({ error: 'Tournament not found' });
        }

        const { is_active } = validationResult.data;
        await TournamentService.setActive(tournamentId, is_active);
        const { Scheduler } = await import('../../engine/Scheduler.js');
        await Scheduler.getInstance().reload();

        res.json({ success: true, is_active });
    } catch (error) {
        logError('API Error (PATCH rooms/:roomId/tournaments/:id/active):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.delete('/:roomId/tournaments/:id', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        // S0 (Phase 0): guard against orphaning live games. A bare DELETE here
        // leaves any ACTIVE/QUEUED games with a dangling tournament_id — they
        // drop out of every game_room_id-scoped admin query AND stop importing
        // scores (the poller INNER JOINs tournaments). Block with a 409 listing
        // the blockers; S7 adds an auto-deactivate option in the confirm modal.
        const db = await getDatabase();
        const blockers = await db.all(
            `SELECT id, name, status FROM games
             WHERE tournament_id = ? AND status IN ('ACTIVE', 'QUEUED')`,
            req.params.id as string
        );
        if (blockers.length > 0) {
            return res.status(409).json({
                error: 'Tournament has active or queued games. Deactivate or remove them before deleting the tournament.',
                games: blockers.map((g: any) => ({ id: g.id, name: g.name, status: g.status })),
            });
        }
        await TournamentService.delete(req.params.id as string);
        const { Scheduler } = await import('../../engine/Scheduler.js');
        await Scheduler.getInstance().reload();
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE rooms/:roomId/tournaments/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Tournament game activation
router.post('/:roomId/tournaments/:id/activate-game', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const tournamentId = req.params.id as string;
        const { gameName } = req.body;
        if (!gameName || typeof gameName !== 'string') {
            return res.status(400).json({ error: 'gameName is required' });
        }

        const db = await getDatabase();
        const tournament = await db.get('SELECT id, name, type, mode, discord_channel_id, game_room_id, platform_rules FROM tournaments WHERE id = ?', tournamentId);
        if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

        // Enforce platform rules. Game's effective platforms = catalogue ∪ room tags.
        const platformRules = parseTournamentRules(tournament);
        if (hasAnyPlatformRules(platformRules)) {
            const gameLibRow = await db.get(
                `SELECT platforms, features FROM global_games WHERE LOWER(name) = LOWER(?) AND status = 'approved' LIMIT 1`,
                gameName,
            );
            const cataloguePlatforms = parsePlatformsList(gameLibRow?.platforms || '[]');
            const roomTags = await RoomGameTagsService.getTagsForGameName(tournament.game_room_id, gameName);
            const gamePlatforms = Array.from(new Set([...cataloguePlatforms, ...roomTags]));
            const gameFeatures = parsePlatformsList(gameLibRow?.features || '[]');
            if (!passesplatformRules(gamePlatforms, platformRules, gameFeatures)) {
                return res.status(400).json({ error: `Game "${gameName}" does not meet this tournament's platform requirements` });
            }
        }

        const { TournamentEngine } = await import('../../engine/TournamentEngine.js');
        const engine = TournamentEngine.getInstance();

        const styleId: string | undefined = undefined;

        // v2.6.x: use per-room creds (with env fallback inside the helper) so
        // activate/deactivate paths agree on which iScored account they're
        // hitting. Pre-fix this used `new IScoredClient()` which ignored
        // per-room config and went straight to env, allowing activations to
        // succeed against env creds while later deactivations failed against
        // misconfigured per-room creds — leaving orphaned games on iScored.
        let iscoredId: string | undefined;
        const { GameRoomSettingsService } = await import('../../services/GameRoomSettingsService.js');
        const iscoredSetting = await GameRoomSettingsService.get(req.params.roomId as string, 'ISCORED_ENABLED');
        const iscoredEnabled = iscoredSetting !== 'false';
        const { getIScoredCredsForRoom } = await import('../../utils/iscoredCreds.js');
        const creds = iscoredEnabled ? await getIScoredCredsForRoom(req.params.roomId as string) : null;
        const hasCredentials = !!creds;
        if (hasCredentials) {
            const { IScoredSessionRegistry } = await import('../../engine/IScoredSessionRegistry.js');
            iscoredId = await IScoredSessionRegistry.getInstance().withSession(creds!, async (client) => {
                const id = await client.createGame(gameName, styleId);
                await client.setGameTags(id, tournament.type);
                await client.setGameStatus(id, { locked: false, hidden: false });
                return id;
            });
        }

        await db.exec('BEGIN TRANSACTION');
        try {
            const game = await engine.activateGame(tournamentId, gameName, styleId, iscoredId, false);
            await db.exec('COMMIT');
            logInfo(`Admin activated game: ${gameName} for tournament ${tournamentId}`);
            res.json({ success: true, gameId: game.id });

            // Announce activation in Discord
            const channelId = tournament.discord_channel_id || (await GameRoomSettingsService.get(req.params.roomId as string, 'DISCORD_ANNOUNCEMENT_CHANNEL_ID'));
            if (channelId) {
                const { EmbedBuilder } = await import('discord.js');
                const { sendChannelEmbed, getTournamentColor } = await import('../../utils/discord.js');
                const color = getTournamentColor(tournament.type);
                const embed = new EmbedBuilder()
                    .setTitle(`Now Active: ${gameName}`)
                    .setDescription(`A new game has been activated for **${tournament.name}**. Get your scores in!`)
                    .setColor(color)
                    .setFooter({ text: tournament.name })
                    .setTimestamp();
                sendChannelEmbed(channelId, embed).catch(err =>
                    logWarn('Failed to send activation announcement:', err)
                );
            }

            if (hasCredentials) {
                engine.reorderIScoredLineup().catch(err =>
                    logWarn('Failed to reorder iScored lineup after activation:', err)
                );
            }
        } catch (dbError) {
            await db.exec('ROLLBACK');
            throw dbError;
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Internal Server Error';
        logError('API Error (POST rooms/:roomId/tournaments/:id/activate-game):', error);
        res.status(500).json({ error: message });
    }
});

// Pin a game from the room's library to the scoreboard as a standalone
// (non-tournament) entry. Body: { gameName, createOnIScored?, iScoredTags? }.
// v2.4.0 feature — see src/engine/gameCreation.ts for the data-model invariants.
router.post('/:roomId/games/pin', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const { gameName, createOnIScored, iScoredTags } = req.body ?? {};
        if (!gameName || typeof gameName !== 'string') {
            return res.status(400).json({ error: 'gameName is required' });
        }
        if (createOnIScored !== undefined && typeof createOnIScored !== 'boolean') {
            return res.status(400).json({ error: 'createOnIScored must be a boolean' });
        }
        if (iScoredTags !== undefined && (!Array.isArray(iScoredTags) || iScoredTags.some((t: unknown) => typeof t !== 'string'))) {
            return res.status(400).json({ error: 'iScoredTags must be an array of strings' });
        }

        // Validate the game exists in the catalogue to prevent typo pins.
        const db = await getDatabase();
        const exists = await db.get(
            `SELECT 1 FROM global_games WHERE name = ? COLLATE NOCASE AND status = 'approved' LIMIT 1`,
            gameName,
        );
        if (!exists) {
            return res.status(404).json({ error: `Game "${gameName}" not found in the catalogue — pin the canonical name` });
        }

        try {
            const { pinGameToScoreboard } = await import('../../engine/gameCreation.js');
            const result = await pinGameToScoreboard({
                roomId, gameName, createOnIScored: !!createOnIScored,
                iScoredTags: iScoredTags ?? ['MG'],
            });
            res.json(result);
        } catch (err) {
            // Unique-partial-index violation (074) = double pin attempt.
            const msg = err instanceof Error ? err.message : String(err);
            if (/UNIQUE constraint failed/i.test(msg)) {
                return res.status(409).json({ error: `"${gameName}" is already pinned in this room` });
            }
            throw err;
        }
    } catch (error) {
        logError('API Error (POST rooms/:roomId/games/pin):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Unpin a standalone game. Query: ?deleteOnIScored=true to also remove the
// iScored row. Score history is always preserved (submissions.game_id → NULL
// before DELETE).
router.delete('/:roomId/games/pinned/:gameId', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const gameId = req.params.gameId as string;
        const deleteOnIScored = req.query.deleteOnIScored === 'true';

        const { unpinGameFromScoreboard } = await import('../../engine/gameCreation.js');
        const result = await unpinGameFromScoreboard({ roomId, gameId, deleteOnIScored });
        if (!result.deleted) {
            return res.status(404).json({ error: 'Pinned game not found in this room' });
        }
        res.json(result);
    } catch (error) {
        logError('API Error (DELETE rooms/:roomId/games/pinned/:gameId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * Validate this room's iScored credentials with a quick login attempt.
 * Returns `{ ok: true }` on success or `{ ok: false, error }` on auth failure.
 * 200 status either way — auth failure is a valid response, not a server error.
 *
 * Login is the slow path (Playwright, ~10–20s with retry). Caller should
 * disable the button while in flight.
 */
router.post('/:roomId/iscored/validate', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const { getIScoredCredsForRoom } = await import('../../utils/iscoredCreds.js');
        const creds = await getIScoredCredsForRoom(roomId);
        if (!creds) {
            return res.json({
                ok: false,
                error: 'No iScored credentials configured for this room (and no environment fallback set).',
            });
        }
        const { IScoredSessionRegistry } = await import('../../engine/IScoredSessionRegistry.js');
        try {
            // Driving an empty fn through the registry exercises the same
            // connect path as real work; if creds are bad, withSession throws.
            await IScoredSessionRegistry.getInstance().withSession(creds, async () => {});
            res.json({ ok: true, username: creds.username });
        } catch (err) {
            res.json({
                ok: false,
                username: creds.username,
                error: err instanceof Error ? err.message : 'Login failed',
            });
        }
    } catch (error) {
        logError('API Error (POST rooms/:roomId/iscored/validate):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Game deactivation
router.post('/:roomId/games/:id/deactivate', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const gameId = req.params.id as string;
        const { TournamentEngine } = await import('../../engine/TournamentEngine.js');
        const engine = TournamentEngine.getInstance();
        const dbOnly = req.body?.dbOnly === true;
        const result = await engine.deactivateGame(gameId, dbOnly);
        res.json({ success: true, ...result });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Internal Server Error';
        logError('API Error (POST rooms/:roomId/games/:id/deactivate):', error);
        res.status(400).json({ error: message });
    }
});

// COMPLETED games that still appear on the public scoreboard because their
// tournament's cleanup_rule retains them (mode='scheduled' or mode='retain'
// with count>0). Surfaces them so admins can Delete one before the scheduled
// cleanup fires — otherwise a deactivated game with no scores can sit on the
// scoreboard indefinitely with no admin affordance to remove it. Mirrors the
// retention logic in LeaderboardService.getActiveLeaderboards.
router.get('/:roomId/games/retained-completed', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const db = await getDatabase();

        const tournaments = await db.all(
            `SELECT id, name, type, cleanup_rule, COALESCE(display_order, 9999) AS display_order
             FROM tournaments WHERE is_active = 1 AND game_room_id = ?`,
            roomId,
        );

        const rows: any[] = [];
        for (const t of tournaments as Array<{ id: string; name: string; type: string; cleanup_rule: string }>) {
            let rule: { mode?: string; count?: number } = { mode: 'retain', count: 0 };
            try { rule = JSON.parse(t.cleanup_rule || '{}'); } catch {}

            if (rule.mode === 'immediate' || (rule.mode === 'retain' && (rule.count || 0) === 0)) continue;

            // Hard cap on scheduled mode so a long-running tournament with
            // years of history doesn't dump everything into the admin table.
            const limit = rule.mode === 'retain' ? (rule.count || 0) : 100;
            const games = await db.all(
                `SELECT g.id, g.name, g.display_name, g.status, g.iscored_id, g.end_date,
                        ? AS tournament_id, ? AS tournament_name, ? AS tournament_type
                 FROM games g
                 WHERE g.tournament_id = ? AND g.status = 'COMPLETED'
                 ORDER BY g.end_date DESC
                 LIMIT ?`,
                t.id, t.name, t.type, t.id, limit,
            );
            rows.push(...games);
        }

        // Most recently ended first across tournaments.
        rows.sort((a, b) => (b.end_date || '').localeCompare(a.end_date || ''));
        res.json(rows);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/games/retained-completed):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Destructive removal — pairs with deactivate. Use when a game was activated
// in the wrong tournament (or otherwise should never have existed).
// Final-syncs scores, deletes from iScored, orphans local scores (preserves
// player history per ADR 0005), and DELETEs the games row. Scoped to the room
// so admins can only remove games inside rooms they manage.
router.delete('/:roomId/games/:id', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const gameId = req.params.id as string;
        const db = await getDatabase();

        // Verify the game lives in this room (via tournament join, or via
        // games.game_room_id for pinned rows that have no tournament_id).
        const game = await db.get(`
            SELECT g.id, g.status, g.tournament_id,
                   COALESCE(t.game_room_id, g.game_room_id) AS resolved_room_id
            FROM games g LEFT JOIN tournaments t ON t.id = g.tournament_id
            WHERE g.id = ?
        `, gameId);
        if (!game) return res.status(404).json({ error: 'Game not found' });
        if (game.resolved_room_id !== roomId) {
            return res.status(404).json({ error: 'Game not found in this room' });
        }

        // S7 — active/queued siblings list. Returned in both the 409 block
        // payload (so the FE can offer "deactivate and remove") and the success
        // response. Scoped to the SAME tournament so the modal shows siblings;
        // for a pinned row (tournament_id NULL) this resolves to just itself if
        // ACTIVE.
        const siblings = game.tournament_id
            ? await db.all(
                `SELECT id, name, status FROM games
                 WHERE tournament_id = ? AND status IN ('ACTIVE','QUEUED')`,
                game.tournament_id
            )
            : await db.all(
                `SELECT id, name, status FROM games
                 WHERE id = ? AND status IN ('ACTIVE','QUEUED')`,
                gameId
            );
        const games = siblings.map((g: any) => ({ id: g.id, name: g.name, status: g.status }));

        const deactivateActive = req.body?.deactivateActive === true || req.query.deactivateActive === 'true';

        const { TournamentEngine } = await import('../../engine/TournamentEngine.js');
        const engine = TournamentEngine.getInstance();
        const { RoomEventService } = await import('../../services/RoomEventService.js');

        // Default behavior on an ACTIVE game: block with 409 and the blocker
        // list. The FE confirm modal re-submits with deactivateActive:true.
        if (game.status === 'ACTIVE' && !deactivateActive) {
            return res.status(409).json({
                error: 'Game is active. Deactivate it first, or pass deactivateActive to deactivate-and-remove.',
                games,
            });
        }

        // Deactivate-and-remove branch: end-of-round semantics (finalSync +
        // iScored lock + mark COMPLETED). Does NOT delete the row, so there's
        // nothing to orphan — iscored_id stays non-NULL for cleanup policies.
        if (game.status === 'ACTIVE' && deactivateActive) {
            const deactivateResult = await engine.deactivateGame(gameId);
            await RoomEventService.log(roomId, 'game_deactivated', {
                gameName: deactivateResult.gameName,
                tournamentName: deactivateResult.tournamentName,
                iscoredStatus: deactivateResult.iscoredStatus,
            });
            return res.json({ success: true, action: 'deactivated', ...deactivateResult, games });
        }

        // Otherwise (COMPLETED / QUEUED / pinned-inactive): destructive removal
        // with ADR 0005 orphan-then-delete (handled inside deleteGameCompletely).
        const result = await engine.deleteGameCompletely(gameId);
        await RoomEventService.log(roomId, 'game_deleted', {
            gameName: result.gameName,
            tournamentName: result.tournamentName,
            iscoredStatus: result.iscoredStatus,
            scoresOrphaned: result.scoresOrphaned,
        });

        res.json({ success: true, action: 'deleted', ...result });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Internal Server Error';
        logError('API Error (DELETE rooms/:roomId/games/:id):', error);
        res.status(400).json({ error: message });
    }
});

// Active games list
router.get('/:roomId/games/active', async (req, res) => {
    try {
        const db = await getDatabase();
        const rows = await db.all(
            `SELECT g.id, g.name, g.display_name, g.tournament_id, g.iscored_id, g.start_date,
                    g.catalogue_style_id, g.style_header_disabled,
                    t.name as tournament_name, t.type as tournament_type
             FROM games g JOIN tournaments t ON g.tournament_id = t.id
             WHERE g.status = 'ACTIVE' AND t.game_room_id = ?
             ORDER BY g.start_date DESC`,
            req.params.roomId as string
        );
        res.json(rows);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/games/active):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Update game display name
router.patch('/:roomId/admin/games/:gameId/display-name', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const gameId = req.params.gameId as string;
        const roomId = req.params.roomId as string;
        const { displayName } = req.body;
        if (displayName !== null && displayName !== undefined && typeof displayName !== 'string') {
            return res.status(400).json({ error: 'displayName must be a string or null' });
        }
        const db = await getDatabase();
        // Verify game belongs to this room
        const game = await db.get(
            `SELECT g.id, g.name FROM games g JOIN tournaments t ON g.tournament_id = t.id WHERE g.id = ? AND t.game_room_id = ?`,
            gameId, roomId
        );
        if (!game) return res.status(404).json({ error: 'Game not found in this room' });

        const value = displayName?.trim() || null;
        await db.run('UPDATE games SET display_name = ? WHERE id = ?', value, gameId);

        // Invalidate leaderboard cache
        const { LeaderboardService } = await import('../../services/LeaderboardService.js');
        await LeaderboardService.invalidate(gameId);

        res.json({ success: true, displayName: value });
    } catch (error) {
        logError('API Error (PATCH rooms/:roomId/admin/games/:gameId/display-name):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Update game notes
router.patch('/:roomId/admin/games/:gameId/notes', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const gameId = req.params.gameId as string;
        const roomId = req.params.roomId as string;
        const { notes } = req.body;
        const db = await getDatabase();

        const game = await db.get(`
            SELECT g.*, t.game_room_id
            FROM games g JOIN tournaments t ON g.tournament_id = t.id
            WHERE g.id = ? AND t.game_room_id = ?
        `, gameId, roomId);
        if (!game) return res.status(404).json({ error: 'Game not found in this room' });

        const value = typeof notes === 'string' ? notes.trim() || null : null;
        await db.run('UPDATE games SET notes = ? WHERE id = ?', value, gameId);

        const { LeaderboardService } = await import('../../services/LeaderboardService.js');
        await LeaderboardService.invalidate(gameId);

        res.json({ success: true, notes: value });
    } catch (error) {
        logError('API Error (PATCH rooms/:roomId/admin/games/:gameId/notes):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Get default catalogue style for a game in room's library
router.get('/:roomId/game_library/:name/style', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const gameName = decodeURIComponent(req.params.name as string);
        const style = await GameLibraryService.getRoomGameStyle(req.params.roomId as string, gameName);
        res.json({ catalogueStyleId: style?.catalogue_style_id || null, headerDisabled: style?.style_header_disabled === 1 });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/game_library/:name/style):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Set default catalogue style for a game in room's library
router.put('/:roomId/game_library/:name/style', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const gameName = decodeURIComponent(req.params.name as string);
        const validationResult = validate(AssignStyleSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const { catalogueStyleId, headerDisabled } = validationResult.data;
        const updated = await GameLibraryService.setRoomGameStyle(
            req.params.roomId as string, gameName, catalogueStyleId, headerDisabled
        );
        if (!updated) return res.status(404).json({ error: 'Game not found in room library' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (PUT rooms/:roomId/game_library/:name/style):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Clear default catalogue style for a game in room's library
router.delete('/:roomId/game_library/:name/style', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const gameName = decodeURIComponent(req.params.name as string);
        await GameLibraryService.setRoomGameStyle(req.params.roomId as string, gameName, null, false);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE rooms/:roomId/game_library/:name/style):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Ranking groups (write operations)
router.post('/:roomId/ranking-groups', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const validationResult = validate(CreateRankingGroupSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const { RankingService } = await import('../../services/RankingService.js');
        const data = { ...validationResult.data, game_room_id: req.params.roomId as string };
        await RankingService.create(data);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/ranking-groups):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.put('/:roomId/ranking-groups/:id', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const validationResult = validate(UpdateRankingGroupSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const { RankingService } = await import('../../services/RankingService.js');
        await RankingService.update(req.params.id as string, validationResult.data);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (PUT rooms/:roomId/ranking-groups/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.delete('/:roomId/ranking-groups/:id', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { RankingService } = await import('../../services/RankingService.js');
        await RankingService.delete(req.params.id as string);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE rooms/:roomId/ranking-groups/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/:roomId/ranking-groups/:id/recompute', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { RankingService } = await import('../../services/RankingService.js');
        await RankingService.invalidate(req.params.id as string);
        const rankings = await RankingService.computeRankings(req.params.id as string);
        res.json({ success: true, count: rankings.length });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/ranking-groups/:id/recompute):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Merge / rename player (sync-alias username rewrite).
//
// S7 SECURITY: gate relaxed from requireSuperAdmin → requireRoomAccess. This is
// SAFE *only because* every score-table UPDATE/DELETE below is room-scoped to
// :roomId via explicit WHERE clauses (direct game_room_id column where present;
// game→tournament join for submissions/scores which have no room column). The
// room-scoping is the SOLE guarantee that a room_admin cannot touch another
// room's data — there must be NO bare LOWER(iscored_username) statement here.
//
// The two GLOBAL identity writes (user_mappings UPDATE + player_aliases INSERT)
// affect cross-room attribution + forward-sync for every room, so they run ONLY
// when the caller is super_admin (`includeGlobalIdentity`). A room_admin rename
// runs ONLY the four room-scoped score-table statements.
//
// Audit: automatic — auditLog wraps res.json for 2xx POST and maps /merge-player
// → target_type 'player' (auditMiddleware). Dry-run (?dryRun=true | body dryRun)
// runs the gathering SELECTs only — no writes.
router.post('/:roomId/admin/merge-player', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const validationResult = validate(MergePlayerSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const { fromUsername, toUsername } = validationResult.data;
        if (fromUsername.toLowerCase() === toUsername.toLowerCase()) {
            return res.status(400).json({ error: 'Source and target usernames are the same' });
        }

        const isSuperAdmin = req.user?.role === 'super_admin';
        const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;

        const { MergeService } = await import('../../services/MergeService.js');

        // DRY-RUN: same room-scoped gathering SELECTs as the commit, no writes.
        if (dryRun) {
            const rowsAffected = await MergeService.previewRename(roomId, fromUsername, toUsername, isSuperAdmin);
            return res.json({
                dryRun: true,
                rowsAffected: {
                    submissions: rowsAffected.submissions,
                    scores: rowsAffected.scores,
                    community_scores: rowsAffected.community_scores,
                    score_history: rowsAffected.score_history,
                    user_mappings: rowsAffected.user_mappings,
                    player_aliases: rowsAffected.player_aliases,
                },
                total: rowsAffected.total,
                globalIdentityWillUpdate: isSuperAdmin,
            });
        }

        const db = await getDatabase();

        // 1. submissions: rename the `${gameId}-${username}` IDs and keep the
        //    higher score on conflicts. Source set is room-scoped via the
        //    game→tournament join (submissions has no room column); g.game_room_id
        //    is the OR branch for pinned rows (tournament_id NULL).
        const syncRows = await db.all(
            `SELECT s.id, s.game_id, s.score FROM submissions s
             LEFT JOIN games g ON g.id = s.game_id
             LEFT JOIN tournaments t ON t.id = g.tournament_id
             WHERE LOWER(s.iscored_username) = LOWER(?)
               AND s.id LIKE '%' || '-' || ?
               AND (s.submitted_from_room_id = ? OR t.game_room_id = ? OR g.game_room_id = ?)`,
            fromUsername, fromUsername.toLowerCase(), roomId, roomId, roomId
        );
        let submissionsRenamed = 0;
        for (const row of syncRows) {
            const newId = `${row.game_id}-${toUsername.toLowerCase()}`;
            const existing = await db.get('SELECT id, score FROM submissions WHERE id = ?', newId);
            if (existing) {
                if (row.score > existing.score) {
                    // Source has higher score — replace target
                    await db.run('DELETE FROM submissions WHERE id = ?', existing.id);
                    await db.run('UPDATE submissions SET id = ?, iscored_username = ? WHERE id = ?', newId, toUsername, row.id);
                } else {
                    // Target has higher or equal score — delete source
                    await db.run('DELETE FROM submissions WHERE id = ?', row.id);
                }
            } else {
                await db.run('UPDATE submissions SET id = ?, iscored_username = ? WHERE id = ?', newId, toUsername, row.id);
            }
            submissionsRenamed++;
        }

        // 2. Catch any remaining room-scoped submissions not matched by ID pattern.
        const subResult = await db.run(
            `UPDATE submissions SET iscored_username = ?
             WHERE id IN (
                SELECT s.id FROM submissions s
                LEFT JOIN games g ON g.id = s.game_id
                LEFT JOIN tournaments t ON t.id = g.tournament_id
                WHERE LOWER(s.iscored_username) = LOWER(?)
                  AND (s.submitted_from_room_id = ? OR t.game_room_id = ? OR g.game_room_id = ?))`,
            toUsername, fromUsername, roomId, roomId, roomId
        );

        // 3. Scores table (no room column, no submitted_from_room_id → join only).
        const scoreResult = await db.run(
            `UPDATE scores SET iscored_username = ?
             WHERE id IN (
                SELECT sc.id FROM scores sc
                LEFT JOIN games g ON g.id = sc.game_id
                LEFT JOIN tournaments t ON t.id = g.tournament_id
                WHERE LOWER(sc.iscored_username) = LOWER(?)
                  AND (t.game_room_id = ? OR g.game_room_id = ?))`,
            toUsername, fromUsername, roomId, roomId
        );

        // 4. Community scores (direct game_room_id column).
        const communityResult = await db.run(
            'UPDATE community_scores SET iscored_username = ? WHERE LOWER(iscored_username) = LOWER(?) AND game_room_id = ?',
            toUsername, fromUsername, roomId
        );

        // 5. Score history (direct game_room_id column).
        const historyResult = await db.run(
            'UPDATE score_history SET iscored_username = ? WHERE LOWER(iscored_username) = LOWER(?) AND game_room_id = ?',
            toUsername, fromUsername, roomId
        );

        let globalIdentityUpdated = false;
        let userMappingsAffected = 0;
        if (isSuperAdmin) {
            // Count the from-rows BEFORE the rewrite so rowsAffected matches the
            // dry-run computation exactly (which counts LOWER(from)).
            userMappingsAffected = (await db.get<{ n: number }>(
                'SELECT COUNT(*) AS n FROM user_mappings WHERE LOWER(iscored_username) = LOWER(?)', fromUsername
            ))?.n ?? 0;

            // 6. User mappings (GLOBAL — cross-room attribution). super_admin only.
            await db.run(
                'UPDATE user_mappings SET iscored_username = ? WHERE LOWER(iscored_username) = LOWER(?)',
                toUsername, fromUsername
            );

            // 7. Fix discord_user_id on merged rows — resolve target's real
            //    Discord ID. Scoped to this room so it can't touch other tenants.
            const targetMapping = await db.get(
                'SELECT discord_user_id FROM user_mappings WHERE LOWER(iscored_username) = LOWER(?)',
                toUsername
            );
            if (targetMapping?.discord_user_id) {
                await db.run(
                    `UPDATE submissions SET discord_user_id = ?
                     WHERE id IN (
                        SELECT s.id FROM submissions s
                        LEFT JOIN games g ON g.id = s.game_id
                        LEFT JOIN tournaments t ON t.id = g.tournament_id
                        WHERE LOWER(s.iscored_username) = LOWER(?)
                          AND (s.submitted_from_room_id = ? OR t.game_room_id = ? OR g.game_room_id = ?))
                       AND (discord_user_id LIKE 'iscored:%' OR discord_user_id IN ('COMMUNITY', 'ANON'))`,
                    targetMapping.discord_user_id, toUsername, roomId, roomId, roomId
                );
                await db.run(
                    `UPDATE community_scores SET discord_user_id = ? WHERE LOWER(iscored_username) = LOWER(?) AND game_room_id = ? AND (discord_user_id LIKE 'iscored:%' OR discord_user_id IN ('COMMUNITY', 'ANON'))`,
                    targetMapping.discord_user_id, toUsername, roomId
                );
            }

            // 8. Record alias (GLOBAL — drives ScoreSyncPoller forward mapping).
            await db.run(
                'INSERT OR REPLACE INTO player_aliases (old_username, new_username) VALUES (?, ?)',
                fromUsername.toLowerCase(), toUsername
            );
            globalIdentityUpdated = true;
        }

        const { LeaderboardService } = await import('../../services/LeaderboardService.js');
        await LeaderboardService.invalidateAll();
        const { RankingService } = await import('../../services/RankingService.js');
        await RankingService.invalidateAll();

        const submissionsUpdated = submissionsRenamed + (subResult.changes || 0);
        const scoresUpdated = (scoreResult.changes || 0) + (communityResult.changes || 0) + (historyResult.changes || 0);
        // rowsAffected re-uses the dry-run counter shape, computed with the same
        // room-scoped WHERE clauses (so dry-run === commit, regression test #2).
        // For the from→to rename the source rows now read as `toUsername`, so we
        // report the actual changed counts captured above rather than recounting.
        const rowsAffected = {
            submissions: submissionsUpdated,
            scores: scoreResult.changes || 0,
            community_scores: communityResult.changes || 0,
            score_history: historyResult.changes || 0,
            user_mappings: globalIdentityUpdated ? userMappingsAffected : 0,
            player_aliases: globalIdentityUpdated ? 1 : 0,
        };
        const total = rowsAffected.submissions + rowsAffected.scores + rowsAffected.community_scores
            + rowsAffected.score_history + rowsAffected.user_mappings + rowsAffected.player_aliases;

        logInfo(`Renamed player '${fromUsername}' -> '${toUsername}' in room ${roomId}: ${total} records updated (global identity: ${globalIdentityUpdated})`);

        res.json({
            success: true,
            submissionsUpdated,
            scoresUpdated,
            rowsAffected,
            total,
            globalIdentityUpdated,
        });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/admin/merge-player):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Scheduler reload
router.post('/:roomId/scheduler/reload', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { Scheduler } = await import('../../engine/Scheduler.js');
        await Scheduler.getInstance().reload();
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/scheduler/reload):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Reorder iScored lineup
router.post('/:roomId/tournaments/reorder-lineup', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { TournamentEngine } = await import('../../engine/TournamentEngine.js');
        const engine = TournamentEngine.getInstance();
        await engine.reorderIScoredLineup();
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/tournaments/reorder-lineup):', error);
        const message = error instanceof Error ? error.message : 'Internal Server Error';
        res.status(500).json({ error: message });
    }
});

// --- Admin management endpoints ---

// List room admins
router.get('/:roomId/admins', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const localAdmins = await AdminService.getLocalAdmins(roomId);
        const discordAdmins = await AdminService.getRoomDiscordAdmins(roomId);
        res.json({ localAdmins, discordAdmins });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/admins):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Create local admin
router.post('/:roomId/admins/local', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const validationResult = validate(CreateLocalAdminSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const { username, password, display_name } = validationResult.data;
        const roomId = req.params.roomId as string;

        const existing = await AdminService.getLocalAdminByUsername(roomId, username);
        if (existing) return res.status(409).json({ error: 'Username already exists for this room' });

        const admin = await AdminService.createLocalAdmin(roomId, username, password, display_name);
        res.json({ success: true, admin });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/admins/local):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Delete local admin
router.delete('/:roomId/admins/local/:id', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const admin = await AdminService.getLocalAdminById(req.params.id as string);
        if (!admin || admin.game_room_id !== (req.params.roomId as string)) {
            return res.status(404).json({ error: 'Local admin not found in this room' });
        }
        await AdminService.deleteLocalAdmin(req.params.id as string);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE rooms/:roomId/admins/local/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Reset local admin password
router.post('/:roomId/admins/local/:id/reset-password', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { newPassword } = req.body;
        if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }
        const admin = await AdminService.getLocalAdminById(req.params.id as string);
        if (!admin || admin.game_room_id !== (req.params.roomId as string)) {
            return res.status(404).json({ error: 'Local admin not found in this room' });
        }
        await AdminService.resetLocalAdminPassword(req.params.id as string, newPassword);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/admins/local/:id/reset-password):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Add Discord admin to room
router.post('/:roomId/admins/discord', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { discord_user_id, discord_user, role } = req.body;
        const input = discord_user || discord_user_id;
        if (!input) return res.status(400).json({ error: 'discord_user or discord_user_id required' });

        const roomId = req.params.roomId as string;

        // Resolve username to ID if needed
        let resolvedId: string;
        if (isProviderUserId(input.trim())) {
            // Accept a pasted Discord snowflake OR a `google:<sub>` id directly —
            // granting room-admin to a Google-identified user by pasted ID is
            // legitimate (role derivation is table-based and provider-agnostic).
            resolvedId = input.trim();
        } else {
            const guildId = await GameRoomSettingsService.get(roomId, 'DISCORD_GUILD_ID');
            const hasBotToken = !!process.env.DISCORD_BOT_TOKEN;
            if (!hasBotToken || !guildId) {
                const missing = [
                    !hasBotToken ? 'Discord bot token (Super-Admin → Global Settings)' : null,
                    !guildId ? 'Discord Guild ID (this room\'s Discord section)' : null,
                ].filter(Boolean).join(' and ');
                return res.status(400).json({
                    error: `Username lookup is not configured — set ${missing}. In the meantime, paste the user's numeric Discord ID (Developer Mode → Copy User ID).`,
                });
            }
            const { resolveDiscordUserId } = await import('../../utils/discord.js');
            const resolved = await resolveDiscordUserId(input.trim(), guildId);
            if (!resolved) {
                return res.status(400).json({ error: `Could not find Discord user "${input}" in the configured guild. Make sure the bot is a member of the guild with the Server Members Intent enabled, or paste their numeric user ID instead.` });
            }
            resolvedId = resolved;
        }

        await AdminService.addRoomDiscordAdmin(roomId, resolvedId, role || 'admin');
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/admins/discord):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Remove Discord admin from room
router.delete('/:roomId/admins/discord/:discordId', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const deleted = await AdminService.removeRoomDiscordAdmin(
            req.params.roomId as string, req.params.discordId as string
        );
        if (!deleted) return res.status(404).json({ error: 'Discord admin not found in this room' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE rooms/:roomId/admins/discord/:discordId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Admin Invites ---

// List pending invites
router.get('/:roomId/admins/invites', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const invites = await AdminService.getPendingInvites(req.params.roomId as string);
        res.json(invites);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/admins/invites):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Create invite
router.post('/:roomId/admins/invites', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { display_name, discord_user } = req.body;
        if (!display_name || typeof display_name !== 'string' || display_name.trim().length === 0) {
            return res.status(400).json({ error: 'display_name is required' });
        }

        const roomId = req.params.roomId as string;
        const createdBy = req.user?.discordId || req.user?.localAdminId || 'unknown';

        // Resolve Discord user input (could be numeric ID or username/handle)
        let resolvedDiscordId: string | undefined;
        if (discord_user && typeof discord_user === 'string' && discord_user.trim()) {
            const { resolveDiscordUserId } = await import('../../utils/discord.js');
            const guildId = await GameRoomSettingsService.get(roomId, 'DISCORD_GUILD_ID');
            const resolved = await resolveDiscordUserId(discord_user.trim(), guildId || undefined);
            if (!resolved) {
                return res.status(400).json({ error: `Could not find Discord user "${discord_user}". Try their numeric user ID instead.` });
            }
            resolvedDiscordId = resolved;
        }

        const invite = await AdminService.createInvite(
            roomId, display_name.trim(), createdBy, resolvedDiscordId
        );

        // If Discord user resolved, try to DM them
        let dmSent = false;
        if (resolvedDiscordId) {
            const room = await GameRoomService.getById(roomId);
            const roomName = room?.name || 'a game room';
            const baseUrl = req.headers.origin || `${req.protocol}://${req.get('host')}`;
            const inviteUrl = `${baseUrl}/invite/${invite.token}`;
            const { sendDirectMessage } = await import('../../utils/discord.js');
            dmSent = await sendDirectMessage(
                resolvedDiscordId,
                `You've been invited to join **${roomName}** on Arcaid as an admin!\n\nClick the link below to set up your account:\n${inviteUrl}\n\nThis invite expires in 48 hours.`
            );
        }

        res.json({ ...invite, dmSent });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/admins/invites):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Cancel invite
router.delete('/:roomId/admins/invites/:inviteId', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const deleted = await AdminService.cancelInvite(
            req.params.inviteId as string, req.params.roomId as string
        );
        if (!deleted) return res.status(404).json({ error: 'Invite not found' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE rooms/:roomId/admins/invites/:inviteId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Approval-room join requests (v2.39.0) ---

// Room-admin queue. ?status=pending (default) | resolved
router.get('/:roomId/admin/join-requests', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const { JoinRequestService } = await import('../../services/JoinRequestService.js');
        const status = req.query.status === 'resolved' ? 'resolved' : 'pending';
        const rows = status === 'resolved'
            ? await JoinRequestService.listResolved(roomId)
            : await JoinRequestService.listPending(roomId);

        // Enrich with display_name/username/avatar so the admin queue doesn't
        // render bare IDs. v2.40.0 (D1): username is the fallback below
        // display_name — FE renders displayName ?? username ?? userId.
        const db = await getDatabase();
        const enriched = await Promise.all(rows.map(async (r) => {
            const profile = await db.get(
                `SELECT display_name, username, avatar_hash, avatar_url FROM user_profiles WHERE discord_user_id = ?`,
                r.user_id,
            );
            return {
                id: r.id,
                userId: r.user_id,
                status: r.status,
                requestedAt: r.requested_at,
                resolvedAt: r.resolved_at,
                resolvedBy: r.resolved_by,
                displayName: profile?.display_name ?? null,
                username: profile?.username ?? null,
                avatarUrl: profile?.avatar_url ?? null,
                avatarHash: profile?.avatar_hash ?? null,
            };
        }));
        res.json(enriched);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/admin/join-requests):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/:roomId/admin/join-requests/count', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { JoinRequestService } = await import('../../services/JoinRequestService.js');
        const pending = await JoinRequestService.countPending(req.params.roomId as string);
        res.json({ pending });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/admin/join-requests/count):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/:roomId/admin/join-requests/:id/approve', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const id = parseInt(req.params.id as string, 10);
        if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid request id' });
        const resolvedBy = req.user?.discordId || req.user?.localAdminId || 'unknown';
        const { JoinRequestService } = await import('../../services/JoinRequestService.js');
        const ok = await JoinRequestService.approve(roomId, id, resolvedBy);
        if (!ok) return res.status(404).json({ error: 'Join request not found or already resolved' });

        // No approve-notification this release, by design (approval-rooms
        // contract D2): none of the 5 existing NotificationType values
        // ('tournamentWin' | 'turnToPick' | 'tournamentStarting' |
        // 'rankDethroned' | 'friendScore') fits "you've been approved to join
        // a room", and the contract explicitly says not to invent a 6th here.
        // A raw unconditional DM (bypassing NotificationService) was
        // considered and rejected — every existing DM path is opt-in/rate-
        // limited via NotificationService, and a bespoke DM here would ignore
        // a user's notification prefs. Deferred; add a real notification type
        // in a future release if this is field-requested.
        res.json({ success: true });
    } catch (error) {
        // v2.49.0 fix-round (#4) — JoinRequestService.approve's defensive
        // ban re-check throws a typed USER_BANNED error rather than a plain
        // false, so it can be distinguished from "not found" (404).
        const code = (error as Error & { code?: string })?.code;
        if (code === 'USER_BANNED') {
            return res.status(403).json({ error: (error as Error).message });
        }
        logError('API Error (POST rooms/:roomId/admin/join-requests/:id/approve):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/:roomId/admin/join-requests/:id/deny', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const id = parseInt(req.params.id as string, 10);
        if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid request id' });
        const resolvedBy = req.user?.discordId || req.user?.localAdminId || 'unknown';
        const { JoinRequestService } = await import('../../services/JoinRequestService.js');
        const ok = await JoinRequestService.deny(roomId, id, resolvedBy);
        if (!ok) return res.status(404).json({ error: 'Join request not found or already resolved' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/admin/join-requests/:id/deny):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Room-tier bans (v2.49.0, tmp/room-bans-contract.md) ---
// v2.49.0 fix-round (#2) — NOT auto-audited. The app-level auditLog
// middleware (server.ts `app.use('/api/', auditLog)`) is mounted BEFORE the
// routers, so it runs before `requireAuth` has set `req.user` and early-
// returns without ever wrapping `res.json` — this is already documented at
// global.ts ~449-451 for the same reason. Every write below calls
// `AuditService.log` explicitly (mirrors global.ts's `account.delete`
// pattern). See ROADMAP.md ("Player Self-Service + Moderation") for the note
// that this is a repo-wide gap, not something this PR is scoped to fix
// wholesale.

// Active + lifted bans scoped to THIS room only (not global bans — those
// stay on the super-admin Reports "Bans" tab). Enriched with resolved
// display names (ScoreReportService.listBans' LEFT JOIN user_profiles). GET,
// so no requireNotBanned — matches the sibling GET .../admin/join-requests
// and GET .../admins, neither of which gates reads on the actor's own ban
// status.
router.get('/:roomId/admin/bans', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const { ScoreReportService } = await import('../../services/ScoreReportService.js');
        const bans = await ScoreReportService.listBans(false, roomId);
        res.json(bans);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/admin/bans):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Ban a Discord/Google identity out of THIS room. Decision 1 (contract):
// banning strips the room_members row and blocks re-join/join-request while
// active (requireNotBanned, now room-aware, enforces the latter for free).
// Decision 2: Arcaid-side only — no Discord guild kick.
//
// v2.49.0 fix-round (#8) — gated with requireNotBanned (a globally-banned
// room admin must not be able to issue room bans, same as every other
// per-submit/content-write route in this router).
router.post('/:roomId/admin/bans', requireAuth, requireRoomAccess('roomId'), requireNotBanned, async (req, res) => {
    try {
        const validationResult = validate(CreateBanSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const { discordUserId, durationDays, reason } = validationResult.data;
        const roomId = req.params.roomId as string;

        // Same guard as the global ban routes (admin.ts) — an iscored:*
        // synthetic id has no login identity behind it, so a ban row naming
        // one can never match a real session.
        if (discordUserId.startsWith('iscored:')) {
            return res.status(400).json({
                error: "Cannot ban an iScored-synced name — it has no login identity to ban.",
            });
        }

        // v2.49.0 fix-round (#3) — target-guard checks now use the FULL
        // link-graph expansion (`BanService.expandIdentityCandidates`), not
        // just `IN (raw, canonical)`. Ban enforcement (`BanService.isIdentityBanned`)
        // already checks the whole graph, so a super admin or room admin
        // holding a grant on a linked `google:*` alias (reachable via
        // POST /:roomId/admins/discord, which accepts a pasted google id —
        // `IdentityLinkService.createLink` never normalizes `super_admins`)
        // was bannable out of a room the narrower check missed.
        const { BanService } = await import('../../services/BanService.js');
        const targetCandidates = await BanService.expandIdentityCandidates(discordUserId);

        // Self-ban guard — candidate-set overlap covers "actor and target
        // resolve to the same identity via any linked alias", not just an
        // exact raw/canonical match.
        const actorId = req.user!.discordId;
        if (actorId) {
            const actorCandidates = await BanService.expandIdentityCandidates(actorId);
            if (actorId === discordUserId || actorCandidates.some(c => targetCandidates.includes(c))) {
                return res.status(400).json({ error: 'You cannot ban your own account.' });
            }
        }

        // Cannot ban a super admin — that's a super-admin matter, not a room one.
        let isSuper = false;
        for (const candidate of targetCandidates) {
            if (await AdminService.isSuperAdmin(candidate)) { isSuper = true; break; }
        }
        if (isSuper) {
            return res.status(403).json({ error: 'Cannot ban a super admin. Escalate to a super admin instead.' });
        }

        // Cannot ban a room admin of THIS room — admin misbehavior is a
        // super-admin matter, not something a fellow room admin can act on.
        const db = await getDatabase();
        const candidatePlaceholders = targetCandidates.map(() => '?').join(', ');
        const isRoomAdminOfThisRoom = await db.get(
            `SELECT 1 FROM game_room_admins WHERE game_room_id = ? AND discord_user_id IN (${candidatePlaceholders})`,
            roomId, ...targetCandidates,
        );
        if (isRoomAdminOfThisRoom) {
            return res.status(403).json({ error: 'Cannot ban a room admin of this room. Remove their admin role first, or escalate to a super admin.' });
        }

        const { ScoreReportService } = await import('../../services/ScoreReportService.js');
        const { RoomMembershipService } = await import('../../services/RoomMembershipService.js');
        const actorLabel = req.user!.discordId || req.user!.username || 'admin';

        // v2.49.0 fix-round (#5, #6) — pre-flight dup-ban check + ban insert +
        // membership strip + pending-join-request denial (#4) all share one
        // transaction: two sequential awaits with no shared transaction meant
        // a `removeMember` throw left a committed ban behind a 500, and a
        // retry of that 500 could then write a SECOND active ban row for the
        // same (identity, room) — the pre-flight closes that race by running
        // inside the same transaction as the insert, not just before it.
        await db.exec('BEGIN TRANSACTION');
        let ban;
        try {
            const dupCheck = await db.get(
                `SELECT 1 FROM user_bans
                  WHERE discord_user_id IN (${candidatePlaceholders}) AND game_room_id = ?
                    AND lifted_at IS NULL
                    AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
                  LIMIT 1`,
                ...targetCandidates, roomId,
            );
            if (dupCheck) {
                await db.exec('ROLLBACK');
                return res.status(409).json({ error: 'That player is already banned from this room.' });
            }

            ban = await ScoreReportService.ban(discordUserId, actorLabel, durationDays ?? null, reason, roomId);

            // Decision 1 — banning strips membership immediately (they're no
            // longer a member; lifting the ban does NOT auto-restore it, they
            // can re-join).
            await RoomMembershipService.removeMember(discordUserId, roomId);

            // v2.49.0 fix-round (#4) — a pending join request must not survive
            // the ban and later get approved into re-admitting a banned user.
            // Denied across the full candidate set, since enforcement treats
            // every linked alias as equally banned in this room.
            await db.run(
                `UPDATE join_requests SET status = 'denied', resolved_at = datetime('now'), resolved_by = ?
                  WHERE game_room_id = ? AND status = 'pending' AND user_id IN (${candidatePlaceholders})`,
                actorLabel, roomId, ...targetCandidates,
            );

            await db.exec('COMMIT');
        } catch (err) {
            await db.exec('ROLLBACK').catch(() => {});
            throw err;
        }

        // v2.49.0 fix-round (#2) — explicit audit call, see header comment.
        await AuditService.log({
            actor: actorLabel,
            action: 'room.ban',
            target_type: 'user',
            target_id: discordUserId,
            details: JSON.stringify({ roomId, durationDays: durationDays ?? null, reason: reason ?? null }),
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

        res.status(201).json(ban);
    } catch (error) {
        logError('API Error (POST rooms/:roomId/admin/bans):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Lift a room ban — must belong to THIS room (404 otherwise; a room admin
// can't lift a ban scoped to a different room, or a global ban).
//
// v2.49.0 fix-round (#8) — gated with requireNotBanned, same rationale as
// the ban route above.
router.post('/:roomId/admin/bans/:banId/lift', requireAuth, requireRoomAccess('roomId'), requireNotBanned, async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const banId = req.params.banId as string;
        const { ScoreReportService } = await import('../../services/ScoreReportService.js');
        const ban = await ScoreReportService.getBanById(banId);
        if (!ban || ban.game_room_id !== roomId) {
            return res.status(404).json({ error: 'Ban not found in this room' });
        }
        const actorLabel = req.user!.discordId || req.user!.username || 'admin';
        const ok = await ScoreReportService.lift(banId, actorLabel);
        if (!ok) return res.status(404).json({ error: 'Ban not found or already lifted' });

        // v2.49.0 fix-round (#2) — explicit audit call, see header comment.
        await AuditService.log({
            actor: actorLabel,
            action: 'room.unban',
            target_type: 'user',
            target_id: ban.discord_user_id,
            details: JSON.stringify({ roomId, banId }),
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        });

        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/admin/bans/:banId/lift):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Member picker (v2.39.0) — provider-agnostic list of current room members for
// the "add admin" picker in Settings, replacing raw-ID pasting as the primary
// flow (the text/ID input stays as an advanced fallback).
router.get('/:roomId/admin/members', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const db = await getDatabase();
        const rows = await db.all(
            `SELECT rm.user_id AS userId, rm.joined_at AS joinedAt, rm.source AS source,
                    up.display_name AS displayName, up.avatar_hash AS avatarHash, up.avatar_url AS avatarUrl
             FROM room_members rm
             LEFT JOIN user_profiles up ON up.discord_user_id = rm.user_id
             WHERE rm.room_id = ?
             ORDER BY COALESCE(up.display_name, rm.user_id) COLLATE NOCASE ASC`,
            roomId,
        );
        res.json(rows);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/admin/members):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Game Style Assignment ---

// Assign a catalogue style to a game
router.put('/:roomId/admin/games/:gameId/style', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const validationResult = validate(AssignStyleSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const { StyleCatalogueService } = await import('../../services/StyleCatalogueService.js');
        const { catalogueStyleId, headerDisabled } = validationResult.data;

        // Verify game belongs to this room
        const db = await getDatabase();
        const game = await db.get(
            `SELECT g.id FROM games g
             JOIN tournaments t ON g.tournament_id = t.id
             WHERE g.id = ? AND t.game_room_id = ?`,
            req.params.gameId as string, req.params.roomId as string
        );
        if (!game) return res.status(404).json({ error: 'Game not found in this room' });

        const assigned = await StyleCatalogueService.assignToGame(
            req.params.gameId as string, catalogueStyleId, headerDisabled
        );
        if (!assigned) return res.status(404).json({ error: 'Style not found' });

        res.json({ success: true });
    } catch (error) {
        logError('API Error (PUT rooms/:roomId/admin/games/:gameId/style):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Remove style from a game
router.delete('/:roomId/admin/games/:gameId/style', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { StyleCatalogueService } = await import('../../services/StyleCatalogueService.js');

        // Verify game belongs to this room
        const db = await getDatabase();
        const game = await db.get(
            `SELECT g.id FROM games g
             JOIN tournaments t ON g.tournament_id = t.id
             WHERE g.id = ? AND t.game_room_id = ?`,
            req.params.gameId as string, req.params.roomId as string
        );
        if (!game) return res.status(404).json({ error: 'Game not found in this room' });

        await StyleCatalogueService.removeFromGame(req.params.gameId as string);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE rooms/:roomId/admin/games/:gameId/style):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Assign a style image (logo/background/both) to an active game
router.put('/:roomId/admin/games/:gameId/image', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const validationResult = validate(AssignImageSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const { styleId, imageType } = validationResult.data;
        const gameId = req.params.gameId as string;

        const { StyleCatalogueService } = await import('../../services/StyleCatalogueService.js');
        const result = await StyleCatalogueService.assignImageToGame(gameId, styleId, imageType);
        if (!result.ok) return res.status(400).json({ error: result.error });

        const { LeaderboardService } = await import('../../services/LeaderboardService.js');
        await LeaderboardService.invalidate(gameId);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (PUT rooms/:roomId/admin/games/:gameId/image):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Assign a style image (logo/background/both) as room library default
router.put('/:roomId/game_library/:name/image', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const validationResult = validate(AssignImageSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const { styleId, imageType } = validationResult.data;
        const roomId = req.params.roomId as string;
        const gameName = decodeURIComponent(req.params.name as string);

        const { StyleCatalogueService } = await import('../../services/StyleCatalogueService.js');
        const result = await StyleCatalogueService.assignImageToLibrary(roomId, gameName, styleId, imageType);
        if (!result.ok) return res.status(400).json({ error: result.error });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (PUT rooms/:roomId/game_library/:name/image):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Get games for the "Apply to Game" picker (leaderboard games + catalogue games)
router.get('/:roomId/admin/games-for-picker', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const { LeaderboardService } = await import('../../services/LeaderboardService.js');

        const leaderboards = await LeaderboardService.getActiveLeaderboards(roomId);
        const leaderboardGames = leaderboards.map(lb => ({
            gameId: lb.gameId,
            gameName: lb.gameName,
            tournamentName: lb.tournamentName,
            gameStatus: lb.gameStatus,
        }));

        const db = await getDatabase();
        const catalogueRows = await db.all(
            `SELECT name FROM global_games WHERE status = 'approved' GROUP BY LOWER(name) ORDER BY name`
        );
        const leaderboardNames = new Set(leaderboardGames.map(g => g.gameName.toLowerCase()));
        const libraryOnly = catalogueRows
            .filter((g: any) => !leaderboardNames.has(String(g.name).toLowerCase()))
            .map((g: any) => ({ gameName: g.name }));

        res.json({ leaderboardGames, libraryGames: libraryOnly });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/admin/games-for-picker):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Upload a custom style to the global catalogue (room admins can contribute)
router.post('/:roomId/admin/styles/upload', requireAuth, requireRoomAccess('roomId'), requireNotBanned, roomAssetUpload.fields([
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

        // S11: magic-byte validation on each present upload before persisting.
        if (bgFile && !isAllowedImage(bgFile.buffer)) {
            return res.status(400).json({ error: 'Invalid image file' });
        }
        if (headerFile && !isAllowedImage(headerFile.buffer)) {
            return res.status(400).json({ error: 'Invalid image file' });
        }

        const { StyleCatalogueService } = await import('../../services/StyleCatalogueService.js');
        const id = await StyleCatalogueService.createCustom({
            name: validationResult.data.name,
            author: validationResult.data.author,
            notes: validationResult.data.notes,
            backgroundBuffer: bgFile?.buffer,
            headerBuffer: headerFile?.buffer,
        });

        const style = await StyleCatalogueService.getById(id);

        // Log activity event
        const { RoomEventService } = await import('../../services/RoomEventService.js');
        RoomEventService.log(req.params.roomId as string, 'style_uploaded', {
            styleId: id,
            styleName: validationResult.data.name,
        }).catch(() => {});

        res.status(201).json({ success: true, style });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/admin/styles/upload):', error);
        res.status(500).json({ error: error instanceof Error ? error.message : 'Style upload failed' });
    }
});

// Wipe a player's record on a game (admin). Removes the submissions row and
// every matching score_history row so the tournament leaderboard recompute
// (which reads score_history filtered by submitted_during_tournament_id since
// v2.1.0) actually reflects the deletion. Works on tournament games AND
// pin-to-scoreboard games (tournament_id IS NULL — ADR 0005).
router.delete('/:roomId/admin/games/:gameId/submissions/:submissionId', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const gameId = req.params.gameId as string;
        const submissionId = req.params.submissionId as string;
        const db = await getDatabase();

        // Verify game belongs to this room. LEFT JOIN tournaments so pinned
        // rows (tournament_id IS NULL) match via games.game_room_id directly.
        const game = await db.get(
            `SELECT g.id, g.name, g.game_room_id, g.tournament_id, t.game_room_id as tournament_room_id
             FROM games g
             LEFT JOIN tournaments t ON t.id = g.tournament_id
             WHERE g.id = ?`,
            gameId
        );
        if (!game) return res.status(404).json({ error: 'Game not found' });
        const ownedByRoom = game.tournament_room_id === roomId || game.game_room_id === roomId;
        if (!ownedByRoom) return res.status(404).json({ error: 'Game not found in this room' });

        // Verify submission exists and belongs to this game
        const submission = await db.get(
            'SELECT id, iscored_username, score, photo_url FROM submissions WHERE id = ? AND game_id = ?',
            submissionId, gameId
        );
        if (!submission) return res.status(404).json({ error: 'Submission not found' });

        // S12: collect the score-photo files referenced by the rows we're about
        // to delete (the submissions row + the score_history sweep) so they can
        // be unlinked from disk after the rows are gone. Predicate mirrors the
        // score_history DELETE below so no per-attempt photo is missed.
        const photoRows = await db.all(
            `SELECT photo_url FROM score_history
             WHERE game_room_id = ?
               AND LOWER(iscored_username) = LOWER(?)
               AND (game_id = ? OR (game_id IS NULL AND LOWER(game_name) = LOWER(?)))
               AND photo_url LIKE '/api/score-photos/%'`,
            roomId, submission.iscored_username, gameId, game.name
        );
        const photoUrls: Array<string | null | undefined> = [
            submission.photo_url,
            ...photoRows.map((r: any) => r.photo_url),
        ];

        // Delete the submissions row + all matching score_history rows. Without
        // the score_history sweep the tournament leaderboard recompute (reads
        // score_history) puts the score right back on next render.
        await db.run('DELETE FROM submissions WHERE id = ?', submissionId);
        const historyDelete = await db.run(
            `DELETE FROM score_history
             WHERE game_room_id = ?
               AND LOWER(iscored_username) = LOWER(?)
               AND (game_id = ? OR (game_id IS NULL AND LOWER(game_name) = LOWER(?)))`,
            roomId, submission.iscored_username, gameId, game.name
        );

        // S12: unlink the collected photo files now that their score rows are
        // gone (best-effort, never throws). A surviving community_scores row
        // could still reference the same file, but wiping the player's scores
        // is meant to drop their evidence too and a missing image degrades
        // gracefully.
        const photosDeleted = deleteScorePhotoFiles(photoUrls);

        // Tombstone for the sync poller. Without this, the next iScored poll
        // (~30s) re-creates the score because iScored still holds the player's
        // best. submission.score IS that best (submissions tracks
        // best-per-player-per-game). We MAX against any existing suppression
        // so repeat admin deletions never lower the threshold.
        await db.run(
            `INSERT INTO deleted_score_suppressions
                (game_id, iscored_username_lower, suppressed_score, deleted_at, deleted_by_user_id)
             VALUES (?, LOWER(?), ?, datetime('now'), ?)
             ON CONFLICT(game_id, iscored_username_lower) DO UPDATE SET
                suppressed_score = MAX(suppressed_score, excluded.suppressed_score),
                deleted_at = datetime('now'),
                deleted_by_user_id = excluded.deleted_by_user_id`,
            gameId, submission.iscored_username, submission.score,
            req.user!.discordId || req.user!.username || 'admin'
        );

        // Invalidate leaderboard cache + broadcast so every open Scoreboard /
        // admin Leaderboard / Game Detail page repaints without a manual
        // reload.
        const { LeaderboardService } = await import('../../services/LeaderboardService.js');
        await LeaderboardService.invalidate(gameId);
        const { emitLeaderboardUpdated } = await import('../websocket.js');
        emitLeaderboardUpdated(req.params.roomId as string, { gameId });

        // Log activity event
        const { RoomEventService } = await import('../../services/RoomEventService.js');
        RoomEventService.log(roomId, 'score_deleted', {
            gameId,
            player: submission.iscored_username,
            score: submission.score,
            historyRowsRemoved: historyDelete.changes ?? 0,
        }).catch(() => {});

        logInfo(`Admin deleted submission ${submissionId} (${submission.iscored_username}: ${submission.score}) from game ${gameId}; ${historyDelete.changes ?? 0} history rows removed, ${photosDeleted} photo(s) unlinked`);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE rooms/:roomId/admin/games/:gameId/submissions/:submissionId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// List deleted-score suppressions (tombstones) for a game in a room (admin).
// Mirrors the wipe-player endpoint's auth + room-ownership gate so a room admin
// only ever sees tombstones for games their room owns. Read-only — the global
// auditLog skips GETs.
router.get('/:roomId/admin/games/:gameId/suppressions', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const gameId = req.params.gameId as string;
        const db = await getDatabase();

        // Verify game belongs to this room. LEFT JOIN tournaments so pinned
        // rows (tournament_id IS NULL) match via games.game_room_id directly.
        const game = await db.get(
            `SELECT g.id, g.game_room_id, g.tournament_id, t.game_room_id as tournament_room_id
             FROM games g
             LEFT JOIN tournaments t ON t.id = g.tournament_id
             WHERE g.id = ?`,
            gameId
        );
        if (!game) return res.status(404).json({ error: 'Game not found' });
        const ownedByRoom = game.tournament_room_id === roomId || game.game_room_id === roomId;
        if (!ownedByRoom) return res.status(404).json({ error: 'Game not found in this room' });

        const rows = await db.all(
            `SELECT game_id, iscored_username_lower, suppressed_score, deleted_at, deleted_by_user_id
             FROM deleted_score_suppressions
             WHERE game_id = ?
             ORDER BY deleted_at DESC`,
            gameId
        );
        res.json({
            suppressions: rows.map(r => ({
                gameId: r.game_id,
                username: r.iscored_username_lower,
                suppressedScore: r.suppressed_score,
                deletedAt: r.deleted_at,
                deletedBy: r.deleted_by_user_id,
            })),
        });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/admin/games/:gameId/suppressions):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Remove one deleted-score suppression tombstone for a game in a room (admin).
// The composite PK (game_id, iscored_username_lower) has no surrogate id, so the
// DELETE targets BOTH columns to clear exactly one row (game_id alone would wipe
// every tombstone for the game). Once gone, the sync poller re-imports the
// player's iScored score on its next ~30s cycle (subject to the score > existing
// check). Auto-audited by the global auditLog on 2xx.
router.delete('/:roomId/admin/games/:gameId/suppressions/:username', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const gameId = req.params.gameId as string;
        const username = decodeURIComponent(req.params.username as string);
        const db = await getDatabase();

        const game = await db.get(
            `SELECT g.id, g.game_room_id, g.tournament_id, t.game_room_id as tournament_room_id
             FROM games g
             LEFT JOIN tournaments t ON t.id = g.tournament_id
             WHERE g.id = ?`,
            gameId
        );
        if (!game) return res.status(404).json({ error: 'Game not found' });
        const ownedByRoom = game.tournament_room_id === roomId || game.game_room_id === roomId;
        if (!ownedByRoom) return res.status(404).json({ error: 'Game not found in this room' });

        const result = await db.run(
            `DELETE FROM deleted_score_suppressions
             WHERE game_id = ? AND iscored_username_lower = LOWER(?)`,
            gameId, username
        );
        if ((result.changes ?? 0) === 0) return res.status(404).json({ error: 'Suppression not found' });

        const { RoomEventService } = await import('../../services/RoomEventService.js');
        RoomEventService.log(roomId, 'score_suppression_cleared', { gameId, player: username }).catch(() => {});

        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE rooms/:roomId/admin/games/:gameId/suppressions/:username):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Get style for a game
router.get('/:roomId/games/:gameId/style', async (req, res) => {
    try {
        const { StyleCatalogueService } = await import('../../services/StyleCatalogueService.js');
        const result = await StyleCatalogueService.getGameStyle(req.params.gameId as string);
        if (!result) return res.json({ style: null });
        res.json(result);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/games/:gameId/style):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Asset Upload Endpoints ---

// Upload background image
router.post('/:roomId/admin/upload/background', requireAuth, requireRoomAccess('roomId'), roomAssetUpload.single('file'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const file = req.file;
        if (!file) return res.status(400).json({ error: 'No file uploaded' });
        // S11: reject non-image bytes before persisting (client MIME is spoofable).
        if (!isAllowedImage(file.buffer)) return res.status(400).json({ error: 'Invalid image file' });

        const ext = (file.mimetype === 'image/png' || file.mimetype === 'image/apng') ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
        const dir = path.join(process.cwd(), 'data', 'room-assets', roomId);
        fs.mkdirSync(dir, { recursive: true });

        // Remove any existing background files
        for (const f of fs.readdirSync(dir).filter(f => f.startsWith('background.'))) {
            fs.unlinkSync(path.join(dir, f));
        }

        const filename = `background.${ext}`;
        fs.writeFileSync(path.join(dir, filename), file.buffer);

        const url = `/api/room-assets/${roomId}/${filename}?v=${Date.now()}`;
        await GameRoomSettingsService.set(roomId, 'SCOREBOARD_BG_URL', url);
        res.json({ success: true, url });
    } catch (error) {
        logError('API Error (POST upload/background):', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// Delete background image
router.delete('/:roomId/admin/upload/background', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const dir = path.join(process.cwd(), 'data', 'room-assets', roomId);
        if (fs.existsSync(dir)) {
            for (const f of fs.readdirSync(dir).filter(f => f.startsWith('background.'))) {
                fs.unlinkSync(path.join(dir, f));
            }
        }
        await GameRoomSettingsService.delete(roomId, 'SCOREBOARD_BG_URL');
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE upload/background):', error);
        res.status(500).json({ error: 'Delete failed' });
    }
});

// Upload logo image
router.post('/:roomId/admin/upload/logo', requireAuth, requireRoomAccess('roomId'), roomAssetUpload.single('file'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const file = req.file;
        if (!file) return res.status(400).json({ error: 'No file uploaded' });
        // S11: reject non-image bytes before persisting (client MIME is spoofable).
        if (!isAllowedImage(file.buffer)) return res.status(400).json({ error: 'Invalid image file' });

        const ext = (file.mimetype === 'image/png' || file.mimetype === 'image/apng') ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
        const dir = path.join(process.cwd(), 'data', 'room-assets', roomId);
        fs.mkdirSync(dir, { recursive: true });

        // Remove any existing logo files
        for (const f of fs.readdirSync(dir).filter(f => f.startsWith('logo.'))) {
            fs.unlinkSync(path.join(dir, f));
        }

        const filename = `logo.${ext}`;
        fs.writeFileSync(path.join(dir, filename), file.buffer);

        const url = `/api/room-assets/${roomId}/${filename}?v=${Date.now()}`;
        // Update both game_rooms.logo_url and settings
        await GameRoomService.update(roomId, { logo_url: url });
        await GameRoomSettingsService.set(roomId, 'LOGO_URL', url);
        res.json({ success: true, url });
    } catch (error) {
        logError('API Error (POST upload/logo):', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// Delete logo image
router.delete('/:roomId/admin/upload/logo', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const dir = path.join(process.cwd(), 'data', 'room-assets', roomId);
        if (fs.existsSync(dir)) {
            for (const f of fs.readdirSync(dir).filter(f => f.startsWith('logo.'))) {
                fs.unlinkSync(path.join(dir, f));
            }
        }
        await GameRoomService.update(roomId, { logo_url: null });
        await GameRoomSettingsService.delete(roomId, 'LOGO_URL');
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE upload/logo):', error);
        res.status(500).json({ error: 'Delete failed' });
    }
});

// Sprint 11 — Anonymous-identity merge admin endpoints (plan §15).
//
// Pending claim queue: active anonymous identities in this room, plus a rough
// Discord-match hint (server nickname ↔ user_mappings.iscored_username).
router.get('/:roomId/admin/identity/queue', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const db = await getDatabase();
        const identities = await db.all(
            `SELECT ai.id, ai.server_nickname, ai.guild_id, ai.first_seen_at, ai.status
             FROM anonymous_identities ai
             WHERE ai.status = 'active' AND (ai.room_id = ? OR ai.room_id IS NULL)
             ORDER BY ai.first_seen_at DESC
             LIMIT 200`,
            roomId,
        );
        const results = await Promise.all(identities.map(async (ai: any) => {
            // Row counts across the 4 score tables for this nickname.
            const csRow = await db.get(
                `SELECT COUNT(*) AS c FROM community_scores
                 WHERE game_room_id = ? AND submitted_by_user_id IS NULL
                   AND merged_from_anonymous_identity_id IS NULL
                   AND LOWER(submitted_by_anonymous_name) = LOWER(?)`,
                roomId, ai.server_nickname,
            );
            // Potential target from user_mappings by nickname.
            const match = await db.get(
                `SELECT discord_user_id, iscored_username, avatar_hash FROM user_mappings
                 WHERE LOWER(iscored_username) = LOWER(?) LIMIT 1`,
                ai.server_nickname,
            );
            return {
                id: ai.id,
                serverNickname: ai.server_nickname,
                guildId: ai.guild_id,
                firstSeenAt: ai.first_seen_at,
                status: ai.status,
                anonymousScoreCount: csRow?.c ?? 0,
                potentialMatch: match ? {
                    discordUserId: match.discord_user_id,
                    username: match.iscored_username,
                    avatarHash: match.avatar_hash,
                } : null,
            };
        }));
        res.json(results);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/admin/identity/queue):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/:roomId/admin/identity/audit', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const { MergeService } = await import('../../services/MergeService.js');
        const records = await MergeService.listMergeHistory(roomId, limit);
        // Enrich with the anonymous nickname + target username for display.
        const db = await getDatabase();
        const enriched = await Promise.all(records.map(async r => {
            const ai = await db.get(`SELECT server_nickname, status FROM anonymous_identities WHERE id = ?`, r.anonymousIdentityId);
            const targetMap = await db.get(`SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?`, r.targetDiscordUserId);
            let summary = { moving: 0, frozen: 0 };
            try {
                const snap = JSON.parse(r.scoreIdsSnapshot) as { submissions?: string[]; community_scores?: number[]; score_history?: number[]; global_scores?: string[]; frozen_tournament_ids_at_merge?: string[] };
                summary.moving = (snap.submissions?.length ?? 0) + (snap.community_scores?.length ?? 0) + (snap.score_history?.length ?? 0) + (snap.global_scores?.length ?? 0);
                summary.frozen = snap.frozen_tournament_ids_at_merge?.length ?? 0;
            } catch { /* bad JSON — report zeros */ }
            return {
                ...r,
                anonymousNickname: ai?.server_nickname ?? null,
                anonymousStatus: ai?.status ?? null,
                targetUsername: targetMap?.iscored_username ?? null,
                summary,
            };
        }));
        res.json(enriched);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/admin/identity/audit):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/:roomId/admin/identity/preview', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const { anonymousIdentityId, targetUserId } = req.body || {};
        if (!Number.isInteger(anonymousIdentityId)) return res.status(400).json({ error: 'anonymousIdentityId (int) required' });
        if (!targetUserId || typeof targetUserId !== 'string') return res.status(400).json({ error: 'targetUserId required' });
        const { MergeService } = await import('../../services/MergeService.js');
        const preview = await MergeService.previewMerge(roomId, anonymousIdentityId, targetUserId);
        res.json(preview);
    } catch (error) {
        const msg = error instanceof Error ? error.message : 'preview failed';
        logError('API Error (POST rooms/:roomId/admin/identity/preview):', error);
        res.status(400).json({ error: msg });
    }
});

router.post('/:roomId/admin/identity/merge', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const { anonymousIdentityId, targetUserId, reason, previewHash } = req.body || {};
        if (!Number.isInteger(anonymousIdentityId)) return res.status(400).json({ error: 'anonymousIdentityId (int) required' });
        if (!targetUserId || typeof targetUserId !== 'string') return res.status(400).json({ error: 'targetUserId required' });
        if (!previewHash || typeof previewHash !== 'string') return res.status(400).json({ error: 'previewHash required' });
        const adminId = req.user?.discordId || req.user?.localAdminId || 'unknown';

        const { MergeService } = await import('../../services/MergeService.js');
        try {
            const out = await MergeService.recordMerge({
                roomId,
                anonymousIdentityId,
                targetDiscordUserId: targetUserId,
                adminDiscordUserId: adminId,
                reason,
                previewHash,
            });
            const { RoomEventService } = await import('../../services/RoomEventService.js');
            RoomEventService.log(roomId, 'identity_merge', {
                mergeId: out.mergeId,
                anonymousIdentityId,
                targetUserId,
                movedRows: out.movedRows,
                reason: reason ?? null,
            }).catch(() => {});
            res.status(201).json(out);
        } catch (err) {
            if (err instanceof Error && (err as Error & { code?: string }).code === 'MERGE_CONFLICT') {
                return res.status(409).json({ error: 'preview drift', fresh: (err as Error & { fresh?: unknown }).fresh });
            }
            throw err;
        }
    } catch (error) {
        logError('API Error (POST rooms/:roomId/admin/identity/merge):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/:roomId/admin/identity/:mergeId/reverse', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const mergeId = Number(req.params.mergeId);
        if (!Number.isInteger(mergeId)) return res.status(400).json({ error: 'mergeId must be integer' });
        const adminId = req.user?.discordId || req.user?.localAdminId || 'unknown';
        const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;

        const { MergeService } = await import('../../services/MergeService.js');
        const out = await MergeService.reverseMerge({ mergeId, reversalAdminId: adminId, reason });
        const { RoomEventService } = await import('../../services/RoomEventService.js');
        RoomEventService.log(roomId, 'identity_unmerge', {
            mergeId,
            returnedRows: out.returned,
            stayingRows: out.staying,
            reason: reason ?? null,
        }).catch(() => {});
        res.json(out);
    } catch (error) {
        const msg = error instanceof Error ? error.message : 'reverse failed';
        logError('API Error (POST rooms/:roomId/admin/identity/:mergeId/reverse):', error);
        res.status(400).json({ error: msg });
    }
});

router.get('/:roomId/admin/identity/:mergeId', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const mergeId = Number(req.params.mergeId);
        if (!Number.isInteger(mergeId)) return res.status(400).json({ error: 'mergeId must be integer' });
        const { MergeService } = await import('../../services/MergeService.js');
        const record = await MergeService.getMergeRecord(mergeId);
        if (!record) return res.status(404).json({ error: 'merge record not found' });
        // If unreversed, include a fresh reversal preview to power the drill-down UI.
        let reversalPreview = null;
        if (!record.reversedAt) {
            try {
                reversalPreview = await MergeService.previewReversal(mergeId);
            } catch { /* best effort */ }
        }
        res.json({ record, reversalPreview });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/admin/identity/:mergeId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Room activity log
router.get('/:roomId/admin/activity', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { RoomEventService } = await import('../../services/RoomEventService.js');
        const roomId = req.params.roomId as string;
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const offset = parseInt(req.query.offset as string) || 0;
        const events = await RoomEventService.getRecent(roomId, limit, offset);
        res.json(events);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/admin/activity):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Platform usage check (are any tournaments using this platform in their platform_rules?)
router.get('/:roomId/admin/platform-usage/:platform', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const platform = req.params.platform as string;
        const db = await getDatabase();
        const rows = await db.all(
            `SELECT name FROM tournaments WHERE game_room_id = ? AND platform_rules LIKE ?`,
            [roomId, `%${platform}%`]
        );
        res.json({
            inUse: rows.length > 0,
            tournaments: rows.map((r: any) => r.name),
        });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/admin/platform-usage/:platform):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ==================== GAME STATE MANAGEMENT ====================

// List all games for a room (admin view with full state info)
router.get('/:roomId/admin/game-states', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const db = await getDatabase();
        const statusFilter = req.query.status ? (req.query.status as string).split(',') : null;

        // v2.4.0: LEFT JOIN tournaments so pinned games (tournament_id IS NULL)
        // appear. Scope by COALESCE(tournament.game_room_id, games.game_room_id)
        // since tournament-linked rows get their room via the tournament and
        // pinned rows carry it directly (migration 073).
        let query = `
            SELECT g.id, g.name, g.status, g.iscored_id, g.picker_discord_id,
                   g.picker_type, g.picker_designated_at, g.reminder_count,
                   g.won_game_id, g.start_date, g.end_date,
                   g.queue_order, g.style_id,
                   COALESCE(t.name, '(pinned)') as tournament_name,
                   COALESCE(t.type, '') as tournament_type,
                   t.id as tournament_id,
                   CASE WHEN g.tournament_id IS NULL THEN 1 ELSE 0 END as is_pinned
            FROM games g
            LEFT JOIN tournaments t ON g.tournament_id = t.id
            WHERE COALESCE(t.game_room_id, g.game_room_id) = ?
        `;
        const params: any[] = [roomId];

        if (statusFilter) {
            query += ` AND g.status IN (${statusFilter.map(() => '?').join(',')})`;
            params.push(...statusFilter);
        }

        query += `
            ORDER BY
              CASE g.status
                WHEN 'ACTIVE' THEN 1
                WHEN 'QUEUED' THEN 2
                WHEN 'COMPLETED' THEN 3
                WHEN 'ARCHIVED' THEN 4
              END,
              g.start_date DESC, g.queue_order ASC
        `;

        const games = await db.all(query, ...params);
        res.json(games);
    } catch (error) {
        logError('API Error (GET game-states):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Force change a game's status
router.patch('/:roomId/admin/game-states/:gameId/status', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const gameId = req.params.gameId as string;
        const parsed = UpdateGameStateSchema.parse(req.body);
        const db = await getDatabase();

        // Verify game belongs to this room
        const game = await db.get(`
            SELECT g.*, t.game_room_id, t.type as tournament_type
            FROM games g JOIN tournaments t ON g.tournament_id = t.id
            WHERE g.id = ? AND t.game_room_id = ?
        `, gameId, roomId);
        if (!game) return res.status(404).json({ error: 'Game not found in this room' });

        const oldStatus = game.status;
        const now = new Date().toISOString();

        // Update status with appropriate date fields
        if (parsed.status === 'ACTIVE') {
            await db.run('UPDATE games SET status = ?, start_date = COALESCE(start_date, ?), end_date = NULL WHERE id = ?', 'ACTIVE', now, gameId);
        } else if (parsed.status === 'COMPLETED') {
            await db.run('UPDATE games SET status = ?, end_date = ? WHERE id = ?', 'COMPLETED', now, gameId);
        } else if (parsed.status === 'QUEUED') {
            await db.run('UPDATE games SET status = ?, start_date = NULL, end_date = NULL WHERE id = ?', 'QUEUED', gameId);
        } else {
            await db.run('UPDATE games SET status = ? WHERE id = ?', parsed.status, gameId);
        }

        // Sync to iScored if requested
        if (parsed.syncIScored && game.iscored_id) {
            const { getIScoredCredsForRoom } = await import('../../utils/iscoredCreds.js');
            const creds = await getIScoredCredsForRoom(roomId);
            if (creds) {
                try {
                    const { IScoredSessionRegistry } = await import('../../engine/IScoredSessionRegistry.js');
                    await IScoredSessionRegistry.getInstance().withSession(creds, async (client) => {
                        if (parsed.status === 'ACTIVE') {
                            await client.setGameStatus(game.iscored_id, { locked: false, hidden: false });
                        } else if (parsed.status === 'COMPLETED') {
                            await client.setGameStatus(game.iscored_id, { locked: true });
                        } else if (parsed.status === 'ARCHIVED') {
                            // ARCHIVED is the local terminal state. When the
                            // admin opts in to syncIScored, ask iScored to soft-
                            // hide the entry (gentlest cleanup; doesn't delete).
                            await client.setGameStatus(game.iscored_id, { hidden: true });
                        }
                    });
                } catch (err) {
                    logError(`Failed to sync game ${gameId} to iScored:`, err);
                }
            }
        }

        // Invalidate leaderboard cache
        const { LeaderboardService } = await import('../../services/LeaderboardService.js');
        await LeaderboardService.invalidate(gameId);

        // Log activity
        const { RoomEventService } = await import('../../services/RoomEventService.js');
        await RoomEventService.log(roomId, 'game_state_change', {
            gameName: game.name,
            oldStatus,
            newStatus: parsed.status,
            syncedIScored: parsed.syncIScored && !!game.iscored_id,
        });

        logInfo(`Admin forced game state: ${game.name} ${oldStatus} → ${parsed.status} (room: ${roomId})`);
        res.json({ success: true, oldStatus, newStatus: parsed.status });
    } catch (error: any) {
        if (error.name === 'ZodError') return res.status(400).json({ error: 'Invalid request', details: error.errors });
        logError('API Error (PATCH game-states/:gameId/status):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Clear picker assignment (cancel timeout)
router.patch('/:roomId/admin/game-states/:gameId/clear-picker', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const gameId = req.params.gameId as string;
        const db = await getDatabase();

        const game = await db.get(`
            SELECT g.*, t.game_room_id
            FROM games g JOIN tournaments t ON g.tournament_id = t.id
            WHERE g.id = ? AND t.game_room_id = ?
        `, gameId, roomId);
        if (!game) return res.status(404).json({ error: 'Game not found in this room' });

        await db.run(
            'UPDATE games SET picker_discord_id = NULL, picker_type = NULL, picker_designated_at = NULL, reminder_count = 0 WHERE id = ?',
            gameId
        );

        const { RoomEventService } = await import('../../services/RoomEventService.js');
        await RoomEventService.log(roomId, 'picker_cleared', { gameName: game.name });

        logInfo(`Admin cleared picker for game: ${game.name} (room: ${roomId})`);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (PATCH game-states/:gameId/clear-picker):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Delete a game row (cleanup phantom/orphaned entries)
router.delete('/:roomId/admin/game-states/:gameId', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const gameId = req.params.gameId as string;
        const parsed = DeleteGameStateSchema.parse(req.body);
        const db = await getDatabase();

        // v2.4.0: LEFT JOIN tournaments + COALESCE on game_room_id so pinned
        // games (tournament_id IS NULL) resolve via the denormalized
        // games.game_room_id column added in migration 073. Tournament games
        // keep working because their row inherits the same FK.
        const game = await db.get(`
            SELECT g.*, t.game_room_id AS tournament_game_room_id
            FROM games g LEFT JOIN tournaments t ON g.tournament_id = t.id
            WHERE g.id = ? AND COALESCE(t.game_room_id, g.game_room_id) = ?
        `, gameId, roomId);
        if (!game) return res.status(404).json({ error: 'Game not found in this room' });

        // Safety guard: never silently delete a LIVE game. Deleting an ACTIVE
        // game mid-round removes it and orphans its scores, so require an explicit
        // force flag (the UI shows a warning before setting it). For a normal
        // end-of-round, admins Deactivate on the Tournaments page instead. This
        // also protects non-UI callers (API/scripts) that omit force.
        if (game.status === 'ACTIVE' && !parsed.force) {
            return res.status(409).json({
                error: `"${game.name}" is currently ACTIVE. Deactivate it for a normal end-of-round, or confirm force-delete to remove it mid-round.`,
                status: 'ACTIVE',
                gameName: game.name,
            });
        }

        // Delete from iScored if requested (per-room creds via resolver).
        if (parsed.deleteFromIScored && game.iscored_id) {
            const { getIScoredCredsForRoom } = await import('../../utils/iscoredCreds.js');
            const creds = await getIScoredCredsForRoom(roomId);
            if (creds) {
                try {
                    const { IScoredSessionRegistry } = await import('../../engine/IScoredSessionRegistry.js');
                    const deleted = await IScoredSessionRegistry.getInstance().withSession(creds, (client) =>
                        client.deleteGame(game.iscored_id, game.name),
                    );
                    if (deleted) {
                        logInfo(`Deleted game from iScored: ${game.name} (${game.iscored_id})`);
                    } else {
                        logWarn(`iScored delete skipped for ${game.name} (${game.iscored_id}): not in dropdown.`);
                    }
                } catch (err) {
                    logError(`Failed to delete game ${gameId} from iScored:`, err);
                }
            }
        }

        // v2.4.0: unlink scores instead of cascading, so player history is
        // preserved even when the game row is removed (matches unpin semantics).
        await db.run('UPDATE submissions SET game_id = NULL WHERE game_id = ?', gameId);
        await db.run('DELETE FROM leaderboard_cache WHERE game_id = ?', gameId);
        await db.run('UPDATE score_history SET game_id = NULL WHERE game_id = ?', gameId);
        await db.run('UPDATE global_scores SET origin_game_id = NULL WHERE origin_game_id = ?', gameId);
        await db.run('DELETE FROM games WHERE id = ?', gameId);

        const { RoomEventService } = await import('../../services/RoomEventService.js');
        await RoomEventService.log(roomId, 'game_deleted', {
            gameName: game.name,
            status: game.status,
            deletedFromIScored: parsed.deleteFromIScored && !!game.iscored_id,
        });

        logInfo(`Admin deleted game: ${game.name} (status: ${game.status}, room: ${roomId})`);
        res.json({ success: true });
    } catch (error: any) {
        if (error.name === 'ZodError') return res.status(400).json({ error: 'Invalid request', details: error.errors });
        logError('API Error (DELETE game-states/:gameId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Remove a game from leaderboard (retains scores/history for player records)
router.delete('/:roomId/admin/games/:gameId', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const gameId = req.params.gameId as string;
        const db = await getDatabase();

        const game = await db.get(`
            SELECT g.*, t.game_room_id
            FROM games g JOIN tournaments t ON g.tournament_id = t.id
            WHERE g.id = ? AND t.game_room_id = ?
        `, gameId, roomId);
        if (!game) return res.status(404).json({ error: 'Game not found in this room' });

        // Clean up on iScored if the game has an iScored ID
        if (game.iscored_id) {
            const { getIScoredCredsForRoom } = await import('../../utils/iscoredCreds.js');
            const creds = await getIScoredCredsForRoom(roomId);
            if (creds) {
                try {
                    const { IScoredSessionRegistry } = await import('../../engine/IScoredSessionRegistry.js');
                    const deleted = await IScoredSessionRegistry.getInstance().withSession(creds, (client) =>
                        client.deleteGame(game.iscored_id, game.name),
                    );
                    if (deleted) {
                        logInfo(`Deleted game from iScored: ${game.name} (${game.iscored_id})`);
                    } else {
                        logWarn(`iScored delete skipped for ${game.name} (${game.iscored_id}): not in dropdown.`);
                    }
                } catch (err) {
                    logError(`Failed to delete game ${gameId} from iScored:`, err);
                    // Continue with local deletion even if iScored fails
                }
            }
        }

        // Retain submissions & score_history for player records, but unlink them
        // from the game first (FK enforcement, S3) so the games delete doesn't
        // violate the game_id FK. Mirrors the sibling game-states delete above.
        await db.run('DELETE FROM leaderboard_cache WHERE game_id = ?', gameId);
        await db.run('UPDATE submissions SET game_id = NULL WHERE game_id = ?', gameId);
        await db.run('UPDATE score_history SET game_id = NULL WHERE game_id = ?', gameId);
        await db.run('UPDATE global_scores SET origin_game_id = NULL WHERE origin_game_id = ?', gameId);
        await db.run('DELETE FROM scores WHERE game_id = ?', gameId);
        await db.run('DELETE FROM games WHERE id = ?', gameId);

        const { LeaderboardService } = await import('../../services/LeaderboardService.js');
        await LeaderboardService.invalidate(gameId);

        const { RoomEventService } = await import('../../services/RoomEventService.js');
        await RoomEventService.log(roomId, 'game_removed', {
            gameName: game.name,
            status: game.status,
            hadIScored: !!game.iscored_id,
            scoresRetained: true,
        });

        logInfo(`Admin removed game from leaderboard: ${game.name} (status: ${game.status}, room: ${roomId}, scores retained)`);
        res.json({ success: true });
    } catch (error: any) {
        logError('API Error (DELETE admin/games/:gameId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Sync a single game to iScored (granular operations)
router.post('/:roomId/admin/game-states/:gameId/sync-iscored', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const gameId = req.params.gameId as string;
        const parsed = SyncIScoredActionSchema.parse(req.body);
        const db = await getDatabase();

        const game = await db.get(`
            SELECT g.*, t.game_room_id
            FROM games g JOIN tournaments t ON g.tournament_id = t.id
            WHERE g.id = ? AND t.game_room_id = ?
        `, gameId, roomId);
        if (!game) return res.status(404).json({ error: 'Game not found in this room' });

        const { getIScoredCredsForRoom } = await import('../../utils/iscoredCreds.js');
        const creds = await getIScoredCredsForRoom(roomId);
        if (!creds) {
            return res.status(400).json({ error: 'No iScored credentials configured for this room.' });
        }
        // Hoist the iscored_id requirement check out of the withSession
        // callback — throwing inside the registry callback would propagate as a
        // generic 500, so do the validation up here and return 400 cleanly.
        const requiresIscoredId =
            parsed.action === 'lock' || parsed.action === 'unlock'
            || parsed.action === 'hide' || parsed.action === 'unhide'
            || parsed.action === 'delete';
        if (requiresIscoredId && !game.iscored_id) {
            return res.status(400).json({ error: 'Game has no iScored ID' });
        }
        const { IScoredSessionRegistry } = await import('../../engine/IScoredSessionRegistry.js');
        await IScoredSessionRegistry.getInstance().withSession(creds, async (client) => {
            switch (parsed.action) {
                case 'lock':
                    await client.setGameStatus(game.iscored_id, { locked: true });
                    break;
                case 'unlock':
                    await client.setGameStatus(game.iscored_id, { locked: false, hidden: false });
                    break;
                case 'hide':
                    await client.setGameStatus(game.iscored_id, { hidden: true });
                    break;
                case 'unhide':
                    await client.setGameStatus(game.iscored_id, { hidden: false });
                    break;
                case 'delete': {
                    const deleted = await client.deleteGame(game.iscored_id, game.name);
                    if (!deleted) {
                        logWarn(`iScored delete skipped for ${game.name} (${game.iscored_id}): not in dropdown.`);
                    }
                    await db.run('UPDATE games SET iscored_id = NULL WHERE id = ?', gameId);
                    break;
                }
                case 'create': {
                    const styleId = game.style_id || undefined;
                    const newId = await client.createGame(game.name, styleId);
                    await db.run('UPDATE games SET iscored_id = ? WHERE id = ?', newId, gameId);
                    break;
                }
            }
        });

        const { RoomEventService } = await import('../../services/RoomEventService.js');
        await RoomEventService.log(roomId, 'iscored_sync', { gameName: game.name, action: parsed.action });

        logInfo(`Admin iScored sync: ${parsed.action} on ${game.name} (room: ${roomId})`);
        res.json({ success: true, action: parsed.action });
    } catch (error: any) {
        if (error.name === 'ZodError') return res.status(400).json({ error: 'Invalid request', details: error.errors });
        logError('API Error (POST game-states/:gameId/sync-iscored):', error);
        res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
});

// Force maintenance for a tournament
router.post('/:roomId/admin/game-states/force-maintenance', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const { tournamentId } = req.body;
        if (!tournamentId) return res.status(400).json({ error: 'tournamentId required' });

        const db = await getDatabase();
        const tournament = await db.get('SELECT id, name, game_room_id FROM tournaments WHERE id = ? AND game_room_id = ?', tournamentId, roomId);
        if (!tournament) return res.status(404).json({ error: 'Tournament not found in this room' });

        const { RoomEventService } = await import('../../services/RoomEventService.js');
        await RoomEventService.log(roomId, 'force_maintenance', { tournamentName: tournament.name });

        logInfo(`Admin forcing maintenance for tournament: ${tournament.name} (room: ${roomId})`);

        // Await the run so the admin sees the REAL outcome (S10) instead of an
        // optimistic "triggered" + a blind FE refetch. The per-tournament mutex
        // bounds the runtime; a forced run is an explicit admin action, so
        // blocking the response is acceptable.
        try {
            await TournamentEngine.getInstance().runMaintenance(tournamentId);
        } catch (err) {
            logError(`Forced maintenance failed for ${tournament.name}:`, err);
            return res.status(500).json({
                error: err instanceof Error ? err.message : 'Maintenance failed',
                tournamentName: tournament.name,
            });
        }

        // Report the outcome the run just recorded to the maintenance-run trail.
        const { MaintenanceRunService } = await import('../../services/MaintenanceRunService.js');
        const latest = (await MaintenanceRunService.getLatestPerTournament(roomId)).get(tournamentId);
        res.json({
            success: true,
            outcome: latest?.outcome ?? 'success',
            summary: latest?.summary ?? `Maintenance complete for ${tournament.name}`,
            message: `Maintenance complete for ${tournament.name}`,
        });
    } catch (error) {
        logError('API Error (POST game-states/force-maintenance):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET — room-admin health / observability surface (S10). Real Discord gateway
// readiness + guild membership (not env-var presence), ScoreSyncPoller sync
// status, per-tournament last-run outcome + next fire, and app version.
router.get('/:roomId/admin/health', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const db = await getDatabase();

        // --- Discord gateway health (real readiness, not env presence) ---
        const { getDiscordClient } = await import('../../discord/DiscordClient.js');
        const discordClient = getDiscordClient();
        const guildId = await GameRoomSettingsService.get(roomId, 'DISCORD_GUILD_ID');
        const discordEnabled = (await GameRoomSettingsService.get(roomId, 'DISCORD_ENABLED')) !== 'false';
        const ready = !!discordClient?.isReady();
        const inGuild = ready && guildId ? discordClient!.isInGuild(guildId) : null;

        // --- Poller sync status (global singleton) — scoped to THIS room's
        // account only (D3, v2.32.0). Pre-fix this leaked every OTHER room's
        // iScored account health onto this room's dashboard, since the poller
        // tracks accounts globally. `getIScoredCredsForRoom` already applies
        // the room's ISCORED_ENABLED gate + per-room/env creds resolution;
        // accountHealth (surfaced as PollerAccountStatus.name) is keyed by
        // `creds.gameroomName` (see ScoreSyncPoller.recordAccountSuccess/Failure),
        // so filtering on that name isolates this room's own account. No creds
        // → no accounts (room isn't polled at all).
        const { ScoreSyncPoller } = await import('../../engine/ScoreSyncPoller.js');
        const { getIScoredCredsForRoom } = await import('../../utils/iscoredCreds.js');
        const rawPoller = ScoreSyncPoller.getInstance().getStatus();
        const iscoredEnabled = (await GameRoomSettingsService.get(roomId, 'ISCORED_ENABLED')) !== 'false';
        const roomIScoredCreds = await getIScoredCredsForRoom(roomId);
        const poller = {
            ...rawPoller,
            accounts: roomIScoredCreds
                ? rawPoller.accounts.filter(a => a.name === roomIScoredCreds.gameroomName)
                : [],
        };

        // --- Per-tournament maintenance trail + next fire ---
        const { MaintenanceRunService } = await import('../../services/MaintenanceRunService.js');
        const { getNextRunTime } = await import('../../utils/cronUtils.js');
        const latestRuns = await MaintenanceRunService.getLatestPerTournament(roomId);
        const envTz = process.env.BOT_TIMEZONE || 'America/Chicago';
        const tournamentRows = await db.all(
            'SELECT id, name, is_active, cadence FROM tournaments WHERE game_room_id = ? ORDER BY display_order ASC, name ASC',
            roomId,
        );
        const maintenance = tournamentRows.map((t: any) => {
            let nextFireAt: string | null = null;
            // Only compute a next fire for active tournaments — a paused one has
            // its maintenance cron removed by Scheduler.reload().
            if (t.is_active !== 0 && t.cadence) {
                try {
                    const c = JSON.parse(t.cadence);
                    if (c.cron) {
                        const next = getNextRunTime(c.cron, c.timezone || envTz);
                        nextFireAt = next ? next.toISOString() : null;
                    }
                } catch { /* leave null on malformed cadence */ }
            }
            return {
                tournamentId: t.id,
                tournamentName: t.name,
                isActive: t.is_active !== 0,
                lastRun: latestRuns.get(t.id) ?? null,
                nextFireAt,
            };
        });

        const { getVersionInfo } = await import('../../utils/version.js');

        res.json({
            discord: { enabled: discordEnabled, ready, inGuild, guildId: guildId || null },
            iscored: { enabled: iscoredEnabled, configured: !!roomIScoredCreds },
            poller,
            maintenance,
            version: getVersionInfo(),
        });
    } catch (error) {
        logError('API Error (GET admin/health):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET — iScored reconcile DRY-RUN. Categorize the games currently on iScored
// (by iscored_id) against the local DB into keep / orphans / unmanaged so an
// admin can clean up entries ArcAid archived but iScored never deleted.
router.get('/:roomId/admin/game-states/iscored-reconcile', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const { getIScoredCredsForRoom } = await import('../../utils/iscoredCreds.js');
        const creds = await getIScoredCredsForRoom(roomId);
        if (!creds) return res.status(400).json({ error: 'No iScored credentials configured for this room.' });

        const { IScoredSessionRegistry } = await import('../../engine/IScoredSessionRegistry.js');
        const iscoredGames = await IScoredSessionRegistry.getInstance()
            .withSession(creds, (client) => client.getGamesOnIScored());

        const { buildReconcilePlan } = await import('../../services/IScoredReconcileService.js');
        const plan = await buildReconcilePlan(iscoredGames);
        res.json(plan);
    } catch (error: any) {
        logError('API Error (GET game-states/iscored-reconcile):', error);
        res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
});

// POST — EXECUTE reconcile: delete the given iScored gameIDs. The plan is
// re-derived inside the session and anything in `keep` is refused, so a live
// game can never be deleted even if the client sends a stale or forged id.
router.post('/:roomId/admin/game-states/iscored-reconcile', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const gameIds: string[] = Array.isArray(req.body?.gameIds)
            ? req.body.gameIds.map((g: unknown) => String(g))
            : [];
        if (gameIds.length === 0) return res.status(400).json({ error: 'No gameIds provided.' });

        const { getIScoredCredsForRoom } = await import('../../utils/iscoredCreds.js');
        const creds = await getIScoredCredsForRoom(roomId);
        if (!creds) return res.status(400).json({ error: 'No iScored credentials configured for this room.' });

        const { IScoredSessionRegistry } = await import('../../engine/IScoredSessionRegistry.js');
        const { buildReconcilePlan } = await import('../../services/IScoredReconcileService.js');

        const results = await IScoredSessionRegistry.getInstance().withSession(creds, async (client) => {
            const iscoredGames = await client.getGamesOnIScored();
            const plan = await buildReconcilePlan(iscoredGames);
            const deletable = new Map<string, string>(); // id -> name (orphans + unmanaged only)
            for (const e of [...plan.orphans, ...plan.unmanaged]) deletable.set(e.id, e.name);

            const out: { id: string; name: string | null; deleted: boolean; reason?: string }[] = [];
            for (const id of gameIds) {
                const name = deletable.get(id);
                if (name === undefined) {
                    out.push({ id, name: null, deleted: false, reason: 'kept for safety (live game or not present on iScored)' });
                    continue;
                }
                const deleted = await client.deleteGame(id, name);
                out.push({ id, name, deleted });
            }
            return out;
        });

        const deletedCount = results.filter((r) => r.deleted).length;
        const { RoomEventService } = await import('../../services/RoomEventService.js');
        await RoomEventService.log(roomId, 'iscored_reconcile', { requested: gameIds.length, deleted: deletedCount });
        logInfo(`Admin iScored reconcile (room ${roomId}): deleted ${deletedCount}/${gameIds.length} game(s)`);
        res.json({ success: true, deletedCount, results });
    } catch (error: any) {
        logError('API Error (POST game-states/iscored-reconcile):', error);
        res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
});

export default router;
