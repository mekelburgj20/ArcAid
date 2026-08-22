import { describe, it, expect, beforeEach } from 'vitest';
import { ScoreRankService } from '../services/ScoreRankService.js';
import { getDatabase } from '../database/database.js';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import crypto from 'crypto';

/**
 * S5 — ScoreRankService submit-moment rank.
 *
 * The load-bearing assertion is the CANONICAL partition:
 *   COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username))
 * One Discord user holding TWO iScored aliases must collapse to ONE player
 * (totalPlayers counts them once) and rank by their COMBINED best — a result
 * that DIFFERS from the wrong LOWER(iscored_username)-only partition (which
 * would count the two aliases as two separate players).
 */

/** Direct community_scores insert with an explicit canonical partition key. */
async function insertCommunityScore(opts: {
    gameRoomId: string;
    gameName: string;
    iscoredUsername: string;
    submittedByUserId: string | null;
    score: number;
}): Promise<number> {
    const db = await getDatabase();
    const result = await db.run(
        `INSERT INTO community_scores (
            game_name, game_room_id, iscored_username, discord_user_id, score,
            submitted_by_user_id, submitted_by_anonymous_name
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        opts.gameName, opts.gameRoomId, opts.iscoredUsername,
        opts.submittedByUserId ?? 'ANON', opts.score,
        opts.submittedByUserId, opts.submittedByUserId ? null : opts.iscoredUsername,
    );
    return result.lastID as number;
}

/** Direct global_scores insert. */
async function insertGlobalScore(opts: {
    globalGameId: string;
    playerId: string;
    iscoredUsername: string | null;
    submittedByUserId: string | null;
    score: number;
    excludeFromGlobal?: boolean;
}): Promise<string> {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_scores (
            id, global_game_id, player_id, iscored_username, score, origin_type,
            exclude_from_global, submitted_by_user_id
         ) VALUES (?, ?, ?, ?, ?, 'global', ?, ?)`,
        id, opts.globalGameId, opts.playerId, opts.iscoredUsername, opts.score,
        opts.excludeFromGlobal ? 1 : 0, opts.submittedByUserId,
    );
    return id;
}

async function createGlobalGame(name = 'Medieval Madness'): Promise<string> {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_games (id, name, type, status) VALUES (?, ?, 'pinball', 'approved')`,
        id, name,
    );
    return id;
}

describe('ScoreRankService — canonical partition', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    it('ROOM: collapses two iScored aliases of one Discord user into ONE player', async () => {
        const db = await getDatabase();
        const roomId = await createTestRoom('sr-room', 'SR Room');
        const gameName = 'Attack from Mars';

        // disc-1 holds TWO aliases.
        await db.run(`INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES ('disc-1', 'AceA')`);
        await db.run(`INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES ('disc-1', 'AceB')`);

        // disc-1 submits under BOTH aliases. Both rows carry submitted_by_user_id='disc-1',
        // so the canonical partition collapses them; a LOWER(iscored_username) partition
        // would (wrongly) treat them as two distinct players.
        await insertCommunityScore({ gameRoomId: roomId, gameName, iscoredUsername: 'AceA', submittedByUserId: 'disc-1', score: 5000 });
        const lastId = await insertCommunityScore({ gameRoomId: roomId, gameName, iscoredUsername: 'AceB', submittedByUserId: 'disc-1', score: 8000 });

        // A genuinely different player.
        await insertCommunityScore({ gameRoomId: roomId, gameName, iscoredUsername: 'Rival', submittedByUserId: 'disc-2', score: 6000 });

        const res = await ScoreRankService.computeRoomRank({
            gameRoomId: roomId,
            gameName,
            partitionKey: 'disc-1',
            submittedScore: 8000,
            excludeCommunityScoreId: lastId,
        });

        // ONE player for disc-1's two aliases + the rival = 2 distinct players,
        // NOT 3. This is the assertion that fails under a per-alias partition.
        expect(res.totalPlayers).toBe(2);
        // disc-1's combined best is 8000 → ahead of Rival's 6000 → rank 1.
        expect(res.rank).toBe(1);
        expect(res.gapToNext).toBeNull();
        expect(res.gapToFirst).toBeNull();
        // previousBest excludes the just-inserted 8000 row, so disc-1's prior
        // best across the partition is the 5000 (AceA) row.
        expect(res.previousBest).toBe(5000);
    });

    it('ROOM: rank and gap math against a small fixture', async () => {
        const roomId = await createTestRoom('sr-gaps', 'SR Gaps');
        const gameName = 'Twilight Zone';

        // Three distinct players. The submitter (disc-mid) is in the middle.
        await insertCommunityScore({ gameRoomId: roomId, gameName, iscoredUsername: 'Top', submittedByUserId: 'disc-top', score: 10000 });
        await insertCommunityScore({ gameRoomId: roomId, gameName, iscoredUsername: 'Above', submittedByUserId: 'disc-above', score: 7000 });
        const midId = await insertCommunityScore({ gameRoomId: roomId, gameName, iscoredUsername: 'Mid', submittedByUserId: 'disc-mid', score: 4000 });

        const res = await ScoreRankService.computeRoomRank({
            gameRoomId: roomId,
            gameName,
            partitionKey: 'disc-mid',
            submittedScore: 4000,
            excludeCommunityScoreId: midId,
        });

        expect(res.totalPlayers).toBe(3);
        expect(res.rank).toBe(3);
        // gapToNext = score of player immediately above (7000) - my best (4000) = 3000.
        expect(res.gapToNext).toBe(3000);
        // gapToFirst = top (10000) - my best (4000) = 6000.
        expect(res.gapToFirst).toBe(6000);
        // First-ever submission on this game for disc-mid → no previousBest.
        expect(res.previousBest).toBeNull();
    });

    it('ROOM: merges community_scores + tournament score_history under one partition', async () => {
        const db = await getDatabase();
        const roomId = await createTestRoom('sr-merge', 'SR Merge');
        const gameName = 'Funhouse';

        // A tournament score_history row (source='tournament') for disc-1.
        await db.run(
            `INSERT INTO score_history (
                game_name, game_room_id, iscored_username, discord_user_id, score, source, submitted_by_user_id
             ) VALUES (?, ?, ?, ?, ?, 'tournament', ?)`,
            gameName, roomId, 'AceA', 'disc-1', 9000, 'disc-1',
        );
        // A community row for the SAME disc-1 under a different alias, lower score.
        const cId = await insertCommunityScore({ gameRoomId: roomId, gameName, iscoredUsername: 'AceB', submittedByUserId: 'disc-1', score: 3000 });
        // A separate rival via community.
        await insertCommunityScore({ gameRoomId: roomId, gameName, iscoredUsername: 'Rival', submittedByUserId: 'disc-2', score: 5000 });

        const res = await ScoreRankService.computeRoomRank({
            gameRoomId: roomId,
            gameName,
            partitionKey: 'disc-1',
            submittedScore: 3000,
            excludeCommunityScoreId: cId,
        });

        // disc-1 (best 9000 from tournament) + rival (5000) = 2 players.
        expect(res.totalPlayers).toBe(2);
        // disc-1's combined best (9000) > rival → rank 1.
        expect(res.rank).toBe(1);
        // previousBest excludes the just-inserted community row (3000) but the
        // tournament 9000 row remains in the partition.
        expect(res.previousBest).toBe(9000);
    });

    it('ROOM: ranks inside the ACTIVE tournament window against synced rows (rtx_pinball Jaws, 2026-08-21)', async () => {
        // Regression: the submitter was told "#1 of 1" on a board whose five
        // rivals all came from iScored sync (source='sync'), while the card
        // (score_history by submitted_during_tournament_id) showed #4 of 6.
        const db = await getDatabase();
        const roomId = await createTestRoom('sr-window', 'SR Window');
        const gameName = 'Jaws';
        const tid = await createTestTournament(roomId, { name: 'Monthly Grind' });
        const gameId = await createTestGame(tid, { name: gameName, status: 'ACTIVE' });

        const synced: Array<[string, number]> = [
            ['Beckles2024', 461_478_960], ['Jay', 265_209_500], ['Acskinner', 255_278_810],
            ['asdfate', 120_000_000], ['BrickShotBobes', 90_000_000],
        ];
        for (const [name, score] of synced) {
            await db.run(
                `INSERT INTO score_history (
                    game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source,
                    submitted_during_tournament_id, submitted_by_user_id
                 ) VALUES (?, ?, ?, ?, 'SYSTEM', ?, 'sync', ?, ?)`,
                gameName, roomId, gameId, name, score, tid, `iscored:${name.toLowerCase()}`,
            );
        }
        // A stale out-of-window row for the same game must NOT count.
        await db.run(
            `INSERT INTO score_history (game_name, game_room_id, iscored_username, discord_user_id, score, source, submitted_by_user_id)
             VALUES (?, ?, 'OldTimer', 'SYSTEM', 999_000_000_000, 'sync', 'iscored:oldtimer')`,
            gameName, roomId,
        );
        // The owner's community submit: game_id NULL, discord-attributed.
        const cId = await insertCommunityScore({ gameRoomId: roomId, gameName, iscoredUsername: 'mekelburgj', submittedByUserId: 'disc-owner', score: 211_347_030 });
        const hist = await db.run(
            `INSERT INTO score_history (
                game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source,
                submitted_during_tournament_id, submitted_by_user_id
             ) VALUES (?, ?, NULL, 'mekelburgj', 'disc-owner', ?, 'community', ?, 'disc-owner')`,
            gameName, roomId, 211_347_030, tid,
        );

        const res = await ScoreRankService.computeRoomRank({
            gameRoomId: roomId,
            gameName,
            partitionKey: 'disc-owner',
            submittedScore: 211_347_030,
            excludeCommunityScoreId: cId,
            excludeHistoryId: hist.lastID as number,
        });

        expect(res.rank).toBe(4);
        expect(res.totalPlayers).toBe(6);
        expect(res.gapToNext).toBe(255_278_810 - 211_347_030);
        expect(res.gapToFirst).toBe(461_478_960 - 211_347_030);
        expect(res.previousBest).toBeNull();

        // A second, higher submit from the same player: previousBest is the
        // earlier window row, rank moves to #3.
        const hist2 = await db.run(
            `INSERT INTO score_history (
                game_name, game_room_id, iscored_username, discord_user_id, score, source,
                submitted_during_tournament_id, submitted_by_user_id
             ) VALUES (?, ?, 'mekelburgj', 'disc-owner', ?, 'community', ?, 'disc-owner')`,
            gameName, roomId, 260_000_000, tid,
        );
        const res2 = await ScoreRankService.computeRoomRank({
            gameRoomId: roomId, gameName, partitionKey: 'disc-owner', submittedScore: 260_000_000,
            excludeHistoryId: hist2.lastID as number,
        });
        expect(res2.rank).toBe(3);
        expect(res2.totalPlayers).toBe(6);
        expect(res2.previousBest).toBe(211_347_030);

        // Explicit tournamentId: null forces the freeplay union (sync rows excluded).
        const legacy = await ScoreRankService.computeRoomRank({
            gameRoomId: roomId, gameName, partitionKey: 'disc-owner', submittedScore: 211_347_030, tournamentId: null,
        });
        expect(legacy.totalPlayers).toBe(1);
    });

    it('ROOM: tournament window — a deduped resubmit of an out-of-window score still ranks correctly', async () => {
        const db = await getDatabase();
        const roomId = await createTestRoom('sr-window-dedup', 'SR Window Dedup');
        const gameName = 'Taxi';
        const tid = await createTestTournament(roomId, { name: 'Daily Grind' });
        await createTestGame(tid, { name: gameName, status: 'ACTIVE' });
        await db.run(
            `INSERT INTO score_history (game_name, game_room_id, iscored_username, discord_user_id, score, source, submitted_during_tournament_id, submitted_by_user_id)
             VALUES (?, ?, 'Rival', 'SYSTEM', 5000, 'sync', ?, 'iscored:rival')`,
            gameName, roomId, tid,
        );
        // The player's only row is from BEFORE the window (no tournament id);
        // ScoreHistoryService.log would dedup an identical resubmit → no new row.
        await db.run(
            `INSERT INTO score_history (game_name, game_room_id, iscored_username, discord_user_id, score, source, submitted_by_user_id)
             VALUES (?, ?, 'Me', 'disc-me', 3000, 'community', 'disc-me')`,
            gameName, roomId,
        );
        const res = await ScoreRankService.computeRoomRank({
            gameRoomId: roomId, gameName, partitionKey: 'disc-me', submittedScore: 3000, excludeHistoryId: null,
        });
        expect(res.rank).toBe(2);
        expect(res.totalPlayers).toBe(2);
        expect(res.gapToNext).toBe(2000);
    });

    it('GLOBAL: collapses two iScored aliases of one Discord user into ONE player', async () => {
        const globalGameId = await createGlobalGame('Global MM');

        // disc-1 submits under two aliases on the global board.
        await insertGlobalScore({ globalGameId, playerId: 'disc-1', iscoredUsername: 'AceA', submittedByUserId: 'disc-1', score: 5000 });
        const savedId = await insertGlobalScore({ globalGameId, playerId: 'disc-1', iscoredUsername: 'AceB', submittedByUserId: 'disc-1', score: 8000 });
        // Distinct rival.
        await insertGlobalScore({ globalGameId, playerId: 'disc-2', iscoredUsername: 'Rival', submittedByUserId: 'disc-2', score: 6000 });

        const res = await ScoreRankService.computeGlobalRank({
            globalGameId,
            partitionKey: 'disc-1',
            submittedScore: 8000,
            excludeGlobalScoreId: savedId,
        });

        // 2 distinct players, NOT 3.
        expect(res.totalPlayers).toBe(2);
        expect(res.rank).toBe(1);
        expect(res.previousBest).toBe(5000);
        expect(res.gapToNext).toBeNull();
        expect(res.gapToFirst).toBeNull();
    });

    it('GLOBAL: keys iScored-synced rows via player_id when iscored_username is null', async () => {
        const globalGameId = await createGlobalGame('Global Synced');

        // iScored-synced style row: no submitted_by_user_id, null iscored_username,
        // player_id holds the synthetic 'iscored:*' id. Canonical key falls back
        // to COALESCE(iscored_username, player_id) → the player_id.
        await insertGlobalScore({ globalGameId, playerId: 'iscored:bob', iscoredUsername: null, submittedByUserId: null, score: 9000 });
        const savedId = await insertGlobalScore({ globalGameId, playerId: 'disc-2', iscoredUsername: 'Rival', submittedByUserId: 'disc-2', score: 4000 });

        const res = await ScoreRankService.computeGlobalRank({
            globalGameId,
            // The submitter is the rival; partition key is their discord id.
            partitionKey: 'disc-2',
            submittedScore: 4000,
            excludeGlobalScoreId: savedId,
        });

        // Two distinct players (the synced bob + the rival).
        expect(res.totalPlayers).toBe(2);
        expect(res.rank).toBe(2);
        // gapToNext = next-higher (9000) - my best (4000) = 5000.
        expect(res.gapToNext).toBe(5000);
        expect(res.gapToFirst).toBe(5000);
    });

    it('GLOBAL: excludes exclude_from_global rows from the public-board rank', async () => {
        const globalGameId = await createGlobalGame('Global Exclude');

        // A higher private (excluded) score by another player must NOT count.
        await insertGlobalScore({ globalGameId, playerId: 'disc-x', iscoredUsername: 'Hidden', submittedByUserId: 'disc-x', score: 99999, excludeFromGlobal: true });
        const savedId = await insertGlobalScore({ globalGameId, playerId: 'disc-1', iscoredUsername: 'Me', submittedByUserId: 'disc-1', score: 5000 });

        const res = await ScoreRankService.computeGlobalRank({
            globalGameId,
            partitionKey: 'disc-1',
            submittedScore: 5000,
            excludeGlobalScoreId: savedId,
        });

        // Only the public row counts → 1 player, rank 1.
        expect(res.totalPlayers).toBe(1);
        expect(res.rank).toBe(1);
        expect(res.gapToFirst).toBeNull();
    });

    it('returns an all-null result on failure (best-effort)', async () => {
        // No DB row matches; a missing/garbage game still yields the safe shape.
        const roomId = await createTestRoom('sr-empty', 'SR Empty');
        const res = await ScoreRankService.computeRoomRank({
            gameRoomId: roomId,
            gameName: 'Nonexistent Game',
            partitionKey: 'disc-nobody',
            submittedScore: 1000,
            excludeCommunityScoreId: null,
        });

        // Empty board: total_players is 0 (a valid aggregate, not a failure),
        // so the helper reports the submitter as the sole/top player.
        expect(res.totalPlayers).toBe(0);
        expect(res.rank).toBe(1);
    });
});
