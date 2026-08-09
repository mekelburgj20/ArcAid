import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';

/**
 * Ban → content cascade + Ban → Discord DM (ROADMAP "Player Self-Service +
 * Moderation" §C, "Ban → content cascade" / "Ban → Discord notification").
 *
 * We mock ../utils/discord.js so `sendDirectMessage` (used by
 * `BanNotificationService`, itself called from `ScoreReportService.ban`) is
 * a spy instead of a real Discord REST call. Same idiom as
 * s6-notifications.test.ts.
 */

const sentDMs: Array<{ userId: string; content: string }> = [];
let dmShouldThrow = false;

vi.mock('../utils/discord.js', () => ({
    sendDirectMessage: vi.fn(async (userId: string, content: string) => {
        if (dmShouldThrow) throw new Error('simulated Discord REST failure');
        sentDMs.push({ userId, content });
        return true;
    }),
}));

import { ScoreReportService } from '../services/ScoreReportService.js';
import { CommentService } from '../services/CommentService.js';
import { GlobalCommentService } from '../services/GlobalCommentService.js';

const DISCORD_A = '111111111111111111';
const DISCORD_B = '222222222222222222';
const DISCORD_LINKED = '333333333333333333';

async function seedRoomContent(gameRoomId: string, discordUserId: string, gameId: string) {
    const db = await getDatabase();
    // submissions.id is keyed on (gameId, username) — vary by identity so two
    // different discordUserIds seeded against the same game don't collide.
    const username = `CascadeTester${discordUserId.slice(-4)}`;

    await db.run(
        `INSERT INTO submissions (id, game_id, discord_user_id, iscored_username, score, timestamp, submitted_from_room_id, submitted_by_user_id)
         VALUES (?, ?, 'SYSTEM', ?, 1000, datetime('now'), ?, ?)`,
        `${gameId}-${username.toLowerCase()}`, gameId, username, gameRoomId, discordUserId,
    );
    const community = await db.run(
        `INSERT INTO community_scores (game_name, game_room_id, iscored_username, score, submitted_by_user_id)
         VALUES ('Cascade Game', ?, ?, 500, ?)`,
        gameRoomId, username, discordUserId,
    );
    const history = await db.run(
        `INSERT INTO score_history (game_name, game_room_id, game_id, iscored_username, score, source, submitted_by_user_id)
         VALUES ('Cascade Game', ?, ?, ?, 750, 'tournament', ?)`,
        gameRoomId, gameId, username, discordUserId,
    );
    const comment = await db.run(
        `INSERT INTO game_comments (game_name, game_room_id, user_id, display_name, type, body)
         VALUES ('Cascade Game', ?, ?, 'Cascade Tester', 'comment', 'hello world')`,
        gameRoomId, discordUserId,
    );
    return {
        submissionId: `${gameId}-${username.toLowerCase()}`,
        communityId: community.lastID as number,
        historyId: history.lastID as number,
        commentId: comment.lastID as number,
    };
}

async function makeGlobalGame(): Promise<string> {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_games (id, name, type, status) VALUES (?, 'Cascade Global Game', 'pinball', 'approved')`,
        id,
    );
    return id;
}

async function seedGlobalComment(discordUserId: string, globalGameId: string) {
    const db = await getDatabase();
    const result = await db.run(
        `INSERT INTO global_game_comments (global_game_id, discord_user_id, display_name, type, body)
         VALUES (?, ?, 'Cascade Tester', 'comment', 'global hello')`,
        globalGameId, discordUserId,
    );
    return result.lastID as number;
}

async function makeGame(roomId: string): Promise<string> {
    const db = await getDatabase();
    const tournamentId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id)
         VALUES (?, 'Cascade Tournament', 'DG', 'pinball', '{}', 1, ?)`,
        tournamentId, roomId,
    );
    const gameId = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, start_date)
         VALUES (?, ?, 'Cascade Game', 'ACTIVE', datetime('now'))`,
        gameId, tournamentId,
    );
    return gameId;
}

describe('Ban → content cascade + DM', () => {
    beforeEach(async () => {
        await setupTestDb();
        sentDMs.length = 0;
        dmShouldThrow = false;
    });

    it('migration sanity: ban_content_actions table + comment hidden_at columns exist', async () => {
        const db = await getDatabase();
        await expect(db.all('SELECT * FROM ban_content_actions LIMIT 1')).resolves.toEqual([]);
        const gcCols = await db.all<Array<{ name: string }>>('PRAGMA table_info(game_comments)');
        expect(gcCols.some(c => c.name === 'hidden_at')).toBe(true);
        const ggcCols = await db.all<Array<{ name: string }>>('PRAGMA table_info(global_game_comments)');
        expect(ggcCols.some(c => c.name === 'hidden_at')).toBe(true);
    });

    it('room ban with contentAction=hide: hides that room\'s rows only, records ban_content_actions, leaves other rooms + global comments untouched', async () => {
        const roomA = await createTestRoom('room-a', 'Room A');
        const roomB = await createTestRoom('room-b', 'Room B');
        const gameA = await makeGame(roomA);
        const gameB = await makeGame(roomB);

        const rowsA = await seedRoomContent(roomA, DISCORD_A, gameA);
        const rowsB = await seedRoomContent(roomB, DISCORD_A, gameB); // same identity, OTHER room
        const globalGameId = await makeGlobalGame();
        const globalCommentId = await seedGlobalComment(DISCORD_A, globalGameId);

        const ban = await ScoreReportService.ban(DISCORD_A, 'admin-1', null, 'spamming', roomA, 'hide');

        const db = await getDatabase();
        const sub = await db.get('SELECT orphaned_at FROM submissions WHERE id = ?', rowsA.submissionId);
        const comm = await db.get('SELECT orphaned_at FROM community_scores WHERE id = ?', rowsA.communityId);
        const hist = await db.get('SELECT orphaned_at FROM score_history WHERE id = ?', rowsA.historyId);
        const cmt = await db.get('SELECT hidden_at FROM game_comments WHERE id = ?', rowsA.commentId);
        expect(sub.orphaned_at).toBeTruthy();
        expect(comm.orphaned_at).toBeTruthy();
        expect(hist.orphaned_at).toBeTruthy();
        expect(cmt.hidden_at).toBeTruthy();

        // Room B (different room, same identity) untouched.
        const subB = await db.get('SELECT orphaned_at FROM submissions WHERE id = ?', rowsB.submissionId);
        const commB = await db.get('SELECT orphaned_at FROM community_scores WHERE id = ?', rowsB.communityId);
        const histB = await db.get('SELECT orphaned_at FROM score_history WHERE id = ?', rowsB.historyId);
        const cmtB = await db.get('SELECT hidden_at FROM game_comments WHERE id = ?', rowsB.commentId);
        expect(subB.orphaned_at).toBeNull();
        expect(commB.orphaned_at).toBeNull();
        expect(histB.orphaned_at).toBeNull();
        expect(cmtB.hidden_at).toBeNull();

        // Global comments are never touched by a room-scoped ban.
        const globalCmt = await db.get('SELECT hidden_at FROM global_game_comments WHERE id = ?', globalCommentId);
        expect(globalCmt.hidden_at).toBeNull();

        const actions = await db.all('SELECT table_name, action FROM ban_content_actions WHERE ban_id = ?', ban.id);
        expect(actions.length).toBe(4); // submissions, community_scores, score_history, game_comments (room A only)
        expect(actions.every((a: { action: string }) => a.action === 'hide')).toBe(true);
    });

    it('comments hidden by a ban are excluded from CommentService/GlobalCommentService public reads', async () => {
        const roomA = await createTestRoom('room-comments', 'Room Comments');
        const gameA = await makeGame(roomA);
        const rows = await seedRoomContent(roomA, DISCORD_A, gameA);
        const globalGameId = await makeGlobalGame();
        const globalCommentId = await seedGlobalComment(DISCORD_A, globalGameId);

        let comments = await CommentService.getComments(roomA, 'Cascade Game');
        expect(comments.some((c: { id: number }) => c.id === rows.commentId)).toBe(true);
        let globalComments = await GlobalCommentService.getComments(globalGameId);
        expect(globalComments.some(c => c.id === globalCommentId)).toBe(true);

        // Global ban sweeps both room comments AND global comments.
        await ScoreReportService.ban(DISCORD_A, 'admin-1', null, 'spam', null, 'hide');

        comments = await CommentService.getComments(roomA, 'Cascade Game');
        expect(comments.some((c: { id: number }) => c.id === rows.commentId)).toBe(false);
        globalComments = await GlobalCommentService.getComments(globalGameId);
        expect(globalComments.some(c => c.id === globalCommentId)).toBe(false);
    });

    it('global ban with contentAction=hide cascades across every room + global comments', async () => {
        const roomA = await createTestRoom('room-global-a', 'Room Global A');
        const roomB = await createTestRoom('room-global-b', 'Room Global B');
        const gameA = await makeGame(roomA);
        const gameB = await makeGame(roomB);
        const rowsA = await seedRoomContent(roomA, DISCORD_A, gameA);
        const rowsB = await seedRoomContent(roomB, DISCORD_A, gameB);
        const globalGameId = await makeGlobalGame();
        const globalCommentId = await seedGlobalComment(DISCORD_A, globalGameId);

        await ScoreReportService.ban(DISCORD_A, 'admin-1', null, 'global spam', null, 'hide');

        const db = await getDatabase();
        for (const rows of [rowsA, rowsB]) {
            const sub = await db.get('SELECT orphaned_at FROM submissions WHERE id = ?', rows.submissionId);
            expect(sub.orphaned_at).toBeTruthy();
        }
        const globalCmt = await db.get('SELECT hidden_at FROM global_game_comments WHERE id = ?', globalCommentId);
        expect(globalCmt.hidden_at).toBeTruthy();
    });

    it('contentAction=leave makes no changes and records nothing', async () => {
        const roomA = await createTestRoom('room-leave', 'Room Leave');
        const gameA = await makeGame(roomA);
        const rows = await seedRoomContent(roomA, DISCORD_A, gameA);

        const ban = await ScoreReportService.ban(DISCORD_A, 'admin-1', null, 'reason', roomA, 'leave');

        const db = await getDatabase();
        const sub = await db.get('SELECT orphaned_at FROM submissions WHERE id = ?', rows.submissionId);
        expect(sub.orphaned_at).toBeNull();
        const actions = await db.all('SELECT * FROM ban_content_actions WHERE ban_id = ?', ban.id);
        expect(actions.length).toBe(0);
    });

    it('contentAction=delete hard-deletes rows, tombstones score_history for the sync poller, and is NOT restorable on lift', async () => {
        const roomA = await createTestRoom('room-delete', 'Room Delete');
        const gameA = await makeGame(roomA);
        const rows = await seedRoomContent(roomA, DISCORD_A, gameA);

        const ban = await ScoreReportService.ban(DISCORD_A, 'admin-1', null, 'hard offense', roomA, 'delete');

        const db = await getDatabase();
        expect(await db.get('SELECT * FROM submissions WHERE id = ?', rows.submissionId)).toBeUndefined();
        expect(await db.get('SELECT * FROM community_scores WHERE id = ?', rows.communityId)).toBeUndefined();
        expect(await db.get('SELECT * FROM score_history WHERE id = ?', rows.historyId)).toBeUndefined();
        expect(await db.get('SELECT * FROM game_comments WHERE id = ?', rows.commentId)).toBeUndefined();

        const actions = await db.all<Array<{ action: string }>>('SELECT action FROM ban_content_actions WHERE ban_id = ?', ban.id);
        expect(actions.length).toBe(4);
        expect(actions.every(a => a.action === 'delete')).toBe(true);

        const tombstone = await db.get(
            'SELECT suppressed_score FROM deleted_score_suppressions WHERE game_id = ? AND iscored_username_lower = ?',
            gameA, `cascadetester${DISCORD_A.slice(-4)}`,
        );
        expect(tombstone).toBeTruthy();
        expect(tombstone.suppressed_score).toBe(750);

        // Lifting does NOT restore deleted content.
        const result = await ScoreReportService.lift(ban.id, 'admin-1');
        expect(result.lifted).toBe(true);
        expect(result.restoredCount).toBe(0);
        expect(await db.get('SELECT * FROM submissions WHERE id = ?', rows.submissionId)).toBeUndefined();
        // 'delete' action rows remain as a permanent (non-restorable) audit trail.
        const remainingActions = await db.all('SELECT * FROM ban_content_actions WHERE ban_id = ?', ban.id);
        expect(remainingActions.length).toBe(4);
    });

    it('lifting a hide-ban restores exactly that ban\'s hidden rows, and restoredCount matches', async () => {
        const roomA = await createTestRoom('room-restore', 'Room Restore');
        const gameA = await makeGame(roomA);
        const rows = await seedRoomContent(roomA, DISCORD_A, gameA);

        const ban = await ScoreReportService.ban(DISCORD_A, 'admin-1', null, 'reason', roomA, 'hide');

        const db = await getDatabase();
        const beforeLift = await db.get('SELECT orphaned_at FROM submissions WHERE id = ?', rows.submissionId);
        expect(beforeLift.orphaned_at).toBeTruthy();

        const result = await ScoreReportService.lift(ban.id, 'admin-1');
        expect(result.lifted).toBe(true);
        expect(result.restoredCount).toBe(4);

        const sub = await db.get('SELECT orphaned_at FROM submissions WHERE id = ?', rows.submissionId);
        const comm = await db.get('SELECT orphaned_at FROM community_scores WHERE id = ?', rows.communityId);
        const hist = await db.get('SELECT orphaned_at FROM score_history WHERE id = ?', rows.historyId);
        const cmt = await db.get('SELECT hidden_at FROM game_comments WHERE id = ?', rows.commentId);
        expect(sub.orphaned_at).toBeNull();
        expect(comm.orphaned_at).toBeNull();
        expect(hist.orphaned_at).toBeNull();
        expect(cmt.hidden_at).toBeNull();

        // The 'hide' tracking rows are consumed on restore.
        const remaining = await db.all('SELECT * FROM ban_content_actions WHERE ban_id = ?', ban.id);
        expect(remaining.length).toBe(0);
    });

    it('lifting one ban only restores THAT ban\'s hidden rows — a separate active ban (different identity) is untouched', async () => {
        // Two DIFFERENT identities in the same room so the two bans' cascade
        // match-sets never overlap — isolates "does restore only touch rows
        // THIS ban_id's ban_content_actions recorded" from "does a fresh ban
        // re-sweep whatever's currently visible" (a different, also-true
        // property covered by the room-vs-room isolation test above).
        const roomA = await createTestRoom('room-two-bans', 'Room Two Bans');
        const gameA = await makeGame(roomA);
        const rows1 = await seedRoomContent(roomA, DISCORD_A, gameA);
        const rows2 = await seedRoomContent(roomA, DISCORD_B, gameA);

        const ban1 = await ScoreReportService.ban(DISCORD_A, 'admin-1', null, 'first offense', roomA, 'hide');
        const ban2 = await ScoreReportService.ban(DISCORD_B, 'admin-1', null, 'second offense', roomA, 'hide');

        const db = await getDatabase();
        const sub1Hidden = await db.get('SELECT orphaned_at FROM submissions WHERE id = ?', rows1.submissionId);
        const sub2Hidden = await db.get('SELECT orphaned_at FROM submissions WHERE id = ?', rows2.submissionId);
        expect(sub1Hidden.orphaned_at).toBeTruthy();
        expect(sub2Hidden.orphaned_at).toBeTruthy();

        // Lift ONLY ban1.
        const result1 = await ScoreReportService.lift(ban1.id, 'admin-1');
        expect(result1.restoredCount).toBe(4);

        const sub1 = await db.get('SELECT orphaned_at FROM submissions WHERE id = ?', rows1.submissionId);
        expect(sub1.orphaned_at).toBeNull();
        // ban2's identity (DISCORD_B) is still banned and its rows still hidden.
        const sub2 = await db.get('SELECT orphaned_at FROM submissions WHERE id = ?', rows2.submissionId);
        expect(sub2.orphaned_at).toBeTruthy();

        const result2 = await ScoreReportService.lift(ban2.id, 'admin-1');
        expect(result2.restoredCount).toBe(4);
    });

    // --- Ban -> Discord DM ---

    it('ban() sends a pref-bypassing DM naming scope, reason, and expiry for a Discord identity', async () => {
        const roomA = await createTestRoom('room-dm', 'DM Test Room');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        await ScoreReportService.ban(DISCORD_A, 'admin-1', 7, 'toxic behavior', roomA, 'leave');

        expect(sentDMs.length).toBe(1);
        expect(sentDMs[0].userId).toBe(DISCORD_A);
        expect(sentDMs[0].content).toContain('DM Test Room');
        expect(sentDMs[0].content).toContain('toxic behavior');
        // Expiry is date-formatted, not a raw ISO string — just assert it's not "permanent".
        expect(sentDMs[0].content.toLowerCase()).not.toContain('permanent');
        void expiresAt;
    });

    it('a permanent global ban DMs "all of Arcaid" and says permanent', async () => {
        await ScoreReportService.ban(DISCORD_B, 'admin-1', null, undefined, null, 'leave');
        expect(sentDMs.length).toBe(1);
        expect(sentDMs[0].content).toContain('all of Arcaid');
        expect(sentDMs[0].content.toLowerCase()).toContain('permanent');
        expect(sentDMs[0].content).toContain('No reason given');
    });

    it('banning a google:* identity with NO linked Discord account skips the DM silently', async () => {
        await ScoreReportService.ban('google:no-link-user', 'admin-1', null, 'reason', null, 'leave');
        expect(sentDMs.length).toBe(0);
    });

    it('banning a google:* identity WITH a linked Discord account DMs the linked Discord id', async () => {
        const db = await getDatabase();
        await db.run(
            'INSERT INTO user_identity_links (provider_user_id, canonical_user_id) VALUES (?, ?)',
            'google:test-linked', DISCORD_LINKED,
        );
        await ScoreReportService.ban('google:test-linked', 'admin-1', null, 'reason', null, 'leave');
        expect(sentDMs.length).toBe(1);
        expect(sentDMs[0].userId).toBe(DISCORD_LINKED);
    });

    it('a DM failure never fails the ban itself', async () => {
        dmShouldThrow = true;
        const ban = await ScoreReportService.ban(DISCORD_A, 'admin-1', null, 'reason', null, 'leave');
        expect(ban).toBeTruthy();
        expect(ban.discord_user_id).toBe(DISCORD_A);
        expect(sentDMs.length).toBe(0); // the throw prevented the push, but ban() itself didn't throw
    });
});
