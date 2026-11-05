import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { VpxScoreIngestService } from '../services/VpxScoreIngestService.js';
import { backfillWitnessSubmissions } from '../database/migrations/witnessSubmissions.js';

/**
 * v2.220.0 (W93) — a witness score reaches `submissions`.
 *
 * The rotation close crowns its winner from `submissions` alone ("Top scorer
 * (local DB)"). Every manual path wrote that row; the witness ingest never
 * did, so Krobs' 31,269,280 from Castcade sat at rank 1 on the Weekly Grind -
 * VPXS board while the close crowned Blegger's typed 29,653,970 (RTX,
 * 2026-11-04). These tests pin:
 *
 *   1. An ingested witness score writes the player's summary row, keyed and
 *      attributed exactly as the web route keys it.
 *   2. The row is best-per-player: a lower later play leaves it alone, a
 *      higher one raises it.
 *   3. The migration backfill gives EXISTING witness rows the same summary
 *      row, without lowering a higher typed score.
 */

const USER = '123456789012345678';
const MINUTE = 60_000;

async function addMember(roomId: string, userId = USER) {
    const db = await getDatabase();
    await db.run(
        `INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'submission')`,
        userId, roomId,
    );
}

async function createRotationGame(roomId: string, name: string) {
    const db = await getDatabase();
    const tournamentId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format)
         VALUES (?, 'Weekly VPXS', 'WG', 'pinball', '{}', 1, ?, 'rotation')`,
        tournamentId, roomId,
    );
    const gameId = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, game_room_id, start_date)
         VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
        gameId, tournamentId, name, roomId, new Date(Date.now() - 60 * MINUTE).toISOString(),
    );
    return { tournamentId, gameId };
}

function vpxScore(roomId: string, score: number, endedTs: number) {
    return {
        canonicalUserId: USER,
        tableName: 'Bad Cats (Williams 1989)',
        rom: 'bcats_l5',
        slug: 'vpx-badcats',
        score,
        startedTs: endedTs - 300,
        endedTs,
        durationSec: 300,
        reason: 'game_over',
        target: { roomId, tournamentId: null, globalFallback: true },
    };
}

type SubmissionRow = {
    id: string; game_id: string; score: number; discord_user_id: string;
    submitted_by_user_id: string | null; submitted_during_tournament_id: string | null;
    platform: string | null; engine: string | null; device: string | null;
};

async function submissionsFor(gameId: string): Promise<SubmissionRow[]> {
    const db = await getDatabase();
    return db.all<SubmissionRow[]>(`SELECT * FROM submissions WHERE game_id = ?`, gameId);
}

describe('witness scores reach submissions (W93)', () => {
    let roomId: string;

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
        await addMember(roomId);
    });

    it('an ingested witness score writes the best-per-player summary row the rotation close reads', async () => {
        const { gameId, tournamentId } = await createRotationGame(roomId, 'Bad Cats');
        const ended = Math.floor(Date.now() / 1000);

        const result = await VpxScoreIngestService.ingest(vpxScore(roomId, 8366650, ended));
        expect(result.status).toBe('ingested');

        const rows = await submissionsFor(gameId);
        expect(rows).toHaveLength(1);
        const name = (await getDatabase().then((db) => db.get<{ iscored_username: string }>(
            `SELECT iscored_username FROM score_history WHERE game_id = ? AND source = 'vpx'`, gameId,
        )))!.iscored_username;
        expect(rows[0]).toMatchObject({
            id: `${gameId}-${name.toLowerCase()}`,
            score: 8366650,
            discord_user_id: USER,
            submitted_by_user_id: USER,
            submitted_during_tournament_id: tournamentId,
            platform: 'vpxs', engine: 'vpx', device: 'atgames',
        });

        // The winner query the close runs sees it.
        const db = await getDatabase();
        const top = await db.get<{ submitted_by_user_id: string; score: number }>(
            `SELECT submitted_by_user_id, score FROM submissions WHERE game_id = ? ORDER BY score DESC LIMIT 1`, gameId,
        );
        expect(top).toMatchObject({ submitted_by_user_id: USER, score: 8366650 });
    });

    it('keeps the row at the player\'s best: a lower play leaves it, a higher one raises it', async () => {
        const { gameId } = await createRotationGame(roomId, 'Bad Cats');
        const ended = Math.floor(Date.now() / 1000);

        await VpxScoreIngestService.ingest(vpxScore(roomId, 8366650, ended - 600));
        await VpxScoreIngestService.ingest(vpxScore(roomId, 1000000, ended - 300));
        let rows = await submissionsFor(gameId);
        expect(rows).toHaveLength(1);
        expect(rows[0].score).toBe(8366650);

        await VpxScoreIngestService.ingest(vpxScore(roomId, 9000000, ended));
        rows = await submissionsFor(gameId);
        expect(rows).toHaveLength(1);
        expect(rows[0].score).toBe(9000000);
    });

    it('never lowers a higher typed score for the same player', async () => {
        const { gameId } = await createRotationGame(roomId, 'Bad Cats');
        const ended = Math.floor(Date.now() / 1000);
        await VpxScoreIngestService.ingest(vpxScore(roomId, 8366650, ended - 600));
        const [row] = await submissionsFor(gameId);

        // A typed score on the web route lands in the same row, higher.
        const db = await getDatabase();
        await db.run(`UPDATE submissions SET score = 20000000, platform = 'vpx', device = 'pc' WHERE id = ?`, row.id);

        await VpxScoreIngestService.ingest(vpxScore(roomId, 9000000, ended));
        const rows = await submissionsFor(gameId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ score: 20000000, device: 'pc' });
    });

    it('the backfill gives existing witness rows a summary row and leaves a higher typed one alone', async () => {
        const db = await getDatabase();
        const a = await createRotationGame(roomId, 'Bad Cats');
        const b = await createRotationGame(roomId, 'Taxi');
        const at = (minsAgo: number) => new Date(Date.now() - minsAgo * MINUTE).toISOString().replace('T', ' ').slice(0, 19);

        // Game A: two witness plays by Krobs (the HIGHER one must win), one
        // orphaned play that must be ignored, and a typed score by Blegger
        // already in submissions. Game B: Krobs' witness play is below his
        // own typed score, which must stay.
        const history = `INSERT INTO score_history
            (game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source,
             submitted_by_user_id, submitted_during_tournament_id, platform, engine, device, created_at, orphaned_at)
            VALUES (?, ?, ?, ?, ?, ?, 'vpx', ?, ?, 'vpx', 'vpx', 'vr_headset', ?, ?)`;
        await db.run(history, 'Bad Cats', roomId, a.gameId, 'Krobs', USER, 5276390, USER, a.tournamentId, at(50), null);
        await db.run(history, 'Bad Cats', roomId, a.gameId, 'Krobs', USER, 31269280, USER, a.tournamentId, at(40), null);
        await db.run(history, 'Bad Cats', roomId, a.gameId, 'Krobs', USER, 99999999, USER, a.tournamentId, at(30), at(20));
        await db.run(history, 'Taxi', roomId, b.gameId, 'Krobs', USER, 4000000, USER, b.tournamentId, at(10), null);
        await db.run(
            `INSERT INTO submissions (id, game_id, discord_user_id, iscored_username, score, timestamp, submitted_by_user_id)
             VALUES (?, ?, 'COMMUNITY', 'Blegger', 29653970, ?, '583104017840996363'),
                    (?, ?, 'COMMUNITY', 'Krobs', 6000000, ?, ?)`,
            `${a.gameId}-blegger`, a.gameId, at(45),
            `${b.gameId}-krobs`, b.gameId, at(15), USER,
        );

        const changed = await backfillWitnessSubmissions(db);
        expect(changed).toBe(1);

        const aRows = await submissionsFor(a.gameId);
        expect(aRows.map((r) => [r.iscored_username, r.score])).toEqual(
            expect.arrayContaining([['Blegger', 29653970], ['Krobs', 31269280]]),
        );
        const top = await db.get<{ submitted_by_user_id: string }>(
            `SELECT submitted_by_user_id FROM submissions WHERE game_id = ? ORDER BY score DESC LIMIT 1`, a.gameId,
        );
        expect(top!.submitted_by_user_id).toBe(USER);
        expect((await submissionsFor(a.gameId)).find((r) => r.id === `${a.gameId}-krobs`)).toMatchObject({
            discord_user_id: USER, submitted_by_user_id: USER, device: 'vr_headset',
        });

        const bRows = await submissionsFor(b.gameId);
        expect(bRows).toHaveLength(1);
        expect(bRows[0].score).toBe(6000000);

        // Idempotent.
        expect(await backfillWitnessSubmissions(db)).toBe(0);
    });
});
