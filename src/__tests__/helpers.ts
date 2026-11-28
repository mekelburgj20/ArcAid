import { initDatabase, getDatabase } from '../database/database.js';
import crypto from 'crypto';

/**
 * Initialize a fresh in-memory database with schema.
 * Call at the start of each test that needs DB access.
 */
export async function setupTestDb() {
    return await initDatabase();
}

/**
 * Create a test game room and return its ID.
 */
export async function createTestRoom(slug = 'test-room', name = 'Test Room') {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO game_rooms (id, name, slug, description, is_public) VALUES (?, ?, ?, '', 1)`,
        id, name, slug
    );
    return id;
}

/**
 * Create a test tournament and return its ID.
 */
export async function createTestTournament(gameRoomId: string, opts: {
    name?: string;
    type?: string;
    mode?: string;
} = {}) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id)
         VALUES (?, ?, ?, ?, '{}', 1, ?)`,
        id, opts.name || 'Test Tournament', opts.type || 'DG', opts.mode || 'pinball', gameRoomId
    );
    return id;
}

/**
 * Create a test game in a tournament.
 */
export async function createTestGame(tournamentId: string, opts: {
    name?: string;
    status?: string;
    startDate?: string;
    endDate?: string;
} = {}) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, start_date, end_date)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id, tournamentId, opts.name || 'Test Game', opts.status || 'ACTIVE',
        opts.startDate || new Date().toISOString(), opts.endDate || null
    );
    return id;
}

/**
 * Insert a test submission (score).
 *
 * v2.1.0: writes to BOTH `submissions` (back-compat) and `score_history`
 * (new source of truth for tournament leaderboards). score_history row
 * carries submitted_during_tournament_id so LeaderboardService.recalculate
 * picks it up.
 */
export async function createTestSubmission(gameId: string, opts: {
    username?: string;
    discordUserId?: string;
    score?: number;
} = {}) {
    const db = await getDatabase();
    const username = opts.username || 'TestPlayer';
    const discordUserId = opts.discordUserId || 'SYSTEM';
    const score = opts.score || 1000;
    const id = `${gameId}-${username.toLowerCase()}`;

    await db.run(
        `INSERT OR REPLACE INTO submissions (id, game_id, discord_user_id, iscored_username, score, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id, gameId, discordUserId, username, score,
        new Date().toISOString()
    );

    // Look up the tournament + room + game name so score_history has the same
    // context that production writes carry.
    const game = await db.get<{ name: string; tournament_id: string | null }>(
        'SELECT name, tournament_id FROM games WHERE id = ?',
        gameId,
    );
    if (game) {
        const tournament = game.tournament_id
            ? await db.get<{ game_room_id: string | null }>(
                'SELECT game_room_id FROM tournaments WHERE id = ?',
                game.tournament_id,
            )
            : null;
        await db.run(
            `INSERT INTO score_history (
                game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source,
                submitted_from_room_id, submitted_during_tournament_id
             ) VALUES (?, ?, ?, ?, ?, ?, 'tournament', ?, ?)`,
            game.name, tournament?.game_room_id ?? null, gameId,
            username, discordUserId, score,
            tournament?.game_room_id ?? null,
            game.tournament_id,
        );
    }

    return id;
}

/**
 * Approved catalogue rows for these names (skips any that exist). Event saves
 * through the admin routes refuse a round whose game is not in the catalogue
 * (v2.233.0, A34), so a route-level event test seeds the names it uses.
 */
export async function seedCatalogueGames(...names: string[]) {
    const db = await getDatabase();
    for (const name of names) {
        const exists = await db.get('SELECT 1 FROM global_games WHERE LOWER(name) = LOWER(?)', name);
        if (exists) continue;
        await db.run(
            `INSERT INTO global_games (id, name, type, status) VALUES (?, ?, 'pinball', 'approved')`,
            crypto.randomUUID(), name,
        );
    }
}

/**
 * W131.1 (ADR 0045) - the owner row a paired device carries. A test that
 * INSERTs `witness_devices` by hand (instead of pairing) adds it here, with
 * the routing that used to sit on the device row: routing is each player's,
 * on `witness_device_players`.
 */
export async function seedDeviceOwner(
    deviceId: string, userId: string,
    routing: { roomId?: string | null; tournamentId?: string | null; globalOnly?: boolean; globalFallback?: boolean } = {},
) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO witness_device_players
            (device_id, canonical_user_id, role, slot, target_room_id, target_tournament_id, global_only, global_fallback)
         VALUES (?, ?, 'owner', ?, ?, ?, ?, ?)`,
        deviceId, userId, crypto.randomBytes(4).toString('hex'),
        routing.roomId ?? null, routing.tournamentId ?? null,
        routing.globalOnly ? 1 : 0, routing.globalFallback === false ? 0 : 1,
    );
}

/** Set a device's routing as a test fixture: the routing of the account the device is paired to. */
export async function setDeviceRouting(
    deviceId: string,
    routing: { roomId?: string | null; tournamentId?: string | null; globalOnly?: boolean },
) {
    const db = await getDatabase();
    const sets: string[] = [];
    const args: unknown[] = [];
    if ('roomId' in routing) { sets.push('target_room_id = ?'); args.push(routing.roomId ?? null); }
    if ('tournamentId' in routing) { sets.push('target_tournament_id = ?'); args.push(routing.tournamentId ?? null); }
    if ('globalOnly' in routing) { sets.push('global_only = ?'); args.push(routing.globalOnly ? 1 : 0); }
    await db.run(
        `UPDATE witness_device_players SET ${sets.join(', ')}
          WHERE device_id = ? AND removed_at IS NULL
            AND canonical_user_id = (SELECT canonical_user_id FROM witness_devices WHERE atgames_unique_id = ?)`,
        ...args, deviceId, deviceId,
    );
}
