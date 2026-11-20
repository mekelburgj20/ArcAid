import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { drainBackgroundTasks } from '../utils/backgroundTasks.js';
import { LobbyFeedGenerator } from '../services/LobbyFeedGenerator.js';
import { DiscordScorePostService } from '../services/DiscordScorePostService.js';

/**
 * W115 — a Witness score reaches the ONE score hook.
 *
 * `LobbyFeedGenerator.onScoreSubmitted` is where a landed score becomes
 * visible beyond its board: the live toast, the lobby feed, the dethrone DM
 * and the room's top-N Discord post (E13). Every typed path called it; the
 * Witness ingest did not, so a cabinet score sat on the board and nothing was
 * posted to Mox's Discord (GamerDad89, 2026-11-20).
 *
 *   1. A landed play calls the hook as source `vpx`, and the hook ranks it
 *      (the W93 `submissions` row is what it ranks from) and hands the
 *      Discord post its rank.
 *   2. One play announces ONCE per (room, table), even when it lands in two
 *      of that room's tournaments (W37 lands it in both).
 *   3. A repeat of a play that already landed announces nothing.
 */

const USER = '123456789012345678';
const DEVICE = 'fp-device-uuid-hook';
const MINUTE = 60_000;

const playerToken = (discordId: string) =>
    signToken({ role: 'player', gameRoomIds: [], discordId, username: discordId });

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    return app;
}

async function pairDevice(app: express.Express) {
    const codeRes = await request(app)
        .post('/api/me/witness/pairing-code')
        .set('Authorization', `Bearer ${playerToken(USER)}`).send({});
    const pairRes = await request(app)
        .get('/api/witness/pair')
        .query({ code: codeRes.body.code, device: DEVICE, username: 'CabinetOwner' });
    return pairRes.body.token as string;
}

function scoreQuery(endedMs: number) {
    return {
        table: 'Bad Cats (Williams 1989)',
        rom: 'bcats_l5',
        slug: 'vpx-badcats',
        score: 8366650,
        started: Math.floor((endedMs - 5 * MINUTE) / 1000),
        ended: Math.floor(endedMs / 1000),
        dur: 300,
        reason: 'game_over',
    };
}

async function addMember(roomId: string) {
    const db = await getDatabase();
    await db.run(
        `INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'submission')`,
        USER, roomId,
    );
}

async function createRotationGame(roomId: string, tournamentName: string) {
    const db = await getDatabase();
    const tournamentId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format)
         VALUES (?, ?, 'WG', 'pinball', '{}', 1, ?, 'rotation')`,
        tournamentId, tournamentName, roomId,
    );
    const gameId = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, game_room_id, start_date)
         VALUES (?, ?, 'Bad Cats', 'ACTIVE', ?, ?)`,
        gameId, tournamentId, roomId, new Date(Date.now() - 60 * MINUTE).toISOString(),
    );
    return { tournamentId, gameId };
}

describe('W115 — a Witness score reaches the score hook', () => {
    let app: express.Express;
    let roomId: string;
    let token: string;

    beforeEach(async () => {
        app = await createTestApp();
        roomId = await createTestRoom();
        token = await pairDevice(app);
        await addMember(roomId);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('a landed play fires the hook as source vpx, and the Discord post gets its rank', async () => {
        const { tournamentId } = await createRotationGame(roomId, 'Weekly VPXS');
        const hook = vi.spyOn(LobbyFeedGenerator, 'onScoreSubmitted');
        const post = vi.spyOn(DiscordScorePostService, 'onScoreRanked').mockResolvedValue(undefined);

        const res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery(Date.now()) });
        expect(res.body).toMatchObject({ ok: true, status: 'ingested' });
        await drainBackgroundTasks();

        expect(hook).toHaveBeenCalledTimes(1);
        expect(hook.mock.calls[0]![0]).toMatchObject({
            gameRoomId: roomId,
            gameName: 'Bad Cats',
            score: 8366650,
            discordUserId: USER,
            source: 'vpx',
            tournamentId,
        });
        // The real hook ran: it ranked the play from the W93 `submissions` row
        // and handed the top-N post (the room switch is checked inside it).
        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0]![0]).toMatchObject({
            roomId, gameName: 'Bad Cats', score: 8366650, rank: 1, total: 1, tournamentId,
        });
    });

    it('one play landing in two tournaments of the same room announces once', async () => {
        await createRotationGame(roomId, 'Weekly VPXS');
        await createRotationGame(roomId, 'Season 06');
        const hook = vi.spyOn(LobbyFeedGenerator, 'onScoreSubmitted').mockResolvedValue(undefined);

        const res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery(Date.now()) });
        await drainBackgroundTasks();

        // Both boards took it (W37) ...
        expect(res.body.landed?.filter((l: { status: string }) => l.status === 'ingested')).toHaveLength(2);
        // ... and the room heard about it once.
        expect(hook).toHaveBeenCalledTimes(1);
    });

    it('a repeat of a play that already landed announces nothing', async () => {
        await createRotationGame(roomId, 'Weekly VPXS');
        const hook = vi.spyOn(LobbyFeedGenerator, 'onScoreSubmitted').mockResolvedValue(undefined);
        const endedMs = Date.now();

        await request(app).get('/api/witness/score').query({ device: DEVICE, token, ...scoreQuery(endedMs) });
        const again = await request(app).get('/api/witness/score').query({ device: DEVICE, token, ...scoreQuery(endedMs) });
        await drainBackgroundTasks();

        expect(again.body.ok).toBe(true);
        expect(hook).toHaveBeenCalledTimes(1);
    });
});
