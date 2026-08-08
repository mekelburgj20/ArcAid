import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import {
    AccountDeletionService,
    DELETED_USER_SENTINEL,
    LastSuperAdminError,
    type AccountDeletionResult,
} from '../services/AccountDeletionService.js';

// S12 — account deletion = ANONYMIZE-AND-KEEP-SCORES.
//
// The product decision (fixed): deleting an account strips every piece of
// PERSONAL data (Discord id, avatar, display name, proof photos, mappings,
// prefs, sessions, comments, ratings, friendships, privileges) but KEEPS the
// score rows under their game handle (iscored_username). The score is
// de-identified — its attribution column (submitted_by_user_id) is nulled and
// the NOT-NULL identity column (discord_user_id / player_id) is set to the
// DELETED sentinel — so leaderboards/rankings, which partition on
// COALESCE(submitted_by_user_id, 'iscored:'||LOWER(iscored_username)), re-anchor
// the score to the anonymous handle rather than dropping it.
//
// This suite seeds ONE user (user1) with a row in EVERY table the deletion
// contract's perTablePlan touches — plus a second, uninvolved user (user2) — then
// runs AccountDeletionService.anonymizeUser(user1) and asserts:
//   (a) every delete-outright row for user1 is GONE;
//   (b) every score row for user1 SURVIVES but is de-identified (attribution
//       nulled / identity sentinel), with iscored_username + score intact and
//       photo_url nulled + the on-disk photo file unlinked;
//   (c) user2's data is completely untouched (both DB rows and their photo file);
//   (d) the two HTTP entry points are authorization-gated — a Discord player can
//       only delete THEMSELVES via /api/me/account, and the admin variant
//       (/api/admin/users/:id) is super-admin-only, with a last-super-admin 409.

// Score-photo files live under <cwd>/data/score-photos/{roomId|global}/<file>,
// referenced by photo_url = /api/score-photos/{roomId|global}/<file>. Mirrors the
// SCORE_PHOTOS_ROOT the service's scorePhotos helper resolves (process.cwd() is the
// repo root under vitest). We create real temp files so photosDeleted is a real,
// exact count and the unlink is actually observable — then clean them up.
const SCORE_PHOTOS_ROOT = path.join(process.cwd(), 'data', 'score-photos');

// Files/dirs created by seedWorld, torn down in afterEach so no stray temp images
// linger in the (git-ignored-adjacent) data/score-photos tree.
let createdFiles: string[] = [];
let createdDirs: string[] = [];

async function count(sql: string, ...params: unknown[]): Promise<number> {
    const db = await getDatabase();
    const r = await db.get<{ n: number }>(sql, ...params);
    return r?.n ?? 0;
}

interface SeedContext {
    user1: string;
    user2: string;
    roomId: string;
    tournamentId: string;
    gameId: string;
    ggId: string;
    anonId: number;
    rgId: string;
    photos: {
        sub: { abs: string; url: string };
        hist: { abs: string; url: string };
        comm: { abs: string; url: string };
        global: { abs: string; url: string };
        user2: { abs: string; url: string };
    };
}

const SCORE1 = 123456;
const SCORE2 = 777;

/**
 * Seed one game room and, within it, a full footprint for user1 across EVERY
 * table the deletion perTablePlan touches, plus a parallel (must-survive)
 * footprint for user2. Returns the ids/paths the assertions key off.
 */
async function seedWorld(): Promise<SeedContext> {
    const db = await getDatabase();
    const user1 = 'du1-' + crypto.randomUUID();
    const user2 = 'du2-' + crypto.randomUUID();

    const roomId = await createTestRoom('s12-' + crypto.randomUUID().slice(0, 8), 'S12 Room');
    const tournamentId = await createTestTournament(roomId, { name: 'S12 Tournament' });

    // --- Parent rows the score/cache tables FK-depend on ---
    const gameId = crypto.randomUUID();
    // picker_discord_id = user1 → must be anonymized to NULL (row kept).
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, start_date, game_room_id, picker_discord_id)
         VALUES (?, ?, 'S12 Game', 'COMPLETED', ?, ?, ?)`,
        gameId, tournamentId, new Date().toISOString(), roomId, user1,
    );

    const ggId = crypto.randomUUID();
    // Contributor attribution = user1 → anonymized to NULL; the shared catalogue
    // row + its art survive.
    await db.run(
        `INSERT INTO global_games (id, name, type, status, submitted_by_user_id, submitted_by, reviewed_by)
         VALUES (?, 'S12 Game', 'pinball', 'approved', ?, ?, ?)`,
        ggId, user1, user1, user1,
    );

    // Merge-linked anonymous identity: server_nickname may hold the user's real
    // Discord server nickname → scrubbed to sentinel (row kept).
    const anonRes = await db.run(
        `INSERT INTO anonymous_identities (server_nickname, status) VALUES ('RealServerNick', 'merged')`,
    );
    const anonId = anonRes.lastID as number;

    const rgId = crypto.randomUUID();
    await db.run(`INSERT INTO ranking_groups (id, name, game_room_id) VALUES (?, 'S12 RG', ?)`, rgId, roomId);

    // --- Real on-disk photo files (so photosDeleted is an exact, observable count) ---
    const roomDir = path.join(SCORE_PHOTOS_ROOT, roomId);
    const globalDir = path.join(SCORE_PHOTOS_ROOT, 'global');
    fs.mkdirSync(roomDir, { recursive: true });
    fs.mkdirSync(globalDir, { recursive: true });
    createdDirs.push(roomDir);
    const mkPhoto = (dir: string, urlPrefix: string) => {
        const name = crypto.randomUUID() + '.png';
        const abs = path.join(dir, name);
        fs.writeFileSync(abs, 'not-a-real-image');
        createdFiles.push(abs);
        return { abs, url: `${urlPrefix}/${name}` };
    };
    const photos = {
        sub: mkPhoto(roomDir, `/api/score-photos/${roomId}`),
        hist: mkPhoto(roomDir, `/api/score-photos/${roomId}`),
        comm: mkPhoto(roomDir, `/api/score-photos/${roomId}`),
        global: mkPhoto(globalDir, `/api/score-photos/global`),
        user2: mkPhoto(roomDir, `/api/score-photos/${roomId}`),
    };

    // ================= user1: SCORE tables (anonymize, keep) =================
    await db.run(
        `INSERT INTO submissions
           (id, game_id, discord_user_id, iscored_username, score, photo_url, timestamp,
            submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
            submitted_by_anonymous_name, merged_from_anonymous_identity_id, platform)
         VALUES (?, ?, ?, 'PlayerOne', ?, ?, ?, ?, ?, ?, 'AnonSub', ?, 'real')`,
        `${gameId}-playerone`, gameId, user1, SCORE1, photos.sub.url, new Date().toISOString(),
        roomId, tournamentId, user1, anonId,
    );
    await db.run(
        `INSERT INTO score_history
           (game_name, game_room_id, game_id, iscored_username, discord_user_id, score, photo_url, source,
            submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
            submitted_by_anonymous_name, merged_from_anonymous_identity_id, platform)
         VALUES ('S12 Game', ?, ?, 'PlayerOne', ?, ?, ?, 'tournament', ?, ?, ?, 'AnonHist', ?, 'real')`,
        roomId, gameId, user1, SCORE1, photos.hist.url, roomId, tournamentId, user1, anonId,
    );
    await db.run(
        `INSERT INTO community_scores
           (game_name, game_room_id, iscored_username, discord_user_id, score, photo_url,
            submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
            submitted_by_anonymous_name, merged_from_anonymous_identity_id, platform)
         VALUES ('S12 Game', ?, 'PlayerOne', ?, ?, ?, ?, ?, ?, 'AnonComm', ?, 'real')`,
        roomId, user1, SCORE1, photos.comm.url, roomId, tournamentId, user1, anonId,
    );
    await db.run(
        `INSERT INTO global_scores
           (id, global_game_id, player_id, iscored_username, score, photo_url, origin_type,
            origin_game_room_id, origin_game_id, submitted_from_room_id, submitted_during_tournament_id,
            submitted_by_user_id, submitted_by_anonymous_name, merged_from_anonymous_identity_id, platform)
         VALUES (?, ?, ?, 'PlayerOne', ?, ?, 'room', ?, ?, ?, ?, ?, 'AnonGlobal', ?, 'real')`,
        crypto.randomUUID(), ggId, user1, SCORE1, photos.global.url, roomId, gameId,
        roomId, tournamentId, user1, anonId,
    );
    // A global_scores row user1 MODERATED (deleted_by = user1) but does not own —
    // exercises the `SET deleted_by = NULL WHERE deleted_by = X` scrub; the row +
    // its owner (someoneelse) are otherwise untouched.
    await db.run(
        `INSERT INTO global_scores
           (id, global_game_id, player_id, iscored_username, score, origin_type, deleted_at, deleted_by)
         VALUES (?, ?, 'someoneelse', 'Someone', 42, 'room', ?, ?)`,
        crypto.randomUUID(), ggId, new Date().toISOString(), user1,
    );
    // Legacy verified-flag table (no photo_url / submitted_by_user_id): identity
    // column flips to sentinel, handle kept.
    await db.run(
        `INSERT INTO scores (id, game_id, discord_user_id, iscored_username, score, verified, timestamp)
         VALUES (?, ?, ?, 'PlayerOne', ?, 1, ?)`,
        crypto.randomUUID(), gameId, user1, SCORE1, new Date().toISOString(),
    );

    // ================= user1: DELETE-OUTRIGHT tables =================
    await db.run(
        `INSERT INTO user_profiles (discord_user_id, display_name, avatar_hash) VALUES (?, 'PlayerOne', 'avhash1')`,
        user1,
    );
    await db.run(`INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, 'PlayerOne')`, user1);
    await db.run(
        `INSERT INTO user_preferences (discord_user_id, ui_theme, notification_prefs) VALUES (?, 'dark', '{}')`,
        user1,
    );
    await db.run(
        `INSERT INTO sessions (id, discord_user_id, refresh_token, expires_at)
         VALUES (?, ?, 'refresh-1', ?)`,
        crypto.randomUUID(), user1, new Date(Date.now() + 8.64e7).toISOString(),
    );
    // Friendships in BOTH directions.
    await db.run(
        `INSERT INTO friendships (id, user_id, friend_user_id) VALUES (?, ?, 'friend-of-1')`,
        crypto.randomUUID(), user1,
    );
    await db.run(
        `INSERT INTO friendships (id, user_id, friend_user_id) VALUES (?, 'follower-of-1', ?)`,
        crypto.randomUUID(), user1,
    );
    await db.run(
        `INSERT INTO game_comments (game_name, game_room_id, user_id, display_name, type, body)
         VALUES ('S12 Game', ?, ?, 'PlayerOne', 'comment', 'nice table')`,
        roomId, user1,
    );
    await db.run(
        `INSERT INTO game_ratings (game_room_id, game_name, user_id, rating) VALUES (?, 'S12 Game', ?, 5)`,
        roomId, user1,
    );
    await db.run(
        `INSERT INTO global_game_comments (global_game_id, discord_user_id, display_name, type, body)
         VALUES (?, ?, 'PlayerOne', 'comment', 'global comment')`,
        ggId, user1,
    );
    await db.run(
        `INSERT INTO global_game_ratings (global_game_id, discord_user_id, rating) VALUES (?, ?, 4)`,
        ggId, user1,
    );
    await db.run(
        `INSERT INTO room_members (user_id, room_id, source, display_name) VALUES (?, ?, 'submission', 'PlayerOne')`,
        user1, roomId,
    );
    // user1 is the SOLE admin of this room → deleting them must surface the room
    // in roomsLeftAdminless.
    await db.run(`INSERT INTO game_room_admins (game_room_id, discord_user_id) VALUES (?, ?)`, roomId, user1);
    // Super-admin row for user1 + a second super-admin ("keeper") so the
    // last-super-admin precondition does NOT trip (that guard is exercised
    // separately below).
    await db.run(`INSERT INTO super_admins (discord_user_id) VALUES (?)`, user1);
    await db.run(`INSERT INTO super_admins (discord_user_id) VALUES ('keeper-super-admin')`);
    await db.run(
        `INSERT INTO player_milestones_fired (game_room_id, player_key, scope, threshold)
         VALUES (?, ?, 'scores_submitted', 10)`,
        roomId, user1,
    );
    // Feed rows in BOTH referencing columns.
    await db.run(
        `INSERT INTO lobby_feed_events (game_room_id, type, title, player_id) VALUES (?, 'score', 'p1 scored', ?)`,
        roomId, user1,
    );
    await db.run(
        `INSERT INTO lobby_feed_events (game_room_id, type, title, player_id, target_user_id)
         VALUES (?, 'friend_score', 'friend scored', 'other-player', ?)`,
        roomId, user1,
    );
    // room_events — no dedicated user column; the 18+ char id lives inside the JSON blob.
    await db.run(
        `INSERT INTO room_events (game_room_id, event_type, event_data) VALUES (?, 'score', ?)`,
        roomId, JSON.stringify({ discordUserId: user1, note: 'seeded' }),
    );

    // ================= user1: ANONYMIZE non-score tables =================
    await db.run(
        `INSERT INTO admin_invites (id, token, game_room_id, display_name, discord_user_id, created_by, expires_at)
         VALUES (?, ?, ?, 'Invitee', ?, ?, ?)`,
        crypto.randomUUID(), 'invite-token-' + crypto.randomUUID(), roomId, user1, user1,
        new Date(Date.now() + 8.64e7).toISOString(),
    );
    await db.run(
        `INSERT INTO lobby_announcements (id, game_room_id, title, created_by) VALUES (?, ?, 'Welcome', ?)`,
        crypto.randomUUID(), roomId, user1,
    );
    await db.run(
        `INSERT INTO merge_records
           (anonymous_identity_id, target_discord_user_id, admin_discord_user_id, reversal_admin_id)
         VALUES (?, ?, ?, ?)`,
        anonId, user1, user1, user1,
    );
    // user_bans — subject row (KEEP subject, abuse-prevention) + actor row (de-identify actor).
    await db.run(
        `INSERT INTO user_bans (id, discord_user_id, reason, banned_by) VALUES (?, ?, 'cheating', 'admin-actor')`,
        crypto.randomUUID(), user1,
    );
    await db.run(
        `INSERT INTO user_bans (id, discord_user_id, reason, banned_by, lifted_by)
         VALUES (?, 'badguy', 'spam', ?, ?)`,
        crypto.randomUUID(), user1, user1,
    );
    await db.run(
        `INSERT INTO score_reports (id, score_id, reporter_discord_id, reason, resolved_by)
         VALUES (?, 'some-score-id', ?, 'looks fake', ?)`,
        crypto.randomUUID(), user1, user1,
    );
    await db.run(
        `INSERT INTO deleted_score_suppressions (game_id, iscored_username_lower, suppressed_score, deleted_by_user_id)
         VALUES (?, 'playerone', 999, ?)`,
        gameId, user1,
    );

    // ================= user1: KEEP / SKIP tables (must survive untouched) =================
    await db.run(`INSERT INTO player_aliases (old_username, new_username) VALUES ('oldhandle', 'newhandle')`);
    await db.run(
        `INSERT INTO anon_room_claims (anon_token, room_id, display_name) VALUES ('anon-token-xyz', ?, 'GuestBob')`,
        roomId,
    );
    await db.run(
        `INSERT INTO submission_drafts (state_param, target_json, expires_at)
         VALUES ('state-xyz', '{}', ?)`,
        new Date(Date.now() + 8.64e7).toISOString(),
    );
    await db.run(
        `INSERT INTO audit_log (actor, action, target_type, target_id) VALUES (?, 'login', 'user', ?)`,
        user1, user1,
    );

    // ================= user1: CACHE tables (fully busted on deletion) =================
    await db.run(
        `INSERT INTO leaderboard_cache (game_id, rankings, generated_at) VALUES (?, '[]', ?)`,
        gameId, new Date().toISOString(),
    );
    await db.run(
        `INSERT INTO global_leaderboard_cache (global_game_id, scope, rankings, generated_at)
         VALUES (?, 'global', '[]', ?)`,
        ggId, new Date().toISOString(),
    );
    await db.run(
        `INSERT INTO ranking_groups_cache (ranking_group_id, rankings, generated_at) VALUES (?, '[]', ?)`,
        rgId, new Date().toISOString(),
    );

    // ================= user2: parallel footprint (must be UNTOUCHED) =================
    await db.run(
        `INSERT INTO user_profiles (discord_user_id, display_name, avatar_hash) VALUES (?, 'PlayerTwo', 'avhash2')`,
        user2,
    );
    await db.run(`INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, 'PlayerTwo')`, user2);
    await db.run(
        `INSERT INTO user_preferences (discord_user_id, ui_theme, notification_prefs) VALUES (?, 'light', '{}')`,
        user2,
    );
    await db.run(
        `INSERT INTO sessions (id, discord_user_id, refresh_token, expires_at) VALUES (?, ?, 'refresh-2', ?)`,
        crypto.randomUUID(), user2, new Date(Date.now() + 8.64e7).toISOString(),
    );
    await db.run(
        `INSERT INTO friendships (id, user_id, friend_user_id) VALUES (?, ?, 'friend-of-2')`,
        crypto.randomUUID(), user2,
    );
    await db.run(
        `INSERT INTO game_comments (game_name, game_room_id, user_id, display_name, type, body)
         VALUES ('S12 Game', ?, ?, 'PlayerTwo', 'comment', 'p2 comment')`,
        roomId, user2,
    );
    await db.run(
        `INSERT INTO game_ratings (game_room_id, game_name, user_id, rating) VALUES (?, 'S12 Game', ?, 3)`,
        roomId, user2,
    );
    await db.run(
        `INSERT INTO room_members (user_id, room_id, source, display_name) VALUES (?, ?, 'submission', 'PlayerTwo')`,
        user2, roomId,
    );
    await db.run(
        `INSERT INTO lobby_feed_events (game_room_id, type, title, player_id) VALUES (?, 'score', 'p2 scored', ?)`,
        roomId, user2,
    );
    await db.run(
        `INSERT INTO room_events (game_room_id, event_type, event_data) VALUES (?, 'score', ?)`,
        roomId, JSON.stringify({ discordUserId: user2, note: 'seeded' }),
    );
    await db.run(
        `INSERT INTO submissions
           (id, game_id, discord_user_id, iscored_username, score, photo_url, timestamp,
            submitted_from_room_id, submitted_by_user_id, platform)
         VALUES (?, ?, ?, 'PlayerTwo', ?, ?, ?, ?, ?, 'real')`,
        `${gameId}-playertwo`, gameId, user2, SCORE2, photos.user2.url, new Date().toISOString(),
        roomId, user2,
    );
    await db.run(
        `INSERT INTO score_history
           (game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source,
            submitted_from_room_id, submitted_by_user_id, platform)
         VALUES ('S12 Game', ?, ?, 'PlayerTwo', ?, ?, 'tournament', ?, ?, 'real')`,
        roomId, gameId, user2, SCORE2, roomId, user2,
    );
    await db.run(
        `INSERT INTO community_scores
           (game_name, game_room_id, iscored_username, discord_user_id, score, submitted_by_user_id, platform)
         VALUES ('S12 Game', ?, 'PlayerTwo', ?, ?, ?, 'real')`,
        roomId, user2, SCORE2, user2,
    );
    await db.run(
        `INSERT INTO global_scores
           (id, global_game_id, player_id, iscored_username, score, origin_type, origin_game_room_id,
            submitted_by_user_id, platform)
         VALUES (?, ?, ?, 'PlayerTwo', ?, 'room', ?, ?, 'real')`,
        crypto.randomUUID(), ggId, user2, SCORE2, roomId, user2,
    );

    return {
        user1, user2, roomId, tournamentId, gameId, ggId, anonId, rgId, photos,
    };
}

function cleanupFiles(): void {
    for (const f of createdFiles) {
        try { fs.rmSync(f, { force: true }); } catch { /* best-effort */ }
    }
    for (const d of createdDirs) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    createdFiles = [];
    createdDirs = [];
}

// ============================================================================
// (a)/(b)/(c) — data effects of a self-initiated deletion
// ============================================================================
describe('S12 — AccountDeletionService.anonymizeUser (data effects)', () => {
    let ctx: SeedContext;
    let result: AccountDeletionResult;

    beforeEach(async () => {
        await setupTestDb();
        ctx = await seedWorld();
        result = await AccountDeletionService.anonymizeUser(ctx.user1, { actor: 'self' });
    });

    afterEach(() => {
        cleanupFiles();
    });

    it('DELETED_USER_SENTINEL is the documented "DELETED" placeholder', () => {
        expect(DELETED_USER_SENTINEL).toBe('DELETED');
    });

    it('(a) identity + session rows for the user are deleted outright', async () => {
        expect(await count('SELECT COUNT(*) AS n FROM user_profiles WHERE discord_user_id = ?', ctx.user1)).toBe(0);
        expect(await count('SELECT COUNT(*) AS n FROM user_mappings WHERE discord_user_id = ?', ctx.user1)).toBe(0);
        expect(await count('SELECT COUNT(*) AS n FROM user_preferences WHERE discord_user_id = ?', ctx.user1)).toBe(0);
        // Sessions MUST be gone so a stale refresh token cannot re-auth.
        expect(await count('SELECT COUNT(*) AS n FROM sessions WHERE discord_user_id = ?', ctx.user1)).toBe(0);
    });

    it('(a) social rows for the user are deleted (friendships both directions)', async () => {
        expect(await count(
            'SELECT COUNT(*) AS n FROM friendships WHERE user_id = ? OR friend_user_id = ?', ctx.user1, ctx.user1,
        )).toBe(0);
        expect(await count('SELECT COUNT(*) AS n FROM game_comments WHERE user_id = ?', ctx.user1)).toBe(0);
        expect(await count('SELECT COUNT(*) AS n FROM game_ratings WHERE user_id = ?', ctx.user1)).toBe(0);
        expect(await count('SELECT COUNT(*) AS n FROM global_game_comments WHERE discord_user_id = ?', ctx.user1)).toBe(0);
        expect(await count('SELECT COUNT(*) AS n FROM global_game_ratings WHERE discord_user_id = ?', ctx.user1)).toBe(0);
        expect(await count('SELECT COUNT(*) AS n FROM room_members WHERE user_id = ?', ctx.user1)).toBe(0);
    });

    it('(a) privilege / ledger / feed rows for the user are deleted', async () => {
        expect(await count('SELECT COUNT(*) AS n FROM game_room_admins WHERE discord_user_id = ?', ctx.user1)).toBe(0);
        expect(await count('SELECT COUNT(*) AS n FROM super_admins WHERE discord_user_id = ?', ctx.user1)).toBe(0);
        // The other super-admin ("keeper") is untouched.
        expect(await count(`SELECT COUNT(*) AS n FROM super_admins WHERE discord_user_id = 'keeper-super-admin'`)).toBe(1);
        expect(await count('SELECT COUNT(*) AS n FROM player_milestones_fired WHERE player_key = ?', ctx.user1)).toBe(0);
        expect(await count(
            'SELECT COUNT(*) AS n FROM lobby_feed_events WHERE player_id = ? OR target_user_id = ?', ctx.user1, ctx.user1,
        )).toBe(0);
        // Best-effort JSON scrub of room_events referencing the id.
        expect(await count(
            `SELECT COUNT(*) AS n FROM room_events WHERE event_data LIKE '%' || ? || '%'`, ctx.user1,
        )).toBe(0);
    });

    it('(b) the 4 photo-bearing score rows SURVIVE, de-identified, with handle + score intact and photo nulled', async () => {
        const db = await getDatabase();

        const sub = await db.get<{ submitted_by_user_id: string | null; discord_user_id: string;
            submitted_by_anonymous_name: string | null; merged_from_anonymous_identity_id: number | null;
            iscored_username: string; score: number; photo_url: string | null }>(
            'SELECT * FROM submissions WHERE id = ?', `${ctx.gameId}-playerone`,
        );
        expect(sub).toBeTruthy();
        expect(sub!.submitted_by_user_id).toBeNull();
        expect(sub!.discord_user_id).toBe(DELETED_USER_SENTINEL);
        expect(sub!.submitted_by_anonymous_name).toBeNull();
        expect(sub!.merged_from_anonymous_identity_id).toBeNull();
        expect(sub!.iscored_username).toBe('PlayerOne'); // handle preserved
        expect(sub!.score).toBe(SCORE1);                 // score preserved
        expect(sub!.photo_url).toBeNull();               // proof photo reference stripped

        const hist = await db.get<{ submitted_by_user_id: string | null; discord_user_id: string;
            iscored_username: string; score: number; photo_url: string | null }>(
            'SELECT * FROM score_history WHERE game_room_id = ? AND iscored_username = ?', ctx.roomId, 'PlayerOne',
        );
        expect(hist).toBeTruthy();
        expect(hist!.submitted_by_user_id).toBeNull();
        expect(hist!.discord_user_id).toBe(DELETED_USER_SENTINEL);
        expect(hist!.iscored_username).toBe('PlayerOne');
        expect(hist!.score).toBe(SCORE1);
        expect(hist!.photo_url).toBeNull();

        const comm = await db.get<{ submitted_by_user_id: string | null; discord_user_id: string;
            iscored_username: string; score: number; photo_url: string | null }>(
            'SELECT * FROM community_scores WHERE game_room_id = ? AND iscored_username = ?', ctx.roomId, 'PlayerOne',
        );
        expect(comm).toBeTruthy();
        expect(comm!.submitted_by_user_id).toBeNull();
        expect(comm!.discord_user_id).toBe(DELETED_USER_SENTINEL);
        expect(comm!.iscored_username).toBe('PlayerOne');
        expect(comm!.score).toBe(SCORE1);
        expect(comm!.photo_url).toBeNull();

        const gs = await db.get<{ submitted_by_user_id: string | null; player_id: string;
            iscored_username: string; score: number; photo_url: string | null }>(
            'SELECT * FROM global_scores WHERE global_game_id = ? AND iscored_username = ?', ctx.ggId, 'PlayerOne',
        );
        expect(gs).toBeTruthy();
        expect(gs!.submitted_by_user_id).toBeNull();
        expect(gs!.player_id).toBe(DELETED_USER_SENTINEL); // NOT-NULL identity → sentinel
        expect(gs!.iscored_username).toBe('PlayerOne');
        expect(gs!.score).toBe(SCORE1);
        expect(gs!.photo_url).toBeNull();
    });

    it('(b) legacy `scores` row survives with the identity flipped to sentinel and handle kept', async () => {
        const db = await getDatabase();
        const row = await db.get<{ discord_user_id: string; iscored_username: string; score: number }>(
            'SELECT * FROM scores WHERE game_id = ? AND iscored_username = ?', ctx.gameId, 'PlayerOne',
        );
        expect(row).toBeTruthy();
        expect(row!.discord_user_id).toBe(DELETED_USER_SENTINEL);
        expect(row!.iscored_username).toBe('PlayerOne');
        expect(row!.score).toBe(SCORE1);
    });

    it('(b) the score-photo files on disk are unlinked; result.photosDeleted counts exactly them', async () => {
        expect(fs.existsSync(ctx.photos.sub.abs)).toBe(false);
        expect(fs.existsSync(ctx.photos.hist.abs)).toBe(false);
        expect(fs.existsSync(ctx.photos.comm.abs)).toBe(false);
        expect(fs.existsSync(ctx.photos.global.abs)).toBe(false);
        expect(result.photosDeleted).toBe(4);
    });

    it('non-score identity references are ANONYMIZED in place (row kept, PII stripped)', async () => {
        const db = await getDatabase();

        // global_games: contributor attribution nulled, catalogue row kept.
        const gg = await db.get<{ submitted_by_user_id: string | null; submitted_by: string | null;
            reviewed_by: string | null; name: string }>(
            'SELECT * FROM global_games WHERE id = ?', ctx.ggId,
        );
        expect(gg).toBeTruthy();
        expect(gg!.submitted_by_user_id).toBeNull();
        expect(gg!.submitted_by).toBeNull();
        expect(gg!.reviewed_by).toBeNull();
        expect(gg!.name).toBe('S12 Game');

        // games.picker_discord_id nulled, row kept.
        const game = await db.get<{ picker_discord_id: string | null }>(
            'SELECT picker_discord_id FROM games WHERE id = ?', ctx.gameId,
        );
        expect(game!.picker_discord_id).toBeNull();

        // admin_invites: both id columns nulled, invite row kept.
        const invite = await db.get<{ discord_user_id: string | null; created_by: string | null }>(
            'SELECT discord_user_id, created_by FROM admin_invites WHERE game_room_id = ?', ctx.roomId,
        );
        expect(invite).toBeTruthy();
        expect(invite!.discord_user_id).toBeNull();
        expect(invite!.created_by).toBeNull();

        // lobby_announcements.created_by nulled, row kept.
        const ann = await db.get<{ created_by: string | null }>(
            'SELECT created_by FROM lobby_announcements WHERE game_room_id = ?', ctx.roomId,
        );
        expect(ann).toBeTruthy();
        expect(ann!.created_by).toBeNull();

        // merge_records: identity columns → sentinel / NULL, audit row kept.
        const mr = await db.get<{ target_discord_user_id: string; admin_discord_user_id: string;
            reversal_admin_id: string | null }>(
            'SELECT * FROM merge_records WHERE anonymous_identity_id = ?', ctx.anonId,
        );
        expect(mr).toBeTruthy();
        expect(mr!.target_discord_user_id).toBe(DELETED_USER_SENTINEL);
        expect(mr!.admin_discord_user_id).toBe(DELETED_USER_SENTINEL);
        expect(mr!.reversal_admin_id).toBeNull();

        // anonymous_identities.server_nickname scrubbed for the merge-linked id.
        // server_nickname is NOT NULL + UNIQUE per (guild_id, LOWER(nickname)) /
        // (room_id, LOWER(nickname)) (migration 059), so the service writes a
        // collision-proof `DELETED-<rowid>` tombstone rather than a bare sentinel.
        const anon = await db.get<{ server_nickname: string }>(
            'SELECT server_nickname FROM anonymous_identities WHERE id = ?', ctx.anonId,
        );
        expect(anon!.server_nickname).toMatch(/^DELETED-/);

        // score_reports: reporter → sentinel, resolver → NULL, moderation row kept.
        const sr = await db.get<{ reporter_discord_id: string; resolved_by: string | null }>(
            `SELECT * FROM score_reports WHERE score_id = 'some-score-id'`,
        );
        expect(sr).toBeTruthy();
        expect(sr!.reporter_discord_id).toBe(DELETED_USER_SENTINEL);
        expect(sr!.resolved_by).toBeNull();

        // global_scores row the user MODERATED: deleted_by scrubbed, owner untouched.
        const moderated = await db.get<{ deleted_by: string | null; player_id: string }>(
            `SELECT deleted_by, player_id FROM global_scores WHERE player_id = 'someoneelse'`,
        );
        expect(moderated).toBeTruthy();
        expect(moderated!.deleted_by).toBeNull();
        expect(moderated!.player_id).toBe('someoneelse');
    });

    it('user_bans KEEPS the subject row (abuse-prevention) and de-identifies the actor row', async () => {
        const db = await getDatabase();
        // Subject row: user was the banned party → row + subject id retained.
        const subject = await db.get<{ discord_user_id: string; banned_by: string }>(
            'SELECT discord_user_id, banned_by FROM user_bans WHERE discord_user_id = ?', ctx.user1,
        );
        expect(subject).toBeTruthy();
        expect(subject!.discord_user_id).toBe(ctx.user1);   // subject KEPT, not sentinel
        expect(subject!.banned_by).toBe('admin-actor');     // untouched
        // Actor row: user was the banning admin → actor columns de-identified, subject kept.
        const actor = await db.get<{ discord_user_id: string; banned_by: string; lifted_by: string | null }>(
            `SELECT discord_user_id, banned_by, lifted_by FROM user_bans WHERE discord_user_id = 'badguy'`,
        );
        expect(actor).toBeTruthy();
        expect(actor!.banned_by).toBe(DELETED_USER_SENTINEL);
        expect(actor!.lifted_by).toBeNull();
        expect(actor!.discord_user_id).toBe('badguy');
    });

    it('the load-bearing tombstone keeps its row; only its actor column is nulled', async () => {
        const db = await getDatabase();
        const supp = await db.get<{ suppressed_score: number; deleted_by_user_id: string | null }>(
            'SELECT * FROM deleted_score_suppressions WHERE game_id = ? AND iscored_username_lower = ?',
            ctx.gameId, 'playerone',
        );
        expect(supp).toBeTruthy();                       // row survives (deleting it resurrects the score)
        expect(supp!.suppressed_score).toBe(999);
        expect(supp!.deleted_by_user_id).toBeNull();
    });

    it('KEEP/SKIP tables are left entirely untouched', async () => {
        expect(await count(`SELECT COUNT(*) AS n FROM player_aliases WHERE old_username = 'oldhandle'`)).toBe(1);
        expect(await count(`SELECT COUNT(*) AS n FROM anon_room_claims WHERE anon_token = 'anon-token-xyz'`)).toBe(1);
        expect(await count(`SELECT COUNT(*) AS n FROM submission_drafts WHERE state_param = 'state-xyz'`)).toBe(1);
        // audit_log is append-only; the pre-existing row referencing the user stays.
        expect(await count('SELECT COUNT(*) AS n FROM audit_log WHERE actor = ?', ctx.user1)).toBe(1);
    });

    it('the three leaderboard/ranking caches are fully busted', async () => {
        expect(await count('SELECT COUNT(*) AS n FROM leaderboard_cache')).toBe(0);
        expect(await count('SELECT COUNT(*) AS n FROM global_leaderboard_cache')).toBe(0);
        expect(await count('SELECT COUNT(*) AS n FROM ranking_groups_cache')).toBe(0);
        expect(result.cachesBusted).toBeGreaterThan(0);
    });

    it('the result summary reflects the work done', async () => {
        expect(result.discordUserId).toBe(ctx.user1);
        expect(Array.isArray(result.tablesAffected)).toBe(true);
        expect(result.tablesAffected.length).toBeGreaterThan(0);
        expect(result.rowsDeleted).toBeGreaterThan(0);
        expect(result.rowsAnonymized).toBeGreaterThan(0);
        // user1 was the sole admin of the room → flagged.
        expect(result.roomsLeftAdminless).toContain(ctx.roomId);
    });

    it('(c) user2 data is completely untouched (rows + attribution + photo file)', async () => {
        const db = await getDatabase();

        // Identity / session / social rows all survive.
        expect(await count('SELECT COUNT(*) AS n FROM user_profiles WHERE discord_user_id = ?', ctx.user2)).toBe(1);
        expect(await count('SELECT COUNT(*) AS n FROM user_mappings WHERE discord_user_id = ?', ctx.user2)).toBe(1);
        expect(await count('SELECT COUNT(*) AS n FROM user_preferences WHERE discord_user_id = ?', ctx.user2)).toBe(1);
        expect(await count('SELECT COUNT(*) AS n FROM sessions WHERE discord_user_id = ?', ctx.user2)).toBe(1);
        expect(await count('SELECT COUNT(*) AS n FROM friendships WHERE user_id = ?', ctx.user2)).toBe(1);
        expect(await count('SELECT COUNT(*) AS n FROM game_comments WHERE user_id = ?', ctx.user2)).toBe(1);
        expect(await count('SELECT COUNT(*) AS n FROM game_ratings WHERE user_id = ?', ctx.user2)).toBe(1);
        expect(await count('SELECT COUNT(*) AS n FROM room_members WHERE user_id = ?', ctx.user2)).toBe(1);
        expect(await count('SELECT COUNT(*) AS n FROM lobby_feed_events WHERE player_id = ?', ctx.user2)).toBe(1);
        expect(await count(
            `SELECT COUNT(*) AS n FROM room_events WHERE event_data LIKE '%' || ? || '%'`, ctx.user2,
        )).toBe(1);

        // user2 score rows keep FULL attribution (nothing de-identified).
        const sub2 = await db.get<{ submitted_by_user_id: string | null; discord_user_id: string;
            iscored_username: string; photo_url: string | null }>(
            'SELECT * FROM submissions WHERE id = ?', `${ctx.gameId}-playertwo`,
        );
        expect(sub2).toBeTruthy();
        expect(sub2!.submitted_by_user_id).toBe(ctx.user2);        // NOT nulled
        expect(sub2!.discord_user_id).toBe(ctx.user2);             // NOT sentinel
        expect(sub2!.iscored_username).toBe('PlayerTwo');
        expect(sub2!.photo_url).toBe(ctx.photos.user2.url);        // photo ref intact
        const gs2 = await db.get<{ submitted_by_user_id: string | null; player_id: string }>(
            'SELECT * FROM global_scores WHERE global_game_id = ? AND iscored_username = ?', ctx.ggId, 'PlayerTwo',
        );
        expect(gs2!.submitted_by_user_id).toBe(ctx.user2);
        expect(gs2!.player_id).toBe(ctx.user2);
        expect(await count(
            'SELECT COUNT(*) AS n FROM score_history WHERE discord_user_id = ?', ctx.user2,
        )).toBe(1);
        expect(await count(
            'SELECT COUNT(*) AS n FROM community_scores WHERE discord_user_id = ?', ctx.user2,
        )).toBe(1);

        // user2's proof-photo file on disk survives the purge.
        expect(fs.existsSync(ctx.photos.user2.abs)).toBe(true);
    });

    it('is idempotent — a second run for the same user affects zero rows', async () => {
        const again = await AccountDeletionService.anonymizeUser(ctx.user1, { actor: 'self' });
        expect(again.rowsDeleted).toBe(0);
        expect(again.rowsAnonymized).toBe(0);
        expect(again.photosDeleted).toBe(0);
    });
});

// ============================================================================
// Last-super-admin precondition guard
// ============================================================================
describe('S12 — last-super-admin guard', () => {
    it('throws LastSuperAdminError and deletes nothing when the target is the only super admin', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const only = 'sole-super-' + crypto.randomUUID();
        await db.run(`INSERT INTO super_admins (discord_user_id) VALUES (?)`, only);
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, display_name) VALUES (?, 'Sole')`, only,
        );

        await expect(
            AccountDeletionService.anonymizeUser(only, { actor: 'admin', actorDiscordId: only }),
        ).rejects.toBeInstanceOf(LastSuperAdminError);

        // Pre-tx guard → nothing was deleted.
        expect(await count('SELECT COUNT(*) AS n FROM super_admins WHERE discord_user_id = ?', only)).toBe(1);
        expect(await count('SELECT COUNT(*) AS n FROM user_profiles WHERE discord_user_id = ?', only)).toBe(1);
    });

    it('succeeds when another super admin exists (not the last one)', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const target = 'super-a-' + crypto.randomUUID();
        await db.run(`INSERT INTO super_admins (discord_user_id) VALUES (?)`, target);
        await db.run(`INSERT INTO super_admins (discord_user_id) VALUES ('super-b-keeper')`);
        await db.run(`INSERT INTO user_profiles (discord_user_id, display_name) VALUES (?, 'A')`, target);

        const res = await AccountDeletionService.anonymizeUser(target, { actor: 'admin', actorDiscordId: 'super-b-keeper' });
        expect(res.discordUserId).toBe(target);
        expect(await count('SELECT COUNT(*) AS n FROM super_admins WHERE discord_user_id = ?', target)).toBe(0);
        expect(await count(`SELECT COUNT(*) AS n FROM super_admins WHERE discord_user_id = 'super-b-keeper'`)).toBe(1);
    });
});

// ============================================================================
// (d) — route authorization
// ============================================================================
describe('S12 — DELETE routes are authorization-gated', () => {
    // Mount the real global + admin routers (admin.ts applies requireAuth +
    // requireSuperAdmin at the router level) so the authz behavior under test is
    // the production middleware chain, not a stub.
    async function createApp() {
        await setupTestDb();
        const app = express();
        app.set('trust proxy', 1);
        app.use(express.json());
        // Mirror server.ts: correlationId runs before the routers so req.correlationId
        // is defined when the DELETE handlers write their explicit audit_log row.
        const { correlationId } = await import('../api/correlationId.js');
        app.use(correlationId);
        const { default: adminRouter } = await import('../api/routes/admin.js');
        const { default: globalRouter } = await import('../api/routes/global.js');
        app.use('/api/admin', adminRouter);
        app.use('/api', globalRouter);
        return app;
    }

    const playerToken = (discordId: string) => signToken({ role: 'player', gameRoomIds: [], discordId });
    const roomAdminToken = (discordId: string, roomId: string) =>
        signToken({ role: 'room_admin', gameRoomIds: [roomId], discordId });
    const superToken = (discordId: string) => signToken({ role: 'super_admin', gameRoomIds: [], discordId });

    async function seedProfile(discordId: string, name: string): Promise<void> {
        const db = await getDatabase();
        await db.run(`INSERT INTO user_profiles (discord_user_id, display_name) VALUES (?, ?)`, discordId, name);
    }

    it('DELETE /api/me/account requires a Discord token (401 when anonymous)', async () => {
        const app = await createApp();
        const res = await request(app).delete('/api/me/account');
        expect(res.status).toBe(401);
    });

    it('DELETE /api/me/account deletes only the caller — not other users', async () => {
        const app = await createApp();
        const me = 'me-' + crypto.randomUUID();
        const other = 'other-' + crypto.randomUUID();
        await seedProfile(me, 'Me');
        await seedProfile(other, 'Other');

        const res = await request(app)
            .delete('/api/me/account')
            .set('Authorization', `Bearer ${playerToken(me)}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.discordUserId).toBe(me);

        // The caller's identity is gone; the bystander's is untouched (self-scope).
        expect(await count('SELECT COUNT(*) AS n FROM user_profiles WHERE discord_user_id = ?', me)).toBe(0);
        expect(await count('SELECT COUNT(*) AS n FROM user_profiles WHERE discord_user_id = ?', other)).toBe(1);
    });

    it('DELETE /api/admin/users/:id requires authentication (401 when anonymous)', async () => {
        const app = await createApp();
        const res = await request(app).delete(`/api/admin/users/${'victim-' + crypto.randomUUID()}`);
        expect(res.status).toBe(401);
    });

    it('DELETE /api/admin/users/:id rejects a non-super-admin player (403) and leaves the target intact', async () => {
        const app = await createApp();
        const target = 'target-' + crypto.randomUUID();
        await seedProfile(target, 'Target');

        const res = await request(app)
            .delete(`/api/admin/users/${target}`)
            .set('Authorization', `Bearer ${playerToken('rando-' + crypto.randomUUID())}`);
        expect(res.status).toBe(403);
        expect(await count('SELECT COUNT(*) AS n FROM user_profiles WHERE discord_user_id = ?', target)).toBe(1);
    });

    it('DELETE /api/admin/users/:id rejects a room_admin (403)', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('s12-authz-ra', 'S12 Authz RA');
        const target = 'target-' + crypto.randomUUID();
        await seedProfile(target, 'Target');

        const res = await request(app)
            .delete(`/api/admin/users/${target}`)
            .set('Authorization', `Bearer ${roomAdminToken('ra-' + crypto.randomUUID(), roomId)}`);
        expect(res.status).toBe(403);
        expect(await count('SELECT COUNT(*) AS n FROM user_profiles WHERE discord_user_id = ?', target)).toBe(1);
    });

    it('DELETE /api/admin/users/:id lets a super-admin anonymize the target (200)', async () => {
        const app = await createApp();
        const db = await getDatabase();
        const actor = 'super-' + crypto.randomUUID();
        const target = 'target-' + crypto.randomUUID();
        await db.run(`INSERT INTO super_admins (discord_user_id) VALUES (?)`, actor);
        await seedProfile(target, 'Target');

        const res = await request(app)
            .delete(`/api/admin/users/${target}`)
            .set('Authorization', `Bearer ${superToken(actor)}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.discordUserId).toBe(target);

        // Target erased; the acting super-admin is untouched.
        expect(await count('SELECT COUNT(*) AS n FROM user_profiles WHERE discord_user_id = ?', target)).toBe(0);
        expect(await count('SELECT COUNT(*) AS n FROM super_admins WHERE discord_user_id = ?', actor)).toBe(1);
    });

    it('DELETE /api/admin/users/:id returns 409 when the target is the last super admin', async () => {
        const app = await createApp();
        const db = await getDatabase();
        const soleSuper = 'sole-' + crypto.randomUUID();
        // Exactly one super-admin row — the actor deleting themselves.
        await db.run(`INSERT INTO super_admins (discord_user_id) VALUES (?)`, soleSuper);
        await seedProfile(soleSuper, 'Sole');

        const res = await request(app)
            .delete(`/api/admin/users/${soleSuper}`)
            .set('Authorization', `Bearer ${superToken(soleSuper)}`);
        expect(res.status).toBe(409);
        // Guarded before the transaction — the account is still fully present.
        expect(await count('SELECT COUNT(*) AS n FROM super_admins WHERE discord_user_id = ?', soleSuper)).toBe(1);
        expect(await count('SELECT COUNT(*) AS n FROM user_profiles WHERE discord_user_id = ?', soleSuper)).toBe(1);
    });
});
