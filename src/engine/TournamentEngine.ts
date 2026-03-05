import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../database/database.js';
import { Tournament, Game, TournamentType } from '../types/index.js';
import { logInfo, logError } from '../utils/logger.js';
import { getTerminology } from '../utils/terminology.ts';

export class TournamentEngine {
    private static instance: TournamentEngine;

    private constructor() {}

    public static getInstance(): TournamentEngine {
        if (!TournamentEngine.instance) {
            TournamentEngine.instance = new TournamentEngine();
        }
        return TournamentEngine.instance;
    }

    /**
     * Creates a new tournament in the database.
     */
    public async createTournament(name: string, type: TournamentType, channelId?: string, roleId?: string): Promise<Tournament> {
        const db = await getDatabase();
        const tournament: Tournament = {
            id: uuidv4(),
            name,
            type,
            discordChannelId: channelId,
            discordRoleId: roleId,
            isActive: true
        };

        logInfo(`Creating new ${getTerminology().tournament}: ${name} (${type})`);

        await db.run(
            'INSERT INTO tournaments (id, name, type, discord_channel_id, discord_role_id, is_active) VALUES (?, ?, ?, ?, ?, ?)',
            tournament.id, tournament.name, tournament.type, tournament.discordChannelId, tournament.discordRoleId, tournament.isActive ? 1 : 0
        );

        return tournament;
    }

    /**
     * Activates a new game for a specific tournament.
     */
    public async activateGame(tournamentId: string, gameName: string, styleId?: string): Promise<Game> {
        const db = await getDatabase();
        const game: Game = {
            id: uuidv4(),
            tournamentId,
            name: gameName,
            styleId,
            startDate: new Date(),
            isActive: true
        };

        logInfo(`Activating new ${getTerminology().game} for tournament ${tournamentId}: ${gameName}`);

        // 1. Deactivate current active game for this tournament
        await db.run(
            'UPDATE games SET is_active = 0, end_date = ? WHERE tournament_id = ? AND is_active = 1',
            new Date().toISOString(), tournamentId
        );

        // 2. Insert the new game
        await db.run(
            'INSERT INTO games (id, tournament_id, name, style_id, start_date, is_active) VALUES (?, ?, ?, ?, ?, ?)',
            game.id, game.tournamentId, game.name, game.styleId, game.startDate.toISOString(), game.isActive ? 1 : 0
        );

        return game;
    }

    /**
     * Retrieves the currently active game for a tournament.
     */
    public async getActiveGame(tournamentId: string): Promise<Game | null> {
        const db = await getDatabase();
        const row = await db.get('SELECT * FROM games WHERE tournament_id = ? AND is_active = 1', tournamentId);

        if (!row) return null;

        return {
            id: row.id,
            tournamentId: row.tournament_id,
            name: row.name,
            iscoredId: row.iscored_id,
            styleId: row.style_id,
            startDate: row.start_date ? new Date(row.start_date) : undefined,
            endDate: row.end_date ? new Date(row.end_date) : undefined,
            isActive: row.is_active === 1
        };
    }
}
