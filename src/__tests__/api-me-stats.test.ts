import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { signToken } from '../api/auth.js';
import { getDatabase } from '../database/database.js';
import { RoomMembershipService } from '../services/RoomMembershipService.js';

/**
 * v2.82.0 (My Stats v1, Identity arc Phase 3, WS1) — GET /api/me/stats.
 *
 * Bootstrap pattern copied from api-me-rooms-join-leave.test.ts: mount
 * global.ts at /api against a fresh setupTestDb() per test.
 */
async function createTestApp() {
    await setupTestDb();

    const app = express();
    app.use(express.json());

    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);

    return app;
}

function playerToken(discordId: string) {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username: 'Tester' });
}

/**
 * Insert a `score_history` row in the shape production actually stores
 * (`game_name` + `game_room_id` populated, `game_id` NULL) — copied verbatim
 * from `s13-achievements.test.ts`'s `insertHistoryScore` (not exported from
 * that file). See that file's doc comment for why `createTestSubmission`
 * (which starts from a `games` row and populates `game_id`) does NOT
 * resemble production and must not be used for score_history reads.
 */
async function insertHistoryScore(opts: {
    gameRoomId: string;
    gameName: string;
    username: string;
    score: number;
    submittedByUserId?: string | null;
    tournamentId?: string | null;
    createdAt?: string;
    source?: 'tournament' | 'community' | 'sync';
}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO score_history (
            game_name, game_room_id, game_id, iscored_username, discord_user_id,
            submitted_by_user_id, score, source, submitted_from_room_id,
            submitted_during_tournament_id, created_at
         ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        opts.gameName, opts.gameRoomId, opts.username,
        opts.submittedByUserId ?? 'SYSTEM', opts.submittedByUserId ?? null,
        opts.score, opts.source ?? 'community', opts.gameRoomId,
        opts.tournamentId ?? null, opts.createdAt ?? new Date().toISOString(),
    );
}

async function insertGlobalGame(opts: { id: string; name: string }) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO global_games (id, name, type) VALUES (?, ?, 'pinball')`,
        opts.id, opts.name,
    );
}

async function insertGlobalScore(opts: {
    id: string;
    globalGameId: string;
    playerId: string;
    submittedByUserId?: string | null;
    iscoredUsername?: string;
    score: number;
    originType: 'global' | 'game_room';
    originGameRoomId?: string | null;
}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO global_scores (
            id, global_game_id, player_id, iscored_username, score, origin_type,
            origin_game_room_id, submitted_by_user_id, submitted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        opts.id, opts.globalGameId, opts.playerId, opts.iscoredUsername ?? opts.playerId,
        opts.score, opts.originType, opts.originGameRoomId ?? null, opts.submittedByUserId ?? null,
    );
}

async function linkIdentities(providerUserId: string, canonicalUserId: string) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO user_identity_links (provider_user_id, canonical_user_id) VALUES (?, ?)`,
        providerUserId, canonicalUserId,
    );
}

describe('GET /api/me/stats — auth', () => {
    it('401s without a token', async () => {
        const app = await createTestApp();
        const res = await request(app).get('/api/me/stats');
        expect(res.status).toBe(401);
    });
});

describe('GET /api/me/stats — single-identity happy path', () => {
    it('returns the room-scoped personal best with room identity (incl. logo) + overview counts', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('stats-happy', 'Stats Happy Room');
        const viewer = 'D-HAPPY-1';
        const token = playerToken(viewer);

        // Owner revision (screenshot review) — room leg carries room_logo_url
        // so the FE can render the room's logo in place of the text caption.
        // createTestRoom doesn't set one, so set it directly.
        const db = await getDatabase();
        await db.run(`UPDATE game_rooms SET logo_url = ? WHERE id = ?`, 'https://example.com/happy-room-logo.png', roomId);

        await insertHistoryScore({
            gameRoomId: roomId, gameName: 'Solo Game', username: 'Solo', score: 1000,
            submittedByUserId: viewer,
        });

        const res = await request(app).get('/api/me/stats').set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.scope).toBe('all');
        expect(res.body.personalBests).toHaveLength(1);
        const best = res.body.personalBests[0];
        expect(best.source).toBe('room');
        expect(best.game_name).toBe('Solo Game');
        expect(best.best_score).toBe(1000);
        expect(best.rank).toBe(1);
        expect(best.total_players).toBe(1);
        expect(best.room_id).toBe(roomId);
        expect(best.room_slug).toBe('stats-happy');
        expect(best.room_name).toBe('Stats Happy Room');
        expect(best.room_logo_url).toBe('https://example.com/happy-room-logo.png');

        expect(res.body.overview.gamesWithBest).toBe(1);
        expect(res.body.overview.memberRooms).toBe(0);
        expect(res.body.overview.totalScores).toBe(1);
    });

    it('room_logo_url is null when the room has no logo set', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('stats-happy-nologo', 'Stats Happy No-Logo Room');
        const viewer = 'D-HAPPY-2';
        const token = playerToken(viewer);

        await insertHistoryScore({
            gameRoomId: roomId, gameName: 'Solo Game 2', username: 'Solo', score: 500,
            submittedByUserId: viewer,
        });

        const res = await request(app).get('/api/me/stats').set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.personalBests).toHaveLength(1);
        expect(res.body.personalBests[0].room_logo_url).toBeNull();
    });
});

describe('GET /api/me/stats — multi-alias rank collapse regression (decision 2)', () => {
    it('two identity-linked ids scoring on the same game collapse to ONE row with correct rank/total_players', async () => {
        // The trap: BanService.expandIdentityCandidates can return several
        // DISTINCT player_key strings for the same real person (a Discord
        // snowflake + a linked google:* id used before the link existed,
        // each set directly as submitted_by_user_id on different rows). A
        // bare `player_key IN (candidates)` filter would surface BOTH as
        // separate competitors on the same game — two rows for one person,
        // and total_players inflated by one ghost competitor.
        const app = await createTestApp();
        const roomId = await createTestRoom('stats-multi-alias', 'Multi Alias Room');

        const discordId = 'D-CANON-1';
        const googleId = 'google:pre-link-1';
        await linkIdentities(googleId, discordId);

        // Same person, two different submitted_by_user_id values on the same game.
        await insertHistoryScore({
            gameRoomId: roomId, gameName: 'Shared Game', username: 'ViaSnowflake', score: 500,
            submittedByUserId: discordId,
        });
        await insertHistoryScore({
            gameRoomId: roomId, gameName: 'Shared Game', username: 'ViaGoogle', score: 700,
            submittedByUserId: googleId,
        });
        // A genuinely different other player on the same game.
        await insertHistoryScore({
            gameRoomId: roomId, gameName: 'Shared Game', username: 'OtherPlayer', score: 600,
            submittedByUserId: 'OTHER-PLAYER-1',
        });

        const token = playerToken(discordId);
        const res = await request(app).get('/api/me/stats').set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        // Naive `IN (...)` filtering would return 2 rows here (one per alias).
        expect(res.body.personalBests).toHaveLength(1);
        const best = res.body.personalBests[0];
        expect(best.game_name).toBe('Shared Game');
        // The higher of the two aliases' scores wins the collapse.
        expect(best.best_score).toBe(700);
        expect(best.rank).toBe(1);
        // Real distinct people on this game: the viewer (collapsed) + OtherPlayer = 2.
        // A naive IN-filter implementation double-counts the viewer's two
        // aliases as separate competitors and reports 3 here instead.
        expect(best.total_players).toBe(2);

        // totalScores counts raw events (no collapse trap for a plain count):
        // both of the viewer's rows count individually.
        expect(res.body.overview.totalScores).toBe(2);
    });

    it('works whichever side of the link presents the token (google id -> same canonical result)', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('stats-multi-alias-2', 'Multi Alias Room 2');

        const discordId = 'D-CANON-2';
        const googleId = 'google:pre-link-2';
        await linkIdentities(googleId, discordId);

        await insertHistoryScore({
            gameRoomId: roomId, gameName: 'Shared Game 2', username: 'ViaSnowflake', score: 500,
            submittedByUserId: discordId,
        });
        await insertHistoryScore({
            gameRoomId: roomId, gameName: 'Shared Game 2', username: 'ViaGoogle', score: 700,
            submittedByUserId: googleId,
        });

        // Present the GOOGLE id as the token — pre-relink browser session.
        const token = playerToken(googleId);
        const res = await request(app).get('/api/me/stats').set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.personalBests).toHaveLength(1);
        expect(res.body.personalBests[0].best_score).toBe(700);
        expect(res.body.personalBests[0].total_players).toBe(1);
    });
});

describe('GET /api/me/stats — unlinked google:* token', () => {
    it('works standalone with no linked Discord identity', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('stats-google-only', 'Google Only Room');
        const googleId = 'google:standalone-1';

        await insertHistoryScore({
            gameRoomId: roomId, gameName: 'Google Only Game', username: 'GoogleUser', score: 250,
            submittedByUserId: googleId,
        });

        const token = playerToken(googleId);
        const res = await request(app).get('/api/me/stats').set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.personalBests).toHaveLength(1);
        expect(res.body.personalBests[0].best_score).toBe(250);
        expect(res.body.personalBests[0].total_players).toBe(1);
    });
});

describe('GET /api/me/stats?scope=<roomId> — membership gate', () => {
    it('200s for a member room', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('stats-member', 'Member Room');
        const viewer = 'D-MEMBER-1';
        await RoomMembershipService.addMember(viewer, roomId, 'self_join');

        const token = playerToken(viewer);
        const res = await request(app).get(`/api/me/stats?scope=${roomId}`).set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.scope).toBe(roomId);
    });

    it('403s for a room the viewer is not a member of', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('stats-nonmember', 'Non-Member Room');
        const viewer = 'D-NONMEMBER-1';

        const token = playerToken(viewer);
        const res = await request(app).get(`/api/me/stats?scope=${roomId}`).set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(403);
    });

    it('excludes a game whose only board is direct-Global when scoped to a room', async () => {
        // v2.83.0: the mechanism changed (the Global leg is now ALWAYS
        // fetched, even in room scope — see collapseToOverallBests), but the
        // observable result here is unchanged: a game the viewer only has a
        // direct-Global score for shares no game-name key with anything on
        // this room's board, so `collapseToOverallBests` never emits a row
        // for it in room scope (a room-scope row must be `source: 'room'`
        // with a matching `room_id`).
        const app = await createTestApp();
        const roomId = await createTestRoom('stats-scoped-noglobal', 'Scoped No Global Room');
        const viewer = 'D-SCOPED-1';
        await RoomMembershipService.addMember(viewer, roomId, 'self_join');

        await insertGlobalGame({ id: 'gg-scoped-1', name: 'Global Game Scoped' });
        await insertGlobalScore({
            id: 'gs-scoped-1', globalGameId: 'gg-scoped-1', playerId: viewer,
            submittedByUserId: viewer, score: 999, originType: 'global',
        });
        await insertHistoryScore({
            gameRoomId: roomId, gameName: 'Room Game Scoped', username: 'Scoped', score: 100,
            submittedByUserId: viewer,
        });

        const token = playerToken(viewer);
        const res = await request(app).get(`/api/me/stats?scope=${roomId}`).set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.personalBests).toHaveLength(1);
        expect(res.body.personalBests[0].source).toBe('room');
        expect(res.body.overview.totalScores).toBe(1);
    });
});

describe('GET /api/me/stats — v2.83.0 cross-board overall-best collapse', () => {
    it('All scope: the same game in two rooms collapses to ONE row on the higher-scoring room', async () => {
        const app = await createTestApp();
        const roomLo = await createTestRoom('stats-collapse-lo', 'Low Room');
        const roomHi = await createTestRoom('stats-collapse-hi', 'High Room');
        const viewer = 'D-COLLAPSE-1';

        await insertHistoryScore({
            gameRoomId: roomLo, gameName: 'Medieval Madness', username: 'V', score: 500_000,
            submittedByUserId: viewer, createdAt: '2026-01-01 00:00:00',
        });
        await insertHistoryScore({
            gameRoomId: roomHi, gameName: 'Medieval Madness', username: 'V', score: 900_000,
            submittedByUserId: viewer, createdAt: '2026-01-02 00:00:00',
        });

        const token = playerToken(viewer);
        const res = await request(app).get('/api/me/stats').set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.personalBests).toHaveLength(1);
        expect(res.body.personalBests[0].room_id).toBe(roomHi);
        expect(res.body.personalBests[0].best_score).toBe(900_000);
        expect(res.body.overview.gamesWithBest).toBe(1);
    });

    it('Room scope: the lower-scoring room excludes the game entirely; the higher-scoring room includes it', async () => {
        const app = await createTestApp();
        const roomLo = await createTestRoom('stats-collapse-lo2', 'Low Room 2');
        const roomHi = await createTestRoom('stats-collapse-hi2', 'High Room 2');
        const viewer = 'D-COLLAPSE-2';
        await RoomMembershipService.addMember(viewer, roomLo, 'self_join');
        await RoomMembershipService.addMember(viewer, roomHi, 'self_join');

        await insertHistoryScore({
            gameRoomId: roomLo, gameName: 'Medieval Madness', username: 'V', score: 500_000, submittedByUserId: viewer,
        });
        await insertHistoryScore({
            gameRoomId: roomHi, gameName: 'Medieval Madness', username: 'V', score: 900_000, submittedByUserId: viewer,
        });

        const token = playerToken(viewer);

        const loRes = await request(app).get(`/api/me/stats?scope=${roomLo}`).set('Authorization', `Bearer ${token}`);
        expect(loRes.status).toBe(200);
        expect(loRes.body.personalBests).toHaveLength(0);
        expect(loRes.body.overview.gamesWithBest).toBe(0);

        const hiRes = await request(app).get(`/api/me/stats?scope=${roomHi}`).set('Authorization', `Bearer ${token}`);
        expect(hiRes.status).toBe(200);
        expect(hiRes.body.personalBests).toHaveLength(1);
        expect(hiRes.body.personalBests[0].room_id).toBe(roomHi);
        expect(hiRes.body.overview.gamesWithBest).toBe(1);
    });

    it('Room scope: a tie across two rooms counts as a match in BOTH room scopes', async () => {
        const app = await createTestApp();
        const roomA = await createTestRoom('stats-collapse-tie-a', 'Tie Room A');
        const roomB = await createTestRoom('stats-collapse-tie-b', 'Tie Room B');
        const viewer = 'D-COLLAPSE-TIE-1';
        await RoomMembershipService.addMember(viewer, roomA, 'self_join');
        await RoomMembershipService.addMember(viewer, roomB, 'self_join');

        await insertHistoryScore({
            gameRoomId: roomA, gameName: 'Twilight Zone', username: 'V', score: 700_000, submittedByUserId: viewer,
        });
        await insertHistoryScore({
            gameRoomId: roomB, gameName: 'Twilight Zone', username: 'V', score: 700_000, submittedByUserId: viewer,
        });

        const token = playerToken(viewer);

        const aRes = await request(app).get(`/api/me/stats?scope=${roomA}`).set('Authorization', `Bearer ${token}`);
        expect(aRes.body.personalBests).toHaveLength(1);
        expect(aRes.body.personalBests[0].room_id).toBe(roomA);

        const bRes = await request(app).get(`/api/me/stats?scope=${roomB}`).set('Authorization', `Bearer ${token}`);
        expect(bRes.body.personalBests).toHaveLength(1);
        expect(bRes.body.personalBests[0].room_id).toBe(roomB);
    });

    it('a direct-Global best beats a room best: All shows the GLOBAL row, room scope excludes the game entirely', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('stats-collapse-global-beats', 'Global Beats Room');
        const viewer = 'D-COLLAPSE-GLOBAL-1';
        await RoomMembershipService.addMember(viewer, roomId, 'self_join');

        await insertHistoryScore({
            gameRoomId: roomId, gameName: 'Cosmic Cart Racing', username: 'V', score: 400, submittedByUserId: viewer,
        });
        await insertGlobalGame({ id: 'gg-collapse-1', name: 'Cosmic Cart Racing' });
        await insertGlobalScore({
            id: 'gs-collapse-1', globalGameId: 'gg-collapse-1', playerId: viewer,
            submittedByUserId: viewer, score: 900, originType: 'global',
        });

        const token = playerToken(viewer);

        const allRes = await request(app).get('/api/me/stats').set('Authorization', `Bearer ${token}`);
        expect(allRes.body.personalBests).toHaveLength(1);
        expect(allRes.body.personalBests[0].source).toBe('global');
        expect(allRes.body.personalBests[0].best_score).toBe(900);

        const roomRes = await request(app).get(`/api/me/stats?scope=${roomId}`).set('Authorization', `Bearer ${token}`);
        expect(roomRes.body.personalBests).toHaveLength(0);
    });
});

describe('GET /api/me/stats — direct-Global leg is direct-only (fan-out excluded)', () => {
    it('a fan-out copy of a room score does not overwrite the direct-Global best', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('stats-fanout', 'Fanout Room');
        const viewer = 'D-FANOUT-1';

        await insertGlobalGame({ id: 'gg-fanout-1', name: 'Fanout Game' });
        // Direct Global submission — lower score.
        await insertGlobalScore({
            id: 'gs-direct-1', globalGameId: 'gg-fanout-1', playerId: viewer,
            submittedByUserId: viewer, score: 100, originType: 'global',
        });
        // Fan-out mirror of a (higher-scoring) room submission — must be excluded.
        await insertGlobalScore({
            id: 'gs-fanout-1', globalGameId: 'gg-fanout-1', playerId: viewer,
            submittedByUserId: viewer, score: 999, originType: 'game_room', originGameRoomId: roomId,
        });

        const token = playerToken(viewer);
        const res = await request(app).get('/api/me/stats').set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        const globalRows = res.body.personalBests.filter((b: any) => b.source === 'global');
        expect(globalRows).toHaveLength(1);
        expect(globalRows[0].best_score).toBe(100);
        expect(globalRows[0].global_game_id).toBe('gg-fanout-1');

        // Overview totalScores counts the direct row only, not the fan-out mirror.
        expect(res.body.overview.totalScores).toBe(1);
    });
});

describe('GET /api/me/stats — suspended rooms are excluded', () => {
    it('a personal best in a suspended room does not appear', async () => {
        const app = await createTestApp();
        const activeRoomId = await createTestRoom('stats-active', 'Active Room');
        const suspendedRoomId = await createTestRoom('stats-suspended', 'Suspended Room');
        const viewer = 'D-SUSPENDED-1';

        await insertHistoryScore({
            gameRoomId: activeRoomId, gameName: 'Active Game', username: 'Active', score: 100,
            submittedByUserId: viewer,
        });
        await insertHistoryScore({
            gameRoomId: suspendedRoomId, gameName: 'Suspended Game', username: 'Suspended', score: 100,
            submittedByUserId: viewer,
        });

        const db = await getDatabase();
        await db.run(`UPDATE game_rooms SET suspended_at = datetime('now') WHERE id = ?`, suspendedRoomId);

        const token = playerToken(viewer);
        const res = await request(app).get('/api/me/stats').set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.personalBests).toHaveLength(1);
        expect(res.body.personalBests[0].game_name).toBe('Active Game');
    });
});

describe('GET /api/me/stats — overview counts', () => {
    it('counts games-with-best, member rooms, and total scores (room + direct-Global)', async () => {
        const app = await createTestApp();
        const roomA = await createTestRoom('stats-overview-a', 'Overview Room A');
        const roomB = await createTestRoom('stats-overview-b', 'Overview Room B');
        const viewer = 'D-OVERVIEW-1';

        await RoomMembershipService.addMember(viewer, roomA, 'self_join');
        await RoomMembershipService.addMember(viewer, roomB, 'self_join');

        await insertHistoryScore({
            gameRoomId: roomA, gameName: 'Game A1', username: 'P', score: 100, submittedByUserId: viewer,
        });
        await insertHistoryScore({
            gameRoomId: roomA, gameName: 'Game A1', username: 'P2', score: 50, submittedByUserId: 'OTHER-2',
        });
        await insertHistoryScore({
            gameRoomId: roomB, gameName: 'Game B1', username: 'P', score: 200, submittedByUserId: viewer,
        });

        await insertGlobalGame({ id: 'gg-overview-1', name: 'Overview Global Game' });
        await insertGlobalScore({
            id: 'gs-overview-1', globalGameId: 'gg-overview-1', playerId: viewer,
            submittedByUserId: viewer, score: 42, originType: 'global',
        });

        const token = playerToken(viewer);
        const res = await request(app).get('/api/me/stats').set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        // 2 games with a personal best: Game A1 (room A) + Game B1 (room B) + the global game = 3.
        expect(res.body.overview.gamesWithBest).toBe(3);
        expect(res.body.overview.memberRooms).toBe(2);
        // 2 room score_history events + 1 direct-Global event = 3 (the other
        // player's row in room A does not belong to the viewer).
        expect(res.body.overview.totalScores).toBe(3);
    });
});
