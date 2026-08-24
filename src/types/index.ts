export type TournamentMode = 'pinball' | 'videogame';

export interface CadenceConfig {
    cron: string;             // '0 0 * * *' for daily
    autoRotate: boolean;      // Whether to automatically trigger maintenance
    autoLock: boolean;        // Whether to lock the previous game automatically
    timezone?: string;        // Per-tournament timezone (falls back to BOT_TIMEZONE)
    announcementChannel?: string;
}

/**
 * ADR 0016 P2 §2 — two axes, each carrying ADR 0009's orthogonal pair.
 * The runtime source of truth is `TournamentRules` in
 * `src/utils/platformRules.ts`; this mirrors it for the `Tournament` DTO.
 */
export interface PlatformAxisRules {
    required: string[];       // Game must be available on at least one of these
    excluded: string[];       // Scores cannot be submitted from these
}

export interface PlatformRules {
    engines: PlatformAxisRules;
    devices: PlatformAxisRules;
    restrictedText?: string;  // Informational text shown in announcements
}

export type CleanupRule =
    | { mode: 'immediate' }
    | { mode: 'retain'; count: number }
    | { mode: 'scheduled'; cron: string; timezone?: string };

export interface Tournament {
    id: string;
    name: string;
    type: string;             // iScored tag (DG, WG-VPXS, etc.)
    mode: TournamentMode;     // pinball or videogame
    cadence: CadenceConfig;
    platformRules?: PlatformRules;
    guildId?: string;
    discordChannelId?: string;
    discordRoleId?: string;
    isActive: boolean;
    maxActiveGames?: number;
    winnerPicks: boolean;
    autoPick: boolean;
    eligibilityDays: number;
    winnerPickWindowMin: number;
    runnerupPickWindowMin: number;
    /**
     * v2.135.0 (ADR 0017) — 'rotation' is every tournament that existed before
     * the Live Event format: a perpetual cron-rotated slot machine with no
     * start or end. 'event' is time-boxed: N scheduled rounds, an optional
     * check-in roster, and a frozen result. The two share this table and every
     * read path; only the scheduling and submission-gating differ.
     */
    format?: TournamentFormat;
    /** Events only. ISO UTC — MIN(round start) / MAX(round end). */
    startDate?: string | null;
    endDate?: string | null;
    checkinOpensAt?: string | null;
    checkinRequired?: boolean;
    aggregateMethod?: EventAggregateMethod;
    /** Display-only gear-up threshold; see migration 163. */
    minElapsedSec?: number | null;
    endGraceSec?: number;
    eventFinishedAt?: string | null;
}

export type TournamentFormat = 'rotation' | 'event';

export type EventAggregateMethod = 'best' | 'average' | 'sum';

/**
 * 'SCHEDULED' (v2.135.0) is a pre-created Live Event round: it exists so the
 * roster, the board and the admin UI can show a round before it opens, and it
 * flips to ACTIVE at `scheduled_start_at`. It is deliberately NOT 'QUEUED' —
 * the pick queue, TimeoutManager and the queue_order backfill all act on
 * 'QUEUED' rows and must never see a round.
 */
export type GameStatus = 'QUEUED' | 'SCHEDULED' | 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';

export interface Game {
    id: string;
    tournamentId: string;
    name: string;
    iscoredId?: string;
    styleId?: string;
    status: GameStatus;
    pickerDiscordId?: string;
    pickerType?: 'WINNER' | 'RUNNER_UP';
    pickerDesignatedAt?: Date;
    reminderCount?: number;
    wonGameId?: string;
    startDate?: Date;
    endDate?: Date;
    queueOrder?: number;
    /** Non-NULL == this games row is a Live Event round (v2.135.0). */
    roundNo?: number;
    scheduledStartAt?: string;
    scheduledEndAt?: string;
}

export interface SubmissionContext {
    submittedFromRoomId: string | null;
    submittedDuringTournamentId: string | null;
    submittedByUserId: string | null;
    submittedByAnonymousName: string | null;
    mergedFromAnonymousIdentityId: number | null;
}

export interface Submission {
    id: string;
    gameId: string;
    discordUserId: string;
    iscoredUsername?: string;
    score: number;
    photoUrl?: string;
    timestamp: Date;
    context?: SubmissionContext;
}

export type AnonymousIdentityStatus = 'active' | 'merged' | 'orphaned';

export interface AnonymousIdentity {
    id: number;
    serverNickname: string;
    guildId: string | null;
    roomId: string | null;
    firstSeenAt: string;
    status: AnonymousIdentityStatus;
}

export interface MergeRecord {
    id: number;
    anonymousIdentityId: number;
    targetDiscordUserId: string;
    adminDiscordUserId: string;
    createdAt: string;
    reversedAt: string | null;
    reversalAdminId: string | null;
    scoreIdsSnapshot: string;
    reason: string | null;
}

export interface UserMapping {
    discordUserId: string;
    iscoredUsername: string;
}

export interface Score {
    id: string;
    gameId: string;
    discordUserId: string;
    iscoredUsername?: string;
    score: number;
    verified: boolean;
    syncedAt?: Date;
    timestamp: Date;
}

export interface LeaderboardEntry {
    rank: number;
    discordUserId: string;
    iscoredUsername: string;
    score: number;
}

export interface PlayerStats {
    discordUserId: string;
    totalGamesPlayed: number;
    totalWins: number;
    winPercentage: number;
    averageScore: number;
    bestScore: number;
    bestGame: string;
    recentScores: Array<{ gameName: string; score: number; date: string }>;
}

export interface GameStats {
    gameName: string;
    timesPlayed: number;
    avgScore: number;
    uniquePlayers: number;
    allTimeHigh: number;
    allTimeHighPlayer: string | null;
    recentResults: Array<{ tournamentName: string; winnerName: string; winnerScore: number; endDate: string }>;
}

export type RankMethod = 'max_10' | 'average_rank' | 'best_game_papa' | 'best_game_linear';

export interface RankingGroup {
    id: string;
    name: string;
    description: string;
    rank_method: RankMethod;
    best_n: number;
    min_games: number;
    is_active: boolean;
    created_at: string;
    tournament_ids: string[];
}

export interface OverallRanking {
    rank: number;
    iscored_username: string;
    discord_user_id: string;
    total_points: number;
    games_played: number;
    breakdown: Array<{ game_name: string; game_rank: number; points: number }>;
}

export interface GameRoom {
    id: string;
    name: string;
    slug: string;
    description: string;
    is_public: boolean;
    logo_url: string | null;
    discord_guild_id: string | null;
    /** Sprint 13 — optional short label for RoomTag badges. Falls back to slug-derived when null. */
    short_tag: string | null;
    created_at: string;
    /** S22 Phase 2 (v2.44.0) — super-admin room suspension (migration 119).
     * `suspended_at IS NOT NULL` is the suspended predicate. */
    suspended_at?: string | null;
    suspended_by?: string | null;
    suspended_reason?: string | null;
}

export interface LocalAdmin {
    id: string;
    game_room_id: string;
    username: string;
    display_name: string | null;
    created_at: string;
}

export interface GameRoomAdmin {
    game_room_id: string;
    discord_user_id: string;
    role: 'admin' | 'owner';
}

export interface SuperAdmin {
    discord_user_id: string;
    username: string | null;
    granted_at: string;
}

export interface WebSocketEvents {
    'score:new': { gameId: string; gameName: string; playerName: string; score: number };
    'game:rotated': { tournamentName: string; oldGame: string; newGame: string };
    'picker:assigned': { tournamentName: string; pickerName: string; deadline: string };
    'bot:status': { online: boolean };
    'leaderboard:updated': { gameId: string };
}
