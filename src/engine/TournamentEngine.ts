import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../database/database.js';
import { Tournament, Game, TournamentType, CadenceConfig } from '../types/index.js';
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
    public async createTournament(name: string, type: TournamentType, cadence: CadenceConfig, guildId: string, channelId?: string, roleId?: string): Promise<Tournament> {
        const db = await getDatabase();
        const tournament: Tournament = {
            id: uuidv4(),
            name,
            type,
            cadence,
            guildId,
            discordChannelId: channelId,
            discordRoleId: roleId,
            isActive: true
        };

        logInfo(`Creating new ${getTerminology().tournament}: ${name} (${type})`);

        await db.run(
            'INSERT INTO tournaments (id, name, type, cadence, guild_id, discord_channel_id, discord_role_id, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            tournament.id, tournament.name, tournament.type, JSON.stringify(tournament.cadence), tournament.guildId, tournament.discordChannelId, tournament.discordRoleId, tournament.isActive ? 1 : 0
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
            status: 'ACTIVE',
            startDate: new Date()
        };

        logInfo(`Activating new ${getTerminology().game} for tournament ${tournamentId}: ${gameName}`);

        // 1. Deactivate current active game for this tournament
        await db.run(
            'UPDATE games SET status = ?, end_date = ? WHERE tournament_id = ? AND status = ?',
            'COMPLETED', new Date().toISOString(), tournamentId, 'ACTIVE'
        );

        // 2. Insert the new game
        await db.run(
            'INSERT INTO games (id, tournament_id, name, style_id, status, start_date) VALUES (?, ?, ?, ?, ?, ?)',
            game.id, game.tournamentId, game.name, game.styleId, game.status, game.startDate?.toISOString()
        );

        return game;
    }

    /**
     * Retrieves the currently active game for a tournament.
     */
    public async getActiveGame(tournamentId: string): Promise<Game | null> {
        const db = await getDatabase();
        const row = await db.get('SELECT * FROM games WHERE tournament_id = ? AND status = ?', tournamentId, 'ACTIVE');

        if (!row) return null;

        return {
            id: row.id,
            tournamentId: row.tournament_id,
            name: row.name,
            iscoredId: row.iscored_id,
            styleId: row.style_id,
            status: row.status as any,
            startDate: row.start_date ? new Date(row.start_date) : undefined,
            endDate: row.end_date ? new Date(row.end_date) : undefined
        };
    }

    /**
     * Checks if a game is eligible to be played based on a lookback period.
     * Default lookback is 120 days.
     */
    public async isGameEligible(tournamentId: string, gameName: string, lookbackDays: number = 120): Promise<boolean> {
        const db = await getDatabase();
        
        const lookbackDate = new Date();
        lookbackDate.setDate(lookbackDate.getDate() - lookbackDays);
        const lookbackString = lookbackDate.toISOString();

        const row = await db.get<{ count: number }>(
            `SELECT COUNT(*) as count FROM games 
             WHERE tournament_id = ? 
             AND (name = ? OR name LIKE ? || ' %') 
             AND start_date >= ?`,
            tournamentId, gameName, gameName, lookbackString
        );

        const count = row?.count ?? 0;
        
        if (count > 0) {
            logInfo(`🚫 ${getTerminology().game} '${gameName}' is NOT eligible (played within last ${lookbackDays} days).`);
            return false;
        }

        logInfo(`✅ ${getTerminology().game} '${gameName}' is eligible.`);
        return true;
    }

    /**
     * Executes the maintenance routine for a specific tournament.
     * This handles locking the old game, determining winners, and promoting the next game.
     */
    public async runMaintenance(tournamentId: string): Promise<void> {
        const db = await getDatabase();
        const tournament = await db.get('SELECT * FROM tournaments WHERE id = ?', tournamentId);
        if (!tournament) throw new Error(`Tournament ${tournamentId} not found.`);

        const term = getTerminology();
        logInfo(`⚙️ Starting maintenance for ${term.tournament}: ${tournament.name}`);

        // 1. Get currently active game
        const activeGame = await this.getActiveGame(tournamentId);
        
        if (activeGame) {
            logInfo(`   -> Handling completion of ${term.game}: ${activeGame.name}`);
            // Future: Integration with IScoredClient to lock and scrape scores
        }

        // 2. Promote the next game (if any are queued/scheduled)
        // Future: Logic to pick the next game from a pool or picker
        
        logInfo(`✅ Maintenance complete for ${tournament.name}`);
    }
}
