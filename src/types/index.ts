export type TournamentType = 'daily' | 'weekly' | 'monthly' | 'custom';

export interface CadenceConfig {
    cron: string;             // '0 0 * * *' for daily
    autoRotate: boolean;      // Whether to automatically trigger maintenance
    autoLock: boolean;        // Whether to lock the previous game automatically
    announcementChannel?: string;
}

export interface Tournament {
    id: string;
    name: string;
    type: TournamentType;
    cadence: CadenceConfig;
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
    averageScore: number;
    allTimeHigh: number;
    allTimeHighHolder: string;
    recentResults: Array<{ tournamentName: string; winnerName: string; winnerScore: number; endDate: string }>;
}

export interface WebSocketEvents {
    'score:new': { gameId: string; gameName: string; playerName: string; score: number };
    'game:rotated': { tournamentName: string; oldGame: string; newGame: string };
    'picker:assigned': { tournamentName: string; pickerName: string; deadline: string };
    'bot:status': { online: boolean };
    'leaderboard:updated': { gameId: string };
}
