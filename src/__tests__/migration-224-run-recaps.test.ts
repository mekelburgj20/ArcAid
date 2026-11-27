import { describe, it, expect } from 'vitest';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { runRecaps } from '../database/migrations/runRecaps.js';

/** Migration 224 (B31.1): two recap preference columns and the B31.5 ledger. */
describe('migration 224 - run recaps', () => {
    async function db() {
        const d = await open({ filename: ':memory:', driver: sqlite3.Database });
        await d.exec(`CREATE TABLE user_preferences (discord_user_id TEXT PRIMARY KEY, ui_theme TEXT)`);
        await d.run(`INSERT INTO user_preferences (discord_user_id, ui_theme) VALUES ('u1', 'dark')`);
        return d;
    }

    it('adds the columns and the table, keeping existing rows with NULL prefs', async () => {
        const d = await db();
        await runRecaps(d);
        const cols = (await d.all(`PRAGMA table_info(user_preferences)`)).map((c: { name: string }) => c.name);
        expect(cols).toContain('recap_play_stats');
        expect(cols).toContain('recap_time_of_day');
        const row = await d.get(`SELECT * FROM user_preferences WHERE discord_user_id = 'u1'`);
        expect(row.recap_play_stats).toBeNull();
        expect(row.recap_time_of_day).toBeNull();
        const posts = (await d.all(`PRAGMA table_info(run_recap_posts)`)).map((c: { name: string }) => c.name);
        expect(posts).toEqual(['game_id', 'game_room_id', 'status', 'channel_id', 'message_ids', 'reason', 'claimed_at', 'finished_at']);
    });

    it('is idempotent', async () => {
        const d = await db();
        await runRecaps(d);
        await runRecaps(d);
        const cols = (await d.all(`PRAGMA table_info(user_preferences)`)).map((c: { name: string }) => c.name);
        expect(cols.filter(c => c === 'recap_play_stats')).toHaveLength(1);
    });
});
