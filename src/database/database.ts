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
