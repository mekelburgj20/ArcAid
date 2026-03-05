export type TournamentType = 'daily' | 'weekly' | 'monthly' | 'custom';

export interface Tournament {
    id: string;
    name: string;
    type: TournamentType;
    discordChannelId?: string;
    discordRoleId?: string;
    isActive: boolean;
}

export interface Game {
    id: string;
    tournamentId: string;
    name: string;
    iscoredId?: string;
    styleId?: string;
    startDate?: Date;
    endDate?: Date;
    isActive: boolean;
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
