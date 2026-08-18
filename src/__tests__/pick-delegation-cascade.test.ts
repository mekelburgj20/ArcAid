import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { TournamentEngine } from '../engine/TournamentEngine.js';
import { PickDispositionService } from '../services/PickDispositionService.js';
import { resolvePick, MAX_PLACES } from '../engine/pickResolution.js';
import { resolveLeaderboardPlaces } from '../utils/submissionAttribution.js';

/**
 * Pick delegation cascade — owner spec 2026-08-17.
 * Contract: tmp/pick-delegation-contract.md
 *
 * The bug these pin down was live in prod on 2026-08-17: the queue was a
 * tournament-global FIFO, so winning activated whoever queued FIRST rather than
 * the winner's own pick, and nominate/forfeit were unreachable whenever anything
 * was queued.
 */

let roomCounter = 0;

async function setup() {
    const roomId = await createTestRoom(`cascade-room-${++roomCounter}`, 'Cascade Room');
    const tournamentId = await createTestTournament(roomId, { name: 'Daily Grind' });
    return { roomId, tournamentId };
}

/** One row per player per game, keyed like the real sync-compatible id. */
async function seedScore(gameId: string, opts: {
    username: string;
    playerId?: string | null;
    score: number;
    orphaned?: boolean;
}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO submissions (id, game_id, discord_user_id, submitted_by_user_id, iscored_username, score, timestamp, orphaned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        `${gameId}-${opts.username.toLowerCase()}`,
        gameId,
        opts.playerId ?? 'COMMUNITY',
        opts.playerId ?? null,
        opts.username,
        opts.score,
        new Date().toISOString(),
        opts.orphaned ? new Date().toISOString() : null,
    );
}

/** Queue a game for a specific player through the real allocator. */
async function queueFor(tournamentId: string, playerId: string, gameName: string) {
    const engine = TournamentEngine.getInstance();
    return engine.queueGame(tournamentId, gameName, undefined, undefined, playerId);
}

/** Run the cascade the same way processSlotMaintenance does. */
async function runCascade(tournamentId: string, roomId: string, gameId: string, opts: {
    startPlaceIndex?: number;
    dynastyBlockedWinner?: boolean;
} = {}) {
    const db = await getDatabase();
    const engine = TournamentEngine.getInstance() as any;
    return resolvePick({
        tournamentId,
        places: await resolveLeaderboardPlaces(db, gameId, MAX_PLACES),
        nextQueuedFor: (playerId: string) => engine.nextEligibleQueuedFor(tournamentId, playerId),
        labelFor: (playerId: string) => engine.labelForPlayer(playerId),
        isRoomMember: async (playerId: string) => !!(await db.get(
            'SELECT 1 AS ok FROM room_members WHERE room_id = ? AND user_id = ?', roomId, playerId,
        )),
        ...opts,
    });
}

describe('Pick delegation — per-player queues', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('queue_order is allocated PER PLAYER, so two players both hold position 1', async () => {
        const { tournamentId } = await setup();
        const a1 = await queueFor(tournamentId, 'PLAYER_A', 'A First');
        const a2 = await queueFor(tournamentId, 'PLAYER_A', 'A Second');
        const b1 = await queueFor(tournamentId, 'PLAYER_B', 'B First');

        expect(a1.queueOrder).toBe(1);
        expect(a2.queueOrder).toBe(2);
        // Pre-fix this was 3 — a tournament-global MAX — which is what let the
        // reorder endpoint's 1..N renumber collide across players.
        expect(b1.queueOrder).toBe(1);
    });

    it('REGRESSION (prod 2026-08-17): the winner gets their OWN queued game, not the queue head', async () => {
        const { roomId, tournamentId } = await setup();
        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE', name: 'Blackbelt 2018' });

        // Exact prod shape: soggybacon queued first and lost; ChalataLove queued
        // second and won.
        await queueFor(tournamentId, 'SOGGYBACON', 'Magic Castle');
        await queueFor(tournamentId, 'CHALATALOVE', 'Xena Warrior Princess Pinball');

        await seedScore(gameId, { username: 'ChalataLove', playerId: 'CHALATALOVE', score: 3_588_843_950 });
        await seedScore(gameId, { username: 'soggybacon', playerId: 'SOGGYBACON', score: 723_234_440 });

        const { outcome } = await runCascade(tournamentId, roomId, gameId);

        expect(outcome.kind).toBe('activate');
        expect((outcome as any).playerId).toBe('CHALATALOVE');
        expect((outcome as any).game.name).toBe('Xena Warrior Princess Pinball');
    });

    it("another player's queued game is never activated because someone else won", async () => {
        const { roomId, tournamentId } = await setup();
        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        await queueFor(tournamentId, 'LOSER', 'Not Yours');
        await seedScore(gameId, { username: 'Winner', playerId: 'WINNER', score: 100 });

        const { outcome } = await runCascade(tournamentId, roomId, gameId);

        // Winner has nothing queued → a window, NOT the loser's game.
        expect(outcome.kind).toBe('window');
        expect((outcome as any).playerId).toBe('WINNER');
        expect((outcome as any).pickerType).toBe('WINNER');
    });

    it("consumes the winner's front-of-queue game, in their own queue order", async () => {
        const { roomId, tournamentId } = await setup();
        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        await queueFor(tournamentId, 'WINNER', 'First Choice');
        await queueFor(tournamentId, 'WINNER', 'Second Choice');
        await seedScore(gameId, { username: 'Winner', playerId: 'WINNER', score: 100 });

        const { outcome } = await runCascade(tournamentId, roomId, gameId);
        expect((outcome as any).game.name).toBe('First Choice');
    });
});

describe('Pick delegation — the place cascade', () => {
    beforeEach(async () => { await setupTestDb(); });

    /** 1st=W, 2nd=R, 3rd=T, all attributed. */
    async function seedPodium(tournamentId: string) {
        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        await seedScore(gameId, { username: 'Winner', playerId: 'W', score: 300 });
        await seedScore(gameId, { username: 'Runner', playerId: 'R', score: 200 });
        await seedScore(gameId, { username: 'Third', playerId: 'T', score: 100 });
        return gameId;
    }

    it('winner forfeits → runner-up with a queue activates it IMMEDIATELY (no window)', async () => {
        const { roomId, tournamentId } = await setup();
        const gameId = await seedPodium(tournamentId);
        await PickDispositionService.set(tournamentId, 'W', 'forfeit');
        await queueFor(tournamentId, 'R', 'Runner Pick');

        const { outcome, narrative } = await runCascade(tournamentId, roomId, gameId);

        expect(outcome.kind).toBe('activate');
        expect((outcome as any).playerId).toBe('R');
        expect((outcome as any).game.name).toBe('Runner Pick');
        expect(narrative.join(' ')).toMatch(/forfeited/i);
    });

    it('winner forfeits → runner-up with no queue gets the RUNNER_UP window', async () => {
        const { roomId, tournamentId } = await setup();
        const gameId = await seedPodium(tournamentId);
        await PickDispositionService.set(tournamentId, 'W', 'forfeit');

        const { outcome } = await runCascade(tournamentId, roomId, gameId);

        expect(outcome.kind).toBe('window');
        expect((outcome as any).playerId).toBe('R');
        expect((outcome as any).pickerType).toBe('RUNNER_UP');
    });

    it("both forfeit → THIRD place's queue is used", async () => {
        const { roomId, tournamentId } = await setup();
        const gameId = await seedPodium(tournamentId);
        await PickDispositionService.set(tournamentId, 'W', 'forfeit');
        await PickDispositionService.set(tournamentId, 'R', 'forfeit');
        await queueFor(tournamentId, 'T', 'Third Pick');

        const { outcome, narrative } = await runCascade(tournamentId, roomId, gameId);

        expect(outcome.kind).toBe('activate');
        expect((outcome as any).playerId).toBe('T');
        expect((outcome as any).game.name).toBe('Third Pick');
        // Both forfeits are named in the copy (owner's explicit messaging ask).
        expect(narrative.filter(l => /forfeited/i.test(l))).toHaveLength(2);
    });

    it('both forfeit and third has no queue → auto-pick', async () => {
        const { roomId, tournamentId } = await setup();
        const gameId = await seedPodium(tournamentId);
        await PickDispositionService.set(tournamentId, 'W', 'forfeit');
        await PickDispositionService.set(tournamentId, 'R', 'forfeit');

        const { outcome } = await runCascade(tournamentId, roomId, gameId);
        expect(outcome.kind).toBe('auto');
    });

    it('THIRD place never receives a pick window, even with no queue', async () => {
        const { roomId, tournamentId } = await setup();
        const gameId = await seedPodium(tournamentId);

        const { outcome } = await runCascade(tournamentId, roomId, gameId, { startPlaceIndex: 2 });
        expect(outcome.kind).toBe('auto');
    });

    it("third place's DISPOSITION is ignored — only their queue is read", async () => {
        const { roomId, tournamentId } = await setup();
        const gameId = await seedPodium(tournamentId);
        // A nominate at third would hand the pick onward if dispositions were
        // honored there; contract §4.2 says they are not.
        await PickDispositionService.set(tournamentId, 'T', 'nominate', 'SOMEONE_ELSE');
        await queueFor(tournamentId, 'T', 'Third Pick');

        const { outcome } = await runCascade(tournamentId, roomId, gameId, { startPlaceIndex: 2 });
        expect(outcome.kind).toBe('activate');
        expect((outcome as any).playerId).toBe('T');
    });
});

describe('Pick delegation — dispositions', () => {
    beforeEach(async () => { await setupTestDb(); });

    async function seedPodium(tournamentId: string) {
        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        await seedScore(gameId, { username: 'Winner', playerId: 'W', score: 300 });
        await seedScore(gameId, { username: 'Runner', playerId: 'R', score: 200 });
        await seedScore(gameId, { username: 'Third', playerId: 'T', score: 100 });
        return gameId;
    }

    it('roll the dice → auto-pick, even when the winner has a queue', async () => {
        const { roomId, tournamentId } = await setup();
        const gameId = await seedPodium(tournamentId);
        await PickDispositionService.set(tournamentId, 'W', 'auto');
        await queueFor(tournamentId, 'W', 'Would Have Been Mine');

        const { outcome, narrative } = await runCascade(tournamentId, roomId, gameId);

        expect(outcome.kind).toBe('auto');
        expect(narrative.join(' ')).toMatch(/roll the dice/i);
    });

    it("nominate hands the pick to the nominee's own queue", async () => {
        const { roomId, tournamentId } = await setup();
        const gameId = await seedPodium(tournamentId);
        await PickDispositionService.set(tournamentId, 'W', 'nominate', 'FRIEND');
        await queueFor(tournamentId, 'FRIEND', 'Friend Pick');

        const { outcome } = await runCascade(tournamentId, roomId, gameId);

        expect(outcome.kind).toBe('activate');
        expect((outcome as any).playerId).toBe('FRIEND');
        expect((outcome as any).game.name).toBe('Friend Pick');
    });

    it("a nominee's own disposition is honored (chained nominate)", async () => {
        const { roomId, tournamentId } = await setup();
        const gameId = await seedPodium(tournamentId);
        await PickDispositionService.set(tournamentId, 'W', 'nominate', 'B');
        await PickDispositionService.set(tournamentId, 'B', 'nominate', 'C');
        await queueFor(tournamentId, 'C', 'C Pick');

        const { outcome } = await runCascade(tournamentId, roomId, gameId);
        expect((outcome as any).playerId).toBe('C');
    });

    it('nominee forfeits and was NOT the runner-up → the actual runner-up', async () => {
        const { roomId, tournamentId } = await setup();
        const gameId = await seedPodium(tournamentId);
        await PickDispositionService.set(tournamentId, 'W', 'nominate', 'BYSTANDER');
        await PickDispositionService.set(tournamentId, 'BYSTANDER', 'forfeit');
        await queueFor(tournamentId, 'R', 'Runner Pick');

        const { outcome } = await runCascade(tournamentId, roomId, gameId);

        expect(outcome.kind).toBe('activate');
        expect((outcome as any).playerId).toBe('R');
    });

    it("nominee forfeits and WAS the runner-up → third's queue (unified rule, owner ruling Q1)", async () => {
        const { roomId, tournamentId } = await setup();
        const gameId = await seedPodium(tournamentId);
        await PickDispositionService.set(tournamentId, 'W', 'nominate', 'R');
        await PickDispositionService.set(tournamentId, 'R', 'forfeit');
        await queueFor(tournamentId, 'T', 'Third Pick');

        const { outcome } = await runCascade(tournamentId, roomId, gameId);

        // The originally-stated shortcut was "auto-pick"; the owner unified it so
        // third's queue is always consulted first.
        expect(outcome.kind).toBe('activate');
        expect((outcome as any).playerId).toBe('T');
    });

    it('a nomination CYCLE is broken and falls through to the next place', async () => {
        const { roomId, tournamentId } = await setup();
        const gameId = await seedPodium(tournamentId);
        await PickDispositionService.set(tournamentId, 'W', 'nominate', 'B');
        await PickDispositionService.set(tournamentId, 'B', 'nominate', 'W');
        await queueFor(tournamentId, 'R', 'Runner Pick');

        const { outcome, narrative } = await runCascade(tournamentId, roomId, gameId);

        expect((outcome as any).playerId).toBe('R');
        expect(narrative.join(' ')).toMatch(/looped/i);
    });

    it('LIFETIME: nominate is one-shot; forfeit and auto stand (owner ruling Q2)', async () => {
        const { roomId, tournamentId } = await setup();
        const gameId = await seedPodium(tournamentId);

        await PickDispositionService.set(tournamentId, 'W', 'nominate', 'FRIEND');
        await runCascade(tournamentId, roomId, gameId);
        expect(await PickDispositionService.get(tournamentId, 'W')).toBeNull();

        await PickDispositionService.set(tournamentId, 'W', 'forfeit');
        await runCascade(tournamentId, roomId, gameId);
        expect((await PickDispositionService.get(tournamentId, 'W'))?.disposition).toBe('forfeit');

        await PickDispositionService.set(tournamentId, 'W', 'auto');
        await runCascade(tournamentId, roomId, gameId);
        expect((await PickDispositionService.get(tournamentId, 'W'))?.disposition).toBe('auto');
    });

    it("a chained player's disposition is READ, not consumed", async () => {
        const { roomId, tournamentId } = await setup();
        const gameId = await seedPodium(tournamentId);
        await PickDispositionService.set(tournamentId, 'W', 'forfeit');
        // R is reached through the cascade, not by winning — their nominate must survive.
        await PickDispositionService.set(tournamentId, 'R', 'nominate', 'FRIEND');

        await runCascade(tournamentId, roomId, gameId);

        expect((await PickDispositionService.get(tournamentId, 'R'))?.disposition).toBe('nominate');
    });
});

describe('Pick delegation — identity hazards in the cascade', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('one human holding 1st AND 3rd is not handed the pick as their own runner-up', async () => {
        const { roomId, tournamentId } = await setup();
        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });

        // The live ChalataLove shape: a synced row and a web row for one person,
        // under names that resolve to the same player id.
        await seedScore(gameId, { username: 'ChalataLove', playerId: 'CHALATA', score: 3_588_843_950 });
        await seedScore(gameId, { username: 'soggybacon', playerId: 'SOGGY', score: 723_234_440 });
        await seedScore(gameId, { username: 'ChalataLove_web', playerId: 'CHALATA', score: 358_884_390 });

        await PickDispositionService.set(tournamentId, 'CHALATA', 'forfeit');
        await queueFor(tournamentId, 'SOGGY', 'Soggy Pick');

        const { outcome } = await runCascade(tournamentId, roomId, gameId);

        // Runner-up must be SOGGY, never CHALATA's second row.
        expect((outcome as any).playerId).toBe('SOGGY');
    });

    it('an unattributed (iScored-only) place is skipped, not handed a window', async () => {
        const { roomId, tournamentId } = await setup();
        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        await seedScore(gameId, { username: 'Winner', playerId: 'W', score: 300 });
        await seedScore(gameId, { username: 'UnclaimedName', playerId: null, score: 200 });
        await seedScore(gameId, { username: 'Third', playerId: 'T', score: 100 });

        await PickDispositionService.set(tournamentId, 'W', 'forfeit');
        await queueFor(tournamentId, 'T', 'Third Pick');

        const { outcome } = await runCascade(tournamentId, roomId, gameId);

        // The unclaimed name cannot be DM'd or hold a window, so it is skipped
        // and T moves up into the runner-up slot — where a queue activates
        // immediately.
        expect(outcome.kind).toBe('activate');
        expect((outcome as any).playerId).toBe('T');
    });

    it('a ban-hidden (orphaned) score cannot become the runner-up', async () => {
        const { roomId, tournamentId } = await setup();
        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        await seedScore(gameId, { username: 'Winner', playerId: 'W', score: 300 });
        await seedScore(gameId, { username: 'Banned', playerId: 'BANNED', score: 250, orphaned: true });
        await seedScore(gameId, { username: 'Third', playerId: 'T', score: 100 });

        await PickDispositionService.set(tournamentId, 'W', 'forfeit');
        await queueFor(tournamentId, 'T', 'Third Pick');

        const { outcome } = await runCascade(tournamentId, roomId, gameId);
        expect((outcome as any).playerId).toBe('T');
    });
});

describe('Pick delegation — dynasty interaction', () => {
    beforeEach(async () => { await setupTestDb(); });

    it("a dynasty-blocked winner does NOT get their queued game activated", async () => {
        const { roomId, tournamentId } = await setup();
        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        await seedScore(gameId, { username: 'Winner', playerId: 'W', score: 300 });
        await seedScore(gameId, { username: 'Runner', playerId: 'R', score: 200 });
        await queueFor(tournamentId, 'W', 'Winner Pick');
        await queueFor(tournamentId, 'R', 'Runner Pick');

        const { outcome, narrative } = await runCascade(tournamentId, roomId, gameId, { dynastyBlockedWinner: true });

        expect((outcome as any).playerId).toBe('R');
        expect((outcome as any).game.name).toBe('Runner Pick');
        expect(narrative.join(' ')).toMatch(/back-to-back/i);
    });

    it('a dynasty block does not override an explicit disposition', async () => {
        const { roomId, tournamentId } = await setup();
        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        await seedScore(gameId, { username: 'Winner', playerId: 'W', score: 300 });
        await seedScore(gameId, { username: 'Runner', playerId: 'R', score: 200 });
        await PickDispositionService.set(tournamentId, 'W', 'nominate', 'FRIEND');
        await queueFor(tournamentId, 'FRIEND', 'Friend Pick');

        const { outcome } = await runCascade(tournamentId, roomId, gameId, { dynastyBlockedWinner: true });
        expect((outcome as any).playerId).toBe('FRIEND');
    });
});

describe('Pick delegation — queue eligibility', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('skips (and drops) a queued game that lost eligibility, using the next one', async () => {
        const { roomId, tournamentId } = await setup();
        const db = await getDatabase();
        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        await seedScore(gameId, { username: 'Winner', playerId: 'W', score: 300 });

        const stale = await queueFor(tournamentId, 'W', 'Recently Played');
        await queueFor(tournamentId, 'W', 'Fresh Pick');

        // A COMPLETED run of the same game inside the cooldown window makes the
        // queued row ineligible.
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, start_date, end_date)
             VALUES (?, ?, 'Recently Played', 'COMPLETED', ?, ?)`,
            crypto.randomUUID(), tournamentId, new Date().toISOString(), new Date().toISOString(),
        );

        const { outcome } = await runCascade(tournamentId, roomId, gameId);

        expect((outcome as any).game.name).toBe('Fresh Pick');
        expect(await db.get('SELECT id FROM games WHERE id = ?', stale.id)).toBeUndefined();
    });

    it('a [Pending Pick] placeholder is never treated as a queued pick', async () => {
        const { roomId, tournamentId } = await setup();
        const db = await getDatabase();
        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        await seedScore(gameId, { username: 'Winner', playerId: 'W', score: 300 });
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, picker_discord_id, picker_type, won_game_id)
             VALUES (?, ?, '[Pending Pick]', 'QUEUED', 'W', 'WINNER', ?)`,
            crypto.randomUUID(), tournamentId, gameId,
        );

        const { outcome } = await runCascade(tournamentId, roomId, gameId);
        expect(outcome.kind).toBe('window');
    });
});

describe('Pick delegation — queue reorder endpoint', () => {
    beforeEach(async () => { await setupTestDb(); });

    async function createApp() {
        const express = (await import('express')).default;
        const app = express();
        app.use(express.json());
        const { default: roomsRouter } = await import('../api/routes/rooms.js');
        app.use('/api/rooms', roomsRouter);
        return app;
    }

    it("renumbers only the caller's own queue, leaving another player's positions intact", async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const db = await getDatabase();
        const { roomId, tournamentId } = await setup();

        const a1 = await queueFor(tournamentId, 'PLAYER_A', 'A One');
        const a2 = await queueFor(tournamentId, 'PLAYER_A', 'A Two');
        const b1 = await queueFor(tournamentId, 'PLAYER_B', 'B One');
        const b2 = await queueFor(tournamentId, 'PLAYER_B', 'B Two');

        const app = await createApp();
        const token = signToken({ role: 'player', gameRoomIds: [roomId], discordId: 'PLAYER_A' });
        const res = await request(app)
            .put(`/api/rooms/${roomId}/queue/reorder`)
            .set('Authorization', `Bearer ${token}`)
            .send({ gameIds: [a2.id, a1.id] });

        expect(res.status).toBe(200);

        // A's queue is flipped...
        expect((await db.get('SELECT queue_order FROM games WHERE id = ?', a2.id)).queue_order).toBe(1);
        expect((await db.get('SELECT queue_order FROM games WHERE id = ?', a1.id)).queue_order).toBe(2);
        // ...and B's is untouched. Pre-fix the renumber ran in a tournament-GLOBAL
        // space, so A's write silently collided with B's positions.
        expect((await db.get('SELECT queue_order FROM games WHERE id = ?', b1.id)).queue_order).toBe(1);
        expect((await db.get('SELECT queue_order FROM games WHERE id = ?', b2.id)).queue_order).toBe(2);
    });

    it('a PARTIAL reorder payload does not leave duplicate positions in the caller\'s own queue', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const db = await getDatabase();
        const { roomId, tournamentId } = await setup();

        const g1 = await queueFor(tournamentId, 'PLAYER_A', 'One');
        const g2 = await queueFor(tournamentId, 'PLAYER_A', 'Two');
        const g3 = await queueFor(tournamentId, 'PLAYER_A', 'Three');

        const app = await createApp();
        const token = signToken({ role: 'player', gameRoomIds: [roomId], discordId: 'PLAYER_A' });
        // Mentions only two of the three.
        const res = await request(app)
            .put(`/api/rooms/${roomId}/queue/reorder`)
            .set('Authorization', `Bearer ${token}`)
            .send({ gameIds: [g3.id, g1.id] });

        expect(res.status).toBe(200);

        const orders = await db.all(
            `SELECT id, queue_order FROM games WHERE tournament_id = ? AND status = 'QUEUED' AND picker_discord_id = 'PLAYER_A'
             ORDER BY queue_order ASC`, tournamentId,
        );
        expect(orders.map((r: any) => r.queue_order)).toEqual([1, 2, 3]);
        expect(orders[0].id).toBe(g3.id);
        expect(orders[1].id).toBe(g1.id);
        expect(orders[2].id).toBe(g2.id);
    });
});

describe('Pick delegation — timeout re-entry', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('resuming below a timed-out picker never hands the same person a second window', async () => {
        const { roomId, tournamentId } = await setup();
        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        await seedScore(gameId, { username: 'Winner', playerId: 'W', score: 300 });
        await seedScore(gameId, { username: 'Runner', playerId: 'R', score: 200 });
        await seedScore(gameId, { username: 'Third', playerId: 'T', score: 100 });

        // W nominated R, so R held a WINNER-type window and let it lapse. The
        // pivot must resume at place 2, not walk back to place 1 (R again).
        const timedOutIndex = 1; // R sits at place 1
        const { outcome } = await runCascade(tournamentId, roomId, gameId, {
            startPlaceIndex: timedOutIndex + 1,
        });

        expect(outcome.kind).toBe('auto'); // T is third → queue-only, and has none
        expect((outcome as any).playerId).toBeUndefined();
    });
});

describe('Pick delegation — announcement labels', () => {
    beforeEach(async () => { await setupTestDb(); });

    /**
     * REGRESSION (owner field report, 2026-08-18). A rotation embed read:
     *   "@soggybacon — congrats on the win! 1393376372025458799 handed their
     *    pick to mekelburgj."
     *
     * labelForPlayer resolved display_name -> iScored alias -> raw id, skipping
     * `user_profiles.username`. That middle rung is the only one populated for
     * everyone (written on every login since v2.40.0); a display_name exists
     * only if chosen, an alias only after /map-user or a merge. Two of the four
     * active players on rtx_pinball had neither, so their snowflake shipped to
     * the channel.
     */
    async function seedProfile(id: string, opts: { display?: string | null; username?: string | null } = {}) {
        const db = await getDatabase();
        await db.run(
            'INSERT INTO user_profiles (discord_user_id, display_name, username) VALUES (?, ?, ?)',
            id, opts.display ?? null, opts.username ?? null,
        );
    }
    const label = (id: string) => (TournamentEngine.getInstance() as any).labelForPlayer(id);

    it('falls back to the provider username when no display name is set', async () => {
        await seedProfile('1393376372025458799', { display: null, username: 'soggybacon' });
        expect(await label('1393376372025458799')).toBe('soggybacon');
    });

    it('prefers a chosen display name over the provider username', async () => {
        await seedProfile('U-display', { display: 'RetroTechX', username: 'retro_raw' });
        expect(await label('U-display')).toBe('RetroTechX');
    });

    it('falls back to an iScored alias when neither name is stored', async () => {
        const db = await getDatabase();
        await seedProfile('U-alias', { display: null, username: null });
        await db.run(
            'INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, ?)',
            'U-alias', 'AliasOnly',
        );
        expect(await label('U-alias')).toBe('AliasOnly');
    });

    it('only reaches the raw id when the player is genuinely unknown', async () => {
        expect(await label('U-nothing-known')).toBe('U-nothing-known');
    });

    it('a nominate hand-off names both people, never a snowflake', async () => {
        const { roomId, tournamentId } = await setup();
        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        await seedScore(gameId, { username: 'soggybacon', playerId: 'W-soggy', score: 300 });
        await seedScore(gameId, { username: 'other', playerId: 'R-other', score: 200 });
        await seedProfile('W-soggy', { username: 'soggybacon' });
        await seedProfile('N-mekel', { username: 'mekelburgj' });
        await PickDispositionService.set(tournamentId, 'W-soggy', 'nominate', 'N-mekel');
        await queueFor(tournamentId, 'N-mekel', 'Back to the Future Pinball');

        const { outcome, narrative } = await runCascade(tournamentId, roomId, gameId);
        const copy = narrative.join(' ');

        expect(outcome.kind).toBe('activate');
        expect(copy).toContain('soggybacon handed their pick to mekelburgj');
        expect(copy).not.toMatch(/\b\d{17,20}\b/);   // no raw snowflake anywhere
    });
});
