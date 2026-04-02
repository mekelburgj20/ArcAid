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
            created_at TEXT DEFAULT (datetime('now')),
            mode TEXT DEFAULT 'pinball',
            platform_rules TEXT DEFAULT '{}',
            display_order INTEGER DEFAULT 0,
            cleanup_rule TEXT DEFAULT '{"mode":"retain","count":0}',
            max_active_games INTEGER DEFAULT 1,
            game_room_id TEXT
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
            tournament_types TEXT, -- JSON array or comma separated list of tournament types this game is eligible for
            mode TEXT DEFAULT 'pinball',
            platforms TEXT DEFAULT '[]',
            image_url TEXT
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
            iscored_username TEXT NOT NULL,
            avatar_hash TEXT
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

        CREATE TABLE IF NOT EXISTS community_scores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_name TEXT NOT NULL,
            game_room_id TEXT NOT NULL,
            iscored_username TEXT NOT NULL,
            discord_user_id TEXT DEFAULT 'ANON',
            score INTEGER NOT NULL,
            photo_url TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (game_room_id) REFERENCES game_rooms (id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS score_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_name TEXT NOT NULL,
            game_room_id TEXT NOT NULL,
            game_id TEXT,
            iscored_username TEXT NOT NULL,
            discord_user_id TEXT DEFAULT 'SYSTEM',
            score INTEGER NOT NULL,
            photo_url TEXT,
            source TEXT NOT NULL DEFAULT 'tournament' CHECK(source IN ('tournament', 'community', 'sync')),
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (game_room_id) REFERENCES game_rooms (id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS game_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_name TEXT NOT NULL,
            game_room_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            display_name TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'comment' CHECK(type IN ('comment', 'tip')),
            body TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (game_room_id) REFERENCES game_rooms (id) ON DELETE CASCADE
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
            created_at TEXT DEFAULT (datetime('now')),
            game_room_id TEXT
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

    // 8. Audit log (admin action tracking)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor TEXT NOT NULL,
            action TEXT NOT NULL,
            target_type TEXT NOT NULL,
            target_id TEXT NOT NULL DEFAULT '',
            details TEXT DEFAULT '{}',
            ip_address TEXT DEFAULT '',
            correlation_id TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor);
        CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
        CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log(target_type, target_id)
    `);

    // 9. Schema migrations tracking
    await db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            applied_at TEXT DEFAULT (datetime('now'))
        )
    `);

    // 10. Multi-room tables
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

        CREATE TABLE IF NOT EXISTS admin_invites (
            id TEXT PRIMARY KEY,
            token TEXT NOT NULL UNIQUE,
            game_room_id TEXT NOT NULL,
            display_name TEXT NOT NULL,
            discord_user_id TEXT,
            created_by TEXT,
            expires_at TEXT NOT NULL,
            accepted_at TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (game_room_id) REFERENCES game_rooms (id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS game_room_game_library (
            game_room_id TEXT NOT NULL,
            game_name TEXT NOT NULL,
            PRIMARY KEY (game_room_id, game_name),
            FOREIGN KEY (game_room_id) REFERENCES game_rooms (id) ON DELETE CASCADE,
            FOREIGN KEY (game_name) REFERENCES game_library (name)
        )
    `);

    // 11. Room events (activity log)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS room_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_room_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            event_data TEXT DEFAULT '{}',
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (game_room_id) REFERENCES game_rooms (id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_room_events_room_type ON room_events(game_room_id, event_type);
        CREATE INDEX IF NOT EXISTS idx_room_events_created ON room_events(created_at)
    `);

    // --- Indexes for performance ---
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_games_tournament_id ON games(tournament_id);
        CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
        CREATE INDEX IF NOT EXISTS idx_games_iscored_id ON games(iscored_id);
        CREATE INDEX IF NOT EXISTS idx_submissions_game_id ON submissions(game_id);
        CREATE INDEX IF NOT EXISTS idx_submissions_discord_user_id ON submissions(discord_user_id);
        CREATE INDEX IF NOT EXISTS idx_submissions_timestamp ON submissions(timestamp);
        CREATE INDEX IF NOT EXISTS idx_scores_game_id ON scores(game_id);
        CREATE INDEX IF NOT EXISTS idx_scores_discord_user_id ON scores(discord_user_id);
        CREATE INDEX IF NOT EXISTS idx_scores_timestamp ON scores(timestamp);
        CREATE INDEX IF NOT EXISTS idx_tournaments_game_room_id ON tournaments(game_room_id);
        CREATE INDEX IF NOT EXISTS idx_user_mappings_iscored_username ON user_mappings(iscored_username);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_user_mappings_iscored_unique ON user_mappings(iscored_username);
        CREATE INDEX IF NOT EXISTS idx_ranking_groups_game_room_id ON ranking_groups(game_room_id);
    `);

    // --- Versioned Migrations ---
    // Each migration runs at most once, tracked in schema_migrations table.
    const migrations: Array<{ name: string; sql: string }> = [
        { name: '001_tournaments_created_at', sql: `ALTER TABLE tournaments ADD COLUMN created_at TEXT DEFAULT (datetime('now'))` },
        { name: '002_games_created_at', sql: `ALTER TABLE games ADD COLUMN created_at TEXT DEFAULT (datetime('now'))` },
        { name: '003_tournaments_mode', sql: `ALTER TABLE tournaments ADD COLUMN mode TEXT DEFAULT 'pinball'` },
        { name: '004_tournaments_platform_rules', sql: `ALTER TABLE tournaments ADD COLUMN platform_rules TEXT DEFAULT '{}'` },
        { name: '005_game_library_mode', sql: `ALTER TABLE game_library ADD COLUMN mode TEXT DEFAULT 'pinball'` },
        { name: '006_game_library_platforms', sql: `ALTER TABLE game_library ADD COLUMN platforms TEXT DEFAULT '[]'` },
        { name: '007_tournaments_display_order', sql: `ALTER TABLE tournaments ADD COLUMN display_order INTEGER DEFAULT 0` },
        { name: '008_tournaments_cleanup_rule', sql: `ALTER TABLE tournaments ADD COLUMN cleanup_rule TEXT DEFAULT '{"mode":"retain","count":0}'` },
        { name: '009_game_library_image_url', sql: `ALTER TABLE game_library ADD COLUMN image_url TEXT` },
        { name: '010_tournaments_max_active_games', sql: `ALTER TABLE tournaments ADD COLUMN max_active_games INTEGER DEFAULT 1` },
        { name: '011_tournaments_game_room_id', sql: `ALTER TABLE tournaments ADD COLUMN game_room_id TEXT` },
        { name: '012_ranking_groups_game_room_id', sql: `ALTER TABLE ranking_groups ADD COLUMN game_room_id TEXT` },
        { name: '013_admin_invites', sql: `CREATE TABLE IF NOT EXISTS admin_invites (
            id TEXT PRIMARY KEY,
            token TEXT NOT NULL UNIQUE,
            game_room_id TEXT NOT NULL,
            display_name TEXT NOT NULL,
            discord_user_id TEXT,
            created_by TEXT,
            expires_at TEXT NOT NULL,
            accepted_at TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (game_room_id) REFERENCES game_rooms (id) ON DELETE CASCADE
        )` },
        { name: '014_style_catalogue', sql: `CREATE TABLE IF NOT EXISTS style_catalogue (
            id TEXT PRIMARY KEY,
            iscored_style_id INTEGER,
            name TEXT NOT NULL,
            author TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            has_background INTEGER DEFAULT 0,
            has_header INTEGER DEFAULT 0,
            source TEXT DEFAULT 'iscored',
            created_at TEXT DEFAULT (datetime('now'))
        )` },
        { name: '015_style_catalogue_indexes', sql: `
            CREATE INDEX IF NOT EXISTS idx_style_catalogue_name ON style_catalogue(name);
            CREATE INDEX IF NOT EXISTS idx_style_catalogue_iscored_id ON style_catalogue(iscored_style_id)
        ` },
        { name: '016_games_catalogue_style_id', sql: `ALTER TABLE games ADD COLUMN catalogue_style_id TEXT` },
        { name: '017_games_style_header_disabled', sql: `ALTER TABLE games ADD COLUMN style_header_disabled INTEGER DEFAULT 0` },
        { name: '018_room_library_catalogue_style', sql: `ALTER TABLE game_room_game_library ADD COLUMN catalogue_style_id TEXT` },
        { name: '019_room_library_style_header_disabled', sql: `ALTER TABLE game_room_game_library ADD COLUMN style_header_disabled INTEGER DEFAULT 0` },
        { name: '020_games_queue_order', sql: `ALTER TABLE games ADD COLUMN queue_order INTEGER` },
        { name: '021_user_mappings_avatar_hash', sql: `ALTER TABLE user_mappings ADD COLUMN avatar_hash TEXT` },
        { name: '022_games_logo_style_id', sql: `ALTER TABLE games ADD COLUMN logo_style_id TEXT` },
        { name: '023_games_bg_style_id', sql: `ALTER TABLE games ADD COLUMN bg_style_id TEXT` },
        { name: '024_room_library_logo_style_id', sql: `ALTER TABLE game_room_game_library ADD COLUMN logo_style_id TEXT` },
        { name: '025_room_library_bg_style_id', sql: `ALTER TABLE game_room_game_library ADD COLUMN bg_style_id TEXT` },
    ];

    for (const migration of migrations) {
        const applied = await db.get('SELECT id FROM schema_migrations WHERE name = ?', migration.name);
        if (applied) continue;
        try {
            await db.exec(migration.sql);
        } catch {
            // Column/table may already exist from before versioned migrations — safe to skip
        }
        await db.run('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)', migration.name);
    }

    // --- Backfill queue_order for existing QUEUED games (idempotent) ---
    try {
        await db.exec(`
            UPDATE games SET queue_order = (
                SELECT COUNT(*) FROM games g2
                WHERE g2.tournament_id = games.tournament_id
                  AND g2.status = 'QUEUED'
                  AND g2.rowid <= games.rowid
            ) WHERE status = 'QUEUED' AND queue_order IS NULL
        `);
    } catch { /* safe to skip if column doesn't exist yet */ }

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

/**
 * Reset the database singleton. Used by tests to get a fresh in-memory database.
 */
export async function _resetForTesting(): Promise<void> {
    if (db) {
        await db.close();
        db = null;
    }
}
