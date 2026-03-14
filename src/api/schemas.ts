import { z } from 'zod';

// Simple cron expression validation (5 or 6 fields)
const cronSchema = z.string().regex(
    /^(\*|([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])|\*\/([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])) (\*|([0-9]|1[0-9]|2[0-3])|\*\/([0-9]|1[0-9]|2[0-3])) (\*|([1-9]|1[0-9]|2[0-9]|3[0-1])|\*\/([1-9]|1[0-9]|2[0-9]|3[0-1])) (\*|([1-9]|1[0-2])|\*\/([1-9]|1[0-2])) (\*|([0-6])|\*\/([0-6]))$/,
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
]).transform((v: string[] | string) => Array.isArray(v) ? JSON.stringify(v) : v).optional().default('[]');

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
    ui_theme: z.enum(['arcade', 'dark', 'light']).nullable(),
});
