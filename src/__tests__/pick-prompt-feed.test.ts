import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { PickAwardGate } from '../services/PickAwardGate.js';
import { TournamentEngine } from '../engine/TournamentEngine.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import {
    computePickDeadline,
    isPickWindowExpired,
    pickWindowFallback,
    windowMinForPicker,
    DEFAULT_WINNER_PICK_WINDOW_MIN,
    DEFAULT_RUNNERUP_PICK_WINDOW_MIN,
} from '../utils/pickWindow.js';

// ---------------------------------------------------------------------------
// Public lobby pick-prompt (`pick_prompt` feed event).
//
// The event must fire ONLY on the branch where the winner has to pick by hand.
// When the queue already holds an eligible game the rotation path activates it
// and nobody is being asked for anything — a prompt there would be a lie with
// a countdown attached.
//
// Engine assertions go through the real runMaintenance → processSlotMaintenance
// path (same approach as pick-award-gate.test.ts). Rooms set
// ISCORED_ENABLED=false so credential resolution short-circuits instead of
// launching Playwright. The feed emit is fire-and-forget behind a dynamic
// import, so reads poll briefly rather than assuming it landed synchronously.
// ---------------------------------------------------------------------------

const WINNER = '444444444444444444';

async function seedWinningSubmission(gameId: string, discordUserId: string) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO submissions (id, game_id, discord_user_id, iscored_username, score, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`,
        `${gameId}-winner`, gameId, discordUserId, 'Winner', 99999, new Date().toISOString(),
    );
}

/** Poll for feed rows of a type — the emit is fire-and-forget. */
async function waitForFeedEvents(roomId: string, type: string, timeoutMs = 2000): Promise<any[]> {
    const db = await getDatabase();
    const deadline = Date.now() + timeoutMs;
    let rows: any[] = [];
    while (Date.now() < deadline) {
        rows = await db.all(
            'SELECT * FROM lobby_feed_events WHERE game_room_id = ? AND type = ?',
            roomId, type,
        );
        if (rows.length) return rows;
        await new Promise(r => setTimeout(r, 25));
    }
    return rows;
}

/** Settle any pending fire-and-forget emits before asserting absence. */
async function settle(ms = 400) {
    await new Promise(r => setTimeout(r, ms));
}

async function feedEventsOfType(roomId: string, type: string): Promise<any[]> {
    const db = await getDatabase();
    return db.all('SELECT * FROM lobby_feed_events WHERE game_room_id = ? AND type = ?', roomId, type);
}

describe('pick_prompt lobby event', () => {
    beforeEach(async () => {
        await setupTestDb();
        PickAwardGate.invalidate();
    });

    it('emits on the manual-pick branch (winner won, queue empty)', async () => {
        const roomId = await createTestRoom('pp-manual', 'PP Manual');
        await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
        const tId = await createTestTournament(roomId, { name: 'PP Manual T' });
        const gameId = await createTestGame(tId, { name: 'PP Manual Game', status: 'ACTIVE' });
        await seedWinningSubmission(gameId, WINNER);

        await TournamentEngine.getInstance().runMaintenance(tId);

        const events = await waitForFeedEvents(roomId, 'pick_prompt');
        expect(events).toHaveLength(1);

        const event = events[0]!;
        expect(event.title).toContain('pick the next');
        expect(event.title).toContain('PP Manual T');
        expect(event.player_id).toBe(WINNER);
        expect(event.tournament_id).toBe(tId);
        // Public prompt — everyone sees it, so it must NOT be targeted.
        expect(event.target_user_id).toBeNull();
    });

    it('does NOT emit when a queued game auto-fills the slot', async () => {
        const roomId = await createTestRoom('pp-autofill', 'PP Autofill');
        await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
        const tId = await createTestTournament(roomId, { name: 'PP Autofill T' });
        const gameId = await createTestGame(tId, { name: 'PP Autofill Game', status: 'ACTIVE' });
        await seedWinningSubmission(gameId, WINNER);

        // An eligible queued game — the rotation path activates this and never
        // reaches the picker-slot branch.
        const db = await getDatabase();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, picker_discord_id, queue_order)
             VALUES (?, ?, 'PP Queued Game', 'QUEUED', ?, 1)`,
            crypto.randomUUID(), tId, WINNER,
        );

        await TournamentEngine.getInstance().runMaintenance(tId);
        await settle();

        expect(await feedEventsOfType(roomId, 'pick_prompt')).toHaveLength(0);
        // Sanity: the rotation really did happen (so the absence above is
        // "took the other branch", not "maintenance did nothing").
        const activated = await db.get(
            `SELECT status FROM games WHERE tournament_id = ? AND name = 'PP Queued Game'`, tId,
        );
        expect(activated.status).toBe('ACTIVE');
    });

    it('does not emit when winner picks are disabled', async () => {
        const roomId = await createTestRoom('pp-gateoff', 'PP Gate Off');
        await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
        const tId = await createTestTournament(roomId, { name: 'PP Gate Off T' });
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET winner_picks = 0 WHERE id = ?', tId);
        PickAwardGate.invalidate();
        const gameId = await createTestGame(tId, { name: 'PP Gate Off Game', status: 'ACTIVE' });
        await seedWinningSubmission(gameId, WINNER);

        await TournamentEngine.getInstance().runMaintenance(tId);
        await settle();

        expect(await feedEventsOfType(roomId, 'pick_prompt')).toHaveLength(0);
    });

    describe('payload', () => {
        it('carries a deadline derived from the placeholder row, not from render time', async () => {
            const roomId = await createTestRoom('pp-deadline', 'PP Deadline');
            await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
            const tId = await createTestTournament(roomId, { name: 'PP Deadline T' });
            const db = await getDatabase();
            await db.run('UPDATE tournaments SET winner_pick_window_min = 45 WHERE id = ?', tId);
            const gameId = await createTestGame(tId, { name: 'PP Deadline Game', status: 'ACTIVE' });
            await seedWinningSubmission(gameId, WINNER);

            await TournamentEngine.getInstance().runMaintenance(tId);

            const events = await waitForFeedEvents(roomId, 'pick_prompt');
            expect(events).toHaveLength(1);
            const metadata = JSON.parse(events[0]!.metadata);

            expect(metadata.windowMin).toBe(45);
            expect(metadata.pickerType).toBe('WINNER');
            expect(metadata.deadline).toBeTruthy();

            // The deadline must be exactly picker_designated_at + window — the
            // same instant TimeoutManager enforces against. Anything else and
            // the public countdown drifts from the real cutoff.
            const slot = await db.get(
                `SELECT picker_designated_at FROM games WHERE tournament_id = ? AND name = '[Pending Pick]'`, tId,
            );
            expect(new Date(metadata.deadline).toISOString())
                .toBe(computePickDeadline(slot.picker_designated_at, 45).toISOString());
        });

        it("names the fallback as 'runner_up' for a winner with a won game", async () => {
            const roomId = await createTestRoom('pp-fallback', 'PP Fallback');
            await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
            const tId = await createTestTournament(roomId, { name: 'PP Fallback T' });
            const gameId = await createTestGame(tId, { name: 'PP Fallback Game', status: 'ACTIVE' });
            await seedWinningSubmission(gameId, WINNER);

            await TournamentEngine.getInstance().runMaintenance(tId);

            const events = await waitForFeedEvents(roomId, 'pick_prompt');
            const metadata = JSON.parse(events[0]!.metadata);
            // Winner expiry pivots to the runner-up; auto-pick only follows if
            // THAT window also lapses.
            expect(metadata.fallback).toBe('runner_up');
        });

        it('uses the tournament default window when none is configured', async () => {
            const roomId = await createTestRoom('pp-default', 'PP Default');
            await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
            const tId = await createTestTournament(roomId, { name: 'PP Default T' });
            const gameId = await createTestGame(tId, { name: 'PP Default Game', status: 'ACTIVE' });
            await seedWinningSubmission(gameId, WINNER);

            await TournamentEngine.getInstance().runMaintenance(tId);

            const events = await waitForFeedEvents(roomId, 'pick_prompt');
            const metadata = JSON.parse(events[0]!.metadata);
            expect(metadata.windowMin).toBe(DEFAULT_WINNER_PICK_WINDOW_MIN);
        });
    });
});

describe('pickWindow — shared deadline math', () => {
    it('computes a deadline as designatedAt + window', () => {
        const at = new Date('2026-08-01T12:00:00.000Z');
        expect(computePickDeadline(at, 60).toISOString()).toBe('2026-08-01T13:00:00.000Z');
        expect(computePickDeadline(at.toISOString(), 30).toISOString()).toBe('2026-08-01T12:30:00.000Z');
    });

    it('agrees with the elapsed-minutes comparison TimeoutManager used to inline', () => {
        const at = new Date('2026-08-01T12:00:00.000Z');
        const windowMin = 60;
        for (const [nowIso, expected] of [
            ['2026-08-01T12:59:59.000Z', false],
            ['2026-08-01T13:00:00.000Z', true],
            ['2026-08-01T13:00:01.000Z', true],
        ] as const) {
            const now = new Date(nowIso);
            const elapsedMins = (now.getTime() - at.getTime()) / (1000 * 60);
            expect(isPickWindowExpired(at, windowMin, now)).toBe(expected);
            // The old inline predicate, for the record.
            expect(elapsedMins >= windowMin).toBe(expected);
        }
    });

    it('selects the right window per picker type', () => {
        expect(windowMinForPicker('WINNER', { winnerWindowMin: 45, runnerUpWindowMin: 20 })).toBe(45);
        expect(windowMinForPicker('RUNNER_UP', { winnerWindowMin: 45, runnerUpWindowMin: 20 })).toBe(20);
        expect(windowMinForPicker('WINNER', {})).toBe(DEFAULT_WINNER_PICK_WINDOW_MIN);
        expect(windowMinForPicker('RUNNER_UP', {})).toBe(DEFAULT_RUNNERUP_PICK_WINDOW_MIN);
        expect(windowMinForPicker(null, { winnerWindowMin: null, runnerUpWindowMin: null }))
            .toBe(DEFAULT_WINNER_PICK_WINDOW_MIN);
    });

    it('names the fallback correctly for each picker situation', () => {
        // A winner pivots to the runner-up — but only if the slot knows which
        // game was won; without it TimeoutManager goes straight to auto-select.
        expect(pickWindowFallback('WINNER', 'game-123')).toBe('runner_up');
        expect(pickWindowFallback('WINNER', null)).toBe('autopick');
        // Nobody follows the runner-up.
        expect(pickWindowFallback('RUNNER_UP', 'game-123')).toBe('autopick');
    });
});
