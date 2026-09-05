import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GlobalScoreService } from '../services/GlobalScoreService.js';
import { PreferencesService } from '../services/PreferencesService.js';
import { ThrowdownScoreService } from '../services/ThrowdownScoreService.js';
import { VpxScoreIngestService } from '../services/VpxScoreIngestService.js';

/**
 * v2.153.0 (ADR 0023) — every score reaches the Global Scoreboard.
 *
 * The rule the owner set: *wherever you played, you should be rewarded by
 * having the world see how well you did, unless you explicitly opt out.* Before
 * this, three paths were silently excluded by their FORMAT rather than by the
 * player's choice — AtGames cabinet scores, VPXS cabinet scores that landed in
 * a tournament, and Throwdowns.
 *
 * What these tests pin:
 *
 *   1. **Format never decides.** Each automated path fans out.
 *   2. **The player decides.** `share_to_global = false` stops all of them, and
 *      it is the ONLY thing that does (there is no checkbox on these paths, so
 *      the account preference is the only voice the player has).
 *   3. **An unlinked cabinet score credits nobody.** Publishing a score to a
 *      site-wide board under the wrong name is the one failure worth refusing.
 *   4. **The `'sync'` bar still holds.** ADR 0016 P2 is about missing
 *      provenance, not about format, so it is untouched by this change.
 */

const USER = '123456789012345678';
const MINUTE = 60_000;

async function seedCatalogue(name: string, manufacturer: string | null = null, year: number | null = null) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_games (id, name, type, manufacturer, year, status)
         VALUES (?, ?, 'pinball', ?, ?, 'approved')`,
        id, name, manufacturer, year,
    );
    return id;
}

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

function vpxScore(roomId: string, tournamentId: string | null) {
    const ended = Math.floor(Date.now() / 1000);
    return {
        canonicalUserId: USER,
        tableName: 'Bad Cats (Williams 1989)',
        rom: 'bcats_l5',
        slug: 'vpx-badcats',
        score: 8366650,
        startedTs: ended - 300,
        endedTs: ended,
        durationSec: 300,
        reason: 'game_over',
        target: { roomId, tournamentId, globalFallback: true },
    };
}

describe('Global fan-out — every format', () => {
    let roomId: string;

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
        await addMember(roomId);
    });

    it('publishes a VPXS score that landed in a tournament', async () => {
        // Before ADR 0023 this score existed only on the room's board: playing
        // in a tournament silently cost the player their global record.
        await createRotationGame(roomId, 'Bad Cats');
        const globalGameId = await seedCatalogue('Bad Cats', 'Williams', 1989);

        const result = await VpxScoreIngestService.ingest(vpxScore(roomId, null));
        expect(result.status).toBe('ingested');

        const db = await getDatabase();
        const row = await db.get<{ global_game_id: string; score: number; engine: string; player_id: string }>(
            `SELECT global_game_id, score, engine, player_id FROM global_scores ORDER BY rowid DESC LIMIT 1`,
        );
        expect(row).toMatchObject({
            global_game_id: globalGameId, score: 8366650, engine: 'vpx', player_id: USER,
        });
    });

    it('records HOW the score reached us, so the board can badge it', async () => {
        // v2.155.0: `global_scores` never carried a source, so on the Global
        // Scoreboard — the one place a stranger sees the row — a cabinet-reported
        // score was indistinguishable from a typed one. It has no photo either,
        // so it read as the LEAST evidenced row on the page.
        await createRotationGame(roomId, 'Bad Cats');
        await seedCatalogue('Bad Cats', 'Williams', 1989);

        await VpxScoreIngestService.ingest(vpxScore(roomId, null));

        const db = await getDatabase();
        const row = await db.get<{ source: string | null }>(
            `SELECT source FROM global_scores ORDER BY rowid DESC LIMIT 1`,
        );
        expect(row!.source).toBe('vpx');
    });

    it('publishes a Throwdown score, with no room to hang it on', async () => {
        const globalGameId = await seedCatalogue('Bad Cats', 'Williams', 1989);
        const db = await getDatabase();
        const tournamentId = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, throwdown_code)
             VALUES (?, 'Quick Challenge', 'DG', 'pinball', '{}', 1, NULL, 'event', 'ABC234')`,
            tournamentId,
        );
        const gameId = crypto.randomUUID();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, round_no, scheduled_start_at, scheduled_end_at)
             VALUES (?, ?, 'Bad Cats', 'ACTIVE', 1, ?, ?)`,
            gameId, tournamentId,
            new Date(Date.now() - 10 * MINUTE).toISOString(),
            new Date(Date.now() + 10 * MINUTE).toISOString(),
        );

        await ThrowdownScoreService.submit({
            tournamentId, gameId, gameName: 'Bad Cats', userId: USER,
            username: 'Tester', score: 4242000, engine: 'vpx', device: 'pc', platform: 'vpx',
        });

        const row = await db.get<{ global_game_id: string; score: number; origin_type: string;
                                  origin_game_room_id: string | null }>(
            `SELECT global_game_id, score, origin_type, origin_game_room_id
               FROM global_scores ORDER BY rowid DESC LIMIT 1`,
        );
        // A room-less challenge is a GLOBAL-origin row: there is no room chip
        // for the board to render against it.
        expect(row).toMatchObject({
            global_game_id: globalGameId, score: 4242000,
            origin_type: 'global', origin_game_room_id: null,
        });
    });

    it('obeys the account opt-out on every automated path', async () => {
        await createRotationGame(roomId, 'Bad Cats');
        await seedCatalogue('Bad Cats', 'Williams', 1989);
        await PreferencesService.setShareToGlobal(USER, false);

        const result = await VpxScoreIngestService.ingest(vpxScore(roomId, null));
        expect(result.status).toBe('ingested'); // the tournament board still gets it

        const db = await getDatabase();
        const count = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM global_scores`);
        expect(count!.n).toBe(0);
    });

    it('refuses to credit an unlinked cabinet account', async () => {
        // There is no account behind `atgames:50177`, and putting somebody
        // else's name on a public board is worse than the score not appearing.
        await seedCatalogue('Bad Cats', 'Williams', 1989);
        const fanOut = await GlobalScoreService.fanOutAutomatedScore({
            gameRoomId: roomId, gameName: 'Bad Cats', canonicalUserId: null,
            username: 'SomeCabinet', score: 999, source: 'atgames',
        });
        expect(fanOut).toBeNull();

        const db = await getDatabase();
        const count = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM global_scores`);
        expect(count!.n).toBe(0);
    });

    it('still refuses an iScored-synced score, which is about provenance, not format', async () => {
        // ADR 0016 P2 is untouched by ADR 0023: a synced score carries no
        // engine or device of its own, so nothing about it can qualify it for a
        // board where scores are ranked against strangers.
        await seedCatalogue('Bad Cats', 'Williams', 1989);
        const fanOut = await GlobalScoreService.fanOutFromRoomSubmission({
            gameRoomId: roomId, gameName: 'Bad Cats', playerId: USER,
            iscoredUsername: 'Tester', score: 5150, source: 'sync',
        });
        expect(fanOut).toBeNull();
    });

    it('does not publish the same score twice when a cabinet re-reports it', async () => {
        await createRotationGame(roomId, 'Bad Cats');
        await seedCatalogue('Bad Cats', 'Williams', 1989);

        await VpxScoreIngestService.ingest(vpxScore(roomId, null));
        await VpxScoreIngestService.ingest(vpxScore(roomId, null));

        const db = await getDatabase();
        const count = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM global_scores`);
        expect(count!.n).toBe(1);
    });
});
