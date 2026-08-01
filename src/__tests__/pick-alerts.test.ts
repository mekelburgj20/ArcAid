import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { PickAwardGate } from '../services/PickAwardGate.js';
import { PickAlertService } from '../services/PickAlertService.js';

// ---------------------------------------------------------------------------
// Picks nav badge — PickAlertService.
//
// Three independent conditions feed one badge:
//   (a) pending  — player holds a `[Pending Pick]` placeholder (clock running)
//   (b) empty    — pick-enabled tournament, player has standing, queue empty
//   (c) ineligible — head-of-queue pick would be skipped at activation
//
// (c) must agree with what maintenance actually does, so the service calls
// TournamentEngine.isGameEligible — the same method the rotation and
// extra-slot-fill loops call before activating a queued row. These tests seed
// the cooldown condition the same way the engine sees it (a non-QUEUED game of
// the same name inside the lookback window) rather than stubbing the check.
// ---------------------------------------------------------------------------

const PLAYER = '111111111111111111';
const OTHER_PLAYER = '222222222222222222';

/** Queue a named game for a player, mirroring TournamentEngine.queueGame. */
async function queueGame(tournamentId: string, name: string, pickerDiscordId: string, queueOrder: number) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, picker_discord_id, queue_order)
         VALUES (?, ?, ?, 'QUEUED', ?, ?)`,
        id, tournamentId, name, pickerDiscordId, queueOrder,
    );
    return id;
}

/** Create the `[Pending Pick]` placeholder the engine writes on a manual-pick win. */
async function createPlaceholder(tournamentId: string, pickerDiscordId: string, wonGameId: string) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, picker_discord_id, picker_type, picker_designated_at, reminder_count, won_game_id)
         VALUES (?, ?, '[Pending Pick]', 'QUEUED', ?, 'WINNER', ?, 0, ?)`,
        id, tournamentId, pickerDiscordId, new Date().toISOString(), wonGameId,
    );
    return id;
}

/**
 * Give a player pick standing without leaving anything queued — a COMPLETED
 * row still carrying their picker_discord_id, exactly what the rotation path
 * leaves behind when it activates a queued pick in place.
 */
async function giveStanding(tournamentId: string, pickerDiscordId: string, name = 'Previously Picked') {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, picker_discord_id, start_date, end_date)
         VALUES (?, ?, ?, 'COMPLETED', ?, ?, ?)`,
        id, tournamentId, name, pickerDiscordId,
        new Date(Date.now() - 30 * 86400_000).toISOString(),
        new Date(Date.now() - 29 * 86400_000).toISOString(),
    );
    return id;
}

describe('PickAlertService — Picks nav badge', () => {
    beforeEach(async () => {
        await setupTestDb();
        PickAwardGate.invalidate();
    });

    describe('(a) pending pick placeholder', () => {
        it('badges a placeholder assigned to this player', async () => {
            const roomId = await createTestRoom('pa-pending', 'PA Pending');
            const tId = await createTestTournament(roomId, { name: 'PA Pending T' });
            const wonGameId = await createTestGame(tId, { name: 'Won Game', status: 'COMPLETED' });
            await createPlaceholder(tId, PLAYER, wonGameId);

            const alerts = await PickAlertService.getAlerts(roomId, PLAYER);

            expect(alerts.pendingPickCount).toBe(1);
            expect(alerts.count).toBe(1);
            expect(alerts.urgent).toBe(true);
        });

        it('counts each slot separately on a multi-slot win (the v2.9 per-slot dedup case)', async () => {
            const roomId = await createTestRoom('pa-multi', 'PA Multi');
            const tId = await createTestTournament(roomId, { name: 'PA Multi T' });
            const wonA = await createTestGame(tId, { name: 'Won A', status: 'COMPLETED' });
            const wonB = await createTestGame(tId, { name: 'Won B', status: 'COMPLETED' });
            await createPlaceholder(tId, PLAYER, wonA);
            await createPlaceholder(tId, PLAYER, wonB);

            const alerts = await PickAlertService.getAlerts(roomId, PLAYER);

            expect(alerts.pendingPickCount).toBe(2);
            expect(alerts.count).toBe(2);
        });

        it("does not badge another player's placeholder", async () => {
            const roomId = await createTestRoom('pa-other', 'PA Other');
            const tId = await createTestTournament(roomId, { name: 'PA Other T' });
            const wonGameId = await createTestGame(tId, { name: 'Won Game', status: 'COMPLETED' });
            await createPlaceholder(tId, OTHER_PLAYER, wonGameId);

            const alerts = await PickAlertService.getAlerts(roomId, PLAYER);

            expect(alerts.count).toBe(0);
            expect(alerts.urgent).toBe(false);
        });
    });

    describe('(b) empty queue', () => {
        it('badges an empty queue when the player has pick standing', async () => {
            const roomId = await createTestRoom('pa-empty', 'PA Empty');
            const tId = await createTestTournament(roomId, { name: 'PA Empty T' });
            await giveStanding(tId, PLAYER);

            const alerts = await PickAlertService.getAlerts(roomId, PLAYER);

            expect(alerts.emptyQueue).toHaveLength(1);
            expect(alerts.emptyQueue[0]!.tournamentName).toBe('PA Empty T');
            expect(alerts.count).toBe(1);
            // Empty-queue is a nudge, not an emergency.
            expect(alerts.urgent).toBe(false);
        });

        it('does NOT nag a player with no standing — the scope gate', async () => {
            const roomId = await createTestRoom('pa-nostanding', 'PA No Standing');
            const tId = await createTestTournament(roomId, { name: 'PA No Standing T' });
            // Tournament exists and is pick-enabled, but this player has never
            // queued or won here. A badge would be pure noise.
            await giveStanding(tId, OTHER_PLAYER);

            const alerts = await PickAlertService.getAlerts(roomId, PLAYER);

            expect(alerts.emptyQueue).toHaveLength(0);
            expect(alerts.count).toBe(0);
        });

        it('does not badge an empty queue when the player already holds a placeholder there', async () => {
            // (a) already covers this tournament — double-counting would inflate
            // the badge for a single obligation.
            const roomId = await createTestRoom('pa-both', 'PA Both');
            const tId = await createTestTournament(roomId, { name: 'PA Both T' });
            await giveStanding(tId, PLAYER);
            const wonGameId = await createTestGame(tId, { name: 'Won Game', status: 'COMPLETED' });
            await createPlaceholder(tId, PLAYER, wonGameId);

            const alerts = await PickAlertService.getAlerts(roomId, PLAYER);

            expect(alerts.pendingPickCount).toBe(1);
            expect(alerts.emptyQueue).toHaveLength(0);
            expect(alerts.count).toBe(1);
        });

        it('does not badge when the queue is non-empty', async () => {
            const roomId = await createTestRoom('pa-hasqueue', 'PA Has Queue');
            const tId = await createTestTournament(roomId, { name: 'PA Has Queue T' });
            await giveStanding(tId, PLAYER);
            await queueGame(tId, 'Fresh Game', PLAYER, 1);

            const alerts = await PickAlertService.getAlerts(roomId, PLAYER);

            expect(alerts.emptyQueue).toHaveLength(0);
            expect(alerts.count).toBe(0);
        });
    });

    describe('(c) ineligible head-of-queue', () => {
        it('badges a queued pick that has gone ineligible (cooldown)', async () => {
            const roomId = await createTestRoom('pa-inelig', 'PA Inelig');
            const tId = await createTestTournament(roomId, { name: 'PA Inelig T' });
            // Played recently → inside the default 120-day lookback.
            await createTestGame(tId, { name: 'Repeat Game', status: 'COMPLETED' });
            await queueGame(tId, 'Repeat Game', PLAYER, 1);

            const alerts = await PickAlertService.getAlerts(roomId, PLAYER);

            expect(alerts.ineligible).toHaveLength(1);
            expect(alerts.ineligible[0]!.gameName).toBe('Repeat Game');
            expect(alerts.ineligible[0]!.reason).toBe('cooldown');
            expect(alerts.count).toBe(1);
            expect(alerts.urgent).toBe(false);
        });

        it('does not badge an eligible queued pick', async () => {
            const roomId = await createTestRoom('pa-elig', 'PA Elig');
            const tId = await createTestTournament(roomId, { name: 'PA Elig T' });
            await createTestGame(tId, { name: 'Some Other Game', status: 'COMPLETED' });
            await queueGame(tId, 'Never Played', PLAYER, 1);

            const alerts = await PickAlertService.getAlerts(roomId, PLAYER);

            expect(alerts.ineligible).toHaveLength(0);
            expect(alerts.count).toBe(0);
        });

        it('checks only the HEAD of the queue — that is the row that would activate next', async () => {
            const roomId = await createTestRoom('pa-head', 'PA Head');
            const tId = await createTestTournament(roomId, { name: 'PA Head T' });
            await createTestGame(tId, { name: 'Repeat Game', status: 'COMPLETED' });
            // Head is fine; the ineligible one is behind it and may well become
            // eligible again before it is ever reached.
            await queueGame(tId, 'Never Played', PLAYER, 1);
            await queueGame(tId, 'Repeat Game', PLAYER, 2);

            const alerts = await PickAlertService.getAlerts(roomId, PLAYER);

            expect(alerts.ineligible).toHaveLength(0);
            expect(alerts.count).toBe(0);
        });

        it('badges when the ineligible pick IS the head', async () => {
            const roomId = await createTestRoom('pa-head2', 'PA Head 2');
            const tId = await createTestTournament(roomId, { name: 'PA Head 2 T' });
            await createTestGame(tId, { name: 'Repeat Game', status: 'COMPLETED' });
            await queueGame(tId, 'Repeat Game', PLAYER, 1);
            await queueGame(tId, 'Never Played', PLAYER, 2);

            const alerts = await PickAlertService.getAlerts(roomId, PLAYER);

            expect(alerts.ineligible).toHaveLength(1);
            expect(alerts.ineligible[0]!.gameName).toBe('Repeat Game');
        });

        it('ignores a queued game that is only ineligible in a DIFFERENT tournament', async () => {
            // isGameEligible is scoped per tournament — a game burned in the
            // daily has no bearing on the weekly's queue.
            const roomId = await createTestRoom('pa-scope', 'PA Scope');
            const burnedT = await createTestTournament(roomId, { name: 'Burned T' });
            const freshT = await createTestTournament(roomId, { name: 'Fresh T' });
            await createTestGame(burnedT, { name: 'Repeat Game', status: 'COMPLETED' });
            await queueGame(freshT, 'Repeat Game', PLAYER, 1);

            const alerts = await PickAlertService.getAlerts(roomId, PLAYER);

            expect(alerts.ineligible).toHaveLength(0);
        });
    });

    describe('gating and scoping', () => {
        it('returns nothing for a tournament with winner_picks off', async () => {
            const roomId = await createTestRoom('pa-gateoff', 'PA Gate Off');
            const tId = await createTestTournament(roomId, { name: 'PA Gate Off T' });
            const db = await getDatabase();
            await db.run('UPDATE tournaments SET winner_picks = 0 WHERE id = ?', tId);
            PickAwardGate.invalidate();

            await giveStanding(tId, PLAYER);
            const wonGameId = await createTestGame(tId, { name: 'Won Game', status: 'COMPLETED' });
            await createPlaceholder(tId, PLAYER, wonGameId);

            const alerts = await PickAlertService.getAlerts(roomId, PLAYER);

            expect(alerts.count).toBe(0);
        });

        it('ignores inactive tournaments', async () => {
            const roomId = await createTestRoom('pa-inactive', 'PA Inactive');
            const tId = await createTestTournament(roomId, { name: 'PA Inactive T' });
            const db = await getDatabase();
            await db.run('UPDATE tournaments SET is_active = 0 WHERE id = ?', tId);

            await giveStanding(tId, PLAYER);

            const alerts = await PickAlertService.getAlerts(roomId, PLAYER);

            expect(alerts.count).toBe(0);
        });

        it('does not leak alerts across rooms', async () => {
            const roomA = await createTestRoom('pa-room-a', 'PA Room A');
            const roomB = await createTestRoom('pa-room-b', 'PA Room B');
            const tA = await createTestTournament(roomA, { name: 'PA Room A T' });
            await createTestTournament(roomB, { name: 'PA Room B T' });
            const wonGameId = await createTestGame(tA, { name: 'Won Game', status: 'COMPLETED' });
            await createPlaceholder(tA, PLAYER, wonGameId);

            expect((await PickAlertService.getAlerts(roomA, PLAYER)).count).toBe(1);
            expect((await PickAlertService.getAlerts(roomB, PLAYER)).count).toBe(0);
        });

        it('sums all three conditions across tournaments', async () => {
            const roomId = await createTestRoom('pa-sum', 'PA Sum');
            const tPending = await createTestTournament(roomId, { name: 'Sum Pending' });
            const tEmpty = await createTestTournament(roomId, { name: 'Sum Empty' });
            const tInelig = await createTestTournament(roomId, { name: 'Sum Inelig' });

            const wonGameId = await createTestGame(tPending, { name: 'Won Game', status: 'COMPLETED' });
            await createPlaceholder(tPending, PLAYER, wonGameId);

            await giveStanding(tEmpty, PLAYER);

            await createTestGame(tInelig, { name: 'Repeat Game', status: 'COMPLETED' });
            await queueGame(tInelig, 'Repeat Game', PLAYER, 1);

            const alerts = await PickAlertService.getAlerts(roomId, PLAYER);

            expect(alerts.pendingPickCount).toBe(1);
            expect(alerts.emptyQueue).toHaveLength(1);
            expect(alerts.ineligible).toHaveLength(1);
            expect(alerts.count).toBe(3);
            // Any pending pick makes the whole badge urgent.
            expect(alerts.urgent).toBe(true);
        });

        it('returns the empty result for a guest (no discord id)', async () => {
            const roomId = await createTestRoom('pa-guest', 'PA Guest');
            await createTestTournament(roomId, { name: 'PA Guest T' });

            const alerts = await PickAlertService.getAlerts(roomId, '');

            expect(alerts.count).toBe(0);
            expect(alerts.urgent).toBe(false);
        });
    });
});
