import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { LobbyFeedGenerator } from '../services/LobbyFeedGenerator.js';
import { Scheduler } from '../engine/Scheduler.js';

/**
 * S14 social loops (WP4) — FriendsService follow-by-id + legacy follow-by-username
 * routes (global.ts, mounted bare at /api per the api-auth.test.ts precedent),
 * StatsService.comparePlayersHeadToHead + getParticipationStreak (rooms.ts, mounted
 * at /api/rooms per the room-scores.test.ts / s13-achievements.test.ts precedent),
 * the LobbyFeedGenerator weekly streak_extended feed event, and the Scheduler
 * staleness-challenge per-room worker.
 *
 * FriendsService has ZERO prior test coverage — this file sets the precedent.
 */
async function createTestApp() {
    await setupTestDb();

    const app = express();
    app.use(express.json());

    const { default: globalRouter } = await import('../api/routes/global.js');
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api', globalRouter);
    app.use('/api/rooms', roomsRouter);

    return app;
}

function playerToken(discordId: string) {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username: discordId });
}

/**
 * Direct score_history seeding — mirrors room-scores.test.ts's
 * insertScoreHistoryRow verbatim (the canonical column set for tests that need
 * explicit submitted_by_user_id / created_at, which createTestSubmission()
 * can't express).
 */
async function insertScoreHistoryRow(opts: {
    gameRoomId: string;
    gameName: string;
    iscoredUsername: string;
    score: number;
    discordUserId?: string | null;
    submittedByUserId?: string | null;
    source?: 'tournament' | 'community' | 'sync';
    orphanedAt?: string | null;
    createdAt?: string;
}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO score_history (
            game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source,
            submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id, orphaned_at, created_at
         ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        opts.gameName, opts.gameRoomId, opts.iscoredUsername,
        opts.discordUserId ?? 'SYSTEM', opts.score, opts.source ?? 'community',
        opts.gameRoomId, opts.submittedByUserId ?? null, opts.orphanedAt ?? null,
        opts.createdAt ?? new Date().toISOString(),
    );
}

/** Days-ago ISO timestamp, captured relative to a single reference instant so
 * offsets exactly 7 days apart are guaranteed consecutive by the SAME rule
 * the implementation itself uses to test consecutiveness (datetime(x,'+7 days')).
 */
function daysAgo(referenceMs: number, n: number): string {
    return new Date(referenceMs - n * 24 * 60 * 60 * 1000).toISOString();
}

// ===========================================================================
// (a) FOLLOW BY ID + legacy follow-by-username
// ===========================================================================
describe('POST /api/me/friends', () => {
    it('follows a user seeded in user_profiles by friendUserId, creating a friendships row', async () => {
        const app = await createTestApp();
        const db = await getDatabase();
        const followerId = '100000000000000001';
        const targetId = '100000000000000002';
        await db.run('INSERT INTO user_profiles (discord_user_id, display_name) VALUES (?, ?)', targetId, 'TargetPlayer');

        const res = await request(app)
            .post('/api/me/friends')
            .set('Authorization', `Bearer ${playerToken(followerId)}`)
            .send({ friendUserId: targetId });

        expect(res.status).toBe(201);
        expect(res.body.friendUserId).toBe(targetId);

        const row = await db.get('SELECT * FROM friendships WHERE user_id = ? AND friend_user_id = ?', followerId, targetId);
        expect(row).toBeTruthy();
        expect(row.status).toBe('active');
    });

    it('rejects self-follow with 400', async () => {
        const app = await createTestApp();
        const selfId = '100000000000000003';

        const res = await request(app)
            .post('/api/me/friends')
            .set('Authorization', `Bearer ${playerToken(selfId)}`)
            .send({ friendUserId: selfId });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/yourself/i);
    });

    it('returns 404 for an unknown friendUserId (no user_profiles or user_mappings row)', async () => {
        const app = await createTestApp();
        const followerId = '100000000000000004';

        const res = await request(app)
            .post('/api/me/friends')
            .set('Authorization', `Bearer ${playerToken(followerId)}`)
            .send({ friendUserId: '999999999999999999' });

        expect(res.status).toBe(404);
    });

    it('repeat follow is idempotent — status active, no duplicate row', async () => {
        const app = await createTestApp();
        const db = await getDatabase();
        const followerId = '100000000000000005';
        const targetId = '100000000000000006';
        await db.run('INSERT INTO user_profiles (discord_user_id, display_name) VALUES (?, ?)', targetId, 'RepeatTarget');

        const first = await request(app)
            .post('/api/me/friends')
            .set('Authorization', `Bearer ${playerToken(followerId)}`)
            .send({ friendUserId: targetId });
        expect(first.status).toBe(201);

        const second = await request(app)
            .post('/api/me/friends')
            .set('Authorization', `Bearer ${playerToken(followerId)}`)
            .send({ friendUserId: targetId });
        expect(second.status).toBe(201);

        const rows = await db.all('SELECT * FROM friendships WHERE user_id = ? AND friend_user_id = ?', followerId, targetId);
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('active');
    });

    it('legacy {discordUsername} path still works (non-regression) — resolves via user_mappings alias', async () => {
        const app = await createTestApp();
        const db = await getDatabase();
        const followerId = '100000000000000007';
        const targetId = '100000000000000008';
        await db.run(
            'INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, ?)',
            targetId, 'LegacyAlias'
        );

        const res = await request(app)
            .post('/api/me/friends')
            .set('Authorization', `Bearer ${playerToken(followerId)}`)
            .send({ discordUsername: 'LegacyAlias' });

        expect(res.status).toBe(201);
        expect(res.body.friendUserId).toBe(targetId);

        const row = await db.get('SELECT * FROM friendships WHERE user_id = ? AND friend_user_id = ?', followerId, targetId);
        expect(row).toBeTruthy();
        expect(row.status).toBe('active');
    });

    // Unlinked-player affordances (ROADMAP, S14 field-testing follow-up), part
    // (b) — FriendsService.addFriend now distinguishes "no such player
    // anywhere" from "this name belongs to a real player who just hasn't
    // linked Discord yet", mirroring the room_members fallback used by the
    // enhanced-stats resolvers below.
    it('returns 404 "No player found" when the name matches nobody at all', async () => {
        const app = await createTestApp();
        const followerId = '100000000000000009';

        const res = await request(app)
            .post('/api/me/friends')
            .set('Authorization', `Bearer ${playerToken(followerId)}`)
            .send({ discordUsername: 'NobodyEverHeardOf' });

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/No player found/i);
        expect(res.body.error).not.toMatch(/linked a Discord/i);
    });

    it('returns distinct 404 copy when the name is a room_members claim only (unlinked)', async () => {
        const app = await createTestApp();
        const db = await getDatabase();
        const roomId = await createTestRoom();
        const followerId = '100000000000000010';
        const unlinkedUser = '100000000000000011';
        await db.run(
            `INSERT INTO room_members (user_id, room_id, source, display_name) VALUES (?, ?, 'submission', ?)`,
            unlinkedUser, roomId, 'UnlinkedNick'
        );

        const res = await request(app)
            .post('/api/me/friends')
            .set('Authorization', `Bearer ${playerToken(followerId)}`)
            .send({ discordUsername: 'UnlinkedNick' });

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/hasn't linked a Discord account/i);
    });

    it('returns distinct 404 copy when the name only has a submissions row (pure iScored sync, unlinked)', async () => {
        const app = await createTestApp();
        const db = await getDatabase();
        const followerId = '100000000000000012';

        await db.run(
            `INSERT INTO submissions (id, game_id, discord_user_id, iscored_username, score, timestamp)
             VALUES (?, NULL, 'SYSTEM', ?, 1000, ?)`,
            'sub-unlinked-friend-test', 'PureSyncName', new Date().toISOString()
        );

        const res = await request(app)
            .post('/api/me/friends')
            .set('Authorization', `Bearer ${playerToken(followerId)}`)
            .send({ discordUsername: 'PureSyncName' });

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/hasn't linked a Discord account/i);
    });
});

// ===========================================================================
// (b) COMPARE — head-to-head player comparison
// ===========================================================================
describe('GET /:roomId/stats/compare', () => {
    it('2 shared games (with alias collapse) + 1 exclusive each, correct leader/gap/totals', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const playerA = '200000000000000001';
        const playerB = '200000000000000002';

        // G1 (shared): plain rows, A leads.
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Medieval Madness', iscoredUsername: 'AliceMain',
            submittedByUserId: playerA, score: 5000,
        });
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Medieval Madness', iscoredUsername: 'BobMain',
            submittedByUserId: playerB, score: 3000,
        });

        // G2 (shared): player A has TWO aliases sharing one submitted_by_user_id.
        // The OLDER alias holds the higher (winning) score — proves the canonical
        // partition collapses aliases to ONE best-per-player row via score DESC,
        // not via recency.
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Twilight Zone', iscoredUsername: 'AliceOld',
            submittedByUserId: playerA, score: 9000, createdAt: new Date(Date.now() - 10 * 86400000).toISOString(),
        });
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Twilight Zone', iscoredUsername: 'AliceNewer',
            submittedByUserId: playerA, score: 4000, createdAt: new Date(Date.now() - 1 * 86400000).toISOString(),
        });
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Twilight Zone', iscoredUsername: 'BobMain',
            submittedByUserId: playerB, score: 7000,
        });

        // G3 (A only).
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Attack from Mars', iscoredUsername: 'AliceMain',
            submittedByUserId: playerA, score: 4200,
        });

        // G4 (B only).
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Fish Tales', iscoredUsername: 'BobMain',
            submittedByUserId: playerB, score: 3300,
        });

        const res = await request(app).get(`/api/rooms/${roomId}/stats/compare`).query({ a: playerA, b: playerB });

        expect(res.status).toBe(200);
        expect(res.body.a.discordUserId).toBe(playerA);
        expect(res.body.b.discordUserId).toBe(playerB);

        expect(res.body.sharedGames).toHaveLength(2);
        const mm = res.body.sharedGames.find((g: any) => g.game_name === 'Medieval Madness');
        expect(mm).toMatchObject({ a_best: 5000, b_best: 3000, leader: 'a', gap: 2000 });

        const tz = res.body.sharedGames.find((g: any) => g.game_name === 'Twilight Zone');
        // Alias collapse: A's best on Twilight Zone is 9000 (from the OLDER alias),
        // not 4000 (the newer one) — proves score DESC wins, not recency.
        expect(tz).toMatchObject({ a_best: 9000, b_best: 7000, leader: 'a', gap: 2000 });

        expect(res.body.aOnlyGames).toBe(1);
        expect(res.body.bOnlyGames).toBe(1);
        expect(res.body.totals).toEqual({ aWins: 2, bWins: 0, ties: 0 });
    });

    it('returns 400 when a and b are the same identifier', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const playerA = '200000000000000003';

        const res = await request(app).get(`/api/rooms/${roomId}/stats/compare`).query({ a: playerA, b: playerA });

        expect(res.status).toBe(400);
    });

    // Regression — rtx_pinball field report 2026-07-15: two players on the SAME
    // leaderboard compared as "no shared games". A Discord-linked player's rows
    // synced from iScored BEFORE the link carry submitted_by_user_id NULL, so
    // they keyed as 'iscored:<alias>' — a key the resolver never produces for a
    // mapped name. The three-leg key (submitted_by_user_id → user_mappings →
    // synthetic) folds those rows back into the mapped user.
    it('folds NULL-attribution rows of a Discord-linked alias into the mapped user (field-report shape)', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const db = await getDatabase();
        const playerB = '200000000000000010';

        // B is Discord-linked under the alias 'MekMain'.
        await db.run(
            'INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, ?)',
            playerB, 'MekMain'
        );
        // B's attributed (web) row.
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Fish Tales', iscoredUsername: 'MekMain',
            submittedByUserId: playerB, score: 3300,
        });
        // B's PRE-LINK synced row: NULL attribution, alias only. Pre-fix this
        // keyed as 'iscored:mekmain' and was invisible when comparing B.
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Space Shuttle Deluxe', iscoredUsername: 'MekMain',
            submittedByUserId: null, score: 90000, source: 'sync',
        });
        // A is UNLINKED: a pure synced row under an unmapped alias.
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Space Shuttle Deluxe', iscoredUsername: 'ArcAidAlt',
            submittedByUserId: null, score: 1000000, source: 'sync',
        });

        // a by unmapped NAME, b by snowflake — the prod shapes.
        const res = await request(app).get(`/api/rooms/${roomId}/stats/compare`)
            .query({ a: 'ArcAidAlt', b: playerB });

        expect(res.status).toBe(200);
        expect(res.body.sharedGames).toHaveLength(1);
        expect(res.body.sharedGames[0]).toMatchObject({
            game_name: 'Space Shuttle Deluxe', a_best: 1000000, b_best: 90000, leader: 'a',
        });
        expect(res.body.aOnlyGames).toBe(0);
        expect(res.body.bOnlyGames).toBe(1); // Fish Tales
        expect(res.body.totals).toEqual({ aWins: 1, bWins: 0, ties: 0 });
    });

    it('mapped-alias NAME input and its snowflake input produce the same cluster', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const db = await getDatabase();
        const playerB = '200000000000000011';
        const other = '200000000000000012';

        await db.run(
            'INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, ?)',
            playerB, 'MekMain2'
        );
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Whirlwind', iscoredUsername: 'MekMain2',
            submittedByUserId: null, score: 500, source: 'sync',
        });
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Whirlwind', iscoredUsername: 'OtherGuy',
            submittedByUserId: other, score: 700,
        });

        const byName = await request(app).get(`/api/rooms/${roomId}/stats/compare`)
            .query({ a: 'MekMain2', b: other });
        const byId = await request(app).get(`/api/rooms/${roomId}/stats/compare`)
            .query({ a: playerB, b: other });

        expect(byName.status).toBe(200);
        expect(byId.status).toBe(200);
        expect(byName.body.sharedGames).toHaveLength(1);
        expect(byId.body.sharedGames).toHaveLength(1);
        expect(byName.body.sharedGames[0].a_best).toBe(500);
        expect(byId.body.sharedGames[0].a_best).toBe(500);
    });

    // v2.23.2 — room-nickname fallback. Discord OAuth login writes NO
    // user_mappings row: a web-native player's name exists only as their
    // room_members.display_name claim, so a NAME-typed compare previously
    // resolved to the synthetic 'iscored:<name>' key and missed every
    // Discord-attributed score they had.
    it('resolves a room-claimed nickname (no user_mappings row) to its Discord owner', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const db = await getDatabase();
        const webNative = '200000000000000020';
        const other = '200000000000000021';

        // The web submit flow's claim: room_members only, NO user_mappings row.
        await db.run(
            `INSERT INTO room_members (user_id, room_id, source, display_name) VALUES (?, ?, 'submission', ?)`,
            webNative, roomId, 'WebNick'
        );
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Space Shuttle Deluxe', iscoredUsername: 'WebNick',
            submittedByUserId: webNative, score: 1000000,
        });
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Space Shuttle Deluxe', iscoredUsername: 'OtherGuy2',
            submittedByUserId: other, score: 90000,
        });

        const res = await request(app).get(`/api/rooms/${roomId}/stats/compare`)
            .query({ a: 'WebNick', b: other });

        expect(res.status).toBe(200);
        expect(res.body.a.discordUserId).toBe(webNative);
        expect(res.body.sharedGames).toHaveLength(1);
        expect(res.body.sharedGames[0]).toMatchObject({
            game_name: 'Space Shuttle Deluxe', a_best: 1000000, b_best: 90000, leader: 'a',
        });
    });

    it('a global alias (user_mappings) outranks a same-name room nickname claim', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const db = await getDatabase();
        const aliasOwner = '200000000000000030';
        const nickOwner = '200000000000000031';
        const other = '200000000000000032';

        await db.run(
            'INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, ?)',
            aliasOwner, 'Contested'
        );
        await db.run(
            `INSERT INTO room_members (user_id, room_id, source, display_name) VALUES (?, ?, 'submission', ?)`,
            nickOwner, roomId, 'Contested'
        );
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Whirlwind', iscoredUsername: 'Contested',
            submittedByUserId: aliasOwner, score: 800,
        });
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Whirlwind', iscoredUsername: 'OtherGuy3',
            submittedByUserId: other, score: 900,
        });

        const res = await request(app).get(`/api/rooms/${roomId}/stats/compare`)
            .query({ a: 'Contested', b: other });

        expect(res.status).toBe(200);
        expect(res.body.a.discordUserId).toBe(aliasOwner); // global alias wins
        expect(res.body.sharedGames[0].a_best).toBe(800);
    });

    it('enhanced player stats by room-claimed nickname resolve the Discord identity (Follow gating)', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const db = await getDatabase();
        const webNative = '200000000000000040';

        await db.run(
            `INSERT INTO room_members (user_id, room_id, source, display_name) VALUES (?, ?, 'submission', ?)`,
            webNative, roomId, 'NickOnly'
        );
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Fish Tales', iscoredUsername: 'NickOnly',
            submittedByUserId: webNative, score: 1234,
        });

        const res = await request(app).get(`/api/rooms/${roomId}/stats/enhanced/player/NickOnly`);

        expect(res.status).toBe(200);
        expect(res.body.discordUserId).toBe(webNative);
    });

    // Unlinked-player affordances (d) — the room_members fallback is
    // room-scoped by construction (`WHERE room_id = ?`); this is the
    // regression test proving a claim in one room can't leak into another
    // room's resolution of the same display name.
    it('a room_members claim in room A does not leak into room B\'s resolution of the same name', async () => {
        const app = await createTestApp();
        const db = await getDatabase();
        const roomA = await createTestRoom('room-a-leak-test', 'Room A');
        const roomB = await createTestRoom('room-b-leak-test', 'Room B');
        const roomAOwner = '200000000000000050';

        // 'SharedName' is claimed in room A only.
        await db.run(
            `INSERT INTO room_members (user_id, room_id, source, display_name) VALUES (?, ?, 'submission', ?)`,
            roomAOwner, roomA, 'SharedName'
        );
        // An unrelated, unattributed synced score under the same name in room B.
        await insertScoreHistoryRow({
            gameRoomId: roomB, gameName: 'Whirlwind', iscoredUsername: 'SharedName',
            submittedByUserId: null, score: 500, source: 'sync',
        });

        const res = await request(app).get(`/api/rooms/${roomB}/stats/enhanced/player/SharedName`);

        expect(res.status).toBe(200);
        // Must NOT resolve to room A's claimant — room B has no claim for this name.
        expect(res.body.discordUserId).toBeNull();
    });
});

// ===========================================================================
// (c) STREAKS — participationStreak via the enhanced-player endpoint
// ===========================================================================
describe('GET /:roomId/stats/enhanced/player/:identifier — participationStreak', () => {
    it('3 consecutive weeks + a gap + 1 isolated (live) week → bestWeeks 3, currentWeeks 1', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const playerId = '300000000000000001';
        const ref = Date.now();

        // Run of 3 consecutive weeks: -35, -28, -21 days.
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Streak Game', iscoredUsername: 'Streaker',
            submittedByUserId: playerId, score: 100, createdAt: daysAgo(ref, 35),
        });
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Streak Game', iscoredUsername: 'Streaker',
            submittedByUserId: playerId, score: 110, createdAt: daysAgo(ref, 28),
        });
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Streak Game', iscoredUsername: 'Streaker',
            submittedByUserId: playerId, score: 120, createdAt: daysAgo(ref, 21),
        });
        // Gap at -14 days (no row).
        // Isolated week at -7 days ("last week" — live).
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Streak Game', iscoredUsername: 'Streaker',
            submittedByUserId: playerId, score: 130, createdAt: daysAgo(ref, 7),
        });

        const res = await request(app).get(`/api/rooms/${roomId}/stats/enhanced/player/${playerId}`);

        expect(res.status).toBe(200);
        expect(res.body.participationStreak).toEqual({ currentWeeks: 1, bestWeeks: 3 });
    });

    // Regression (2026-07-15 identity-collapse hotfix): a Discord-linked
    // player's pre-link synced week (NULL attribution, alias only) must fold
    // into the same streak as their attributed weeks — pre-fix the two weeks
    // keyed to different identities and the streak read 1 instead of 2.
    it('folds a NULL-attribution week of a mapped alias into the same streak as attributed weeks', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const db = await getDatabase();
        const playerId = '300000000000000002';
        const ref = Date.now();

        await db.run(
            'INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, ?)',
            playerId, 'StreakAlias'
        );
        // Week -7: pre-link synced row (NULL attribution, alias only).
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Streak Game', iscoredUsername: 'StreakAlias',
            submittedByUserId: null, score: 100, source: 'sync', createdAt: daysAgo(ref, 7),
        });
        // This week: attributed row.
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Streak Game', iscoredUsername: 'StreakAlias',
            submittedByUserId: playerId, score: 200, createdAt: new Date(ref).toISOString(),
        });

        const res = await request(app).get(`/api/rooms/${roomId}/stats/enhanced/player/${playerId}`);

        expect(res.status).toBe(200);
        expect(res.body.participationStreak).toEqual({ currentWeeks: 2, bestWeeks: 2 });
    });
});

// ===========================================================================
// (d) STREAK EVENT — LobbyFeedGenerator.onScoreSubmitted streak_extended
// ===========================================================================
describe('LobbyFeedGenerator — weekly streak_extended feed event', () => {
    it('first score this week with last-week history emits one streak_extended row; a second score the same week does not', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const roomId = await createTestRoom();
        const playerId = '400000000000000001';
        const ref = Date.now();

        // Last week's history (establishes a live, 2-week-consecutive streak).
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Streak Game', iscoredUsername: 'Streaker',
            submittedByUserId: playerId, score: 500, createdAt: daysAgo(ref, 7),
        });
        // This week's row — represents the just-submitted score already written
        // to score_history by the caller before onScoreSubmitted runs (per the
        // implementation's own comment).
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Streak Game', iscoredUsername: 'Streaker',
            submittedByUserId: playerId, score: 600, createdAt: new Date(ref).toISOString(),
        });

        await LobbyFeedGenerator.onScoreSubmitted({
            gameRoomId: roomId, gameName: 'Streak Game', username: 'Streaker', score: 600,
            discordUserId: playerId, source: 'community',
        });

        const rowsAfterFirst = await db.all(
            `SELECT * FROM lobby_feed_events WHERE game_room_id = ? AND type = 'streak_extended'`, roomId,
        );
        expect(rowsAfterFirst).toHaveLength(1);

        // Second score, same week — must NOT emit a second streak_extended event.
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Streak Game', iscoredUsername: 'Streaker',
            submittedByUserId: playerId, score: 700, createdAt: new Date(ref + 1000).toISOString(),
        });
        await LobbyFeedGenerator.onScoreSubmitted({
            gameRoomId: roomId, gameName: 'Streak Game', username: 'Streaker', score: 700,
            discordUserId: playerId, source: 'community',
        });

        const rowsAfterSecond = await db.all(
            `SELECT * FROM lobby_feed_events WHERE game_room_id = ? AND type = 'streak_extended'`, roomId,
        );
        expect(rowsAfterSecond).toHaveLength(1);
    });

    it('does not emit when streak_extended is disabled via LOBBY_FEED_SETTINGS.enabledTypes', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const roomId = await createTestRoom();
        const playerId = '400000000000000002';
        const ref = Date.now();

        await GameRoomSettingsService.set(
            roomId, 'LOBBY_FEED_SETTINGS', JSON.stringify({ enabledTypes: ['score_posted'] })
        );

        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Streak Game', iscoredUsername: 'Streaker',
            submittedByUserId: playerId, score: 500, createdAt: daysAgo(ref, 7),
        });
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Streak Game', iscoredUsername: 'Streaker',
            submittedByUserId: playerId, score: 600, createdAt: new Date(ref).toISOString(),
        });

        await LobbyFeedGenerator.onScoreSubmitted({
            gameRoomId: roomId, gameName: 'Streak Game', username: 'Streaker', score: 600,
            discordUserId: playerId, source: 'community',
        });

        const rows = await db.all(
            `SELECT * FROM lobby_feed_events WHERE game_room_id = ? AND type = 'streak_extended'`, roomId,
        );
        expect(rows).toHaveLength(0);
    });
});

// ===========================================================================
// (e) STALENESS — Scheduler's per-room staleness_challenge worker
// ===========================================================================
describe('Scheduler — staleness_challenge per-room worker', () => {
    // Private method, extracted (not inline in the cron closure) — called via
    // an `as any` cast to bypass TypeScript's compile-time privacy. This is
    // the same runtime object the cron job itself invokes; it is not a mock
    // and does not reach into node-cron.
    function runStalenessCheck(gameRoomId: string): Promise<void> {
        return (Scheduler.getInstance() as any).emitStalenessChallengeForRoom(gameRoomId);
    }

    it('emits one staleness_challenge row with correct metadata for a game past the default 14-day threshold', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const roomId = await createTestRoom();

        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Dusty Table', iscoredUsername: 'OldChamp',
            score: 9999, createdAt: new Date(Date.now() - 20 * 86400000).toISOString(),
        });

        await runStalenessCheck(roomId);

        const rows = await db.all(
            `SELECT * FROM lobby_feed_events WHERE game_room_id = ? AND type = 'staleness_challenge'`, roomId,
        );
        expect(rows).toHaveLength(1);
        const metadata = JSON.parse(rows[0].metadata);
        expect(metadata.topScore).toBe(9999);
        expect(metadata.topPlayer).toBe('OldChamp');
        expect(typeof metadata.days).toBe('number');
        expect(metadata.days).toBeGreaterThanOrEqual(19);
        expect(rows[0].game_name).toBe('Dusty Table');
    });

    it('re-running the same day is deduped — no second row', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const roomId = await createTestRoom();

        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Dusty Table', iscoredUsername: 'OldChamp',
            score: 9999, createdAt: new Date(Date.now() - 20 * 86400000).toISOString(),
        });

        await runStalenessCheck(roomId);
        await runStalenessCheck(roomId);

        const rows = await db.all(
            `SELECT * FROM lobby_feed_events WHERE game_room_id = ? AND type = 'staleness_challenge'`, roomId,
        );
        expect(rows).toHaveLength(1);
    });

    it('emits nothing when staleness_challenge is disabled via LOBBY_FEED_SETTINGS.enabledTypes', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const roomId = await createTestRoom();

        await GameRoomSettingsService.set(
            roomId, 'LOBBY_FEED_SETTINGS', JSON.stringify({ enabledTypes: ['score_posted'] })
        );
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Dusty Table', iscoredUsername: 'OldChamp',
            score: 9999, createdAt: new Date(Date.now() - 20 * 86400000).toISOString(),
        });

        await runStalenessCheck(roomId);

        const rows = await db.all(
            `SELECT * FROM lobby_feed_events WHERE game_room_id = ? AND type = 'staleness_challenge'`, roomId,
        );
        expect(rows).toHaveLength(0);
    });

    it('emits nothing when no game is past the threshold', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const roomId = await createTestRoom();

        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Fresh Table', iscoredUsername: 'ActivePlayer',
            score: 100, createdAt: new Date().toISOString(),
        });

        await runStalenessCheck(roomId);

        const rows = await db.all(
            `SELECT * FROM lobby_feed_events WHERE game_room_id = ? AND type = 'staleness_challenge'`, roomId,
        );
        expect(rows).toHaveLength(0);
    });
});
