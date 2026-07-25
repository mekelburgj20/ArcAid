import { describe, it, expect, beforeEach } from 'vitest';
import { IdentityLinkService } from '../services/IdentityLinkService.js';
import { getDatabase } from '../database/database.js';
import { setupTestDb, createTestRoom } from './helpers.js';

/**
 * Coverage for the v2.36.0 Google<->Discord identity-link contract:
 *   • resolveCanonical hit/miss
 *   • createLink rewrite correctness per table (submissions, score_history,
 *     community_scores, global_scores, sessions, push_subscriptions)
 *   • createLink conflict handling (room_members / user_preferences /
 *     game_room_admins / user_profiles — "keep the snowflake's row" rule)
 *   • deleteLink (unlink = row delete only)
 */

const GOOGLE_ID = 'google:sub-1234';
const DISCORD_ID = '111122223333444455';

describe('IdentityLinkService.resolveCanonical', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('returns the input unchanged when no link exists (miss)', async () => {
        const resolved = await IdentityLinkService.resolveCanonical(GOOGLE_ID);
        expect(resolved).toBe(GOOGLE_ID);
    });

    it('returns the canonical id when a link exists (hit)', async () => {
        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);
        const resolved = await IdentityLinkService.resolveCanonical(GOOGLE_ID);
        expect(resolved).toBe(DISCORD_ID);
    });

    it('is a no-op for a bare Discord snowflake (never a provider_user_id key in v1)', async () => {
        const resolved = await IdentityLinkService.resolveCanonical(DISCORD_ID);
        expect(resolved).toBe(DISCORD_ID);
    });
});

describe('IdentityLinkService.createLink — score-attribution rewrite', () => {
    let roomId: string;

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
    });

    it('rewrites submissions.discord_user_id and submitted_by_user_id', async () => {
        const db = await getDatabase();
        const { createTestTournament, createTestGame } = await import('./helpers.js');
        const tournamentId = await createTestTournament(roomId);
        const gameId = await createTestGame(tournamentId);
        await db.run(
            `INSERT INTO submissions (id, game_id, discord_user_id, iscored_username, score, timestamp, submitted_by_user_id)
             VALUES ('sub-1', ?, ?, 'ghandle', 1000, datetime('now'), ?)`,
            gameId, GOOGLE_ID, GOOGLE_ID,
        );

        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);

        const row = await db.get('SELECT discord_user_id, submitted_by_user_id FROM submissions WHERE id = ?', 'sub-1');
        expect(row.discord_user_id).toBe(DISCORD_ID);
        expect(row.submitted_by_user_id).toBe(DISCORD_ID);
    });

    it('rewrites score_history.discord_user_id and submitted_by_user_id', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO score_history (game_name, game_room_id, iscored_username, discord_user_id, score, submitted_by_user_id)
             VALUES ('Game', ?, 'ghandle', ?, 500, ?)`,
            roomId, GOOGLE_ID, GOOGLE_ID,
        );

        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);

        const row = await db.get(
            `SELECT discord_user_id, submitted_by_user_id FROM score_history WHERE game_room_id = ? AND iscored_username = 'ghandle'`,
            roomId,
        );
        expect(row.discord_user_id).toBe(DISCORD_ID);
        expect(row.submitted_by_user_id).toBe(DISCORD_ID);
    });

    it('rewrites community_scores.discord_user_id and submitted_by_user_id', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO community_scores (game_name, game_room_id, iscored_username, discord_user_id, score, submitted_by_user_id)
             VALUES ('Game', ?, 'ghandle', ?, 500, ?)`,
            roomId, GOOGLE_ID, GOOGLE_ID,
        );

        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);

        const row = await db.get(
            `SELECT discord_user_id, submitted_by_user_id FROM community_scores WHERE game_room_id = ? AND iscored_username = 'ghandle'`,
            roomId,
        );
        expect(row.discord_user_id).toBe(DISCORD_ID);
        expect(row.submitted_by_user_id).toBe(DISCORD_ID);
    });

    it('rewrites global_scores.player_id and submitted_by_user_id', async () => {
        const db = await getDatabase();
        await db.run(`INSERT INTO global_games (id, name, type) VALUES ('gg-1', 'Test Game', 'pinball')`);
        await db.run(
            `INSERT INTO global_scores (id, global_game_id, player_id, score, origin_type, submitted_by_user_id)
             VALUES ('gs-1', 'gg-1', ?, 999, 'room', ?)`,
            GOOGLE_ID, GOOGLE_ID,
        );

        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);

        const row = await db.get('SELECT player_id, submitted_by_user_id FROM global_scores WHERE id = ?', 'gs-1');
        expect(row.player_id).toBe(DISCORD_ID);
        expect(row.submitted_by_user_id).toBe(DISCORD_ID);
    });

    it('rewrites sessions.discord_user_id (refresh chain survives the link)', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO sessions (id, discord_user_id, refresh_token, expires_at)
             VALUES ('sess-1', ?, 'reftok', datetime('now', '+30 days'))`,
            GOOGLE_ID,
        );

        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);

        const row = await db.get('SELECT discord_user_id FROM sessions WHERE id = ?', 'sess-1');
        expect(row.discord_user_id).toBe(DISCORD_ID);
    });

    it('rewrites push_subscriptions.discord_user_id without conflict (endpoint is the unique key)', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO push_subscriptions (discord_user_id, endpoint, p256dh, auth) VALUES (?, 'https://push.example/ep1', 'k1', 'a1')`,
            GOOGLE_ID,
        );
        // Pre-existing snowflake subscription on a DIFFERENT device/endpoint —
        // both rows should coexist under discord_user_id after the link.
        await db.run(
            `INSERT INTO push_subscriptions (discord_user_id, endpoint, p256dh, auth) VALUES (?, 'https://push.example/ep2', 'k2', 'a2')`,
            DISCORD_ID,
        );

        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);

        const rows = await db.all('SELECT endpoint, discord_user_id FROM push_subscriptions ORDER BY endpoint');
        expect(rows).toHaveLength(2);
        expect(rows.every(r => r.discord_user_id === DISCORD_ID)).toBe(true);
    });
});

describe('IdentityLinkService.createLink — conflict-resolution tables', () => {
    let roomA: string;
    let roomB: string;

    beforeEach(async () => {
        await setupTestDb();
        roomA = await createTestRoom('room-a', 'Room A');
        roomB = await createTestRoom('room-b', 'Room B');
    });

    it('room_members: re-keys a room where only the google id is a member', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO room_members (user_id, room_id, source) VALUES (?, ?, 'claim')`,
            GOOGLE_ID, roomA,
        );

        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);

        const row = await db.get('SELECT user_id FROM room_members WHERE room_id = ?', roomA);
        expect(row.user_id).toBe(DISCORD_ID);
    });

    it('room_members: keeps the snowflake row and drops the google row on same-room conflict', async () => {
        const db = await getDatabase();
        await db.run(`INSERT INTO room_members (user_id, room_id, source) VALUES (?, ?, 'claim')`, GOOGLE_ID, roomB);
        await db.run(`INSERT INTO room_members (user_id, room_id, source) VALUES (?, ?, 'backfill')`, DISCORD_ID, roomB);

        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);

        const rows = await db.all('SELECT user_id, source FROM room_members WHERE room_id = ?', roomB);
        expect(rows).toHaveLength(1);
        expect(rows[0].user_id).toBe(DISCORD_ID);
        expect(rows[0].source).toBe('backfill'); // the snowflake's original row, untouched
    });

    it('user_preferences: re-keys when only the google id has a row', async () => {
        const db = await getDatabase();
        await db.run(`INSERT INTO user_preferences (discord_user_id, ui_theme) VALUES (?, 'dark')`, GOOGLE_ID);

        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);

        const row = await db.get('SELECT ui_theme FROM user_preferences WHERE discord_user_id = ?', DISCORD_ID);
        expect(row.ui_theme).toBe('dark');
        const goneRow = await db.get('SELECT 1 FROM user_preferences WHERE discord_user_id = ?', GOOGLE_ID);
        expect(goneRow).toBeUndefined();
    });

    it('user_preferences: keeps the snowflake row on conflict, drops the google row', async () => {
        const db = await getDatabase();
        await db.run(`INSERT INTO user_preferences (discord_user_id, ui_theme) VALUES (?, 'google-theme')`, GOOGLE_ID);
        await db.run(`INSERT INTO user_preferences (discord_user_id, ui_theme) VALUES (?, 'discord-theme')`, DISCORD_ID);

        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);

        const row = await db.get('SELECT ui_theme FROM user_preferences WHERE discord_user_id = ?', DISCORD_ID);
        expect(row.ui_theme).toBe('discord-theme');
        const all = await db.all('SELECT discord_user_id FROM user_preferences');
        expect(all).toHaveLength(1);
    });

    it('game_room_admins: moves admin rights the google id held in rooms the snowflake did not', async () => {
        const db = await getDatabase();
        await db.run(`INSERT INTO game_room_admins (game_room_id, discord_user_id, role) VALUES (?, ?, 'admin')`, roomA, GOOGLE_ID);

        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);

        const row = await db.get('SELECT role FROM game_room_admins WHERE game_room_id = ? AND discord_user_id = ?', roomA, DISCORD_ID);
        expect(row.role).toBe('admin');
        const goneRow = await db.get('SELECT 1 FROM game_room_admins WHERE discord_user_id = ?', GOOGLE_ID);
        expect(goneRow).toBeUndefined();
    });

    it('game_room_admins: keeps the snowflake\'s existing role on same-room conflict', async () => {
        const db = await getDatabase();
        await db.run(`INSERT INTO game_room_admins (game_room_id, discord_user_id, role) VALUES (?, ?, 'admin')`, roomB, GOOGLE_ID);
        await db.run(`INSERT INTO game_room_admins (game_room_id, discord_user_id, role) VALUES (?, ?, 'owner')`, roomB, DISCORD_ID);

        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);

        const row = await db.get('SELECT role FROM game_room_admins WHERE game_room_id = ? AND discord_user_id = ?', roomB, DISCORD_ID);
        expect(row.role).toBe('owner'); // untouched — INSERT OR IGNORE didn't clobber it
        const rows = await db.all('SELECT discord_user_id FROM game_room_admins WHERE game_room_id = ?', roomB);
        expect(rows).toHaveLength(1);
    });

    it('user_profiles: re-keys wholesale when the snowflake has no profile row', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, display_name, avatar_url) VALUES (?, 'Ada', 'https://example.com/a.jpg')`,
            GOOGLE_ID,
        );

        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);

        const row = await db.get('SELECT display_name, avatar_url FROM user_profiles WHERE discord_user_id = ?', DISCORD_ID);
        expect(row.display_name).toBe('Ada');
        expect(row.avatar_url).toBe('https://example.com/a.jpg');
        const goneRow = await db.get('SELECT 1 FROM user_profiles WHERE discord_user_id = ?', GOOGLE_ID);
        expect(goneRow).toBeUndefined();
    });

    it('user_profiles: both exist — keeps the snowflake row, COALESCEs NULL fields from the google row, drops the google row', async () => {
        const db = await getDatabase();
        // Snowflake row has a display_name but no avatar; google row has an avatar but no display_name.
        await db.run(`INSERT INTO user_profiles (discord_user_id, display_name) VALUES (?, 'DiscordChosenName')`, DISCORD_ID);
        await db.run(`INSERT INTO user_profiles (discord_user_id, avatar_url) VALUES (?, 'https://example.com/google-pic.jpg')`, GOOGLE_ID);

        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);

        const row = await db.get('SELECT display_name, avatar_url FROM user_profiles WHERE discord_user_id = ?', DISCORD_ID);
        expect(row.display_name).toBe('DiscordChosenName'); // snowflake's non-null value wins
        expect(row.avatar_url).toBe('https://example.com/google-pic.jpg'); // filled in from google row (was NULL)
        const all = await db.all('SELECT discord_user_id FROM user_profiles');
        expect(all).toHaveLength(1);
    });

    it('user_profiles: does not overwrite a non-null snowflake field with the google row\'s value', async () => {
        const db = await getDatabase();
        await db.run(`INSERT INTO user_profiles (discord_user_id, avatar_url) VALUES (?, 'https://example.com/discord-pic.jpg')`, DISCORD_ID);
        await db.run(`INSERT INTO user_profiles (discord_user_id, avatar_url) VALUES (?, 'https://example.com/google-pic.jpg')`, GOOGLE_ID);

        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);

        const row = await db.get('SELECT avatar_url FROM user_profiles WHERE discord_user_id = ?', DISCORD_ID);
        expect(row.avatar_url).toBe('https://example.com/discord-pic.jpg');
    });
});

describe('IdentityLinkService — misc', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('createLink writes the user_identity_links row itself', async () => {
        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);
        const db = await getDatabase();
        const row = await db.get('SELECT canonical_user_id FROM user_identity_links WHERE provider_user_id = ?', GOOGLE_ID);
        expect(row.canonical_user_id).toBe(DISCORD_ID);
    });

    it('createLink rejects a non-google provider id', async () => {
        await expect(IdentityLinkService.createLink(DISCORD_ID, DISCORD_ID)).rejects.toThrow();
    });

    it('getLinkForCanonical lists every google identity linked to a canonical', async () => {
        await IdentityLinkService.createLink('google:a', DISCORD_ID);
        await IdentityLinkService.createLink('google:b', DISCORD_ID);
        const links = await IdentityLinkService.getLinkForCanonical(DISCORD_ID);
        expect(links.map(l => l.provider_user_id).sort()).toEqual(['google:a', 'google:b']);
    });

    it('deleteLink removes the row only (no un-merge) and resolveCanonical reverts to a miss', async () => {
        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);
        const deleted = await IdentityLinkService.deleteLink(GOOGLE_ID);
        expect(deleted).toBe(true);
        const resolved = await IdentityLinkService.resolveCanonical(GOOGLE_ID);
        expect(resolved).toBe(GOOGLE_ID);
    });

    it('deleteLink returns false for a non-existent link', async () => {
        const deleted = await IdentityLinkService.deleteLink('google:never-linked');
        expect(deleted).toBe(false);
    });
});
