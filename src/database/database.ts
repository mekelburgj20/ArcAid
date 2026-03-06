import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import fs from 'fs';

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
            is_active INTEGER DEFAULT 1
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
            tournament_id TEXT NOT NULL,
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

    return db;
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
