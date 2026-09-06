import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

let db: Database | null = null;

// Single-flight guard (v2.99.2). `db` is assigned mid-init — right after
// `open()`, before the multi-hundred-statement schema+migration sequence —
// so without this, a concurrent initDatabase()/getDatabase() could either
// (a) start a SECOND full init (two migration BEGINs on overlapping handles:
// the test-suite "cannot start a transaction within a transaction" flake
// family, triggered when an untracked background chain's late getDatabase()
// landed during a test reset) or (b) be handed the half-migrated handle.
// Both entry points below return this promise while an init is in flight.
let initInFlight: Promise<Database> | null = null;

/**
 * Initializes the SQLite database and creates the necessary tables.
 */
export async function initDatabase(): Promise<Database> {
    if (initInFlight) return initInFlight;
    if (db) return db;
    initInFlight = doInitDatabase().finally(() => { initInFlight = null; });
    return initInFlight;
}

async function doInitDatabase(): Promise<Database> {
    const dbPath = process.env.DB_PATH || './data/arcaid.db';
    const dbDir = path.dirname(dbPath);

    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    db = await open({
        filename: dbPath,
        driver: sqlite3.Database
    });

    // Enable WAL mode for concurrent read/write support
    await db.exec('PRAGMA journal_mode=WAL');

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
            status TEXT NOT NULL DEFAULT 'ACTIVE', -- 'QUEUED', 'ACTIVE', 'COMPLETED', 'ARCHIVED' (was 'HIDDEN' pre-v2.10.2)
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
            -- NULLABLE as of v2.136.0 (ADR 0018): a Throwdown is a room-less
            -- challenge, so its scores have no game room. Room-scoped rows are
            -- unaffected and keep the FK cascade below — SQLite does not
            -- enforce a foreign key on a NULL value.
            game_room_id TEXT,
            game_id TEXT,
            iscored_username TEXT NOT NULL,
            discord_user_id TEXT DEFAULT 'SYSTEM',
            score INTEGER NOT NULL,
            photo_url TEXT,
            source TEXT NOT NULL DEFAULT 'tournament' CHECK(source IN ('tournament', 'community', 'sync', 'atgames', 'vpx')),
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

    // 12. Global game catalogue
    await db.exec(`
        CREATE TABLE IF NOT EXISTS global_games (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            display_name TEXT,
            manufacturer TEXT,
            year INTEGER,
            type TEXT NOT NULL DEFAULT 'pinball',
            subtype TEXT,
            platforms TEXT DEFAULT '[]',
            themes TEXT DEFAULT '[]',
            designers TEXT DEFAULT '[]',
            players INTEGER,
            image_url TEXT,
            local_image_path TEXT,
            wheel_image_path TEXT,
            opdb_id TEXT,
            vps_id TEXT,
            igdb_id INTEGER,
            ipdb_url TEXT,
            external_url TEXT,
            table_authors TEXT DEFAULT '[]',
            table_download_urls TEXT,
            tutorial_urls TEXT,
            rules_urls TEXT,
            description TEXT,
            source_rating REAL,
            features TEXT DEFAULT '[]',
            status TEXT DEFAULT 'approved',
            submitted_by TEXT,
            reviewed_by TEXT,
            global_leaderboard INTEGER DEFAULT 1,
            imported_from TEXT,
            imported_at TEXT,
            source_updated_at TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_global_games_opdb ON global_games(opdb_id);
        CREATE INDEX IF NOT EXISTS idx_global_games_vps ON global_games(vps_id);
        CREATE INDEX IF NOT EXISTS idx_global_games_igdb ON global_games(igdb_id);
        CREATE INDEX IF NOT EXISTS idx_global_games_name ON global_games(LOWER(name));
        CREATE INDEX IF NOT EXISTS idx_global_games_type ON global_games(type);
        CREATE INDEX IF NOT EXISTS idx_global_games_status ON global_games(status)
    `);

    // 13. Global scores
    await db.exec(`
        CREATE TABLE IF NOT EXISTS global_scores (
            id TEXT PRIMARY KEY,
            global_game_id TEXT NOT NULL,
            player_id TEXT NOT NULL,
            iscored_username TEXT,
            score INTEGER NOT NULL,
            photo_url TEXT,
            photo_hash TEXT,
            origin_type TEXT NOT NULL,
            origin_game_room_id TEXT,
            origin_game_id TEXT,
            exclude_from_global INTEGER DEFAULT 0,
            -- How the score REACHED us (migration 174), mirroring
            -- score_history.source. NULL on rows that predate it.
            source TEXT,
            deleted_at TEXT,
            deleted_by TEXT,
            submitted_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (global_game_id) REFERENCES global_games(id),
            FOREIGN KEY (origin_game_room_id) REFERENCES game_rooms(id)
        );

        CREATE INDEX IF NOT EXISTS idx_global_scores_game ON global_scores(global_game_id);
        CREATE INDEX IF NOT EXISTS idx_global_scores_player ON global_scores(player_id);
        CREATE INDEX IF NOT EXISTS idx_global_scores_room ON global_scores(origin_game_room_id);
        CREATE INDEX IF NOT EXISTS idx_global_scores_submitted ON global_scores(submitted_at)
    `);

    // 14. Global leaderboard cache
    await db.exec(`
        CREATE TABLE IF NOT EXISTS global_leaderboard_cache (
            global_game_id TEXT NOT NULL,
            scope TEXT NOT NULL,
            rankings TEXT NOT NULL,
            generated_at TEXT NOT NULL,
            PRIMARY KEY (global_game_id, scope)
        )
    `);

    // 15. Sync logs
    await db.exec(`
        CREATE TABLE IF NOT EXISTS sync_logs (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            status TEXT NOT NULL,
            records_imported INTEGER DEFAULT 0,
            records_updated INTEGER DEFAULT 0,
            records_skipped INTEGER DEFAULT 0,
            errors TEXT,
            started_at TEXT NOT NULL,
            completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sync_logs_source ON sync_logs(source);
        CREATE INDEX IF NOT EXISTS idx_sync_logs_started ON sync_logs(started_at)
    `);

    // 16. Score reports
    await db.exec(`
        CREATE TABLE IF NOT EXISTS score_reports (
            id TEXT PRIMARY KEY,
            score_id TEXT NOT NULL,
            reporter_discord_id TEXT NOT NULL,
            reason TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            resolved_at TEXT,
            resolved_by TEXT,
            resolution TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_score_reports_score ON score_reports(score_id);
        CREATE INDEX IF NOT EXISTS idx_score_reports_unresolved ON score_reports(resolved_at)
    `);

    // 17. User bans
    await db.exec(`
        CREATE TABLE IF NOT EXISTS user_bans (
            id TEXT PRIMARY KEY,
            discord_user_id TEXT NOT NULL,
            reason TEXT,
            banned_by TEXT NOT NULL,
            banned_at TEXT DEFAULT (datetime('now')),
            expires_at TEXT,
            lifted_at TEXT,
            lifted_by TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_user_bans_user ON user_bans(discord_user_id)
    `);

    // 18. Sessions (refresh tokens)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            discord_user_id TEXT NOT NULL,
            refresh_token TEXT NOT NULL,
            access_token_hash TEXT,
            expires_at TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            last_used_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(discord_user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_refresh ON sessions(refresh_token)
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
    //
    // Two shapes:
    //   { name, sql }      — schema-only migration. Errors are swallowed (a column
    //                        may already exist from a pre-ledger hand-run).
    //   { name, handler }  — data/procedural migration. Errors HALT startup — there
    //                        is no silently-skipping a failed backfill.
    type SchemaMigration = { name: string; sql: string };
    type HandlerMigration = { name: string; handler: (db: Database) => Promise<void> };
    const migrations: Array<SchemaMigration | HandlerMigration> = [
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
        { name: '026_games_display_name', sql: `ALTER TABLE games ADD COLUMN display_name TEXT` },
        { name: '027_game_library_display_name', sql: `ALTER TABLE game_library ADD COLUMN display_name TEXT` },
        { name: '028_tournaments_winner_picks', sql: `ALTER TABLE tournaments ADD COLUMN winner_picks INTEGER DEFAULT 1` },
        { name: '029_tournaments_auto_pick', sql: `ALTER TABLE tournaments ADD COLUMN auto_pick INTEGER DEFAULT 1` },
        { name: '030_tournaments_eligibility_days', sql: `ALTER TABLE tournaments ADD COLUMN eligibility_days INTEGER DEFAULT 120` },
        { name: '031_tournaments_winner_pick_window_min', sql: `ALTER TABLE tournaments ADD COLUMN winner_pick_window_min INTEGER DEFAULT 60` },
        { name: '032_tournaments_runnerup_pick_window_min', sql: `ALTER TABLE tournaments ADD COLUMN runnerup_pick_window_min INTEGER DEFAULT 30` },
        { name: '033_game_library_external_url', sql: `ALTER TABLE game_library ADD COLUMN external_url TEXT` },
        { name: '034_games_external_url', sql: `ALTER TABLE games ADD COLUMN external_url TEXT` },
        { name: '035_games_notes', sql: `ALTER TABLE games ADD COLUMN notes TEXT` },
        { name: '036_player_aliases', sql: `CREATE TABLE IF NOT EXISTS player_aliases (
            old_username TEXT NOT NULL,
            new_username TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (old_username)
        )` },
        { name: '037_room_library_global_game_id', sql: `ALTER TABLE game_room_game_library ADD COLUMN global_game_id TEXT` },
        { name: '038_games_global_game_id', sql: `ALTER TABLE games ADD COLUMN global_game_id TEXT` },
        { name: '039_game_library_global_game_id', sql: `ALTER TABLE game_library ADD COLUMN global_game_id TEXT` },
        { name: '040_user_preferences_scoreboard_prefs', sql: `ALTER TABLE user_preferences ADD COLUMN scoreboard_prefs TEXT` },
        { name: '041_global_game_ratings', sql: `
            CREATE TABLE IF NOT EXISTS global_game_ratings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                global_game_id TEXT NOT NULL,
                discord_user_id TEXT NOT NULL,
                rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                UNIQUE(global_game_id, discord_user_id),
                FOREIGN KEY (global_game_id) REFERENCES global_games (id) ON DELETE CASCADE
            )
        ` },
        { name: '042_global_game_comments', sql: `
            CREATE TABLE IF NOT EXISTS global_game_comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                global_game_id TEXT NOT NULL,
                discord_user_id TEXT NOT NULL,
                display_name TEXT NOT NULL,
                type TEXT NOT NULL DEFAULT 'comment' CHECK(type IN ('comment', 'tip')),
                body TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (global_game_id) REFERENCES global_games (id) ON DELETE CASCADE
            )
        ` },
        { name: '043_lobby_feed_events', sql: `
            CREATE TABLE IF NOT EXISTS lobby_feed_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                game_room_id TEXT NOT NULL,
                type TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'system',
                icon TEXT,
                title TEXT NOT NULL,
                subtitle TEXT,
                player_id TEXT,
                game_name TEXT,
                tournament_id TEXT,
                target_user_id TEXT,
                metadata TEXT DEFAULT '{}',
                created_at TEXT DEFAULT (datetime('now')),
                expires_at TEXT,
                FOREIGN KEY (game_room_id) REFERENCES game_rooms (id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_lobby_feed_room_created ON lobby_feed_events(game_room_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_lobby_feed_type ON lobby_feed_events(game_room_id, type);
            CREATE INDEX IF NOT EXISTS idx_lobby_feed_target ON lobby_feed_events(target_user_id);
        ` },
        { name: '044_lobby_announcements', sql: `
            CREATE TABLE IF NOT EXISTS lobby_announcements (
                id TEXT PRIMARY KEY,
                game_room_id TEXT NOT NULL,
                title TEXT NOT NULL,
                body TEXT,
                image_url TEXT,
                cta_url TEXT,
                cta_label TEXT,
                type TEXT NOT NULL DEFAULT 'announcement',
                event_datetime TEXT,
                display_from TEXT NOT NULL DEFAULT (datetime('now')),
                display_until TEXT,
                sort_order INTEGER DEFAULT 0,
                created_by TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (game_room_id) REFERENCES game_rooms (id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_lobby_announcements_room ON lobby_announcements(game_room_id);
        ` },
        { name: '045_community_shelf_items', sql: `
            CREATE TABLE IF NOT EXISTS community_shelf_items (
                id TEXT PRIMARY KEY,
                game_room_id TEXT NOT NULL,
                type TEXT NOT NULL DEFAULT 'link',
                url TEXT NOT NULL,
                title TEXT NOT NULL,
                thumbnail TEXT,
                description TEXT,
                sort_order INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (game_room_id) REFERENCES game_rooms (id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_community_shelf_room ON community_shelf_items(game_room_id);
        ` },
        { name: '046_friendships', sql: `
            CREATE TABLE IF NOT EXISTS friendships (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                friend_user_id TEXT NOT NULL,
                friend_discord_username TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT DEFAULT (datetime('now')),
                UNIQUE(user_id, friend_user_id)
            );
            CREATE INDEX IF NOT EXISTS idx_friendships_user ON friendships(user_id);
            CREATE INDEX IF NOT EXISTS idx_friendships_friend ON friendships(friend_user_id);
        ` },
        { name: '047_notification_prefs', sql: `
            ALTER TABLE user_preferences ADD COLUMN notification_prefs TEXT DEFAULT '{}';
        ` },
        { name: '048_submissions_context', sql: `
            ALTER TABLE submissions ADD COLUMN submitted_from_room_id TEXT;
            ALTER TABLE submissions ADD COLUMN submitted_during_tournament_id TEXT;
            ALTER TABLE submissions ADD COLUMN submitted_by_user_id TEXT;
            ALTER TABLE submissions ADD COLUMN submitted_by_anonymous_name TEXT;
            ALTER TABLE submissions ADD COLUMN merged_from_anonymous_identity_id INTEGER;
            CREATE INDEX IF NOT EXISTS idx_submissions_room_tourney ON submissions(submitted_from_room_id, submitted_during_tournament_id);
            CREATE INDEX IF NOT EXISTS idx_submissions_by_user ON submissions(submitted_by_user_id);
        ` },
        { name: '049_community_scores_context', sql: `
            ALTER TABLE community_scores ADD COLUMN submitted_from_room_id TEXT;
            ALTER TABLE community_scores ADD COLUMN submitted_during_tournament_id TEXT;
            ALTER TABLE community_scores ADD COLUMN submitted_by_user_id TEXT;
            ALTER TABLE community_scores ADD COLUMN submitted_by_anonymous_name TEXT;
            ALTER TABLE community_scores ADD COLUMN merged_from_anonymous_identity_id INTEGER;
            CREATE INDEX IF NOT EXISTS idx_community_scores_room_tourney ON community_scores(submitted_from_room_id, submitted_during_tournament_id);
            CREATE INDEX IF NOT EXISTS idx_community_scores_by_user ON community_scores(submitted_by_user_id);
        ` },
        { name: '050_score_history_context', sql: `
            ALTER TABLE score_history ADD COLUMN submitted_from_room_id TEXT;
            ALTER TABLE score_history ADD COLUMN submitted_during_tournament_id TEXT;
            ALTER TABLE score_history ADD COLUMN submitted_by_user_id TEXT;
            ALTER TABLE score_history ADD COLUMN submitted_by_anonymous_name TEXT;
            ALTER TABLE score_history ADD COLUMN merged_from_anonymous_identity_id INTEGER;
            CREATE INDEX IF NOT EXISTS idx_score_history_room_tourney ON score_history(submitted_from_room_id, submitted_during_tournament_id);
            CREATE INDEX IF NOT EXISTS idx_score_history_by_user ON score_history(submitted_by_user_id);
        ` },
        { name: '051_global_scores_context', sql: `
            ALTER TABLE global_scores ADD COLUMN submitted_from_room_id TEXT;
            ALTER TABLE global_scores ADD COLUMN submitted_during_tournament_id TEXT;
            ALTER TABLE global_scores ADD COLUMN submitted_by_user_id TEXT;
            ALTER TABLE global_scores ADD COLUMN submitted_by_anonymous_name TEXT;
            ALTER TABLE global_scores ADD COLUMN merged_from_anonymous_identity_id INTEGER;
            CREATE INDEX IF NOT EXISTS idx_global_scores_room_tourney ON global_scores(submitted_from_room_id, submitted_during_tournament_id);
            CREATE INDEX IF NOT EXISTS idx_global_scores_by_user ON global_scores(submitted_by_user_id);
        ` },
        { name: '052_anonymous_identities', sql: `
            CREATE TABLE IF NOT EXISTS anonymous_identities (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                server_nickname TEXT NOT NULL,
                guild_id TEXT,
                room_id TEXT,
                first_seen_at TEXT DEFAULT (datetime('now')),
                status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','merged','orphaned'))
            );
            CREATE INDEX IF NOT EXISTS idx_anon_identities_guild_name ON anonymous_identities(guild_id, server_nickname);
            CREATE INDEX IF NOT EXISTS idx_anon_identities_room ON anonymous_identities(room_id);
            CREATE INDEX IF NOT EXISTS idx_anon_identities_status ON anonymous_identities(status);
        ` },
        { name: '053_merge_records', sql: `
            CREATE TABLE IF NOT EXISTS merge_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                anonymous_identity_id INTEGER NOT NULL,
                target_discord_user_id TEXT NOT NULL,
                admin_discord_user_id TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now')),
                reversed_at TEXT,
                reversal_admin_id TEXT,
                score_ids_snapshot TEXT NOT NULL DEFAULT '{}',
                reason TEXT,
                FOREIGN KEY (anonymous_identity_id) REFERENCES anonymous_identities(id)
            );
            CREATE INDEX IF NOT EXISTS idx_merge_records_target ON merge_records(target_discord_user_id);
            CREATE INDEX IF NOT EXISTS idx_merge_records_anon ON merge_records(anonymous_identity_id);
            CREATE INDEX IF NOT EXISTS idx_merge_records_active ON merge_records(reversed_at);
        ` },
        { name: '054_orphaned_scores', sql: `
            ALTER TABLE submissions ADD COLUMN orphaned_at TEXT;
            ALTER TABLE community_scores ADD COLUMN orphaned_at TEXT;
            ALTER TABLE score_history ADD COLUMN orphaned_at TEXT;
            ALTER TABLE global_scores ADD COLUMN orphaned_at TEXT;
            CREATE INDEX IF NOT EXISTS idx_submissions_orphaned ON submissions(orphaned_at);
            CREATE INDEX IF NOT EXISTS idx_community_scores_orphaned ON community_scores(orphaned_at);
            CREATE INDEX IF NOT EXISTS idx_score_history_orphaned ON score_history(orphaned_at);
            CREATE INDEX IF NOT EXISTS idx_global_scores_orphaned ON global_scores(orphaned_at);
        ` },
        { name: '055_room_members', sql: `
            CREATE TABLE IF NOT EXISTS room_members (
                user_id TEXT NOT NULL,
                room_id TEXT NOT NULL,
                joined_at TEXT NOT NULL DEFAULT (datetime('now')),
                source TEXT NOT NULL CHECK (source IN ('submission','admin_invite','claim','backfill')),
                PRIMARY KEY (user_id, room_id),
                FOREIGN KEY (room_id) REFERENCES game_rooms (id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);

            -- Backfill from tournament submissions (Discord-authenticated only). Earliest
            -- submission timestamp per (user, room) becomes joined_at. Sentinels excluded.
            INSERT OR IGNORE INTO room_members (user_id, room_id, joined_at, source)
            SELECT s.discord_user_id, t.game_room_id, MIN(s.timestamp), 'backfill'
            FROM submissions s
            JOIN games g ON g.id = s.game_id
            JOIN tournaments t ON t.id = g.tournament_id
            WHERE s.discord_user_id IS NOT NULL
              AND s.discord_user_id NOT IN ('SYSTEM', 'COMMUNITY', 'ANON', '')
            GROUP BY s.discord_user_id, t.game_room_id;

            -- Backfill from community scores (Discord-authenticated only). Same shape.
            INSERT OR IGNORE INTO room_members (user_id, room_id, joined_at, source)
            SELECT cs.discord_user_id, cs.game_room_id, MIN(cs.created_at), 'backfill'
            FROM community_scores cs
            WHERE cs.discord_user_id IS NOT NULL
              AND cs.discord_user_id NOT IN ('SYSTEM', 'COMMUNITY', 'ANON', '')
            GROUP BY cs.discord_user_id, cs.game_room_id;

            -- Backfill from existing room admins. They have implicit membership.
            INSERT OR IGNORE INTO room_members (user_id, room_id, joined_at, source)
            SELECT discord_user_id, game_room_id, datetime('now'), 'backfill'
            FROM game_room_admins;
        ` },
        { name: '056_submission_drafts', sql: `
            CREATE TABLE IF NOT EXISTS submission_drafts (
                state_param TEXT PRIMARY KEY,
                target_json TEXT NOT NULL,
                player_name TEXT,
                score INTEGER,
                photo_path TEXT,
                exclude_from_global INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                expires_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_submission_drafts_expires ON submission_drafts(expires_at);
        ` },
        { name: '057_global_leaderboard_cache_bust_room_fields', sql: `
            -- Sprint 12: GlobalRankedEntry schema grew origin_room_slug + origin_room_logo_url.
            -- One-shot bust so clients never render a stale cached row without badge fields.
            DELETE FROM global_leaderboard_cache;
        ` },
        { name: '058_leaderboard_cache_bust_sprint12_tournament_filter', sql: `
            -- Sprint 12 / plan §13: Tournament card query dropped its community_scores
            -- union (see LeaderboardService.recalculate). Flush cached rows so clients
            -- don't see stale unions until a new score submission triggers recompute.
            DELETE FROM leaderboard_cache;
        ` },
        { name: '059_anonymous_identities_unique', sql: `
            -- Sprint 13: UNIQUE partial indexes close the read-check-insert race in
            -- AnonymousIdentityService.upsert. Two indexes cover the (guild_id set,
            -- room_id set) dichotomy since SQLite's default UNIQUE treats NULLs as
            -- distinct. LOWER() matches the service's case-insensitive comparison.
            CREATE UNIQUE INDEX IF NOT EXISTS idx_anon_identities_guild_nick_unique
                ON anonymous_identities(guild_id, LOWER(server_nickname))
                WHERE guild_id IS NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_anon_identities_room_nick_unique
                ON anonymous_identities(room_id, LOWER(server_nickname))
                WHERE guild_id IS NULL;
        ` },
        { name: '060_game_rooms_short_tag', sql: `
            -- Sprint 13: optional short_tag (≤6 chars, uppercased on render) replaces
            -- the slug-derived RoomTag label on the Global Scoreboard. Falls back to
            -- slug-derived when NULL.
            ALTER TABLE game_rooms ADD COLUMN short_tag TEXT;
        ` },
        { name: '061_global_leaderboard_cache_bust_short_tag', sql: `
            -- Sprint 13: leaderboard cache shape gained origin_room_short_tag.
            -- Bust the cache once so stale entries (lacking the new field) don't
            -- reach clients before the next natural recompute.
            DELETE FROM global_leaderboard_cache;
        ` },
        { name: '062_cache_bust_v2_0_1_anon_avatar_fix', sql: `
            -- v2.0.1: LeaderboardService + GlobalLeaderboardService SQL tightened
            -- so COMMUNITY/ANON rows no longer inherit avatars via the username
            -- fallback. Flush cached rows once so clients don't keep rendering
            -- the pre-fix attribution.
            DELETE FROM leaderboard_cache;
            DELETE FROM global_leaderboard_cache;
        ` },
        { name: '063_score_history_tournament_backfill', sql: `
            -- v2.1.0: tournament leaderboards now read from score_history filtered
            -- by submitted_during_tournament_id. Existing rows with game_id set
            -- but submitted_during_tournament_id NULL need backfilling so they
            -- keep appearing on tournament cards. Rows without a game_id link
            -- stay null (community-only submissions — correct exclusion).
            UPDATE score_history
            SET submitted_during_tournament_id = (
                SELECT t.id FROM games g
                JOIN tournaments t ON t.id = g.tournament_id
                WHERE g.id = score_history.game_id
                LIMIT 1
            )
            WHERE submitted_during_tournament_id IS NULL
              AND game_id IS NOT NULL;

            -- Shape-change cache bust.
            DELETE FROM leaderboard_cache;
        ` },
        { name: '064_first_claim_wins_identity', sql: `
            -- v2.2.0: per-room display name (first-claim-wins identity model).
            -- Discord users get a per-room display override stored on room_members.
            -- NULL means a member that hasn't claimed a name in this room yet
            -- (legacy backfilled rows, or admin-invited users who never submitted).
            ALTER TABLE room_members ADD COLUMN display_name TEXT;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_room_members_room_display_unique
                ON room_members(room_id, LOWER(display_name))
                WHERE display_name IS NOT NULL;

            -- Per-anon-token, per-room display claim. The anon_token is the
            -- localStorage 'arcaid_anon_id' UUID the SubmissionSheet sends as
            -- the 'x-user-id' header. One row per (anon, room) — guest's "Bob"
            -- on the same browser stays "Bob" across re-submits, but a different
            -- browser/device has a different token and gets auto-suffixed if
            -- "Bob" is already claimed in that room.
            CREATE TABLE IF NOT EXISTS anon_room_claims (
                anon_token TEXT NOT NULL,
                room_id TEXT NOT NULL,
                display_name TEXT NOT NULL,
                claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (anon_token, room_id),
                FOREIGN KEY (room_id) REFERENCES game_rooms (id) ON DELETE CASCADE
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_anon_room_claims_room_display_unique
                ON anon_room_claims(room_id, LOWER(display_name));
            CREATE INDEX IF NOT EXISTS idx_anon_room_claims_room ON anon_room_claims(room_id);
        ` },
        { name: '065_default_require_login_existing_rooms', sql: `
            -- v2.2.0: the GameRoomService.create path now writes
            -- REQUIRE_DISCORD_LOGIN='true' for new rooms. Pre-existing rooms
            -- aren't touched here on purpose — flipping it on retroactively
            -- would orphan all their anon scores (OrphanService.handleRequireLoginFlip
            -- fires when the value transitions). Admins can opt in per-room
            -- via Settings when they're ready. This migration is intentionally a no-op
            -- so the migration ledger reflects the v2.2.0 default-flip event.
            SELECT 1;
        ` },
        { name: '066_anon_room_claims_multi_name', sql: `
            -- v2.2.3: allow one anon_token to hold multiple display-name claims
            -- per room. Pre-v2.2.3 the PK was (anon_token, room_id) — one claim per
            -- browser per room — which meant a guest who typed "Bob_2" after
            -- already claiming "Bob" silently got collapsed back to "Bob" by the
            -- service's idempotent short-circuit. New PK keys on display_name too,
            -- so the same token can claim "Bob" AND "Bob_2" as separate identities.
            -- Name uniqueness per room is preserved by idx_anon_room_claims_room_display_unique.
            CREATE TABLE anon_room_claims_new (
                anon_token TEXT NOT NULL,
                room_id TEXT NOT NULL,
                display_name TEXT NOT NULL,
                claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (anon_token, room_id, display_name),
                FOREIGN KEY (room_id) REFERENCES game_rooms (id) ON DELETE CASCADE
            );
            INSERT INTO anon_room_claims_new (anon_token, room_id, display_name, claimed_at)
                SELECT anon_token, room_id, display_name, claimed_at FROM anon_room_claims;
            DROP TABLE anon_room_claims;
            ALTER TABLE anon_room_claims_new RENAME TO anon_room_claims;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_anon_room_claims_room_display_unique
                ON anon_room_claims(room_id, LOWER(display_name));
            CREATE INDEX IF NOT EXISTS idx_anon_room_claims_room ON anon_room_claims(room_id);
        ` },
        // --- v2.4.0: Catalogue unification + pin-to-scoreboard (Sprint) ---
        { name: '068_global_games_unique_name_type', handler: async (db) => {
            const { auditAndCreateGlobalGamesUniqueIndex } = await import('./migrations/catalogueUnification.js');
            await auditAndCreateGlobalGamesUniqueIndex(db);
        } },
        { name: '069_backfill_global_game_id', handler: async (db) => {
            const { backfillGlobalGameId } = await import('./migrations/catalogueUnification.js');
            await backfillGlobalGameId(db);
        } },
        // 077 MUST run before 070: the orphan delete handler UPDATEs
        // submissions.game_id = NULL, which needs the NOT NULL constraint
        // dropped first.
        { name: '077_submissions_game_id_nullable', sql: `
            CREATE TABLE submissions_new (
                id TEXT PRIMARY KEY,
                game_id TEXT,
                discord_user_id TEXT NOT NULL,
                iscored_username TEXT,
                score INTEGER NOT NULL,
                photo_url TEXT,
                timestamp TEXT NOT NULL,
                submitted_from_room_id TEXT,
                submitted_during_tournament_id TEXT,
                submitted_by_user_id TEXT,
                submitted_by_anonymous_name TEXT,
                merged_from_anonymous_identity_id INTEGER,
                orphaned_at TEXT,
                FOREIGN KEY (game_id) REFERENCES games (id)
            );
            INSERT INTO submissions_new
                SELECT id, game_id, discord_user_id, iscored_username, score, photo_url, timestamp,
                       submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
                       submitted_by_anonymous_name, merged_from_anonymous_identity_id, orphaned_at
                FROM submissions;
            DROP TABLE submissions;
            ALTER TABLE submissions_new RENAME TO submissions;
            CREATE INDEX IF NOT EXISTS idx_submissions_game_id ON submissions(game_id);
            CREATE INDEX IF NOT EXISTS idx_submissions_discord_user_id ON submissions(discord_user_id);
            CREATE INDEX IF NOT EXISTS idx_submissions_orphaned ON submissions(orphaned_at);
        ` },
        { name: '070_delete_legacy_orphan_games', handler: async (db) => {
            const { deleteLegacyOrphanGames } = await import('./migrations/catalogueUnification.js');
            await deleteLegacyOrphanGames(db);
        } },
        { name: '071_room_library_overlay_fields', sql: `
            ALTER TABLE game_room_game_library ADD COLUMN custom_platforms TEXT DEFAULT '[]';
            ALTER TABLE game_room_game_library ADD COLUMN display_name TEXT;
        ` },
        { name: '072_cache_bust_for_global_game_id_shape', sql: `
            -- Phase C (v2.4.0): leaderboard service output shape adds isPinned,
            -- and query joins prefer global_game_id over name. Flush both
            -- caches so clients don't render rows from the pre-shape schema.
            DELETE FROM leaderboard_cache;
            DELETE FROM global_leaderboard_cache;
        ` },
        { name: '073_games_game_room_id', sql: `
            ALTER TABLE games ADD COLUMN game_room_id TEXT;
            -- Denormalized FK: authoritative for pinned rows, derived from
            -- tournament.game_room_id for tournament-linked rows. Set at insert,
            -- never mutated independently. No FK constraint (rooms rarely
            -- deleted and SQLite ALTER can't add enforced FKs).
            UPDATE games SET game_room_id = (
                SELECT game_room_id FROM tournaments WHERE id = games.tournament_id
            )
            WHERE tournament_id IS NOT NULL AND game_room_id IS NULL;
            CREATE INDEX IF NOT EXISTS idx_games_game_room_id ON games(game_room_id);
        ` },
        { name: '074_games_pinned_unique_per_room', sql: `
            -- Prevent double-pinning the same game in the same room. Tournament
            -- games (tournament_id IS NOT NULL) are allowed to repeat across
            -- tournaments, so the partial predicate restricts the constraint
            -- to pinned rows only.
            CREATE UNIQUE INDEX IF NOT EXISTS idx_games_pinned_unique
                ON games(game_room_id, LOWER(name))
                WHERE tournament_id IS NULL;
        ` },
        { name: '075_unpin_unlinks_submissions_marker', sql: `
            -- Marker only: the application-layer unpin handler UPDATEs
            -- submissions.game_id = NULL (and score_history / global_scores)
            -- before DELETE on the games row, so score history is preserved
            -- when a pin is removed. ON DELETE CASCADE was explicitly rejected.
            SELECT 1;
        ` },
        { name: '076_games_display_order', sql: `
            ALTER TABLE games ADD COLUMN display_order INTEGER;
        ` },
        { name: '078_merge_thin_catalogue_duplicates', handler: async (db) => {
            const { mergeThinCatalogueDuplicates } = await import('./migrations/catalogueUnification.js');
            await mergeThinCatalogueDuplicates(db);
        } },
        { name: '079_merge_thin_catalogue_duplicates_relaxed', handler: async (db) => {
            const { mergeThinCatalogueDuplicatesV2 } = await import('./migrations/catalogueUnification.js');
            await mergeThinCatalogueDuplicatesV2(db);
        } },
        { name: '080_relax_global_games_unique_index', handler: async (db) => {
            const { relaxGlobalGamesUniqueIndex } = await import('./migrations/catalogueUnification.js');
            await relaxGlobalGamesUniqueIndex(db);
        } },
        { name: '082_merge_thin_duplicates_after_wizard_reimport', handler: async (db) => {
            // The first post-v2.4.8 Wizard import inserted rich (name, mfg,
            // year) rows for titles that previously only existed as thin
            // backfill duplicates. Migrations 078/079 ran BEFORE those rich
            // rows existed, so their lookup found no counterpart and left
            // the thin rows alone. Re-run the v2 merger now that the rich
            // counterparts are in place. Idempotent — same (LIKE + regex +
            // strict SELECT) pipeline as 079.
            const { mergeThinCatalogueDuplicatesV2 } = await import('./migrations/catalogueUnification.js');
            await mergeThinCatalogueDuplicatesV2(db);
        } },
        { name: '081_clear_stale_sync_alert_channel_id', sql: `
            -- The original defaultSettings seed shipped a dev-test Discord
            -- channel ID ('1467561374040461527') as SYNC_ALERT_CHANNEL_ID.
            -- That channel doesn't exist in any real deployment, so every
            -- catalogue sync (VPS/Wizard/OPDB/IGDB) logged a 10003 "Unknown
            -- Channel" error on partial/failure alerts. Scrub it; admins who
            -- want alerts can set their own channel ID via Global Settings.
            DELETE FROM settings
             WHERE key = 'SYNC_ALERT_CHANNEL_ID'
               AND value = '1467561374040461527';
        ` },
        // --- v2.5.0: VR + Steam-pinball platform taxonomy expansion ---
        { name: '083_rename_fx3_to_fx_classic', handler: async (db) => {
            const { renameFx3ToFxClassic } = await import('./migrations/platformTaxonomyExpansion.js');
            await renameFx3ToFxClassic(db);
        } },
        { name: '084_add_platform_to_score_tables', sql: `
            -- v2.5.0: per-score platform stratification. Pinball FX VR Medieval
            -- Madness is a different scoring surface than a real machine, and
            -- tournaments need to be able to require/exclude platforms. Column
            -- nullable in SQL (legacy rows survive); required at the API boundary
            -- via Zod for new submissions.
            ALTER TABLE submissions       ADD COLUMN platform TEXT;
            ALTER TABLE score_history     ADD COLUMN platform TEXT;
            ALTER TABLE community_scores  ADD COLUMN platform TEXT;
            ALTER TABLE global_scores     ADD COLUMN platform TEXT;

            -- Composite indexes match the leaderboard query shape:
            --   "scores for game X on platform Y, ordered by score".
            CREATE INDEX IF NOT EXISTS idx_submissions_game_platform   ON submissions(game_id, platform);
            CREATE INDEX IF NOT EXISTS idx_score_history_game_platform ON score_history(game_id, platform);
            CREATE INDEX IF NOT EXISTS idx_community_game_platform     ON community_scores(game_name, game_room_id, platform);
            CREATE INDEX IF NOT EXISTS idx_global_scores_game_platform ON global_scores(global_game_id, platform);

            -- Tournament-scoped fallback for iScored-polled scores. iScored has
            -- no platform concept, so admins can pick a default that gets stamped
            -- on synced submissions. NULL = leave score's platform NULL (renders
            -- as "Platform unknown" in the leaderboard).
            ALTER TABLE tournaments ADD COLUMN iscored_default_platform TEXT;

            -- OAuth-handoff drafts now also carry the picker selection so the
            -- post-login commit can replay it through the platform-required
            -- submit endpoints without re-prompting the user.
            ALTER TABLE submission_drafts ADD COLUMN platform TEXT;
        ` },
        { name: '085_backfill_score_platforms', handler: async (db) => {
            const { backfillScorePlatforms } = await import('./migrations/platformTaxonomyExpansion.js');
            await backfillScorePlatforms(db);
        } },
        { name: '086_cache_bust_for_platform_aware_rankings', sql: `
            -- v2.5.0: RankedEntry now carries a per-row platform field. Cached
            -- leaderboard JSON blobs from before this release have no platform
            -- key, so the GameDetail tabs would render every row as "Platform
            -- unknown" until natural cache invalidation kicked in. Flush both
            -- caches so the next read recomputes with the new shape.
            DELETE FROM leaderboard_cache;
            DELETE FROM global_leaderboard_cache;
        ` },
        { name: '087_global_games_pending_status', sql: `
            -- v2.5.0: per-room "submit to global catalogue for super-admin
            -- approval" flow. global_games.status was already a plain TEXT
            -- column with no CHECK constraint (default 'approved'), so we
            -- just need three new columns to track the proposer + when, plus
            -- a partial index for the approval queue read pattern.
            ALTER TABLE global_games ADD COLUMN submitted_by_user_id TEXT;
            ALTER TABLE global_games ADD COLUMN submitted_by_room_id TEXT;
            ALTER TABLE global_games ADD COLUMN submitted_at TEXT;
            -- Partial index — narrow because the approval queue UI lists ONLY
            -- pending rows ordered by submission time. idx_global_games_status
            -- already exists from the v2.4.0 sprint (see CREATE TABLE block).
            CREATE INDEX IF NOT EXISTS idx_global_games_pending
                ON global_games(status, submitted_at)
                WHERE status = 'pending';
        ` },
        { name: '088_cache_bust_for_platform_on_global_rankings', sql: `
            -- v2.5.1: GlobalRankedEntry now carries a per-row platform field.
            -- Cache entries written by recalcs that happened between v2.5.0
            -- deploy and v2.5.1 don't have the platform field, so the new
            -- "Platform" column on the global game detail leaderboard would
            -- render blank for every cached row. Flush both caches so the
            -- next read recomputes with the new shape.
            DELETE FROM leaderboard_cache;
            DELETE FROM global_leaderboard_cache;
        ` },
        { name: '089_normalize_all_platform_arrays', handler: async (db) => {
            const { normalizeAllPlatformArrays } = await import('./migrations/platformTaxonomyExpansion.js');
            await normalizeAllPlatformArrays(db);
        } },
        { name: '090_global_games_aliases', sql: `ALTER TABLE global_games ADD COLUMN aliases TEXT DEFAULT '[]'` },
        { name: '091_backfill_aliases_to_global_games', handler: async (db) => {
            // Step 2a — preserve game_library.aliases (CSV) onto global_games.aliases (JSON)
            // before the legacy table is dropped in 2e. Keyed via game_library.global_game_id
            // (set by migration 069). Aliases turn out to be write-only metadata in the live
            // codebase — no current reader — but we keep the data so a future feature
            // (search-by-alias, iScored alt-name matching) can use it without re-import.
            const rows = await db.all(`
                SELECT gl.aliases AS aliases, gl.global_game_id AS gg_id
                FROM game_library gl
                WHERE gl.global_game_id IS NOT NULL
                  AND gl.aliases IS NOT NULL
                  AND gl.aliases != ''
            `);
            let updated = 0;
            for (const row of rows) {
                const gg = await db.get('SELECT aliases FROM global_games WHERE id = ?', row.gg_id);
                if (!gg) continue;
                if (gg.aliases && gg.aliases !== '[]') continue;
                const list = String(row.aliases).split(',').map((a: string) => a.trim()).filter(Boolean);
                if (list.length === 0) continue;
                await db.run('UPDATE global_games SET aliases = ? WHERE id = ?', JSON.stringify(list), row.gg_id);
                updated++;
            }
            // eslint-disable-next-line no-console
            console.log(`[migration] 091: backfilled aliases onto ${updated} global_games row(s)`);
        } },
        { name: '092_drop_legacy_game_library_table', sql: `DROP TABLE IF EXISTS game_library` },
        { name: '093_room_game_tags', sql: `
            CREATE TABLE IF NOT EXISTS room_game_tags (
                game_room_id TEXT NOT NULL,
                global_game_id TEXT NOT NULL,
                tag TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (game_room_id, global_game_id, tag)
            );
            CREATE INDEX IF NOT EXISTS idx_room_game_tags_room_tag
                ON room_game_tags(game_room_id, tag);
        ` },
        { name: '094_legacy_vr_tag_cleanup', handler: async (db) => {
            // Pre-v2.5.0 the catalogue used a generic `vr` token for any VR
            // variant. v2.5.0 added specific ids (`pinball_fx_classic_vr`,
            // `pinball_fx_vr`, etc.) but a handful of VPS-imported rows still
            // carry the bare token. For each: if the row also has
            // `pinball_fx_classic` (i.e., it's a Williams/Bally Zen FX line
            // table), promote `vr` → `pinball_fx_classic_vr`. Strip the bare
            // `vr` regardless (FX VR adds happen via FxVrImportService, not
            // this migration). Idempotent.
            const rows = await db.all(`
                SELECT id, platforms FROM global_games
                WHERE platforms LIKE '%"vr"%'
            `) as Array<{ id: string; platforms: string | null }>;
            let promoted = 0;
            let stripped = 0;
            for (const row of rows) {
                let platforms: string[] = [];
                try {
                    const parsed = JSON.parse(row.platforms || '[]');
                    if (Array.isArray(parsed)) platforms = parsed.filter((x: any) => typeof x === 'string');
                } catch { continue; }
                if (!platforms.includes('vr')) continue;
                const hasFxClassic = platforms.includes('pinball_fx_classic');
                const next = platforms.filter(p => p !== 'vr');
                if (hasFxClassic && !next.includes('pinball_fx_classic_vr')) {
                    next.push('pinball_fx_classic_vr');
                    promoted++;
                }
                stripped++;
                await db.run(
                    `UPDATE global_games SET platforms = ? WHERE id = ?`,
                    JSON.stringify(next), row.id,
                );
            }
            // eslint-disable-next-line no-console
            console.log(`[migration] 094: stripped bare 'vr' from ${stripped} row(s); promoted ${promoted} to pinball_fx_classic_vr`);
        } },
        { name: '095_user_mappings_many_to_one_and_user_profiles', handler: async (db) => {
            // Sprint: forward-attribution merge + Discord-style display names.
            // Rebuild user_mappings to allow many iScored aliases per Discord user
            // (previously discord_user_id was the PRIMARY KEY — strict 1:1).
            // Add user_profiles table to hold the user-chosen global display name
            // and the avatar cache (moved off user_mappings so it stays single-row
            // per Discord user).
            //
            // Pre-flight: if any existing user_mappings rows collide case-
            // insensitively on iscored_username, abort with a clear error so the
            // operator can resolve before retrying. Case-only dupes are rare in
            // practice (iScored canonicalizes case) but we refuse to silently
            // pick a winner.
            const collisions = await db.all(`
                SELECT LOWER(iscored_username) AS lc, COUNT(*) AS n,
                       GROUP_CONCAT(iscored_username, ' / ') AS variants,
                       GROUP_CONCAT(discord_user_id, ', ') AS owners
                FROM user_mappings
                GROUP BY LOWER(iscored_username)
                HAVING n > 1
            `) as Array<{ lc: string; n: number; variants: string; owners: string }>;
            if (collisions.length > 0) {
                const detail = collisions.map(c => `  • ${c.variants} (owners: ${c.owners})`).join('\n');
                throw new Error(
                    `[migration 095] user_mappings has ${collisions.length} case-only iscored_username collision(s). ` +
                    `Resolve manually before upgrading:\n${detail}`,
                );
            }

            // Rebuild user_mappings: drop discord_user_id PK, add UNIQUE on
            // iscored_username (case-insensitive), add created_at.
            await db.exec(`
                CREATE TABLE user_mappings_new (
                    discord_user_id TEXT NOT NULL,
                    iscored_username TEXT NOT NULL,
                    avatar_hash TEXT,
                    created_at TEXT DEFAULT (datetime('now')),
                    UNIQUE(iscored_username COLLATE NOCASE)
                );
                INSERT INTO user_mappings_new (discord_user_id, iscored_username, avatar_hash)
                    SELECT discord_user_id, iscored_username, avatar_hash FROM user_mappings;
                DROP TABLE user_mappings;
                ALTER TABLE user_mappings_new RENAME TO user_mappings;
                CREATE INDEX IF NOT EXISTS idx_user_mappings_discord ON user_mappings(discord_user_id);
            `);

            // user_profiles: one row per Discord user. display_name is global
            // and case-insensitively unique (partial unique index excludes NULL
            // so the column can be unset). avatar_hash + avatar_fetched_at move
            // off user_mappings to keep them single-row per user.
            await db.exec(`
                CREATE TABLE IF NOT EXISTS user_profiles (
                    discord_user_id TEXT PRIMARY KEY,
                    display_name TEXT,
                    avatar_hash TEXT,
                    avatar_fetched_at TEXT,
                    created_at TEXT DEFAULT (datetime('now')),
                    updated_at TEXT DEFAULT (datetime('now'))
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profiles_display_name
                    ON user_profiles(LOWER(display_name)) WHERE display_name IS NOT NULL;
            `);

            // Backfill: one user_profiles row per unique discord_user_id, picking
            // any avatar_hash (they were 1:1 before, so MAX is just the value).
            // display_name stays NULL so users pick their own on first visit.
            await db.exec(`
                INSERT OR IGNORE INTO user_profiles (discord_user_id, avatar_hash)
                SELECT discord_user_id, MAX(avatar_hash)
                FROM user_mappings
                GROUP BY discord_user_id
            `);
        } },
        { name: '096_deleted_score_suppressions', sql: `
            -- Tombstone table consulted by ScoreSyncPoller to keep deleted
            -- scores from being re-imported on the next iScored sync. iScored
            -- has no per-score delete API, so when an admin or player deletes
            -- a score in ArcAid the iScored side keeps the entry — without
            -- this, the next ~30s poll cycle re-creates the score_history
            -- row and the deletion is undone. The poller skips inserting a
            -- score whose value <= the suppressed value for the same
            -- (game_id, lower(username)).
            CREATE TABLE IF NOT EXISTS deleted_score_suppressions (
                game_id TEXT NOT NULL,
                iscored_username_lower TEXT NOT NULL,
                suppressed_score INTEGER NOT NULL,
                deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
                deleted_by_user_id TEXT,
                PRIMARY KEY (game_id, iscored_username_lower)
            );
            CREATE INDEX IF NOT EXISTS idx_deleted_score_suppressions_game ON deleted_score_suppressions(game_id);
        ` },

        // Watermark-based cache validation for ranking_groups_cache. The
        // cache stores a fingerprint of the underlying data state at compute
        // time; on read, RankingService recomputes the fingerprint and
        // invalidates if it differs. Eliminates the class of bugs where a
        // score-mutation code path forgot to call RankingService.invalidate*()
        // — the data tells us when it's stale instead. Existing cache rows
        // get NULL watermark, which never matches a freshly-computed one, so
        // the first read after deploy forces a recompute (intentional).
        { name: '097_ranking_groups_cache_watermark', sql: `
            ALTER TABLE ranking_groups_cache ADD COLUMN data_watermark TEXT;
        ` },

        // v2.10.2: rename status enum value HIDDEN -> ARCHIVED. The pre-rename
        // name conflicted with iScored's own "Hidden" concept (game still in
        // lineup, soft-hidden from scoreboard) — ArcAid's value actually means
        // "post-cleanup, kept locally as a historical anchor for score
        // attribution." ARCHIVED captures that intent. No CHECK constraint to
        // update; the schema column is plain TEXT. Idempotent re-run is a
        // no-op once all rows are converted.
        { name: '098_rename_hidden_status_to_archived', sql: `
            UPDATE games SET status = 'ARCHIVED' WHERE status = 'HIDDEN';
        ` },

        // v2.11.0: strip community team-attribution prefix from existing
        // global_games.manufacturer values. The Wizard README format writes
        // "VPW Original" / "VPDB MOD" to credit the team that built the
        // digital recreation, but VPS stores the same machine with plain
        // "Original" / "MOD" — the mismatch was blocking dedup between vpx
        // and vpxs_manual variants of the same game. Pattern matches
        // 2-5-char all-caps initialism followed by Original or MOD.
        // Real manufacturer names (Williams, Stern, etc.) are untouched.
        //
        // Conflict handling: when stripping the prefix would collide with an
        // existing row at the same (name, type, year) — i.e. there's already
        // both "Original" and "VPW Original" rows for the same game — the
        // UPDATE violates idx_global_games_identity. We catch the constraint
        // error per-row, leave the prefixed row in place, and surface the
        // count in the log. Admin resolves via the catalogue Merge UI.
        { name: '099_strip_team_prefix_from_manufacturer', handler: async (db) => {
            const rows = await db.all<Array<{ id: string; manufacturer: string | null }>>(
                `SELECT id, manufacturer FROM global_games WHERE manufacturer IS NOT NULL`
            );
            let updated = 0;
            let collisions = 0;
            for (const row of rows) {
                if (!row.manufacturer) continue;
                const m = row.manufacturer.trim().match(/^[A-Z]{2,5}\s+(Original|MOD)$/i);
                if (!m) continue;
                try {
                    await db.run(
                        `UPDATE global_games SET manufacturer = ? WHERE id = ?`,
                        m[1], row.id
                    );
                    updated++;
                } catch (e: unknown) {
                    const err = e as { code?: string };
                    if (err?.code === 'SQLITE_CONSTRAINT') {
                        collisions++;
                    } else {
                        throw e;
                    }
                }
            }
            // eslint-disable-next-line no-console
            console.log(
                `[migration] 099: stripped team prefix from ${updated} global_games row(s); ` +
                `${collisions} skipped due to duplicate-collision (resolve via catalogue Merge UI)`
            );
        } },

        // v2.12.0: track which sources a row absorbed via merge or
        // cross-source upsert. The base imported_from column says where the
        // row was *first* imported from; merged_from_sources accumulates any
        // additional sources whose data has been folded onto this row. Used
        // to render "vps, wizard" in the admin catalogue when both have
        // contributed metadata.
        { name: '100_merged_from_sources', sql: `
            ALTER TABLE global_games ADD COLUMN merged_from_sources TEXT DEFAULT '[]';
        ` },

        // v2.13.6: AtGames cabinet sub-tags (atgames_hd, atgames_4k, ...) were
        // never tournament-meaningful — no realistic rule says "must run on
        // AtGames Micro only." Move them off `global_games.platforms` and into
        // `features` so they remain queryable for a future "filter by my
        // cabinet" catalogue UX, but stop polluting the tournament rule
        // picker. Same pass strips the dead sub-cabinet entries from any
        // tournament.platform_rules JSON (the umbrella `atgames` already
        // covers eligibility on those rows, so dedup is a no-op for rule
        // matching). Idempotent.
        { name: '101_atgames_subcabinet_to_features', handler: async (db) => {
            const SUB_CABINETS = [
                'atgames_hd', 'atgames_4k', 'atgames_micro', 'atgames_hdp',
                'atgames_alu', 'atgames_mini', 'atgames_gamer', 'atgames_core',
            ];

            // Part 1: global_games — move sub-cabinets from platforms to features.
            const rows = await db.all(
                `SELECT id, platforms, features FROM global_games WHERE platforms LIKE '%atgames_%'`,
            ) as Array<{ id: string; platforms: string | null; features: string | null }>;
            let gamesUpdated = 0;
            for (const row of rows) {
                let platforms: string[] = [];
                let features: string[] = [];
                try {
                    const p = JSON.parse(row.platforms || '[]');
                    if (Array.isArray(p)) platforms = p.filter((x: any) => typeof x === 'string');
                } catch { continue; }
                try {
                    const f = JSON.parse(row.features || '[]');
                    if (Array.isArray(f)) features = f.filter((x: any) => typeof x === 'string');
                } catch { features = []; }

                const subFound = platforms.filter(p => SUB_CABINETS.includes(p));
                if (subFound.length === 0) continue;

                const newPlatforms = platforms.filter(p => !SUB_CABINETS.includes(p));
                const newFeatures = [...new Set([...features, ...subFound])];

                await db.run(
                    `UPDATE global_games SET platforms = ?, features = ? WHERE id = ?`,
                    JSON.stringify(newPlatforms), JSON.stringify(newFeatures), row.id,
                );
                gamesUpdated++;
            }

            // Part 2: tournaments — strip sub-cabinet entries from platform_rules
            // (required + excluded). Umbrella `atgames` already drives eligibility.
            const tournRows = await db.all(
                `SELECT id, platform_rules FROM tournaments WHERE platform_rules LIKE '%atgames_%'`,
            ) as Array<{ id: string; platform_rules: string | null }>;
            let tournUpdated = 0;
            for (const row of tournRows) {
                let rules: { required?: unknown; excluded?: unknown; restrictedText?: unknown } | null = null;
                // Deliberately raw JSON.parse, NOT parseTournamentRules — migrations are
                // frozen transforms of the legacy shape and must not change output when
                // the live parser evolves (P2 ruling, 2026-07-31). This one parses,
                // mutates required/excluded in place while preserving every other field
                // (restrictedText included), and re-persists the same object.
                try { rules = JSON.parse(row.platform_rules || '{}'); } catch { continue; }
                if (!rules || typeof rules !== 'object') continue;

                const stripList = (arr: unknown): string[] => {
                    if (!Array.isArray(arr)) return [];
                    const filtered = arr.filter(
                        (x): x is string => typeof x === 'string' && !SUB_CABINETS.includes(x),
                    );
                    return [...new Set(filtered)];
                };

                const required = stripList(rules.required);
                const excluded = stripList(rules.excluded);
                const before = JSON.stringify(rules.required ?? []) + '|' + JSON.stringify(rules.excluded ?? []);
                const after = JSON.stringify(required) + '|' + JSON.stringify(excluded);
                if (before === after) continue;

                rules.required = required;
                rules.excluded = excluded;
                await db.run(
                    `UPDATE tournaments SET platform_rules = ? WHERE id = ?`,
                    JSON.stringify(rules), row.id,
                );
                tournUpdated++;
            }

            // eslint-disable-next-line no-console
            console.log(
                `[migration] 101: moved atgames_* sub-cabinets to features on ${gamesUpdated} global_games row(s); ` +
                `cleaned dead sub-cabinet entries from ${tournUpdated} tournament platform_rules`,
            );
        } },

        // S0 (Phase 0): backfill games.game_room_id from each game's tournament.
        // Pre-S0 the four TournamentEngine INSERTs left game_room_id NULL on
        // tournament rows (the column was only set on pins), so deleting a
        // tournament orphaned its games out of every game_room_id-scoped admin
        // query. The INSERTs now set it going forward; this one-time pass fixes
        // existing rows so the Game-States COALESCE(t.game_room_id, g.game_room_id)
        // net catches them. Idempotent — only touches NULL rows.
        { name: '102_backfill_games_game_room_id', sql: `
            UPDATE games
               SET game_room_id = (
                   SELECT t.game_room_id FROM tournaments t WHERE t.id = games.tournament_id
               )
             WHERE game_room_id IS NULL
               AND tournament_id IS NOT NULL
               AND (SELECT t.game_room_id FROM tournaments t WHERE t.id = games.tournament_id) IS NOT NULL;
        ` },

        // S1 (Phase 0): performance indexes for the hottest read paths.
        // score_history had no index matching any hot WHERE clause, so every
        // leaderboard recalc, platform tab, dedup check, ranking watermark, and
        // stats page was a full-table scan on the single shared SQLite
        // connection. Expression indexes on LOWER(...) match the case-insensitive
        // lookups the queries use; idx_score_history_tournament is a COVERING
        // index so the ranking watermark's COUNT/SUM never touch the table.
        { name: '103_perf_indexes', sql: `
            CREATE INDEX IF NOT EXISTS idx_score_history_room_gamename
                ON score_history(game_room_id, LOWER(game_name));
            CREATE INDEX IF NOT EXISTS idx_score_history_tournament
                ON score_history(submitted_during_tournament_id, orphaned_at, score);
            CREATE INDEX IF NOT EXISTS idx_score_history_room_created
                ON score_history(game_room_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_submissions_iscored_username
                ON submissions(LOWER(iscored_username));
        ` },

        // S3 (Phase 0): prepare for foreign_keys=ON. Runs while enforcement is
        // still OFF (the loop never enables it). Cleans every orphan class that
        // PRAGMA foreign_key_check would otherwise flag, so the post-enforcement
        // check is clean. Idempotent; no-op on fresh DBs. Sections:
        //  (A1) nullable-FK orphans -> unlink (preserve history, ADR 0005)
        //  (A2) NOT-NULL-FK orphans on game/catalogue/identity parents -> delete
        //  (A3) room-child orphans — rows whose room was deleted before FK
        //       enforcement, so the ON DELETE CASCADE never fired -> delete
        //  (B)  rebuild game_room_game_library: drop its dead FK to game_library
        //       (dropped in migration 092) AND drop rows orphaned to deleted
        //       rooms. SQLite can't ALTER away a FK; columns read dynamically so
        //       the ALTER-added style-overlay columns survive. Handler form so a
        //       failure halts startup instead of being swallowed.
        // Verified against prod 2026-06-15 (foreign_key_check: 6828 -> 0).
        { name: '104_fk_enforcement_prep', handler: async (db) => {
            // (A1) Nullable-FK orphans -> unlink (preserve the row's history).
            await db.exec(`
                UPDATE games SET tournament_id = NULL
                 WHERE tournament_id IS NOT NULL
                   AND tournament_id NOT IN (SELECT id FROM tournaments);
                UPDATE submissions SET game_id = NULL
                 WHERE game_id IS NOT NULL AND game_id NOT IN (SELECT id FROM games);
                UPDATE score_history SET game_id = NULL
                 WHERE game_id IS NOT NULL AND game_id NOT IN (SELECT id FROM games);
                UPDATE global_scores SET origin_game_room_id = NULL
                 WHERE origin_game_room_id IS NOT NULL
                   AND origin_game_room_id NOT IN (SELECT id FROM game_rooms);
                UPDATE global_scores SET origin_game_id = NULL
                 WHERE origin_game_id IS NOT NULL
                   AND origin_game_id NOT IN (SELECT id FROM games);
            `);

            // (A2) NOT-NULL-FK orphans on game / catalogue / identity parents.
            await db.exec(`
                DELETE FROM scores
                 WHERE game_id IS NOT NULL AND game_id NOT IN (SELECT id FROM games);
                DELETE FROM leaderboard_cache
                 WHERE game_id IS NOT NULL AND game_id NOT IN (SELECT id FROM games);
                DELETE FROM global_scores
                 WHERE global_game_id NOT IN (SELECT id FROM global_games);
                DELETE FROM global_leaderboard_cache
                 WHERE global_game_id NOT IN (SELECT id FROM global_games);
                DELETE FROM merge_records
                 WHERE anonymous_identity_id NOT IN (SELECT id FROM anonymous_identities);
                DELETE FROM ranking_group_tournaments
                 WHERE ranking_group_id NOT IN (SELECT id FROM ranking_groups)
                    OR tournament_id NOT IN (SELECT id FROM tournaments);
            `);

            // (A3) Room-child orphans (deleted-room cascade that never fired).
            // Explicit table list for auditability. room_members + anon_room_claims
            // key on `room_id`; the rest on `game_room_id`.
            const roomChildren = [
                'community_scores', 'score_history', 'game_comments', 'game_room_settings',
                'local_admins', 'game_room_admins', 'admin_invites', 'room_events',
                'lobby_feed_events', 'lobby_announcements', 'community_shelf_items',
            ];
            for (const t of roomChildren) {
                await db.run(`DELETE FROM ${t} WHERE game_room_id NOT IN (SELECT id FROM game_rooms)`);
            }
            await db.run(`DELETE FROM room_members WHERE room_id NOT IN (SELECT id FROM game_rooms)`);
            await db.run(`DELETE FROM anon_room_claims WHERE room_id NOT IN (SELECT id FROM game_rooms)`);

            // (B) Rebuild game_room_game_library: drop the dead game_library FK
            // AND drop rows orphaned to deleted rooms (filtered in the INSERT).
            const cols = await db.all(`PRAGMA table_info(game_room_game_library)`) as Array<{
                name: string; type: string; notnull: number; dflt_value: unknown;
            }>;
            if (cols.length > 0) {
                const colDefs = cols.map((c) => {
                    let def = `${c.name} ${c.type || 'TEXT'}`;
                    if (c.notnull) def += ' NOT NULL';
                    if (c.dflt_value !== null && c.dflt_value !== undefined) def += ` DEFAULT ${c.dflt_value}`;
                    return def;
                }).join(', ');
                const colNames = cols.map((c) => c.name).join(', ');
                await db.exec('DROP TABLE IF EXISTS game_room_game_library_new');
                await db.exec(`
                    CREATE TABLE game_room_game_library_new (
                        ${colDefs},
                        PRIMARY KEY (game_room_id, game_name),
                        FOREIGN KEY (game_room_id) REFERENCES game_rooms (id) ON DELETE CASCADE
                    )
                `);
                await db.exec(`INSERT INTO game_room_game_library_new (${colNames})
                    SELECT ${colNames} FROM game_room_game_library
                     WHERE game_room_id IN (SELECT id FROM game_rooms)`);
                await db.exec('DROP TABLE game_room_game_library');
                await db.exec('ALTER TABLE game_room_game_library_new RENAME TO game_room_game_library');
            }
        } },

        // S6: per-player milestone idempotency. Records each fired
        // (game_room_id, player_key, scope, threshold) so MilestoneService emits
        // a given milestone AT MOST ONCE — fixing both the missed-on-jump bug
        // (count goes 9 -> 11 without ever equalling 10) and the double-fire bug
        // (count oscillates back across a threshold after a score delete).
        // player_key is the canonical identity
        //   COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username))
        // computed in the service, so multi-alias Discord users collapse to one
        // row and pure-anon/iscored rows still partition per-name. The service
        // does INSERT OR IGNORE and emits only when changes() === 1; the UNIQUE
        // constraint is what guarantees the at-most-once semantic.
        { name: '105_player_milestones_fired', sql: `
            CREATE TABLE IF NOT EXISTS player_milestones_fired (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                game_room_id  TEXT NOT NULL,
                player_key    TEXT NOT NULL,   -- COALESCE(submitted_by_user_id,'iscored:'||LOWER(iscored_username))
                scope         TEXT NOT NULL,   -- 'scores_submitted' | 'unique_games' | 'number_ones'
                threshold     INTEGER NOT NULL,
                fired_at      TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE (game_room_id, player_key, scope, threshold),
                FOREIGN KEY (game_room_id) REFERENCES game_rooms (id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_player_milestones_fired_lookup
                ON player_milestones_fired (game_room_id, player_key, scope);
        ` },
        // S10 — per-tournament maintenance-run trail. One row per runMaintenance()
        // call (cron or forced) recording outcome/summary/duration so room admins
        // get a "Last run · result" surface and failure paths are admin-visible.
        // Intentionally NO foreign keys: this is an append-only audit log that
        // should outlive the tournament/room it references (consistent with the
        // pseudo-FK treatment of games.tournament_id). Pruning is a future concern.
        { name: '106_maintenance_runs', sql: `
            CREATE TABLE IF NOT EXISTS maintenance_runs (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                game_room_id  TEXT,
                tournament_id TEXT,
                kind          TEXT NOT NULL DEFAULT 'maintenance',  -- 'maintenance' | 'forced' | 'cleanup'
                outcome       TEXT NOT NULL,                        -- 'success' | 'skipped' | 'error'
                summary       TEXT,
                started_at    TEXT,
                finished_at   TEXT NOT NULL DEFAULT (datetime('now')),
                duration_ms   INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_maintenance_runs_tournament
                ON maintenance_runs (tournament_id, finished_at);
            CREATE INDEX IF NOT EXISTS idx_maintenance_runs_room
                ON maintenance_runs (game_room_id, finished_at);
        ` },
        // scores-page-redesign (B4): one-time backfill of legacy PRE-dual-write
        // community_scores rows into score_history, so the new Room Scores tab
        // (which reads score_history alone — see RoomScoresService) doesn't
        // silently drop old freeplay scores that predate CommunityScoreService's
        // dual-write (source='community'). Guarded by two NOT EXISTS:
        //   1. Skip rows that already have a matching score_history twin —
        //      idempotent, re-running this migration inserts 0 rows.
        //   2. Skip rows whose matching deleted_score_suppressions tombstone
        //      exists (the admin "wipe player from game" path deletes
        //      score_history but NOT community_scores) — without this guard,
        //      running this migration would resurrect admin-wiped scores.
        // orphaned_at is copied through so already-orphaned rows stay filtered.
        { name: '107_backfill_community_scores_into_score_history', handler: async (db) => {
            const candidateWhere = `
                WHERE NOT EXISTS (
                    SELECT 1 FROM score_history sh
                    WHERE sh.game_room_id = cs.game_room_id
                      AND LOWER(sh.game_name) = LOWER(cs.game_name)
                      AND LOWER(sh.iscored_username) = LOWER(cs.iscored_username)
                      AND sh.score = cs.score
                )
                AND NOT EXISTS (
                    SELECT 1 FROM deleted_score_suppressions dss
                    JOIN games g ON g.id = dss.game_id
                    WHERE g.game_room_id = cs.game_room_id
                      AND LOWER(g.name) = LOWER(cs.game_name)
                      AND dss.iscored_username_lower = LOWER(cs.iscored_username)
                      AND dss.suppressed_score >= cs.score
                )
            `;

            const countRow = await db.get(
                `SELECT COUNT(*) as c FROM community_scores cs ${candidateWhere}`
            );
            // eslint-disable-next-line no-console
            console.log(`[migration] 107: backfilling ${countRow?.c ?? 0} legacy community_scores row(s) into score_history`);

            await db.run(`
                INSERT INTO score_history
                    (game_name, game_room_id, game_id, iscored_username, discord_user_id, score, photo_url, source,
                     submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
                     submitted_by_anonymous_name, merged_from_anonymous_identity_id, platform, created_at, orphaned_at)
                SELECT cs.game_name, cs.game_room_id, NULL, cs.iscored_username, cs.discord_user_id, cs.score, cs.photo_url, 'community',
                       cs.submitted_from_room_id, NULL, cs.submitted_by_user_id, cs.submitted_by_anonymous_name,
                       cs.merged_from_anonymous_identity_id, cs.platform, cs.created_at, cs.orphaned_at
                FROM community_scores cs
                ${candidateWhere}
            `);
        } },
        // S13 — trophy case: append-only achievement log (tournament wins,
        // milestones, room records). Deliberately NO foreign keys — an audit
        // log that outlives its tournament/room, same treatment as
        // maintenance_runs (migration 106). The partial UNIQUE index on
        // (type, game_id) is the tournament_win dedup key: one win per
        // completed game, INSERT OR IGNORE-safe on re-run.
        { name: '108_player_achievements', handler: async (db) => {
            await db.exec(`
                CREATE TABLE IF NOT EXISTS player_achievements (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    game_room_id TEXT,
                    discord_user_id TEXT,
                    iscored_username TEXT,
                    type TEXT NOT NULL,            -- 'tournament_win' | 'milestone' | 'room_record'
                    game_name TEXT,
                    game_id TEXT,                  -- games row id, set for tournament_win (dedup key)
                    tournament_id TEXT,
                    earned_at TEXT NOT NULL DEFAULT (datetime('now')),
                    metadata TEXT                  -- JSON string: {score} | {scope, threshold} | {score}
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_player_achievements_tournament_win_dedup
                    ON player_achievements(type, game_id) WHERE type = 'tournament_win' AND game_id IS NOT NULL;
                CREATE INDEX IF NOT EXISTS idx_player_achievements_room_username
                    ON player_achievements(game_room_id, iscored_username);
                CREATE INDEX IF NOT EXISTS idx_player_achievements_discord_user
                    ON player_achievements(discord_user_id);
            `);

            // Backfill: one 'tournament_win' achievement per COMPLETED tournament
            // game, derived from the top submissions row (submissions-based —
            // matches BOTH live winner derivations, TournamentEngine's
            // post-rotation resolution and /history's window query — NOT
            // score_history). INSERT OR IGNORE no-ops on re-run via the partial
            // unique index above.
            const topWinnersCte = `
                WITH ranked AS (
                    SELECT
                        s.game_id AS game_id,
                        s.iscored_username AS iscored_username,
                        s.discord_user_id AS discord_user_id,
                        s.score AS score,
                        g.name AS game_name,
                        g.tournament_id AS tournament_id,
                        g.end_date AS end_date,
                        t.game_room_id AS game_room_id,
                        ROW_NUMBER() OVER (PARTITION BY s.game_id ORDER BY s.score DESC) AS rn
                    FROM submissions s
                    JOIN games g ON g.id = s.game_id
                    JOIN tournaments t ON t.id = g.tournament_id
                    WHERE s.orphaned_at IS NULL
                      AND g.status = 'COMPLETED'
                      AND g.tournament_id IS NOT NULL
                )
                SELECT * FROM ranked WHERE rn = 1
            `;

            const countRow = await db.get(`SELECT COUNT(*) as c FROM (${topWinnersCte})`);
            // eslint-disable-next-line no-console
            console.log(`[migration] 108: backfilling ${countRow?.c ?? 0} tournament_win achievement(s) from completed games`);

            await db.run(`
                INSERT OR IGNORE INTO player_achievements
                    (game_room_id, discord_user_id, iscored_username, type, game_name, game_id, tournament_id, earned_at, metadata)
                SELECT
                    game_room_id, discord_user_id, iscored_username, 'tournament_win', game_name, game_id, tournament_id,
                    COALESCE(end_date, datetime('now')), json_object('score', score)
                FROM (${topWinnersCte})
            `);
        } },
        // catalogue-dedup-hardening: a virtual-only-manufacturer (Zen Studios,
        // Original) or missing-manufacturer row's ipdb_url is a thematic
        // reference to a real machine, not an identity claim — it must not
        // participate in the identity-dedup IPDB cross-reference (see
        // GlobalGameService.resolveDedupCandidates step 3). This column holds
        // that reference separately from the identity-bearing ipdb_url.
        { name: '109_global_games_based_on_ipdb_url', sql: `ALTER TABLE global_games ADD COLUMN based_on_ipdb_url TEXT` },
        // v2.21.1: VPS ships a literal "Not Available" placeholder string in
        // its ipdbUrl field, and the importer copied it verbatim for years —
        // the first prod dedup-audit run surfaced 95 rows carrying junk (not
        // parseable machine.cgi?id=N links, so they never affected dedup, but
        // they pollute the identity column and flood the audit). Clear every
        // unparseable value from BOTH ipdb columns (the v2.21.0 routing may
        // have already moved junk into based_on_ipdb_url on virtual rows).
        // Upsert now drops unparseable links at the door, so this is one-shot.
        { name: '110_clear_junk_ipdb_urls', handler: async (db) => {
            const junkWhere = `IS NOT NULL AND LOWER(%COL%) NOT LIKE '%machine.cgi?id=%'`;
            const identRow = await db.get(
                `SELECT COUNT(*) as c FROM global_games WHERE ipdb_url ${junkWhere.replace('%COL%', 'ipdb_url')}`
            );
            const refRow = await db.get(
                `SELECT COUNT(*) as c FROM global_games WHERE based_on_ipdb_url ${junkWhere.replace('%COL%', 'based_on_ipdb_url')}`
            );
            // eslint-disable-next-line no-console
            console.log(`[migration] 110: clearing ${identRow?.c ?? 0} junk ipdb_url + ${refRow?.c ?? 0} junk based_on_ipdb_url value(s) (unparseable placeholders like "Not Available")`);
            await db.run(
                `UPDATE global_games SET ipdb_url = NULL WHERE ipdb_url ${junkWhere.replace('%COL%', 'ipdb_url')}`
            );
            await db.run(
                `UPDATE global_games SET based_on_ipdb_url = NULL WHERE based_on_ipdb_url ${junkWhere.replace('%COL%', 'based_on_ipdb_url')}`
            );
        } },
        // S15 web push — per-device browser push subscriptions. One row per
        // (user, browser endpoint); endpoints are globally unique per the Push
        // API spec, so a browser re-subscribing under a different account moves
        // the row (ON CONFLICT(endpoint) at the write site). Deliberately
        // FK-less: the account-deletion purge owns cleanup (AccountDeletionService),
        // and expired endpoints are pruned on 404/410 at send time (WebPushService).
        { name: '111_push_subscriptions', sql: `
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                discord_user_id TEXT NOT NULL,
                endpoint TEXT NOT NULL UNIQUE,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(discord_user_id);
        ` },
        // v2.25.0 report-a-problem — (a) game_feedback: user-filed reports on
        // catalogue metadata, mirroring score_reports' shape. Deliberately
        // FK-less with a denormalized game_name so a report survives its
        // game's merge/deletion (audit-log pattern, like maintenance_runs).
        // The partial UNIQUE index blocks duplicate OPEN reports per
        // (game, reporter, field) — refiling after resolution is allowed.
        // (b) global_games.field_sources: per-field source stamp JSON
        // ({"manufacturer":"vps",...}), written at the GlobalGameService
        // upsert/update chokepoints from now on ('{}' = legacy/unknown).
        // Per-field source STORAGE was deferred from ADR 0014 to this feature.
        // Handler (not sql) migration: the sql runner's silent catch could
        // swallow a transient partial failure and mark 112 applied with the
        // dedup UNIQUE index (the 409 contract) missing forever. Handlers
        // propagate errors and halt startup instead; every statement here is
        // idempotent so a halted retry is safe.
        { name: '112_game_feedback_field_sources', handler: async (db) => {
            await db.exec(`
                CREATE TABLE IF NOT EXISTS game_feedback (
                    id TEXT PRIMARY KEY,
                    global_game_id TEXT NOT NULL,
                    game_name TEXT NOT NULL,
                    reporter_discord_id TEXT NOT NULL,
                    field TEXT NOT NULL,
                    current_value TEXT,
                    suggested_value TEXT,
                    note TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    resolved_at TEXT,
                    resolved_by TEXT,
                    resolution TEXT,
                    resolution_note TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_game_feedback_game ON game_feedback(global_game_id);
                CREATE INDEX IF NOT EXISTS idx_game_feedback_open ON game_feedback(resolved_at);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_game_feedback_dedup
                    ON game_feedback(global_game_id, reporter_discord_id, field)
                    WHERE resolved_at IS NULL;
            `);
            const cols = await db.all(`PRAGMA table_info(global_games)`);
            if (!cols.some((c: { name: string }) => c.name === 'field_sources')) {
                await db.exec(`ALTER TABLE global_games ADD COLUMN field_sources TEXT DEFAULT '{}'`);
            }
            console.log('[migration] 112: game_feedback + global_games.field_sources ready');
        } },
        { name: '113_user_profiles_avatar_url', sql: `ALTER TABLE user_profiles ADD COLUMN avatar_url TEXT` },
        // v2.36.0 Google<->Discord identity linking. Maps a provider-namespaced
        // login identity (currently only `google:<sub>`) to the canonical
        // identity a linked user should operate as everywhere — always a
        // Discord snowflake in v1 (Discord unlocks the channel/notification
        // features). One google identity links to at most one Discord user
        // (PK on provider_user_id); one Discord user may hold multiple linked
        // google identities (harmless — the UI only ever offers linking one at
        // a time). See IdentityLinkService.ts for the parallel-mechanism
        // distinction from user_mappings.
        { name: '114_user_identity_links', sql: `
            CREATE TABLE IF NOT EXISTS user_identity_links (
                provider_user_id TEXT PRIMARY KEY,
                canonical_user_id TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_user_identity_links_canonical ON user_identity_links(canonical_user_id);
        ` },
        // v2.38.0 — explicit room join/leave (docs/contracts/join-leave-contract.md). Widens
        // room_members.source's CHECK to admit 'self_join' (user-initiated join
        // via the landing-page bookmark toggle / room-page affordance) alongside
        // the existing submission/admin_invite/claim/backfill sources. SQLite
        // can't ALTER a CHECK constraint in place, so rebuild per the
        // 066/077/095 create-copy-drop-rename pattern. Handler (not plain sql)
        // because the generic sql-migration runner swallows exec() errors
        // silently (see the catch block in the loop below) — a botched rebuild
        // of this table must halt startup, not get marked applied anyway.
        // Safe under FK enforcement: this runs inside the migration loop,
        // before initDatabase() sets PRAGMA foreign_keys = ON.
        { name: '115_room_members_self_join_source', handler: async (db) => {
            await db.exec(`
                CREATE TABLE room_members_new (
                    user_id TEXT NOT NULL,
                    room_id TEXT NOT NULL,
                    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
                    source TEXT NOT NULL CHECK (source IN ('submission','admin_invite','claim','backfill','self_join')),
                    display_name TEXT,
                    PRIMARY KEY (user_id, room_id),
                    FOREIGN KEY (room_id) REFERENCES game_rooms (id) ON DELETE CASCADE
                );
                INSERT INTO room_members_new (user_id, room_id, joined_at, source, display_name)
                    SELECT user_id, room_id, joined_at, source, display_name FROM room_members;
                DROP TABLE room_members;
                ALTER TABLE room_members_new RENAME TO room_members;
                CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_room_members_room_display_unique
                    ON room_members(room_id, LOWER(display_name))
                    WHERE display_name IS NOT NULL;
            `);
        } },
        // v2.39.0 — approval rooms (docs/contracts/approval-rooms-contract.md). Per-room
        // JOIN_POLICY ('open'|'approval', stored in game_room_settings — no
        // schema change needed for that). This table backs the request queue
        // for 'approval' rooms: a user requests, a room admin approves/denies.
        // Partial unique index enforces at most one PENDING request per
        // (room, user) — approved/denied rows don't block a fresh request
        // (denied users may re-request; approved requests are historical).
        { name: '116_join_requests', sql: `
            CREATE TABLE IF NOT EXISTS join_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                game_room_id TEXT NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied')),
                requested_at TEXT NOT NULL DEFAULT (datetime('now')),
                resolved_at TEXT,
                resolved_by TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_join_requests_pending ON join_requests(game_room_id, user_id) WHERE status='pending';
            CREATE INDEX IF NOT EXISTS idx_join_requests_room_status ON join_requests(game_room_id, status);
        ` },
        // v2.40.0 — join-request name resolution (docs/contracts/joinreq-names-global-optin-
        // contract.md, D1). The join-requests admin queue was rendering a raw
        // Discord snowflake because login only ever persisted avatar_hash/url
        // into user_profiles, never a name — display_name stays NULL until a
        // user explicitly picks one (AccountSettings), so there was no fallback
        // above the raw ID. `username` is a distinct, nullable, NON-unique
        // fallback (unlike the user-chosen unique display_name): populated at
        // every login with the same displayName value already computed there
        // (Discord global_name||username, Google name||email-prefix), and again
        // at join-request time from the JWT's username claim. Resolution order
        // everywhere this ships: display_name ?? username ?? userId.
        { name: '117_user_profiles_username', sql: `ALTER TABLE user_profiles ADD COLUMN username TEXT` },
        // v2.43.0 — S22 Phase 1 content moderation: unified reports table for
        // both room reports and player-name reports (same shape, rendered
        // together in the super-admin queue — not two tables). The partial
        // UNIQUE index is the anti-spam dedup mechanism (join_requests
        // pattern, migration 116): INSERT and catch the constraint violation
        // → 409, rather than an app-level SELECT-then-INSERT race. A resolved
        // report doesn't block a fresh one — the target may misbehave again.
        { name: '118_content_reports', sql: `
            CREATE TABLE IF NOT EXISTS content_reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                target_type TEXT NOT NULL CHECK (target_type IN ('room','player_name')),
                target_key TEXT NOT NULL,
                game_room_id TEXT REFERENCES game_rooms(id) ON DELETE CASCADE,
                target_user_id TEXT,
                target_name TEXT,
                reporter_user_id TEXT NOT NULL,
                reason TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                resolved_at TEXT,
                resolved_by TEXT,
                resolution TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_content_reports_open_dedup
                ON content_reports(target_key, reporter_user_id) WHERE resolved_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx_content_reports_status ON content_reports(target_type, resolved_at);
        ` },
        // v2.44.0 — S22 Phase 2: super-admin room suspension. A COLUMN on
        // game_rooms (not a game_room_settings key) — this is super-admin-
        // imposed moderation state, not room config: it must survive settings
        // tooling untouched and be cheap to join into room listings.
        // `suspended_at IS NOT NULL` is the suspended predicate everywhere.
        { name: '119_room_suspension', sql: `
            ALTER TABLE game_rooms ADD COLUMN suspended_at TEXT;
            ALTER TABLE game_rooms ADD COLUMN suspended_by TEXT;
            ALTER TABLE game_rooms ADD COLUMN suspended_reason TEXT;
        ` },
        // v2.47.0 — S22 follow-ups Workstream 2: comment reports. Mirrors
        // content_reports (migration 118) shape/dedup pattern: a partial
        // UNIQUE index on the open-report window (not a literal
        // `UNIQUE(comment_id, reporter_discord_id)`, which would permanently
        // block a re-report after the first one resolves — a comment can
        // misbehave again, or a first report can be dismissed in error).
        // `comment_id` intentionally has no FK — mirrors score_reports.score_id
        // (no enforced FK either): the report row must survive the "Remove"
        // resolution, which deletes the underlying game_comments row while
        // keeping the report as an audit record of what was reported/actioned.
        { name: '120_comment_reports', sql: `
            CREATE TABLE IF NOT EXISTS comment_reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                comment_id INTEGER NOT NULL,
                reporter_discord_id TEXT NOT NULL,
                reason TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                resolved_at TEXT,
                resolved_by TEXT,
                resolution TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_reports_open_dedup
                ON comment_reports(comment_id, reporter_discord_id) WHERE resolved_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx_comment_reports_unresolved ON comment_reports(resolved_at);
        ` },
        // v2.48.0 — first-login player tutorial (docs/contracts/first-login-tutorial-contract.md).
        // Nullable ISO timestamp (not boolean) so a future "reset tutorial" admin
        // action can re-show it just by clearing the column. Same ALTER-add
        // idempotency convention as migration 040 (scoreboard_prefs) — duplicate
        // column errors are swallowed by the migration loop's try/catch below.
        { name: '121_user_preferences_tutorial_seen', sql: `ALTER TABLE user_preferences ADD COLUMN tutorial_seen_at TEXT` },
        // v2.49.0 — room-tier bans (docs/contracts/room-bans-contract.md). Nullable
        // `game_room_id` on the EXISTING `user_bans` table (NOT a separate
        // table) — NULL keeps meaning "global ban" (every pre-existing row
        // and every global-ban write path is unaffected), a populated value
        // scopes the ban to one room. `BanService.isIdentityBanned` treats a
        // room ban as `(game_room_id IS NULL OR game_room_id = ?)` so global
        // bans still bite inside rooms, but a room ban never leaks to other
        // rooms or global surfaces (decision 5).
        //
        // v2.49.0 fix-round (docs/contracts/room-bans-fixes.md #11) — split into two
        // migration entries. The original single-entry form ran the ALTER
        // and the CREATE INDEX in one `exec`: on a DB where the column
        // already exists but the `schema_migrations` row for this name
        // doesn't (a legitimate state — see the ALTER-add idempotency
        // convention noted at migration 121), the ALTER throws, the
        // migration loop's swallowing catch (below) skips the CREATE INDEX
        // that was bundled in the SAME string, and the migration is still
        // marked applied — permanently missing the index with no retry path.
        // Splitting means the ALTER's swallowed failure no longer takes the
        // index down with it.
        { name: '122_user_bans_room_scope', sql: `ALTER TABLE user_bans ADD COLUMN game_room_id TEXT` },
        { name: '123_user_bans_room_index', sql: `CREATE INDEX IF NOT EXISTS idx_user_bans_user_room ON user_bans(discord_user_id, game_room_id)` },
        // v2.52.0 — Global Scoreboard pins (Track A, phase A4;
        // docs/contracts/global-scoreboard-a4-contract.md).
        //
        // FK TARGET IS `global_games(id)`. The design handoff specified
        // `REFERENCES global_games(global_game_id)` — that column does not
        // exist (the catalogue PK is `id`, declared at the top of this file).
        // `PRAGMA foreign_keys = ON` is enabled after this loop, and SQLite
        // only reports a malformed FK at DML time, so the handoff's version
        // would have created cleanly and then thrown
        // `foreign key mismatch` on the very first pin INSERT in production.
        // The suite asserts an actual insert, not just that the migration ran.
        //
        // `discord_user_id` is the generic identity column name used
        // everywhere in this schema — it holds any provider id, including the
        // namespaced `google:*` form (ADR 0015). No provider column.
        //
        // `last_known_rank` / `last_seen_at` are seeded/read by pins today
        // (they drive the rail's rank-delta badge); A5's rank-change alerting
        // is the other consumer and ships separately.
        { name: '124_global_game_pins', sql: `
            CREATE TABLE IF NOT EXISTS global_game_pins (
                discord_user_id TEXT NOT NULL,
                global_game_id TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_known_rank INTEGER,
                last_seen_at TEXT,
                PRIMARY KEY (discord_user_id, global_game_id),
                FOREIGN KEY (global_game_id) REFERENCES global_games (id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_pins_user ON global_game_pins(discord_user_id);
            CREATE INDEX IF NOT EXISTS idx_pins_game ON global_game_pins(global_game_id);
        ` },
        // --- v2.53.0 (ADR 0016): engine + device score provenance ---
        // Additive. `platform` is NOT dropped — every read path still consumes
        // it through P1/P2. Handler (not raw SQL) because the DDL is followed by
        // a value-mapping backfill that must not be silently swallowed: a failed
        // backfill would leave NULLs in columns the write paths guarantee are
        // never NULL. See src/database/migrations/engineDeviceProvenance.ts.
        { name: '125_engine_device_score_provenance', handler: async (db) => {
            const { addEngineDeviceProvenance } = await import('./migrations/engineDeviceProvenance.js');
            await addEngineDeviceProvenance(db);
        } },
        // --- v2.56.0: drop the room-level pick-award gate ---
        // `ENABLE_GAME_PICK_AWARD` ANDed with each tournament's `winner_picks`.
        // It defaulted to absent (→ off) and was never surfaced on the
        // tournament form, so correctly-configured winner-picks tournaments
        // silently auto-picked. Winner-picks is per-tournament only now (see
        // PickAwardGate). Handler rather than raw sql so the row count is
        // logged and the delete is unit-testable on its own.
        { name: '126_drop_enable_game_pick_award', handler: async (db) => {
            const { dropEnableGamePickAward } = await import('./migrations/dropEnableGamePickAward.js');
            await dropEnableGamePickAward(db);
        } },
        // --- v2.58.0 (ADR 0016 P3): engine + device on cached ranking rows ---
        { name: '127_cache_bust_for_engine_device_rankings', sql: `
            -- RankedEntry and GlobalRankedEntry now carry engine + device, and
            -- both leaderboards are served from serialized JSON blobs. Blobs
            -- written before this release have neither key, so every cached row
            -- would render with no provenance tag at all until natural
            -- invalidation happened to fire — which for a quiet game is never.
            -- Same reasoning, and the same two tables, as migrations 086/088.
            DELETE FROM leaderboard_cache;
            DELETE FROM global_leaderboard_cache;
        ` },
        // --- v2.60.0 (ADR 0016 P2 §3d): purge sync-origin + unknown-engine scores ---
        // Must run AFTER §3b (both iScored import paths stamp unknown/unknown
        // unconditionally) and §3c (fanOutFromRoomSubmission rejects
        // source:'sync') are in the codebase, otherwise the rows grow straight
        // back. Handler rather than raw sql: the sql runner swallows failures,
        // and this one must report per-table row counts on a real deploy and
        // halt loudly if any statement fails mid-wipe. Pre-GA data wipe
        // authorised by the product owner 2026-07-31 — see the module doc for
        // the FK/soft-reference audit that licence does NOT cover.
        { name: '128_purge_sync_and_unknown_engine_scores', handler: async (db) => {
            const { purgeSyncAndUnknownScores } = await import('./migrations/purgeSyncAndUnknownScores.js');
            await purgeSyncAndUnknownScores(db);
        } },
        // --- ADR 0016 catalogue phase §3: platforms becomes an ENGINE list ---
        // Availability facts (`vpxs`, `bam`, every `*_vr`, `atgames`) move to
        // `features`, following migration 101's platforms→features precedent.
        // Handler rather than raw sql: the sql runner swallows failures, and
        // this one must log the pre-fold distribution, per-id transform counts
        // and every dropped junk token WITH its row id on a real deploy. Only
        // meaningful alongside the importer changes in the same release —
        // `GlobalGameService.upsert` union-merges platforms, so the migration
        // alone is undone by the next sync (hazard H-F).
        { name: '129_catalogue_platforms_to_engines', handler: async (db) => {
            const { foldCatalogueToEngines } = await import('./migrations/catalogueEngineFold.js');
            await foldCatalogueToEngines(db);
        } },
        // --- igdb-import-hardening: catalogue dedup stops full-scanning ---
        // Step 4 of the dedup hierarchy normalized every row's name in JS on
        // every upsert. Persist the (deterministic) key so it can be indexed.
        // Handler rather than raw sql: the sql runner swallows failures, and a
        // half-applied backfill would leave the fast path blind to real rows.
        { name: '130_global_games_normalized_name', handler: async (db) => {
            const { backfillNormalizedNames } = await import('./migrations/normalizedNameBackfill.js');
            await backfillNormalizedNames(db);
        } },
        // --- igdb-import-hardening: sync_logs gets a lifecycle + checkpoint ---
        // `start` used to write status 'success', so an in-flight or dead run
        // was indistinguishable from a clean one. Adds heartbeat/progress plus
        // the keyset cursor a resumable bulk import needs.
        { name: '131_sync_logs_progress_and_checkpoint', handler: async (db) => {
            const { addSyncLogProgressColumns } = await import('./migrations/syncLogProgress.js');
            await addSyncLogProgressColumns(db);
        } },
        // --- RA on-demand import: the RetroAchievements master list ---
        // A SHADOW INDEX of RA, not a child of global_games: nothing references
        // it, every row is re-derivable from the API, and it is freely
        // re-syncable/truncatable. It exists because RA publishes no search
        // endpoint — the only way to offer "search RetroAchievements" is to
        // hold a local copy of the per-console game lists and search that.
        // Hence also no FK and no cascade: deleting a catalogue game must not
        // remove the RA row it was imported from.
        { name: '132_ra_games_master_list', sql: `
            CREATE TABLE IF NOT EXISTS ra_games (
                ra_game_id INTEGER PRIMARY KEY,
                console_id INTEGER NOT NULL,
                console_name TEXT,
                title TEXT NOT NULL,
                normalized_title TEXT NOT NULL,
                image_icon TEXT,
                num_achievements INTEGER,
                num_leaderboards INTEGER,
                date_modified TEXT,
                synced_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_ra_games_normalized ON ra_games(normalized_title);
            CREATE INDEX IF NOT EXISTS idx_ra_games_console ON ra_games(console_id);
        ` },
        // --- RA on-demand import: catalogue columns (see the handler) ---
        { name: '133_global_games_ra_columns', handler: async (db) => {
            const { addRaCatalogueColumns } = await import('./migrations/raCatalogueColumns.js');
            await addRaCatalogueColumns(db);
        } },
        // --- S23.6: score_reports gets a table discriminator ---
        // `score_reports.score_id` used to be implicitly a `global_scores.id` —
        // every ScoreReportService consumer hard-joined that table. Room-scoped
        // reports point at a `score_history.id` instead, so the row has to say
        // which table it means. ALTER-ADD only (no rebuild): existing rows are
        // all global by construction, which is exactly what the DEFAULT gives
        // them. `game_room_id` stays NULL for global rows.
        { name: '134_score_reports_score_source', sql: `ALTER TABLE score_reports ADD COLUMN score_source TEXT NOT NULL DEFAULT 'global'` },
        { name: '135_score_reports_game_room_id', sql: `ALTER TABLE score_reports ADD COLUMN game_room_id TEXT` },
        // --- S23.7: verified-score loop ---
        // Deliberately on `score_history`, NOT the dead legacy `scores` table
        // (whose `verified` column has zero readers and zero writers). Both
        // NULL = unverified, which is every pre-existing row.
        { name: '136_score_history_verified_by', sql: `ALTER TABLE score_history ADD COLUMN verified_by TEXT` },
        { name: '137_score_history_verified_at', sql: `ALTER TABLE score_history ADD COLUMN verified_at TEXT` },
        { name: '138_retire_require_discord_login', sql: `
            -- v2.80.0 — REQUIRE_DISCORD_LOGIN is retired wholesale: login has
            -- been mandatory for all score submissions unconditionally since
            -- v2.79.0, making the per-room setting moot. Config-row cleanup
            -- only — the orphan-on-flip machinery it used to drive is removed
            -- in code (OrphanService.ts deleted); orphaned score rows and every
            -- 'orphaned_at IS NULL' query filter are untouched (owner decision:
            -- any further data cleanup is a separate, backed-up, eyeballed pass).
            DELETE FROM game_room_settings WHERE key = 'REQUIRE_DISCORD_LOGIN';
        ` },
        { name: '139_game_ratings_room_scope', handler: async (db) => {
            // v2.86.0 — game_ratings had no game_room_id column, so ratings
            // keyed on game_name alone: a "Medieval Madness" rating in Room A
            // averaged into the same aggregate as a same-named game in Room B.
            // Rebuild onto (game_room_id, game_name, user_id).
            //
            // Backfill target: the SAME default room the legacy /api/ratings
            // alias resolves to (server.ts's getDefaultRoomId — the oldest
            // game_rooms row). Every pre-migration rating was written either
            // through that alias or a room UI that, pre-this-feature, behaved
            // identically across rooms, so the oldest room is the correct
            // historical owner. If no room exists yet, there's nothing to
            // backfill onto — the rows are dropped (mirrors migration 095's
            // precedent of accepting historical data loss on a table rebuild
            // when there's no principled owner to assign).
            const defaultRoom = await db.get(`SELECT id FROM game_rooms ORDER BY created_at ASC LIMIT 1`) as { id: string } | undefined;
            await db.exec(`
                CREATE TABLE game_ratings_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    game_room_id TEXT NOT NULL,
                    game_name TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
                    created_at TEXT DEFAULT (datetime('now')),
                    updated_at TEXT DEFAULT (datetime('now')),
                    UNIQUE(game_room_id, game_name, user_id),
                    FOREIGN KEY (game_room_id) REFERENCES game_rooms (id) ON DELETE CASCADE
                );
            `);
            if (defaultRoom?.id) {
                await db.run(
                    `INSERT INTO game_ratings_new (id, game_room_id, game_name, user_id, rating, created_at, updated_at)
                     SELECT id, ?, game_name, user_id, rating, created_at, updated_at FROM game_ratings`,
                    defaultRoom.id
                );
            }
            await db.exec(`
                DROP TABLE game_ratings;
                ALTER TABLE game_ratings_new RENAME TO game_ratings;
            `);
        } },
        // --- Ranking-card backgrounds (owner-designed 2026-08-09) ---
        // Mirrors games.bg_style_id / game_room_game_library.bg_style_id
        // (migrations 023/025): a nullable pointer into style_catalogue,
        // ALTER-ADD only. Same pseudo-FK caveat as those columns and every
        // other ALTER-added column in this file — SQLite can't add an
        // enforced FOREIGN KEY via ALTER TABLE, so referential integrity here
        // is app-level only (StyleCatalogueService.delete() nulls this column
        // out alongside the games/library columns when a style is deleted).
        { name: '140_ranking_groups_bg_style', sql: `ALTER TABLE ranking_groups ADD COLUMN bg_style_id TEXT` },
        // --- Ban → content cascade (ROADMAP "Player Self-Service + Moderation" §C) ---
        // Records every row a ban's content cascade touched, so lifting the
        // ban can restore EXACTLY those rows and no others. `action` is
        // 'hide' (orphaned_at/hidden_at set — restorable on lift) or 'delete'
        // (row hard-deleted — NOT restorable; the row here is kept forever as
        // the audit trail proving the deletion happened). `row_id` is TEXT
        // because `submissions.id` is a string key (`${gameId}-${username}`)
        // while every other cascaded table uses an INTEGER AUTOINCREMENT id —
        // SQLite's column-affinity coercion makes a TEXT-bound parameter
        // compare correctly against an INTEGER-affinity id column, so this is
        // safe to use uniformly across all five tables it can name.
        { name: '141_ban_content_actions', sql: `
            CREATE TABLE IF NOT EXISTS ban_content_actions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ban_id TEXT NOT NULL,
                table_name TEXT NOT NULL,
                row_id TEXT NOT NULL,
                action TEXT NOT NULL CHECK(action IN ('hide', 'delete')),
                created_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (ban_id) REFERENCES user_bans (id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_ban_content_actions_ban ON ban_content_actions(ban_id);
        ` },
        // Comments have no soft-delete/hide concept pre-existing (unlike the
        // score tables, which already carry `orphaned_at` for this exact
        // pattern — see the OrphanService-era column). `hidden_at` mirrors
        // `orphaned_at`'s semantics: NULL = visible, set = hidden from every
        // public read. Read sites: CommentService.getComments,
        // GlobalCommentService.getComments.
        { name: '142_comment_hidden_at', sql: `
            ALTER TABLE game_comments ADD COLUMN hidden_at TEXT;
            ALTER TABLE global_game_comments ADD COLUMN hidden_at TEXT;
            CREATE INDEX IF NOT EXISTS idx_game_comments_hidden ON game_comments(hidden_at);
            CREATE INDEX IF NOT EXISTS idx_global_game_comments_hidden ON global_game_comments(hidden_at);
        ` },
        // --- Next-win disposition (RTX demo feedback, ROADMAP "Next-win
        // disposition + dynasty option + rotation-readiness nudge", locked
        // 2026-08-09) ---
        // `picker_dispositions` is the tri-state preference a player sets for
        // "if I win the current slot, what happens to my pick": a row present
        // means 'nominate' (hand it to `nominee_discord_id`) or 'forfeit'
        // (pass straight to the runner-up); NO row means the default
        // 'use-my-queue' behavior — deliberately not a stored enum value, so
        // clearing a disposition is a plain DELETE. One row per
        // (tournament, player); the winner-designation chokepoint in
        // `TournamentEngine.resolveNextPicker` consumes (reads + deletes) the
        // row atomically so it is a strictly ONE-SHOT preference — the next
        // rotation reverts to the queue unless the player sets it again.
        // `allow_dynasty` (default ON = today's behavior) gates whether the
        // same winner can pick again back-to-back; OFF blocks their 'queue'
        // path only (nominate/forfeit still honored) and falls to the
        // runner-up when no disposition is set. `rotation_nudges` dedupes the
        // "get your pick ready" notification one-per-player-per-rotation —
        // `rotation_key` is the ISO timestamp of the rotation boundary the
        // nudge was sent for, so a fresh boundary (next rotation) naturally
        // allows a fresh nudge without any TTL bookkeeping.
        { name: '143_next_win_disposition', sql: `
            CREATE TABLE IF NOT EXISTS picker_dispositions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tournament_id TEXT NOT NULL,
                discord_user_id TEXT NOT NULL,
                disposition TEXT NOT NULL CHECK(disposition IN ('nominate', 'forfeit')),
                nominee_discord_id TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(tournament_id, discord_user_id),
                FOREIGN KEY (tournament_id) REFERENCES tournaments (id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_picker_dispositions_tournament ON picker_dispositions(tournament_id);

            ALTER TABLE tournaments ADD COLUMN allow_dynasty INTEGER NOT NULL DEFAULT 1;

            CREATE TABLE IF NOT EXISTS rotation_nudges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tournament_id TEXT NOT NULL,
                discord_user_id TEXT NOT NULL,
                rotation_key TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(tournament_id, discord_user_id, rotation_key),
                FOREIGN KEY (tournament_id) REFERENCES tournaments (id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_rotation_nudges_tournament ON rotation_nudges(tournament_id);
        ` },
        // --- style-system revamp P1: legacy rooms adopt the Arcade card ---
        // A room with no SCOREBOARD_STYLE row has been rendering the LEGACY
        // GameCard path (`useNewCards = !!config.SCOREBOARD_STYLE`) — a look
        // nobody picked. P0 seeded a style for new rooms; this converts the
        // ones that predate it. Rooms with any stored style keep it. Handler
        // rather than `sql:` because the loop swallows sql failures and a
        // half-applied conversion would strand an arbitrary subset of rooms on
        // the legacy path silently.
        { name: '144_seed_arcade_style_for_legacy_rooms', handler: async (db) => {
            const { seedArcadeStyleForLegacyRooms } = await import('./migrations/seedArcadeStyle.js');
            await seedArcadeStyleForLegacyRooms(db);
        } },
        { name: '145_clear_mobile_vertical_opt_out', handler: async (db) => {
            const { clearMobileVerticalOptOut } = await import('./migrations/clearMobileVerticalOptOut.js');
            await clearMobileVerticalOptOut(db);
        } },
        // Style-system revamp P2 — Style Profiles. Owner-keyed named snapshots
        // of a room's appearance, so an admin who runs several rooms can dress
        // a new one in two clicks. No FK on `owner_user_id`: an owner is a
        // namespaced identity id (discord/google), the same shape used across
        // the identity layer, and profiles should outlive a room they were
        // captured from.
        { name: '146_style_profiles', sql: `
            CREATE TABLE IF NOT EXISTS style_profiles (
                id TEXT PRIMARY KEY,
                owner_user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                settings TEXT NOT NULL DEFAULT '{}',
                is_default INTEGER NOT NULL DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );
        ` },
        // One profile per (owner, name), case-insensitively — "Neon" and "neon"
        // are the same profile to a human picking from a dropdown.
        { name: '146a_style_profiles_owner_name', sql: `
            CREATE UNIQUE INDEX IF NOT EXISTS idx_style_profiles_owner_name
            ON style_profiles(owner_user_id, LOWER(name));
        ` },
        // At most ONE default per owner, enforced by the database rather than
        // by remembering to clear the old one — StyleProfileService.setDefault
        // clears first inside a transaction, and this index is what makes that
        // discipline non-optional.
        { name: '146b_style_profiles_one_default', sql: `
            CREATE UNIQUE INDEX IF NOT EXISTS idx_style_profiles_owner_default
            ON style_profiles(owner_user_id) WHERE is_default = 1;
        ` },
        // Dedup-grade alternate spellings, kept APART from `aliases`.
        //
        // `aliases` is a search/synonym field of unknown provenance, and a dry
        // run against production proved it cannot be trusted for identity: it
        // holds community acronyms, several of them attached to the WRONG row
        // — "TZ" on "Tropical EM+" (Twilight Zone exists separately), "WCS" on
        // "Wood's Queen 2019" (World Cup Soccer exists separately), "WH2O" on
        // "Whirlwind" (White Water exists separately). Letting dedup read that
        // column would route imports onto unrelated machines.
        //
        // `dedup_aliases` is written ONLY by GlobalGameService.merge, which
        // records the name of a row an admin deliberately merged away. Every
        // entry therefore has a provenance: a human decided these two rows are
        // the same game. Search keeps reading `aliases`; identity reads this.
        { name: '147_global_games_dedup_aliases', sql: `
            ALTER TABLE global_games ADD COLUMN dedup_aliases TEXT;
        ` },
        // --- AtGames API importer: catalogue columns (see the handler) ---
        { name: '148_global_games_atgames_columns', handler: async (db) => {
            const { addAtGamesCatalogueColumns } = await import('./migrations/atgamesCatalogueColumns.js');
            await addAtGamesCatalogueColumns(db);
        } },
        // --- Pick delegation & per-player queues (owner spec 2026-08-17;
        // contract at docs/contracts/pick-delegation-contract.md) ---
        // 149 admits the new 'auto' ("roll the dice") disposition; the value is
        // in a CHECK constraint so it needs a table rebuild (see the handler).
        { name: '149_pick_disposition_auto', handler: async (db) => {
            const { widenPickDispositionCheck } = await import('./migrations/pickDispositionAuto.js');
            await widenPickDispositionCheck(db);
        } },
        // 150 re-bases `queue_order` from a tournament-global sequence to a
        // PER-PLAYER one. A queue is that player's standing pick-if-I-win, not
        // a room-level "what we play next" list, so two players may both hold
        // position 1. Existing relative order within each player's own queue is
        // preserved (order by queue_order, then insertion rowid); '[Pending
        // Pick]' placeholders keep queue_order NULL, which is load-bearing —
        // pickgame.ts relies on NULL sorting them to the front.
        //
        // This also repairs the live damage from the reorder bug: PUT
        // /:roomId/queue/reorder renumbered a player's own games 1..N inside the
        // GLOBAL space, so prod accumulated duplicate positions across players
        // that tie-broke on invisible rowid.
        { name: '150_queue_order_per_player', sql: `
            UPDATE games SET queue_order = (
                SELECT COUNT(*) FROM games g2
                WHERE g2.tournament_id = games.tournament_id
                  AND g2.status = 'QUEUED'
                  AND g2.name != '[Pending Pick]'
                  AND g2.picker_discord_id IS games.picker_discord_id
                  AND (
                        COALESCE(g2.queue_order, 999999) < COALESCE(games.queue_order, 999999)
                     OR (COALESCE(g2.queue_order, 999999) = COALESCE(games.queue_order, 999999)
                         AND g2.rowid <= games.rowid)
                  )
            )
            WHERE status = 'QUEUED' AND name != '[Pending Pick]';
        ` },
        // --- User-chosen avatar provider (owner call 2026-08-17) ---
        // Player report: "my Google picture shows but my CL logo doesn't."
        // `PlayerAvatar` resolves `avatarUrl ?? avatarHash`, so for a user
        // linked to BOTH providers the Google picture won unconditionally and
        // their Discord avatar became unreachable with no way to get it back.
        //
        // The column semantics change here, deliberately, to keep the fix off
        // the ~25 read sites that already SELECT avatar_url:
        //   avatar_hash       - Discord's raw avatar hash        (provider store)
        //   avatar_url_google - Google's raw picture URL          (provider store, NEW)
        //   avatar_url        - the EFFECTIVE url to render; NULL means "fall
        //                       through to avatar_hash". Derived from
        //                       avatar_preference by
        //                       UserProfileService.applyAvatarPreference.
        // Readers are unchanged and cannot get it wrong, because there is
        // nothing left for them to decide.
        //
        // avatar_preference: 'discord' | 'google' | NULL (= auto, today's
        // behavior: Google when present). Backfill copies the existing
        // avatar_url into the Google store, which is what it always held.
        { name: '151_avatar_provider_preference', sql: `
            ALTER TABLE user_profiles ADD COLUMN avatar_url_google TEXT;
            ALTER TABLE user_profiles ADD COLUMN avatar_preference TEXT;
            UPDATE user_profiles SET avatar_url_google = avatar_url WHERE avatar_url IS NOT NULL;
        ` },
        // --- Identity claims: guarded self-claim of an iScored name (2026-08-18) ---
        //
        // Closes a live hole: /map-user requires Administrator only when mapping
        // SOMEONE ELSE, so mapping yourself was unguarded — any guild member
        // could claim any unclaimed iScored username. Claimed names feed
        // resolveSubmissionPlayerId, the leaderboard partition key,
        // IdentityCandidateService, and (since PR #239) the pick cascade.
        //
        // A claim auto-approves only on a CASE-INSENSITIVE EXACT match against a
        // name the claimant already answers to (owner ruling: no separator or
        // space normalization); anything else lands here for a mod. Shaped after
        // join_requests, including the partial unique index that makes a second
        // pending claim for the same (claimant, name) impossible.
        //
        // game_room_id records WHERE the claim was made, for review context and
        // queue scoping. The GRANT is global, because user_mappings is global —
        // no worse than today, where a room admin can already /map-user anyone.
        //
        // email_local_part backs auto-match source 5 (a linked Google account's
        // username). Google's email is fetched at login but was never stored;
        // only the part before '@' is kept, never the domain, and it is compared
        // only — never rendered.
        { name: '152_identity_claims', sql: `
            CREATE TABLE IF NOT EXISTS identity_claims (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                -- Nullable: a claim is fundamentally GLOBAL (user_mappings has no room
                -- scope); the room is review-routing context. An auto-approved
                -- claim filed from Account Settings may have no room at all. A
                -- PENDING one must have one, or it would sit in no queue and be
                -- invisible forever — hence the CHECK below.
                game_room_id TEXT REFERENCES game_rooms(id) ON DELETE CASCADE,
                claimant_user_id TEXT NOT NULL,
                iscored_username TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
                auto_matched_on TEXT,
                requested_at TEXT NOT NULL DEFAULT (datetime('now')),
                resolved_at TEXT,
                resolved_by TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_claims_pending
                ON identity_claims(claimant_user_id, LOWER(iscored_username)) WHERE status='pending';
            CREATE INDEX IF NOT EXISTS idx_identity_claims_room_status
                ON identity_claims(game_room_id, status);

            ALTER TABLE user_profiles ADD COLUMN email_local_part TEXT;
        ` },
        // 153 — the guard migration 152 was meant to carry. A PENDING claim with
        // no room would sit in no queue and be invisible forever;
        // IdentityClaimService already refuses to create one, and this makes it
        // impossible at the storage layer too.
        //
        // Shipped separately because 152 was already applied in prod and a
        // migration's SQL cannot be edited into existence retroactively. A
        // create-copy-drop-rename rather than a DROP, so any claim filed between
        // the two deploys survives (prod had 0 at the time of writing).
        { name: '153_identity_claims_pending_room_guard', handler: async (db) => {
            const t = await db.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='identity_claims'`);
            if (!t?.sql) return;                                        // table not created yet
            if (t.sql.includes("status != 'pending'")) return;          // already guarded

            await db.exec(`
                CREATE TABLE identity_claims_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    game_room_id TEXT REFERENCES game_rooms(id) ON DELETE CASCADE,
                    claimant_user_id TEXT NOT NULL,
                    iscored_username TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
                    auto_matched_on TEXT,
                    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
                    resolved_at TEXT,
                    resolved_by TEXT,
                    CHECK (status != 'pending' OR game_room_id IS NOT NULL)
                );

                INSERT INTO identity_claims_new
                    (id, game_room_id, claimant_user_id, iscored_username, status, auto_matched_on, requested_at, resolved_at, resolved_by)
                SELECT id, game_room_id, claimant_user_id, iscored_username, status, auto_matched_on, requested_at, resolved_at, resolved_by
                FROM identity_claims;

                DROP TABLE identity_claims;
                ALTER TABLE identity_claims_new RENAME TO identity_claims;

                CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_claims_pending
                    ON identity_claims(claimant_user_id, LOWER(iscored_username)) WHERE status='pending';
                CREATE INDEX IF NOT EXISTS idx_identity_claims_room_status
                    ON identity_claims(game_room_id, status);
            `);
        } },
        // 154 — per-game background framing (zoom + drag position) for the
        // card background art. NULL means "not framed" and renders at the
        // 100 / 50 / 50 default, so every existing row keeps its current look.
        //
        // Both overlay tables carry the same three columns: `games` is what the
        // scoreboard reads, `game_room_game_library` is the room's saved default
        // that gets copied onto each new games row at activation/pin time.
        //
        // A handler rather than plain SQL because six ALTERs in one `db.exec`
        // abort at the first "duplicate column name" and silently skip the rest
        // (the plain-SQL branch swallows that error by design).
        { name: '154_card_bg_transform', handler: async (db) => {
            for (const table of ['games', 'game_room_game_library']) {
                const existing = await db.all(`PRAGMA table_info(${table})`) as Array<{ name: string }>;
                const have = new Set(existing.map(c => c.name));
                for (const col of ['bg_zoom', 'bg_pos_x', 'bg_pos_y']) {
                    if (have.has(col)) continue;
                    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} REAL`);
                }
            }
        } },
        // --- Callouts moved out of data/callouts.json and into the DB (v2.123.0) ---
        //
        // The Easter-egg bot replies used to live in a git-tracked JSON file that
        // the MessageCreate handler re-read and re-parsed on EVERY message, gated
        // by a single global ENABLE_CALLOUTS env switch. Owner ask: upload the list
        // from the super-admin UI instead of pushing a change, and let each room
        // decide whether the bot talks in ITS Discord server (per-room
        // CALLOUTS_ENABLED, absent = off — see src/discord/callouts.ts).
        //
        // triggers/responses are JSON arrays (SQLite has no array type and the
        // list is read whole into an in-memory cache, so there is nothing to index
        // or join on). sort_order carries MATCH order, which is significant:
        // first matching entry wins. A one-time boot seed imports the legacy file
        // when this table is empty (CalloutService.seedFromFileIfEmpty).
        //
        // `action` names a built-in live-data responder ('active_games',
        // 'picks_link', 'scores_link', 'how_to_submit') for questions a fixed
        // string can't answer ("what's the table today?"). NULL for ordinary
        // entries; when set it wins over responses, which may then be empty.
        { name: '155_callouts', sql: `
            CREATE TABLE IF NOT EXISTS callouts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                triggers TEXT NOT NULL,
                responses TEXT NOT NULL,
                action TEXT,
                enabled INTEGER NOT NULL DEFAULT 1,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_callouts_order ON callouts(sort_order, id);
        ` },
        // --- Arcaid Chat Responses: per-entry category (v2.125.0) ---
        //
        // Rooms now enable the KINDS of reply they want individually, so every
        // entry has to declare which kind it is. Four values: 'help' (live
        // answers + how-tos), 'callouts' (the classic game callouts), 'banter'
        // (replies about the bot), 'easter_eggs' (the obscure in-jokes).
        //
        // The default is 'callouts' at the column level so a row inserted by
        // anything that predates this migration is still filterable, but the
        // BACKFILL below is the real classifier and its rule is shared with
        // `deriveCalloutCategory` in src/utils/callouts.ts — an admin who
        // re-uploads the legacy JSON (which carries no `category`) gets each
        // entry back in the same bucket this migration put it in, instead of a
        // silent collapse to the default. Change one, change the other.
        //
        // Order matters and is the owner's: an action entry is `help` whatever
        // fires it; then bot-directed banter; then the three named Easter eggs;
        // everything else is an ordinary game callout.
        { name: '156_callout_category', handler: async (db) => {
            const columns = (await db.all(`PRAGMA table_info(callouts)`)) as Array<{ name: string }>;
            if (!columns.some(c => c.name === 'category')) {
                await db.exec(
                    `ALTER TABLE callouts ADD COLUMN category TEXT NOT NULL DEFAULT 'callouts'`,
                );
            }
            // Backfill runs unconditionally over rows still sitting on the
            // column default, so a half-applied migration completes on the next
            // boot rather than leaving everything filed as 'callouts'.
            await db.run(
                `UPDATE callouts SET category = 'help'
                 WHERE action IS NOT NULL AND category = 'callouts'`,
            );
            await db.run(
                `UPDATE callouts SET category = 'banter'
                 WHERE action IS NULL AND category = 'callouts'
                   AND (LOWER(triggers) LIKE '%bot%' OR LOWER(triggers) LIKE '%arcaid%')`,
            );
            await db.run(
                `UPDATE callouts SET category = 'easter_eggs'
                 WHERE action IS NULL AND category = 'callouts'
                   AND (LOWER(triggers) LIKE '%seafood%'
                     OR LOWER(triggers) LIKE '%dork cow%'
                     OR LOWER(triggers) LIKE '%secret cow%')`,
            );
        } },
        // v2.125.2: the sync poller passed its synthetic `iscored:<name>` id into
        // ScoreHistoryService.log, so unowned sync rows carried it in
        // submitted_by_user_id (the poller's own `submissions` write already
        // stripped it to NULL). Every profile resolver keys user_profiles on that
        // column first, so a player who linked AFTER syncing never got their
        // avatar/name. NULL = "nobody owns this row" is the poller's convention.
        // Caches are cleared at boot, so no cache purge is needed here.
        { name: '157_null_synthetic_submitter_ids', sql: `
            UPDATE score_history SET submitted_by_user_id = NULL WHERE submitted_by_user_id LIKE 'iscored:%';
            UPDATE submissions SET submitted_by_user_id = NULL WHERE submitted_by_user_id LIKE 'iscored:%';
            UPDATE community_scores SET submitted_by_user_id = NULL WHERE submitted_by_user_id LIKE 'iscored:%';
        ` },
        // v2.126.0 — pick-queue hold model + the queue-low nudge.
        //
        // `games.queue_held_at` replaces the old delete-on-ineligible rule: a
        // queued pick that hits its cooldown when the engine reaches it is
        // STAMPED rather than removed, and the stamp both (a) marks it as
        // waiting and (b) sorts it ahead of the player's unheld picks so it
        // activates the moment the cooldown clears (owner spec 2026-08-21).
        // NULL = not held, which is every pre-existing row — no backfill.
        //
        // `queue_low_nudges` is the dedupe ledger for the `queueLow`
        // notification, same shape of idea as `rotation_nudges`: no FK (it is
        // an audit trail that outlives its tournament, like `maintenance_runs`)
        // and one row per (user, tournament) carrying the last count we told
        // them about, so a queue that keeps shrinking keeps nudging while a
        // flat one goes quiet for a week.
        { name: '158_queue_hold_and_low_nudges', handler: async (db) => {
            const columns = (await db.all(`PRAGMA table_info(games)`)) as Array<{ name: string }>;
            if (!columns.some(c => c.name === 'queue_held_at')) {
                await db.exec(`ALTER TABLE games ADD COLUMN queue_held_at TEXT`);
            }
            await db.exec(`
                CREATE TABLE IF NOT EXISTS queue_low_nudges (
                    user_id TEXT NOT NULL,
                    tournament_id TEXT NOT NULL,
                    last_count INTEGER NOT NULL,
                    sent_at TEXT NOT NULL,
                    PRIMARY KEY (user_id, tournament_id)
                )
            `);
        } },
        // v2.127.0 — identity tidy-up. Folds the synthetic `iscored:*` rows out
        // of room_members (onto the real account where the alias is linked,
        // deleted where it is not) and finishes what 157 started by giving the
        // NULLed sync rows their owner back. Ongoing prevention lives in
        // IdentityAliasEffectsService; this is the one-shot for the backlog.
        // See src/database/migrations/foldSyntheticRoomMembers.ts.
        { name: '159_fold_synthetic_room_members', handler: async (db) => {
            const { foldSyntheticRoomMembers } = await import('./migrations/foldSyntheticRoomMembers.js');
            await foldSyntheticRoomMembers(db);
        } },
        // v2.127.1 — the AUTOMATIC avatar provider is now Discord-first.
        //
        // Migration 151 shipped "Google when present" as the auto rule. Prod
        // evidence 2026-08-22: Google never returns a NULL picture URL — a
        // photo-less Google account gets a generated letter tile — so the rule
        // was really "Google always", and a user with a real Discord avatar saw
        // the letter tile (ChalataLove on rtx_pinball). See
        // resolveEffectiveAvatarProvider.
        //
        // Re-derive the EFFECTIVE column for the rows the new rule changes:
        // no explicit preference + a real Discord hash. NULL avatar_url is how
        // readers fall through to avatar_hash (applyAvatarPreference does the
        // same thing on every write). Rows with an explicit preference are
        // deliberately untouched — the user already decided.
        // See src/database/migrations/avatarAutoPrefersDiscord.ts.
        { name: '160_avatar_auto_prefers_discord', handler: async (db) => {
            const { avatarAutoPrefersDiscord } = await import('./migrations/avatarAutoPrefersDiscord.js');
            await avatarAutoPrefersDiscord(db);
        } },
        // v2.130.0 — viewer-level Dark/Light/Auto appearance preference. NULL
        // (the default for every existing row) means 'auto', i.e. exactly
        // today's behaviour: room pages show the room's theme, global pages
        // follow the OS, admin pages the admin's own ui_theme. Deliberately a
        // dedicated nullable column next to ui_theme rather than a key inside
        // the notification_prefs/scoreboard_prefs JSON blobs — it is read on
        // every page load and hydrated before anything else.
        { name: '161_user_preferences_appearance', sql: `
            ALTER TABLE user_preferences ADD COLUMN appearance TEXT
        ` },
        // v2.133.0 — the theme overhaul. Eleven themes were removed and every
        // one of their theme classes deleted from index.css, so a stored id
        // naming one is a class that no longer exists: the page silently
        // paints the default dark and the choice is lost with no error. This
        // folds every stored id forward through the SAME `LEGACY_THEME_MAP`
        // the runtime shim uses (src/utils/themeIds.ts, mirrored on the FE),
        // across room defaults, personal themes and the roomThemes map inside
        // scoreboard_prefs. Idempotent.
        { name: '162_theme_overhaul', handler: async (db) => {
            const { themeOverhaul } = await import('./migrations/themeOverhaul.js');
            await themeOverhaul(db);
        } },
        // v2.135.0 — Live Event tournament format (ADR 0017). Time-boxed,
        // check-in-gated, multi-round tournaments living alongside the perpetual
        // cron-rotated ones. Rounds are `games` rows with the new SCHEDULED
        // status; `tournament_participants` is the check-in roster. See
        // src/database/migrations/liveEventFormat.ts for the full rationale.
        { name: '163_live_event_format', handler: async (db) => {
            const { liveEventFormat } = await import('./migrations/liveEventFormat.js');
            await liveEventFormat(db);
        } },
        // v2.136.0 (ADR 0018) — Throwdowns are room-less, and this one column
        // is the entire cost. A create-copy-drop-rename on the hottest table in
        // the app: a HANDLER on purpose, so a failure halts startup instead of
        // being swallowed by the `sql:` try/catch. See the migration file.
        { name: '164_score_history_room_nullable', handler: async (db) => {
            const { scoreHistoryRoomNullable } = await import('./migrations/scoreHistoryRoomNullable.js');
            await scoreHistoryRoomNullable(db);
        } },
        // v2.136.0 (ADR 0018) — Throwdown columns. A Throwdown IS a
        // `format='event'` tournament with `game_room_id IS NULL`, so it needs
        // no table of its own; these three columns are the whole difference.
        // v2.137.0 — per-player Global Scoreboard opt-out. NULL = the default
        // (fan out), which is today's behaviour for every existing user; only
        // an explicit 0 suppresses. Resolved SERVER-side at submit time,
        // because Discord /submit-score has no checkbox to carry the choice.
        { name: '166_user_preferences_global_scoreboard', sql: `
            ALTER TABLE user_preferences ADD COLUMN share_to_global INTEGER
        ` },
        { name: '165_throwdown_columns', handler: async (db) => {
            const existing = (await db.all(`PRAGMA table_info(tournaments)`)) as Array<{ name: string }>;
            const have = new Set(existing.map(c => c.name));
            // Short URL-safe code — the whole address of a Throwdown
            // (`/throwdown/:code`). Never reuses a room slug namespace.
            if (!have.has('throwdown_code')) {
                await db.exec(`ALTER TABLE tournaments ADD COLUMN throwdown_code TEXT`);
            }
            // First-click-wins rematch: the UNIQUE index below is what makes a
            // second clicker collide instead of creating a duplicate rematch.
            if (!have.has('rematch_of_tournament_id')) {
                await db.exec(`ALTER TABLE tournaments ADD COLUMN rematch_of_tournament_id TEXT`);
            }
            // Who made it — a room-less tournament has no room admin to infer
            // an owner from, and the creator's profile lists their Throwdowns.
            if (!have.has('created_by_user_id')) {
                await db.exec(`ALTER TABLE tournaments ADD COLUMN created_by_user_id TEXT`);
            }
            await db.exec(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_tournaments_throwdown_code
                    ON tournaments(throwdown_code) WHERE throwdown_code IS NOT NULL
            `);
            await db.exec(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_tournaments_rematch_of
                    ON tournaments(rematch_of_tournament_id) WHERE rematch_of_tournament_id IS NOT NULL
            `);
            await db.exec(`
                CREATE INDEX IF NOT EXISTS idx_tournaments_created_by
                    ON tournaments(created_by_user_id) WHERE created_by_user_id IS NOT NULL
            `);
        } },
        // P7 — AtGames event score sync. A fourth `score_history.source`, which
        // on the biggest table in the DB means a create-copy-drop-rename. A
        // HANDLER on purpose (a swallowed failure here would lose scores); see
        // the migration file for why none of the three existing sources fit.
        { name: '167_score_history_source_atgames', handler: async (db) => {
            const { scoreHistorySourceAtgames } = await import('./migrations/scoreHistorySourceAtgames.js');
            await scoreHistorySourceAtgames(db);
        } },
        // P7 — which AtGames private tournament (if any) an Arcaid tournament
        // draws its scores from. Two columns rather than a table: the link is
        // 1:1 with the tournament and carries no history of its own. The
        // invitation code is stored so the host can show players how to join
        // from their cabinet without a second round trip to AtGames.
        { name: '168_tournaments_atgames_link', handler: async (db) => {
            const existing = (await db.all(`PRAGMA table_info(tournaments)`)) as Array<{ name: string }>;
            const have = new Set(existing.map(c => c.name));
            if (!have.has('atgames_tournament_id')) {
                await db.exec(`ALTER TABLE tournaments ADD COLUMN atgames_tournament_id TEXT`);
            }
            if (!have.has('atgames_invite_code')) {
                await db.exec(`ALTER TABLE tournaments ADD COLUMN atgames_invite_code TEXT`);
            }
            // Partial index: the poller's question is "which tournaments are
            // AtGames-linked", and all but a handful of rows are NULL.
            await db.exec(`
                CREATE INDEX IF NOT EXISTS idx_tournaments_atgames
                    ON tournaments(atgames_tournament_id) WHERE atgames_tournament_id IS NOT NULL
            `);
        } },
        // P8 — Arcaid Witness ingest (device pairing + launch observations).
        // The on-device app reports table launch/exit times over a SYNCHRONOUS
        // GET (the SDK offers no POST), so the auth model is a device-scoped
        // token, minted when the player redeems a short-lived pairing code.
        // The verify-join (matching observations to AtGames scores) is a LATER
        // phase — these tables just capture what the device reports.
        { name: '169_witness_ingest', sql: `
            -- One row per paired cabinet. Keyed on ATGAMES_UNIQUE_ID (stable,
            -- hardware-derived, per-DEVICE not per-account), bound to the
            -- Arcaid canonical user who paired it. token_hash is a SHA-256 of
            -- the device token — the plaintext token lives only on the device,
            -- and it rides in a GET query string, so we never store it raw.
            CREATE TABLE IF NOT EXISTS witness_devices (
                atgames_unique_id TEXT PRIMARY KEY,
                canonical_user_id TEXT NOT NULL,
                atgames_username TEXT,
                token_hash TEXT NOT NULL,
                paired_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_seen_at TEXT,
                revoked_at TEXT,
                -- Score routing (P9b, migration 173). A NULL room means
                -- UNDESIGNATED, which sends unrouted scores to the Global
                -- Scoreboard instead of dropping them.
                target_room_id TEXT,
                target_tournament_id TEXT,
                global_fallback INTEGER NOT NULL DEFAULT 1
            );
            CREATE INDEX IF NOT EXISTS idx_witness_devices_user ON witness_devices(canonical_user_id);

            -- Short-lived, single-use pairing codes. A logged-in player mints
            -- one, types it into the Witness app on the cabinet; the app
            -- redeems it (GET) to bind its device id and receive its token.
            CREATE TABLE IF NOT EXISTS witness_pairing_codes (
                code TEXT PRIMARY KEY,
                canonical_user_id TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                expires_at TEXT NOT NULL,
                consumed_at TEXT,
                consumed_device_id TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_witness_codes_user ON witness_pairing_codes(canonical_user_id);

            -- One row per witnessed table session. launch/exit are epoch
            -- SECONDS as the device read them from /userdata/error_log; the
            -- (device, table, launch) UNIQUE index makes re-reports idempotent
            -- (the app may retry a GET that already landed). Inert until the
            -- verify-join phase reads them.
            CREATE TABLE IF NOT EXISTS witness_observations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                atgames_unique_id TEXT NOT NULL,
                canonical_user_id TEXT NOT NULL,
                table_name TEXT NOT NULL,
                launch_ts INTEGER NOT NULL,
                exit_ts INTEGER,
                duration_sec INTEGER,
                reported_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_witness_obs_unique
                ON witness_observations(atgames_unique_id, table_name, launch_ts);
            CREATE INDEX IF NOT EXISTS idx_witness_obs_user ON witness_observations(canonical_user_id, launch_ts);
        ` },
        // Rotation audit trail (owner-asked 2026-08-27, after the WG-VR /
        // WG-VPXS over-activation incident). One append-only row per rotation
        // DECISION — who or what picked what, and what triggered it — written
        // at the moment the decision happens, so the question is answerable
        // from the room admin UI instead of by grepping prod logs.
        //
        // NO FOREIGN KEYS, deliberately: an audit log has to outlive the
        // tournament and the games row it describes, exactly like
        // `maintenance_runs` (migration 106). `tournament_name` / `game_name`
        // are denormalized for the same reason — a deleted tournament must
        // still read as a name, not a dangling id.
        //
        // `details` is a per-type JSON blob (winner + score, disposition +
        // nominee, deadline, cleanup mode…). `source` / `queue_owner` are the
        // two columns the incident actually needed: WHICH cascade branch
        // activated the game, and WHOSE queue it consumed.
        { name: '170_rotation_events', sql: `
            CREATE TABLE IF NOT EXISTS rotation_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                game_room_id TEXT NOT NULL,
                tournament_id TEXT,
                tournament_name TEXT,
                event_type TEXT NOT NULL,
                actor TEXT NOT NULL,
                source TEXT,
                queue_owner TEXT,
                game_id TEXT,
                game_name TEXT,
                details TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_rotation_events_room
                ON rotation_events(game_room_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_rotation_events_tournament
                ON rotation_events(tournament_id, created_at DESC);
        ` },
        // P8 round 5 — Arcaid Witness three-tier verification (ADR 0021).
        //
        // `witness_checkins` is the tier-2 attestation: the player opened the
        // Witness on the cabinet at (or after) a round start. These cabinets run
        // ONE thing at a time, so an app in the foreground proves no table was
        // mid-session at that instant — which is why the row needs no payload
        // beyond WHO, WHICH CABINET and WHEN.
        //
        // `server_ts` is the SERVER's clock and the device may not supply it.
        // The whole value of a check-in is that its timestamp is not the
        // device's to choose; accepting a client time would make tier 2 a
        // self-attestation worth nothing.
        //
        // NO FOREIGN KEYS, deliberately — same audit-log doctrine as
        // `witness_observations` and `maintenance_runs`: these rows outlive the
        // device row and the account that paired it.
        //
        // `witness_observations.via` distinguishes an observation the beacon saw
        // LIVE from one derived retroactively from on-disk traces. Owner ruling
        // (2026-08-29): same trust, tagged — the tag preserves the distinction
        // for later without letting it change a verdict today.
        { name: '171_witness_checkins', handler: async (db) => {
            await db.exec(`
                CREATE TABLE IF NOT EXISTS witness_checkins (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    atgames_unique_id TEXT NOT NULL,
                    canonical_user_id TEXT NOT NULL,
                    server_ts DATETIME DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX IF NOT EXISTS idx_witness_checkins_user
                    ON witness_checkins(canonical_user_id, server_ts);
                CREATE INDEX IF NOT EXISTS idx_witness_checkins_device
                    ON witness_checkins(atgames_unique_id, server_ts);
            `);
            const cols = (await db.all(`PRAGMA table_info(witness_observations)`)) as Array<{ name: string }>;
            if (!cols.some(c => c.name === 'via')) {
                await db.exec(`ALTER TABLE witness_observations ADD COLUMN via TEXT NOT NULL DEFAULT 'live'`);
            }
        } },
        { name: '172_score_history_source_vpx', handler: async (db) => {
            const { scoreHistorySourceVpx } = await import('./migrations/scoreHistorySourceVpx.js');
            await scoreHistorySourceVpx(db);
        } },
        // Witness score routing (P9b): where a paired cabinet's scores go.
        //
        // `target_room_id` / `target_tournament_id` are the player's own
        // designation, made in Account Settings. `global_fallback` decides what
        // happens to everything the designation does not cover — on by default,
        // because the point of the fallback is that a player can fire up any
        // table and have it count for their personal record without configuring
        // anything at all.
        // The badge (v2.155.0): which scores reached the Global Scoreboard
        // without a human typing them. `score_history` has carried `source`
        // since P7/P9; `global_scores` never did, so a witnessed score was
        // indistinguishable there from one somebody entered by hand — and the
        // Global Scoreboard is exactly where a stranger has no other way to
        // tell. Plain ALTER: nullable, so every pre-existing row reads as
        // "unknown provenance of report", which is the truth about them.
        { name: '174_global_scores_source', handler: async (db) => {
            const cols = (await db.all(`PRAGMA table_info(global_scores)`)) as Array<{ name: string }>;
            if (!cols.some(c => c.name === 'source')) {
                await db.exec(`ALTER TABLE global_scores ADD COLUMN source TEXT`);
            }
        } },
        { name: '173_witness_device_targets', handler: async (db) => {
            const cols = (await db.all(`PRAGMA table_info(witness_devices)`)) as Array<{ name: string }>;
            const has = (name: string) => cols.some(c => c.name === name);
            if (!has('target_room_id')) {
                await db.exec(`ALTER TABLE witness_devices ADD COLUMN target_room_id TEXT`);
            }
            if (!has('target_tournament_id')) {
                await db.exec(`ALTER TABLE witness_devices ADD COLUMN target_tournament_id TEXT`);
            }
            if (!has('global_fallback')) {
                await db.exec(`ALTER TABLE witness_devices ADD COLUMN global_fallback INTEGER NOT NULL DEFAULT 1`);
            }
        } },
        // v2.155.1 — one-shot data repair for the ambiguous-active-games bug:
        // a room with two ACTIVE games sharing a name in two tournaments could
        // land a `submissions` row on one tournament while `score_history`
        // was stamped with the OTHER. See repairAmbiguousSubmissionGames.ts
        // for the full match/move logic; idempotent.
        { name: '175_repair_ambiguous_submission_games', handler: async (db) => {
            const { repairAmbiguousSubmissionGames } = await import('./migrations/repairAmbiguousSubmissionGames.js');
            await repairAmbiguousSubmissionGames(db);
        } },
        // v2.155.3 — one-shot backfill for scores a pre-fix dedup swallowed:
        // the SAME score submitted to a SECOND tournament running the same
        // table never got its own score_history row (isDuplicate ignored the
        // tournament stamp), even though its `submissions` row landed
        // correctly. See backfillHistoryForDedupVictims.ts; idempotent.
        { name: '176_backfill_history_for_dedup_victims', handler: async (db) => {
            const { backfillHistoryForDedupVictims } = await import('./migrations/backfillHistoryForDedupVictims.js');
            await backfillHistoryForDedupVictims(db);
        } },
    ];

    for (const migration of migrations) {
        const applied = await db.get('SELECT id FROM schema_migrations WHERE name = ?', migration.name);
        if (applied) continue;
        if ('handler' in migration) {
            // Handler migrations MUST succeed — a failed backfill cannot be
            // silently skipped. Let the error propagate to halt startup.
            await migration.handler(db);
        } else {
            try {
                await db.exec(migration.sql);
            } catch {
                // Column/table may already exist from before versioned migrations — safe to skip
            }
        }
        await db.run('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)', migration.name);
    }

    // --- Backfill queue_order for existing QUEUED games (idempotent) ---
    // Scoped PER PLAYER to match the queue model (migration 150): each player's
    // queue is their own 1..N sequence, so the count only ranges over rows with
    // the same picker. '[Pending Pick]' placeholders are excluded on BOTH sides
    // — they intentionally carry queue_order NULL so they sort to the front
    // (pickgame.ts), and stamping them here would silently demote them.
    try {
        await db.exec(`
            UPDATE games SET queue_order = (
                SELECT COUNT(*) FROM games g2
                WHERE g2.tournament_id = games.tournament_id
                  AND g2.status = 'QUEUED'
                  AND g2.name != '[Pending Pick]'
                  AND g2.picker_discord_id IS games.picker_discord_id
                  AND g2.rowid <= games.rowid
            ) WHERE status = 'QUEUED' AND name != '[Pending Pick]' AND queue_order IS NULL
        `);
    } catch { /* safe to skip if column doesn't exist yet */ }

    // --- Multi-room data migration (idempotent) ---
    await migrateToMultiRoom(db);

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
        // SYNC_ALERT_CHANNEL_ID intentionally unseeded — super-admin catalogue
        // sync alerts stay silent until an admin configures a channel they
        // actually own. The prior default was a dev-test channel ID that shipped
        // into prod seed and caused "Unknown Channel" errors on every sync.
    ];
    for (const [key, value] of defaultSettings) {
        await db.run(
            'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)',
            key, value
        );
    }

    // S3 (Phase 0): enable referential-integrity enforcement now that all
    // migrations (incl. 104 orphan cleanup + game_room_game_library rebuild),
    // the queue_order backfill, and migrateToMultiRoom have run. Deliberately
    // NOT at connection-open: migrations 066/077/095 are FK-checked table
    // rebuilds (SQLite requires foreign_keys OFF for create-copy-drop-rename),
    // and a swallowed 077 INSERT failure under enforcement would half-migrate a
    // legacy DB. New cross-table deletes must rely on a declared ON DELETE
    // CASCADE or unlink/clean NO-ACTION children first.
    await db.exec('PRAGMA foreign_keys = ON');
    const fkViolations = await db.all('PRAGMA foreign_key_check');
    if (fkViolations.length > 0) {
        // eslint-disable-next-line no-console
        console.error(
            `[fk] PRAGMA foreign_key_check found ${fkViolations.length} residual violation(s) after enabling enforcement:`,
            JSON.stringify(fkViolations.slice(0, 50)),
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
    // Must check the in-flight init FIRST: `db` is set mid-init (see the
    // guard's comment above), so a bare null-check would return a handle the
    // migration sequence is still mutating.
    if (initInFlight) return initInFlight;
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
