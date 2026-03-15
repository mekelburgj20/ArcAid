import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

let db: Database | null = null;

/**
 * Initializes the SQLite database and creates the necessary tables.
 */
export async function initDatabase(): Promise<Database> {
    if (db) return db;

    const dbPath = process.env.DB_PATH || './data/arcaid.db';
    const dbDir = path.dirname(dbPath);

    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    db = await open({
        filename: dbPath,
        driver: sqlite3.Database
    });

    // --- Schema Definition ---

    // 1. Tournaments (The overall competition, e.g., "Daily Grind")
    await db.exec(`
        CREATE TABLE IF NOT EXISTS tournaments (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL, -- 'daily', 'weekly', 'monthly', 'custom'
            cadence TEXT,       -- JSON string of CadenceConfig
            guild_id TEXT,      -- Discord Server ID
            discord_channel_id TEXT,
            discord_role_id TEXT,
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);

    // 1.5 Game Library (Master list of all available games to pick from)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS game_library (
            name TEXT PRIMARY KEY,
            aliases TEXT,
            style_id TEXT,
            css_title TEXT,
            css_initials TEXT,
            css_scores TEXT,
            css_box TEXT,
            bg_color TEXT,
            tournament_types TEXT -- JSON array or comma separated list of tournament types this game is eligible for
        )
    `);

    // 2. Games (The individual games within a tournament, e.g., "Medieval Madness")
    await db.exec(`
        CREATE TABLE IF NOT EXISTS games (
            id TEXT PRIMARY KEY,
            tournament_id TEXT, -- Nullable to support untracked/manual games
            name TEXT NOT NULL,
            iscored_id TEXT, -- Link to iScored game ID
            style_id TEXT,   -- iScored style ID
            status TEXT NOT NULL DEFAULT 'ACTIVE', -- 'QUEUED', 'ACTIVE', 'COMPLETED', 'HIDDEN'
            picker_discord_id TEXT,
            picker_type TEXT,
            picker_designated_at TEXT,
            reminder_count INTEGER DEFAULT 0,
            won_game_id TEXT,
            start_date TEXT,
            end_date TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (tournament_id) REFERENCES tournaments (id)
        )
    `);

    // 3. Submissions (The scores/results posted by users)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS submissions (
            id TEXT PRIMARY KEY,
            game_id TEXT NOT NULL,
            discord_user_id TEXT NOT NULL,
            iscored_username TEXT,
            score INTEGER NOT NULL,
            photo_url TEXT,
            timestamp TEXT NOT NULL,
            FOREIGN KEY (game_id) REFERENCES games (id)
        )
    `);

    // 4. User Mappings (Discord ID -> iScored Username)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS user_mappings (
            discord_user_id TEXT PRIMARY KEY,
            iscored_username TEXT NOT NULL
        )
    `);

    // 5. Global Settings (Key-Value pair configuration)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    `);

    // 6. Scores table (supplements submissions with verified flag)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS scores (
            id TEXT PRIMARY KEY,
            game_id TEXT NOT NULL,
            discord_user_id TEXT NOT NULL,
            iscored_username TEXT,
            score INTEGER NOT NULL,
            verified INTEGER DEFAULT 0,
            synced_at TEXT,
            timestamp TEXT NOT NULL,
            FOREIGN KEY (game_id) REFERENCES games (id)
        )
    `);

    // 7. Leaderboard cache (pre-computed rankings)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS leaderboard_cache (
            game_id TEXT PRIMARY KEY,
            rankings TEXT NOT NULL,
            generated_at TEXT NOT NULL,
            FOREIGN KEY (game_id) REFERENCES games (id)
        );

        CREATE TABLE IF NOT EXISTS user_preferences (
            discord_user_id TEXT PRIMARY KEY,
            ui_theme TEXT
        );

        CREATE TABLE IF NOT EXISTS game_ratings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_name TEXT NOT NULL,
            user_id TEXT NOT NULL,
            rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            UNIQUE(game_name, user_id)
        );

        CREATE TABLE IF NOT EXISTS ranking_groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            rank_method TEXT NOT NULL DEFAULT 'best_game_papa',
            best_n INTEGER NOT NULL DEFAULT 25,
            min_games INTEGER NOT NULL DEFAULT 1,
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS ranking_group_tournaments (
            ranking_group_id TEXT NOT NULL,
            tournament_id TEXT NOT NULL,
            PRIMARY KEY (ranking_group_id, tournament_id),
            FOREIGN KEY (ranking_group_id) REFERENCES ranking_groups (id) ON DELETE CASCADE,
            FOREIGN KEY (tournament_id) REFERENCES tournaments (id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS ranking_groups_cache (
            ranking_group_id TEXT PRIMARY KEY,
            rankings TEXT NOT NULL,
            generated_at TEXT NOT NULL,
            FOREIGN KEY (ranking_group_id) REFERENCES ranking_groups (id) ON DELETE CASCADE
        )
    `);

    // 8. Multi-room tables
    await db.exec(`
        CREATE TABLE IF NOT EXISTS game_rooms (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE,
            description TEXT DEFAULT '',
            is_public INTEGER DEFAULT 1,
            logo_url TEXT,
            discord_guild_id TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS game_room_settings (
            game_room_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (game_room_id, key),
            FOREIGN KEY (game_room_id) REFERENCES game_rooms (id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS local_admins (
            id TEXT PRIMARY KEY,
            game_room_id TEXT NOT NULL,
            username TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            display_name TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(game_room_id, username),
            FOREIGN KEY (game_room_id) REFERENCES game_rooms (id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS game_room_admins (
            game_room_id TEXT NOT NULL,
            discord_user_id TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'admin',
            PRIMARY KEY (game_room_id, discord_user_id),
            FOREIGN KEY (game_room_id) REFERENCES game_rooms (id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS super_admins (
            discord_user_id TEXT PRIMARY KEY,
            username TEXT,
            granted_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS game_room_game_library (
            game_room_id TEXT NOT NULL,
            game_name TEXT NOT NULL,
            PRIMARY KEY (game_room_id, game_name),
            FOREIGN KEY (game_room_id) REFERENCES game_rooms (id) ON DELETE CASCADE,
            FOREIGN KEY (game_name) REFERENCES game_library (name)
        )
    `);

    // --- Indexes for performance ---
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_games_tournament_id ON games(tournament_id);
        CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
        CREATE INDEX IF NOT EXISTS idx_submissions_game_id ON submissions(game_id);
        CREATE INDEX IF NOT EXISTS idx_submissions_discord_user_id ON submissions(discord_user_id);
        CREATE INDEX IF NOT EXISTS idx_submissions_timestamp ON submissions(timestamp);
        CREATE INDEX IF NOT EXISTS idx_scores_game_id ON scores(game_id);
        CREATE INDEX IF NOT EXISTS idx_scores_discord_user_id ON scores(discord_user_id);
        CREATE INDEX IF NOT EXISTS idx_scores_timestamp ON scores(timestamp);
    `);

    // --- Migrations for existing databases ---
    const migrations = [
        `ALTER TABLE tournaments ADD COLUMN created_at TEXT DEFAULT (datetime('now'))`,
        `ALTER TABLE games ADD COLUMN created_at TEXT DEFAULT (datetime('now'))`,
        `ALTER TABLE tournaments ADD COLUMN mode TEXT DEFAULT 'pinball'`,
        `ALTER TABLE tournaments ADD COLUMN platform_rules TEXT DEFAULT '{}'`,
        `ALTER TABLE game_library ADD COLUMN mode TEXT DEFAULT 'pinball'`,
        `ALTER TABLE game_library ADD COLUMN platforms TEXT DEFAULT '[]'`,
        `ALTER TABLE tournaments ADD COLUMN display_order INTEGER DEFAULT 0`,
        `ALTER TABLE tournaments ADD COLUMN cleanup_rule TEXT DEFAULT '{"mode":"retain","count":0}'`,
        `ALTER TABLE game_library ADD COLUMN image_url TEXT`,
        `ALTER TABLE tournaments ADD COLUMN max_active_games INTEGER DEFAULT 1`,
        `ALTER TABLE tournaments ADD COLUMN game_room_id TEXT`,
        `ALTER TABLE ranking_groups ADD COLUMN game_room_id TEXT`,
    ];
    for (const migration of migrations) {
        try {
            await db.exec(migration);
        } catch {
            // Column already exists — safe to ignore
        }
    }

    // --- Multi-room data migration (idempotent) ---
    await migrateToMultiRoom(db);

    // --- Migrate tournament_types → platforms (rename + normalize) ---
    try {
        const rows = await db.all("SELECT name, tournament_types, platforms FROM game_library");
        for (const row of rows) {
            // If platforms already has data, skip
            if (row.platforms && row.platforms !== '[]') continue;
            // Migrate from tournament_types if it has data
            const val = (row.tournament_types || '').trim();
            if (!val) continue;
            let platforms: string[];
            if (val.startsWith('[')) {
                platforms = JSON.parse(val);
            } else {
                platforms = val.split(',').map((t: string) => t.trim()).filter(Boolean);
            }
            await db.run(
                'UPDATE game_library SET platforms = ? WHERE name = ?',
                JSON.stringify(platforms), row.name
            );
        }
    } catch {
        // game_library may not have data yet — safe to ignore
    }

    // --- Seed default configurable settings (INSERT OR IGNORE preserves user values) ---
    const defaultSettings = [
        ['GAME_ELIGIBILITY_DAYS', '120'],
        ['WINNER_PICK_WINDOW_MIN', '60'],
        ['RUNNERUP_PICK_WINDOW_MIN', '30'],
        ['BOT_TIMEZONE', 'America/Chicago'],
        ['PORT', '3001'],
        ['MAX_LOG_LINES', '500'],
        ['BACKUP_RETENTION_DAYS', '30'],
        ['PLATFORMS', JSON.stringify(['AtGames', 'VPXS', 'VR', 'IRL'])],
    ];
    for (const [key, value] of defaultSettings) {
        await db.run(
            'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)',
            key, value
        );
    }

    return db;
}

/** Per-room setting keys that should be migrated from global settings */
const PER_ROOM_SETTING_KEYS = [
    'ISCORED_USERNAME', 'ISCORED_PASSWORD', 'ISCORED_PUBLIC_URL',
    'DISCORD_ANNOUNCEMENT_CHANNEL_ID', 'DISCORD_ADMIN_ROLE_ID', 'DISCORD_GUILD_ID',
    'BOT_TIMEZONE', 'WINNER_PICK_WINDOW_MIN', 'RUNNERUP_PICK_WINDOW_MIN',
    'GAME_ELIGIBILITY_DAYS', 'PLATFORMS', 'UI_THEME', 'GAME_ROOM_NAME',
];

/**
 * Idempotent migration: creates default game room from existing settings,
 * copies per-room keys to game_room_settings, backfills game_room_id on
 * tournaments and ranking_groups, populates game_room_game_library.
 */
async function migrateToMultiRoom(db: Database): Promise<void> {
    // Check if migration already ran (default room exists)
    const existingRoom = await db.get('SELECT id FROM game_rooms LIMIT 1');
    if (existingRoom) return;

    // Read existing slug/name from settings
    const slugRow = await db.get("SELECT value FROM settings WHERE key = 'GAME_ROOM_SLUG'");
    const nameRow = await db.get("SELECT value FROM settings WHERE key = 'GAME_ROOM_NAME'");

    // Only migrate if there's existing data to migrate
    const hasTournaments = await db.get('SELECT id FROM tournaments LIMIT 1');
    if (!slugRow && !hasTournaments) return; // Fresh install, no migration needed

    const roomId = crypto.randomUUID();
    const slug = slugRow?.value || 'default';
    const name = nameRow?.value || slug;

    await db.exec('BEGIN TRANSACTION');
    try {
        // 1. Create default game room
        const guildIdRow = await db.get("SELECT value FROM settings WHERE key = 'DISCORD_GUILD_ID'");
        await db.run(
            `INSERT INTO game_rooms (id, name, slug, description, is_public, discord_guild_id)
             VALUES (?, ?, ?, '', 1, ?)`,
            roomId, name, slug.toLowerCase(), guildIdRow?.value || null
        );

        // 2. Copy per-room setting keys to game_room_settings
        for (const key of PER_ROOM_SETTING_KEYS) {
            const row = await db.get('SELECT value FROM settings WHERE key = ?', key);
            if (row) {
                await db.run(
                    'INSERT OR IGNORE INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)',
                    roomId, key, row.value
                );
            }
        }

        // 3. Backfill game_room_id on tournaments
        await db.run('UPDATE tournaments SET game_room_id = ? WHERE game_room_id IS NULL', roomId);

        // 4. Backfill game_room_id on ranking_groups
        await db.run('UPDATE ranking_groups SET game_room_id = ? WHERE game_room_id IS NULL', roomId);

        // 5. Populate game_room_game_library with all existing game_library entries
        await db.run(
            `INSERT OR IGNORE INTO game_room_game_library (game_room_id, game_name)
             SELECT ?, name FROM game_library`,
            roomId
        );

        await db.exec('COMMIT');
    } catch (err) {
        await db.exec('ROLLBACK');
        throw err;
    }
}

/**
 * Helper to get the database instance.
 */
export async function getDatabase(): Promise<Database> {
    if (!db) {
        return await initDatabase();
    }
    return db;
}
