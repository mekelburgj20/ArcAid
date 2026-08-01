import { z } from 'zod';
import { containsBlockedTerm } from '../utils/contentBlocklist.js';
import { normalizeTournamentRulesInput } from '../utils/platformRules.js';

// S22 Phase 1 content moderation (v2.43.0) — shared field-level refine so a
// blocked-term name fails Zod validation before it ever reaches a service.
// Applied per-field (not per-object) so `.omit()`/`.default()` composition
// on the containing z.object() keeps working (ZodEffects from an
// object-level `.refine()` loses those methods).
const blockedTermMessage = "This name isn't allowed.";
function noBlockedTerm(value: string): boolean {
    return !containsBlockedTerm(value);
}

// Simple cron expression validation (5 or 6 fields)
const cronSchema = z.string().regex(
    /^(\*|([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])|\*\/([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])) (\*|([0-9]|1[0-9]|2[0-3])|\*\/([0-9]|1[0-9]|2[0-3])) (\*|L|([1-9]|1[0-9]|2[0-9]|3[0-1])|\*\/([1-9]|1[0-9]|2[0-9]|3[0-1])) (\*|([1-9]|1[0-2])|\*\/([1-9]|1[0-2])) (\*|([0-6])|\*\/([0-6]))$/,
    'Invalid cron expression (must be 5 fields: min hour day month weekday)'
);

const discordIdSchema = z.string().regex(/^\d{17,20}$/, 'Must be a valid Discord ID (17-20 digits)');

/**
 * `tournaments.platform_rules` — ADR 0016 P2 §2's two-axis shape.
 *
 * The preprocess step runs `normalizeTournamentRulesInput`, the SAME lift the
 * read path uses, so a client still POSTing the pre-0016 flat shape (a stale
 * browser tab, an older integration) is upgraded rather than rejected — and
 * every write persists the new shape. See `src/utils/platformRules.ts`.
 */
const axisRulesSchema = z.object({
    required: z.array(z.string()).default([]),
    excluded: z.array(z.string()).default([]),
}).default({ required: [], excluded: [] });

const emptyPlatformRules = {
    engines: { required: [], excluded: [] },
    devices: { required: [], excluded: [] },
    restrictedText: '',
};

const platformRulesSchema = z.preprocess(
    (value) => (value === undefined ? undefined : normalizeTournamentRulesInput(value)),
    z.object({
        engines: axisRulesSchema,
        devices: axisRulesSchema,
        restrictedText: z.string().optional().default(''),
    }),
).default(emptyPlatformRules);

export const CreateTournamentSchema = z.object({
    id: z.string().uuid(),
    name: z.string().min(1, 'Name required').max(100).refine(noBlockedTerm, blockedTermMessage),
    type: z.string().min(1).max(50),
    mode: z.enum(['pinball', 'videogame']).default('pinball'),
    cadence: z.object({
        cron: cronSchema,
        autoRotate: z.boolean(),
        autoLock: z.boolean(),
        timezone: z.string().optional(),
        announcementChannel: z.string().optional(),
    }),
    platform_rules: platformRulesSchema,
    guild_id: z.string().optional().default(''),
    discord_channel_id: discordIdSchema.optional().or(z.literal('')).default(''),
    discord_role_id: discordIdSchema.optional().or(z.literal('')).default(''),
    is_active: z.boolean().default(true),
    display_order: z.number().int().min(0).default(0),
    max_active_games: z.number().int().min(1).max(10).default(1),
    winner_picks: z.boolean().default(true),
    auto_pick: z.boolean().default(true),
    eligibility_days: z.number().int().min(1).max(365).default(120),
    winner_pick_window_min: z.number().int().min(1).max(1440).default(60),
    runnerup_pick_window_min: z.number().int().min(1).max(1440).default(30),
    cleanup_rule: z.discriminatedUnion('mode', [
        z.object({ mode: z.literal('immediate') }),
        z.object({ mode: z.literal('retain'), count: z.number().int().min(0).max(50) }),
        z.object({ mode: z.literal('scheduled'), cron: cronSchema, timezone: z.string().optional() }),
    ]).default({ mode: 'retain', count: 0 }),
});

export const UpdateTournamentSchema = CreateTournamentSchema.omit({ id: true });

// S7 — focused pause/resume toggle. Flips tournaments.is_active without
// round-tripping the full tournament config (so the FE pause toggle can't
// clobber concurrent edits). Scheduler.reload() picks up the change.
export const ToggleTournamentActiveSchema = z.object({ is_active: z.boolean() });

export const SettingsSchema = z.record(z.string().min(1), z.string());

export const HistoryQuerySchema = z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    tournament_id: z.string().optional(),
    type: z.string().optional(),
});

export const BackupRestoreParamsSchema = z.object({
    name: z.string().min(1).refine(
        (val) => !val.includes('..') && !val.includes('/') && !val.includes('\\'),
        'Invalid backup name'
    ),
});

export const MergePlayerSchema = z.object({
    fromUsername: z.string().min(1, 'Source username required').max(200),
    toUsername: z.string().min(1, 'Target username required').max(200),
});

export const CreateRankingGroupSchema = z.object({
    id: z.string().uuid(),
    name: z.string().min(1, 'Name required').max(100),
    description: z.string().max(500).default(''),
    rank_method: z.enum(['max_10', 'average_rank', 'best_game_papa', 'best_game_linear']),
    best_n: z.number().int().min(1).max(100).default(25),
    min_games: z.number().int().min(1).max(100).default(1),
    tournament_ids: z.array(z.string()).min(1, 'At least one tournament required'),
});

export const UpdateRankingGroupSchema = CreateRankingGroupSchema.omit({ id: true });

export const UpdatePreferencesSchema = z.object({
    ui_theme: z.enum(['dark', 'light', 'retro', 'cyberpunk', 'ocean', 'sunset', 'minimal', 'invaders', 'coffee', 'backglass', 'crt-green', 'plasma', 'cabinet', 'silverball', 'wizard', 'playfield', 'marquee']).nullable(),
});

// S15 web push — the browser PushSubscription shape (endpoint + the two
// client-generated encryption keys). Push endpoints are always https URLs;
// the keys are base64url (p256dh ≈ 87 chars, auth ≈ 22) — bounds + charset
// keep garbage rows (which would fail on every future send) out of the table.
const PushKeyString = z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/);
export const PushSubscriptionSchema = z.object({
    endpoint: z.string().url().max(2048).startsWith('https://'),
    keys: z.object({
        p256dh: PushKeyString,
        auth: PushKeyString,
    }),
});

export const PushUnsubscribeSchema = z.object({
    endpoint: z.string().url().max(2048).startsWith('https://'),
});

export const CreateGameRoomSchema = z.object({
    name: z.string().min(1).max(100).refine(noBlockedTerm, blockedTermMessage),
    slug: z.string().min(1).max(50).regex(/^[a-z0-9_]+$/, 'Slug must be lowercase alphanumeric with underscores')
        .refine(noBlockedTerm, blockedTermMessage),
    description: z.string().max(500).default(''),
    is_public: z.boolean().default(true),
    logo_url: z.string().url().optional().or(z.literal('')),
    discord_guild_id: z.string().optional().default(''),
    // Sprint 13 — optional short label (≤6 chars) for RoomTag badges. Server
    // normalizes on write (uppercase + slice); null means fall back to slug.
    // n3 (S22 Phase 1 adversarial review) — short_tag renders publicly on
    // room cards; a 6-char field is short but some blocked terms still fit
    // whole ("gook", "nigga" doesn't but others do) or as a truncated hint.
    short_tag: z.string().max(6).nullable().optional()
        .refine((v) => v == null || noBlockedTerm(v), blockedTermMessage),
    // Standalone-room Phase 1 (v2.32.0) — when absent, behaves exactly as
    // before (connected room, Discord/iScored integrations left on their
    // normal defaults). 'standalone' seeds DISCORD_ENABLED/ISCORED_ENABLED
    // false at creation — a pure-web room with no Discord guild or iScored
    // board.
    mode: z.enum(['standalone', 'connected']).optional(),
});

/**
 * PUT /api/admin/rooms/:roomId body (v2.43.0 — S22 Phase 1 recon risk #2:
 * this route previously had NO Zod schema at all). Covers exactly the
 * fields `GameRoomService.update` whitelists — every field optional since
 * the route is a partial-update PATCH-style PUT (only supplied fields are
 * written). Blocklist refine on name/slug; no other behavior change.
 */
export const UpdateGameRoomSchema = z.object({
    name: z.string().min(1).max(100).refine(noBlockedTerm, blockedTermMessage).optional(),
    slug: z.string().min(1).max(50).regex(/^[a-z0-9_]+$/, 'Slug must be lowercase alphanumeric with underscores')
        .refine(noBlockedTerm, blockedTermMessage).optional(),
    description: z.string().max(500).optional(),
    is_public: z.boolean().optional(),
    logo_url: z.string().url().or(z.literal('')).nullable().optional(),
    discord_guild_id: z.string().nullable().optional(),
    // n3 (S22 Phase 1 adversarial review) — short_tag renders publicly on
    // room cards; a 6-char field is short but some blocked terms still fit
    // whole ("gook", "nigga" doesn't but others do) or as a truncated hint.
    short_tag: z.string().max(6).nullable().optional()
        .refine((v) => v == null || noBlockedTerm(v), blockedTermMessage),
});

// Public self-serve room creation (v2.33.0) — route segments that a bare-slug
// path (/<slug>, /<slug>/admin/*, etc.) would collide with. Hyphenated routes
// like /my-rooms and /create-room can't collide since the slug regex below
// excludes hyphens, but they're listed anyway for readers scanning this list.
export const RESERVED_ROOM_SLUGS = [
    'admin', 'login', 'auth', 'invite', 'privacy', 'terms', 'friends',
    'account', 'scoreboard', 'games', 'api', 'assets', 'kiosk', 'submit',
    'create', 'createroom', 'room', 'rooms', 'settings', 'static', 'public',
    'www', 'arcaid', 'help', 'about',
];

// Public self-serve room creation (v2.33.0). Deliberately narrower than
// CreateGameRoomSchema (super-admin path): no logo_url/discord_guild_id/
// short_tag/mode — those stay super-admin-only or server-forced (mode is
// always 'standalone' for this path, set in the route handler, not accepted
// from the client).
export const PublicCreateRoomSchema = z.object({
    name: z.string().min(1).max(100).refine(noBlockedTerm, blockedTermMessage),
    slug: z.string().min(1).max(50)
        .regex(/^[a-z0-9_]+$/, 'Slug must be lowercase alphanumeric with underscores')
        .refine((slug) => !RESERVED_ROOM_SLUGS.includes(slug), 'This name is reserved')
        .refine(noBlockedTerm, blockedTermMessage),
    description: z.string().max(500).default(''),
    is_public: z.boolean().default(true),
});

export const CreateLocalAdminSchema = z.object({
    username: z.string().min(1).max(50),
    password: z.string().min(8).max(100),
    display_name: z.string().max(100).optional(),
});

export const AssignStyleSchema = z.object({
    catalogueStyleId: z.string().min(1),
    headerDisabled: z.boolean().default(false),
});

export const AssignImageSchema = z.object({
    styleId: z.string().min(1),
    imageType: z.enum(['logo', 'background', 'both']),
});

export const StyleUploadSchema = z.object({
    name: z.string().min(1).max(200),
    author: z.string().min(1).max(100),
    notes: z.string().max(500).default(''),
});

/**
 * Upper bound for any submitted score. 1e15 — far above any real score
 * (including the 1T+ display case) but below Number.MAX_SAFE_INTEGER
 * (~9.007e15), so integer precision holds and the value stays within SQLite's
 * INTEGER range. Guards the guest submit paths against precision-loss /
 * overflow leaderboard poisoning (S11 item c).
 */
export const MAX_SCORE = 1_000_000_000_000_000;

/**
 * v2.53.0 (ADR 0016) — engine + device score provenance, required on every web
 * submission path. Spread into all four submit schemas so the shape can never
 * diverge between them.
 *
 * Both are REQUIRED, and `'unknown'` is a legal value on either axis (never
 * NULL, never absent) — a client that genuinely can't determine one says so
 * explicitly. The values are re-validated against the game's resolved scope by
 * `ScoreProvenanceService.validate`; Zod only guarantees presence and shape.
 */
export const scoreProvenanceFields = {
    engine: z.string().min(1).max(50),
    device: z.string().min(1).max(50),
} as const;

export const CommunityScoreSchema = z.object({
    // v2.54.0 username lock: optional at the schema layer because an
    // AUTHENTICATED submitter's name is resolved server-side (see
    // `resolveSubmitUsername` in rooms.ts) and this field is ignored for them.
    // Guests still need one — the handler 400s when a guest omits it.
    // Length/emptiness rules for the guest path are unchanged.
    username: z.string().min(1).max(100).optional(),
    score: z.number().int().min(0).max(MAX_SCORE),
    // discord_user_id intentionally NOT accepted here — attribution is derived
    // server-side from the verified Bearer token (req.user.discordId), never
    // trusted from the request body (see rooms.ts POST handler).
    photo_url: z.string().url().optional(),
    // v2.5.0: per-score platform tag. v2.53.0 (ADR 0016): superseded by
    // engine+device below and now OPTIONAL — the server DERIVES the legacy
    // platform value from the pair so the read paths that still consume the
    // `platform` column keep working. Any client-supplied value is ignored.
    platform: z.string().min(1).optional(),
    ...scoreProvenanceFields,
});

export const ScoreSubmissionSchema = z.object({
    // Optional for authenticated submitters — see CommunityScoreSchema.
    username: z.string().min(1).max(100).optional(),
    score: z.preprocess(v => typeof v === 'string' ? parseInt(v as string, 10) : v, z.number().int().min(0).max(MAX_SCORE)),
    platform: z.string().min(1).optional(),
    ...scoreProvenanceFields,
});

/**
 * Freeplay submission body. Multipart/form-data (multer parses files separately),
 * so string→number / string→boolean coercion is built in via z.preprocess.
 * Promoted from inline checks in `rooms.ts:1128` to a named schema so all three
 * web submit paths share validation shape.
 */
export const FreeplayScoreSchema = z.object({
    globalGameId: z.string().min(1),
    // Optional for authenticated submitters — see CommunityScoreSchema.
    username: z.string().min(1).max(100).optional(),
    score: z.preprocess(v => typeof v === 'string' ? parseInt(v as string, 10) : v, z.number().int().min(0).max(MAX_SCORE)),
    excludeGlobal: z.preprocess(
        v => v === 'true' || v === true,
        z.boolean(),
    ).default(false),
    platform: z.string().min(1).optional(),
    ...scoreProvenanceFields,
});

/**
 * v2.53.0 — text fields of `POST /api/global/scores` (multipart, so everything
 * arrives as a string). Previously hand-parsed inline in `global.ts`; promoted
 * to a schema so the global path validates the same shape as the three
 * room-scoped ones.
 */
export const GlobalScoreSubmissionSchema = z.object({
    globalGameId: z.string().min(1),
    score: z.preprocess(v => typeof v === 'string' ? parseInt(v as string, 10) : v, z.number().int().min(0).max(MAX_SCORE)),
    // v2.54.0 username lock: `displayName` is deliberately ABSENT. This route is
    // `requireDiscordUser`, so the name is always resolved server-side via
    // `UserProfileService.resolveSubmitName` and the body has no say. The field
    // is omitted rather than declared-and-ignored so that an older client still
    // posting one has it silently stripped (z.object strips unknown keys) — the
    // same "ignored, not rejected" behaviour as before, including for values
    // that would have failed the old 50-char cap.
    excludeFromGlobal: z.preprocess(v => v === 'true' || v === true, z.boolean()).default(false),
    platform: z.string().min(1).optional(),
    ...scoreProvenanceFields,
});

export const PickGameSchema = z.object({
    tournamentId: z.string().min(1),
    gameName: z.string().min(1).max(200),
});

/**
 * Input for the per-room game-library proposal flow. Used by:
 *   - POST /:roomId/game_library/proposals       (dedup preview)
 *   - POST /:roomId/game_library/submit_to_global (commit pending global submission)
 */
export const GameProposalSchema = z.object({
    name: z.string().min(1).max(200),
    manufacturer: z.string().max(100).optional(),
    year: z.preprocess(
        v => v === '' || v === null || v === undefined ? undefined : Number(v),
        z.number().int().min(1900).max(2100).optional(),
    ),
    type: z.enum(['pinball', 'video_game']).default('pinball'),
    platforms: z.array(z.string().min(1)).optional(),
});

/**
 * Bulk CSV preview body. Client parses CSV in-browser and posts the row
 * list as JSON. Cap at 500 rows so a malicious client can't trigger
 * unbounded dedup work; real CSVs from rooms are typically ≤200 rows.
 */
export const ImportCsvPreviewSchema = z.object({
    games: z.array(GameProposalSchema).min(1).max(500),
});

/**
 * Bulk CSV commit body. Each entry carries the original input. After step 2
 * the only valid decision is submit_to_global; auto_link rows are skipped
 * client-side because the catalogue IS the library.
 */
export const ImportCsvCommitSchema = z.object({
    games: z.array(z.object({
        input: GameProposalSchema,
        decision: z.literal('submit_to_global'),
    })).min(1).max(500),
});

export const ReorderQueueSchema = z.object({
    gameIds: z.array(z.string().min(1)).min(1).max(20),
});

export const GameCommentSchema = z.object({
    display_name: z.string().min(1).max(50),
    type: z.enum(['comment', 'tip']),
    body: z.string().min(1).max(500),
});

export const UpdateGameStateSchema = z.object({
    status: z.enum(['QUEUED', 'ACTIVE', 'COMPLETED', 'ARCHIVED']),
    syncIScored: z.boolean().default(false),
    confirm: z.literal(true),
});

export const DeleteGameStateSchema = z.object({
    deleteFromIScored: z.boolean().default(false),
    confirm: z.literal(true),
    // Force-delete a game even when it is ACTIVE. Defaults false so a live game
    // can't be silently removed mid-round — the delete handler 409s without it.
    force: z.boolean().default(false),
});

export const SyncIScoredActionSchema = z.object({
    action: z.enum(['lock', 'unlock', 'hide', 'unhide', 'delete', 'create']),
});

/**
 * Query params for GET /:roomId/room-scores — every score ever set in a room,
 * best-per-player-per-game across sources (reads score_history alone; see
 * RoomScoresService). Replaces the old bare-array /:roomId/community-leaderboards
 * endpoint (scores-page-redesign).
 */
export const RoomScoresQuerySchema = z.object({
    sort: z.enum(['recent', 'alpha', 'most_played']).default('recent'),
    limit: z.coerce.number().int().min(1).max(100).default(48),
    offset: z.coerce.number().int().min(0).default(0),
    search: z.string().trim().max(100).optional(),
});

/**
 * Report-a-problem (v2.25.0) — POST /global/games/:id/feedback body. The
 * disputed field's current value is snapshotted server-side, never trusted
 * from the client. At least one of suggested_value/note must be non-empty.
 */
export const GameFeedbackSchema = z.object({
    field: z.enum([
        'name', 'manufacturer', 'year', 'platforms', 'artwork', 'duplicate', 'other',
        // Contract §5 — "not score-eligible (game isn't score-based)". A
        // catalogue-fitness claim rather than a wrong-value claim, which is why
        // it is exempt from the correction/note requirement below.
        'not_score_eligible',
    ]),
    suggested_value: z.string().trim().max(300).optional(),
    note: z.string().trim().max(1000).optional(),
}).refine(
    (d) => d.field === 'not_score_eligible' || !!(d.suggested_value || d.note),
    { message: 'Provide a suggested correction or a note' },
);

/** POST /admin/catalogue/feedback/:id/resolve body. */
export const ResolveGameFeedbackSchema = z.object({
    resolution: z.enum(['fixed', 'upstream', 'dismissed']),
    note: z.string().trim().max(1000).optional(),
});

/**
 * S22 Phase 1 content moderation (v2.43.0) — POST /global/rooms/:roomId/report
 * body. Room existence + reporter identity come from the route (param +
 * verified token), not the body.
 */
export const RoomReportSchema = z.object({
    reason: z.string().trim().max(500).optional(),
});

/**
 * POST /global/report-name body. `roomId`/`targetUserId` are optional context
 * — the service handles both identity-keyed and room+name-keyed dedup.
 */
export const NameReportSchema = z.object({
    roomId: z.string().min(1).optional(),
    targetUserId: z.string().min(1).optional(),
    targetName: z.string().trim().min(1).max(64),
    reason: z.string().trim().max(500).optional(),
});

/**
 * v2.47.0 (S22 follow-ups Workstream 2) — POST /global/comments/:id/report
 * body. Comment id + reporter identity come from the route (param + verified
 * token), not the body — same shape as RoomReportSchema.
 */
export const CommentReportSchema = z.object({
    reason: z.string().trim().max(500).optional(),
});

/** POST /admin/reports/:id/resolve body. */
export const ResolveContentReportSchema = z.object({
    resolution: z.string().trim().min(1).max(500),
});

/**
 * m7 (S22 Phase 1 adversarial review) — POST /admin/score-reports/:reportId/ban
 * and POST /admin/bans bodies. Previously unvalidated: `{"durationDays":"abc"}`
 * coerced to `new Date(NaN)` inside ScoreReportService.ban, silently
 * producing a garbage `expires_at` and a 500 further down the line instead of
 * a clear 400 at the boundary.
 */
export const BanActionSchema = z.object({
    durationDays: z.number().int().min(1).max(3650).nullable().optional(),
    reason: z.string().trim().max(500).optional(),
});

/** POST /admin/bans body — BanActionSchema plus the target identity. */
export const CreateBanSchema = BanActionSchema.extend({
    discordUserId: z.string().min(1, 'discordUserId is required'),
});

/**
 * S22 Phase 2 (v2.44.0) — POST /admin/rooms/:roomId/suspend body.
 * `reason` is optional context stored on `game_rooms.suspended_reason`.
 */
export const SuspendRoomSchema = z.object({
    reason: z.string().trim().max(500).optional(),
});

/**
 * S22 Phase 2 (v2.44.0) — PATCH /admin/users/:userId/display-name body.
 * `null` clears the override (render falls back to username/id); a non-null
 * value is re-validated through the same checks as self-service
 * (UserProfileService.setDisplayName) — this schema only enforces the shape.
 * Phase 2 ships clear-to-null only from the Reports UI, but the endpoint
 * itself accepts a non-null value too (kept generic, not clear-only, since
 * setDisplayName already supports it and a future free-text rename UI should
 * not need a new endpoint).
 */
export const AdminSetDisplayNameSchema = z.object({
    displayName: z.string().trim().min(1).max(32).nullable(),
});
