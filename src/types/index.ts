export type TournamentMode = 'pinball' | 'videogame';

export interface CadenceConfig {
    cron: string;             // '0 0 * * *' for daily
    autoRotate: boolean;      // Whether to automatically trigger maintenance
    autoLock: boolean;        // Whether to lock the previous game automatically
    timezone?: string;        // Per-tournament timezone (falls back to BOT_TIMEZONE)
    announcementChannel?: string;
}

export interface PlatformRules {
    required: string[];       // Game must be available on at least one of these
    excluded: string[];       // Game cannot be played on these platforms
    restrictedText?: string;  // Informational text shown in announcements
}

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
}

export type GameStatus = 'QUEUED' | 'ACTIVE' | 'COMPLETED' | 'HIDDEN';

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
}

export interface Submission {
    id: string;
    gameId: string;
    discordUserId: string;
    iscoredUsername?: string;
    score: number;
    photoUrl?: string;
    timestamp: Date;
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

export interface WebSocketEvents {
    'score:new': { gameId: string; gameName: string; playerName: string; score: number };
    'game:rotated': { tournamentName: string; oldGame: string; newGame: string };
    'picker:assigned': { tournamentName: string; pickerName: string; deadline: string };
    'bot:status': { online: boolean };
    'leaderboard:updated': { gameId: string };
}
