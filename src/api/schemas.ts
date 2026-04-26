import { z } from 'zod';

// Simple cron expression validation (5 or 6 fields)
const cronSchema = z.string().regex(
    /^(\*|([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])|\*\/([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])) (\*|([0-9]|1[0-9]|2[0-3])|\*\/([0-9]|1[0-9]|2[0-3])) (\*|L|([1-9]|1[0-9]|2[0-9]|3[0-1])|\*\/([1-9]|1[0-9]|2[0-9]|3[0-1])) (\*|([1-9]|1[0-2])|\*\/([1-9]|1[0-2])) (\*|([0-6])|\*\/([0-6]))$/,
    'Invalid cron expression (must be 5 fields: min hour day month weekday)'
);

const discordIdSchema = z.string().regex(/^\d{17,20}$/, 'Must be a valid Discord ID (17-20 digits)');

const platformRulesSchema = z.object({
    required: z.array(z.string()).default([]),
    excluded: z.array(z.string()).default([]),
    restrictedText: z.string().optional().default(''),
}).default({ required: [], excluded: [], restrictedText: '' });

export const CreateTournamentSchema = z.object({
    id: z.string().uuid(),
    name: z.string().min(1, 'Name required').max(100),
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

const platformsField = z.union([
    z.array(z.string()),
    z.string(),
]).transform((v: string[] | string) => {
    if (Array.isArray(v)) return JSON.stringify(v);
    // Already a valid JSON array string — normalize and pass through
    try {
        const parsed = JSON.parse(v);
        if (Array.isArray(parsed)) return JSON.stringify(parsed);
    } catch {}
    // Comma-separated string → JSON array
    const list = v.split(',').map(s => s.trim()).filter(Boolean);
    return JSON.stringify(list);
}).optional().default('[]');

const gameFields = {
    name: z.string().min(1).max(200),
    aliases: z.string().optional().default(''),
    style_id: z.string().optional().default(''),
    mode: z.enum(['pinball', 'videogame']).default('pinball'),
    css_title: z.string().optional().default(''),
    css_initials: z.string().optional().default(''),
    css_scores: z.string().optional().default(''),
    css_box: z.string().optional().default(''),
    bg_color: z.string().optional().default(''),
    platforms: platformsField,
};

export const ImportGamesSchema = z.object({
    games: z.array(z.object(gameFields)).min(1, 'At least one game required'),
});

export const UpdateGameSchema = z.object(gameFields);

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

export const CreateGameRoomSchema = z.object({
    name: z.string().min(1).max(100),
    slug: z.string().min(1).max(50).regex(/^[a-z0-9_]+$/, 'Slug must be lowercase alphanumeric with underscores'),
    description: z.string().max(500).default(''),
    is_public: z.boolean().default(true),
    logo_url: z.string().url().optional().or(z.literal('')),
    discord_guild_id: z.string().optional().default(''),
    // Sprint 13 — optional short label (≤6 chars) for RoomTag badges. Server
    // normalizes on write (uppercase + slice); null means fall back to slug.
    short_tag: z.string().max(6).nullable().optional(),
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

export const CommunityScoreSchema = z.object({
    username: z.string().min(1).max(100),
    score: z.number().int().min(0),
    discord_user_id: z.string().optional(),
    photo_url: z.string().url().optional(),
    // v2.5.0: required per-score platform tag. Picker-resolved on the client
    // (auto-fill when game has 1 platform; required choice when 2+).
    platform: z.string().min(1),
});

export const ScoreSubmissionSchema = z.object({
    username: z.string().min(1).max(100),
    score: z.preprocess(v => typeof v === 'string' ? parseInt(v as string, 10) : v, z.number().int().min(0)),
    platform: z.string().min(1),
});

/**
 * Freeplay submission body. Multipart/form-data (multer parses files separately),
 * so string→number / string→boolean coercion is built in via z.preprocess.
 * Promoted from inline checks in `rooms.ts:1128` to a named schema so all three
 * web submit paths share validation shape.
 */
export const FreeplayScoreSchema = z.object({
    globalGameId: z.string().min(1),
    username: z.string().min(1).max(100),
    score: z.preprocess(v => typeof v === 'string' ? parseInt(v as string, 10) : v, z.number().int().min(0)),
    excludeGlobal: z.preprocess(
        v => v === 'true' || v === true,
        z.boolean(),
    ).default(false),
    platform: z.string().min(1),
});

export const PickGameSchema = z.object({
    tournamentId: z.string().min(1),
    gameName: z.string().min(1).max(200),
});

/**
 * v2.5.0: input for the per-room game-library proposal flow. Used by:
 *   - POST /:roomId/game_library/proposals       (dedup preview)
 *   - POST /:roomId/game_library/room_only       (commit room-only override)
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

/** v2.5.0: link an existing approved global_games row into the current room. */
export const UseGlobalGameSchema = z.object({
    globalGameId: z.string().min(1),
});

/**
 * v2.5.0: bulk CSV preview body. Client parses CSV in-browser (existing
 * pattern) and posts the row list as JSON. Cap at 500 rows so a malicious
 * client can't trigger unbounded dedup work; real CSVs from rooms are
 * typically ≤200 rows.
 */
export const ImportCsvPreviewSchema = z.object({
    games: z.array(GameProposalSchema).min(1).max(500),
});

/**
 * v2.5.0: bulk CSV commit body. Each entry carries the original input plus
 * the user's per-row decision. `globalGameId` is required only when
 * `decision === 'use_global'`; the server enforces this in-handler.
 */
export const ImportCsvCommitSchema = z.object({
    games: z.array(z.object({
        input: GameProposalSchema,
        decision: z.enum(['use_global', 'room_only', 'submit_to_global']),
        globalGameId: z.string().optional(),
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
    status: z.enum(['QUEUED', 'ACTIVE', 'COMPLETED', 'HIDDEN']),
    syncIScored: z.boolean().default(false),
    confirm: z.literal(true),
});

export const DeleteGameStateSchema = z.object({
    deleteFromIScored: z.boolean().default(false),
    confirm: z.literal(true),
});

export const SyncIScoredActionSchema = z.object({
    action: z.enum(['lock', 'unlock', 'hide', 'unhide', 'delete', 'create']),
});
