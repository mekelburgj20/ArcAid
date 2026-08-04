import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { PickAwardGate } from '../services/PickAwardGate.js';
import { PickAlertService } from '../services/PickAlertService.js';

// ---------------------------------------------------------------------------
// v2.77.0 — "badge and page must agree by construction".
//
// The nav badge (/pick-alerts → PickAlertService) and the Picks page
// (/pick-status) used to disagree in three ways, all field-reachable:
//
//   1. emptyQueue nagged a player whose own pick was the game currently
//      ACTIVE — the badge counted it, the page had nothing to render, so the
//      count could not be cleared. (Reported prod case: count-2 cyan badge,
//      empty page.)
//   2. /pick-status filtered neither `tournaments.is_active` nor the
//      winner_picks gate, so an archived / gate-off tournament rendered an
//      "Awaiting your pick" banner with no badge and no way to act.
//   3. TimeoutManager's fallback left picker-less QUEUED placeholders wedged
//      at the head of the queue — invisible to BOTH surfaces (they key on
//      picker_discord_id) while still blocking the slot.
//
// These tests lock all three.
// ---------------------------------------------------------------------------

const PLAYER = '111111111111111111';
const OTHER_PLAYER = '222222222222222222';

function playerToken(discordId = PLAYER) {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username: 'Tester' } as any);
}

async function createTestApp() {
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

/** A named QUEUED pick owned by a player, mirroring TournamentEngine.queueGame. */
async function queueGame(tournamentId: string, name: string, pickerDiscordId: string, queueOrder: number | null) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, picker_discord_id, queue_order)
         VALUES (?, ?, ?, 'QUEUED', ?, ?)`,
        id, tournamentId, name, pickerDiscordId, queueOrder,
    );
    return id;
}

/** The `[Pending Pick]` placeholder the engine writes on a manual-pick win. */
async function createPlaceholder(tournamentId: string, pickerDiscordId: string, wonGameId: string | null = null) {
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
 * The row the rotation path leaves behind when it activates a player's queued
 * pick in place: status flips to ACTIVE, picker_discord_id survives.
 */
async function activatePlayerPick(tournamentId: string, name: string, pickerDiscordId: string) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, picker_discord_id, start_date)
         VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
        id, tournamentId, name, pickerDiscordId, new Date().toISOString(),
    );
    return id;
}

// =========================================================================
// (1) emptyQueue suppression while the player's own pick is live
// =========================================================================

describe('PickAlertService — emptyQueue suppression when the player\'s pick is ACTIVE', () => {
    beforeEach(async () => {
        await setupTestDb();
        PickAwardGate.invalidate();
    });

    it('reproduces the field case: ACTIVE picker rows, zero QUEUED, gate on → count 0', async () => {
        // Exactly what prod showed: two gated tournaments, the player's own
        // previously-picked games are the currently ACTIVE games in both, and
        // their queue is empty. Pre-fix this badged 2 with an empty page.
        const roomId = await createTestRoom('pa-live', 'PA Live');
        const tA = await createTestTournament(roomId, { name: 'Daily Grind' });
        const tB = await createTestTournament(roomId, { name: 'Weekly Grind' });
        await activatePlayerPick(tA, 'Attack from Mars', PLAYER);
        await activatePlayerPick(tB, 'WHO dunnit', PLAYER);

        const alerts = await PickAlertService.getAlerts(roomId, PLAYER);

        expect(alerts.emptyQueue).toHaveLength(0);
        expect(alerts.count).toBe(0);
        expect(alerts.urgent).toBe(false);
    });

    it('still nudges when the ACTIVE game was picked by someone else', async () => {
        // The suppression is about THIS player's pick being live, not about the
        // tournament being busy — someone else's active game leaves this player
        // free to line up a pick.
        const roomId = await createTestRoom('pa-live-other', 'PA Live Other');
        const tId = await createTestTournament(roomId, { name: 'PA Live Other T' });
        await activatePlayerPick(tId, 'Someone Elses Pick', OTHER_PLAYER);
        // Standing for our player: an old completed row they once picked.
        await createTestGame(tId, { name: 'Old Pick', status: 'COMPLETED' });
        const db = await getDatabase();
        await db.run("UPDATE games SET picker_discord_id = ? WHERE name = 'Old Pick'", PLAYER);

        const alerts = await PickAlertService.getAlerts(roomId, PLAYER);

        expect(alerts.emptyQueue).toHaveLength(1);
        expect(alerts.count).toBe(1);
    });

    it('still nudges once the player\'s active pick has COMPLETED', async () => {
        // The suppression must be transient — it lifts the moment the game is
        // no longer live, which is exactly when queuing the next pick matters.
        const roomId = await createTestRoom('pa-live-done', 'PA Live Done');
        const tId = await createTestTournament(roomId, { name: 'PA Live Done T' });
        const gameId = await activatePlayerPick(tId, 'Attack from Mars', PLAYER);
        const db = await getDatabase();
        await db.run("UPDATE games SET status = 'COMPLETED' WHERE id = ?", gameId);

        const alerts = await PickAlertService.getAlerts(roomId, PLAYER);

        expect(alerts.emptyQueue).toHaveLength(1);
        expect(alerts.count).toBe(1);
    });

    it('suppresses only the tournament where the pick is live', async () => {
        const roomId = await createTestRoom('pa-live-split', 'PA Live Split');
        const tLive = await createTestTournament(roomId, { name: 'Live T' });
        const tIdle = await createTestTournament(roomId, { name: 'Idle T' });
        await activatePlayerPick(tLive, 'Attack from Mars', PLAYER);
        // Standing but nothing live in the second tournament.
        const db = await getDatabase();
        const doneId = await createTestGame(tIdle, { name: 'Old Pick', status: 'COMPLETED' });
        await db.run('UPDATE games SET picker_discord_id = ? WHERE id = ?', PLAYER, doneId);

        const alerts = await PickAlertService.getAlerts(roomId, PLAYER);

        expect(alerts.emptyQueue).toHaveLength(1);
        expect(alerts.emptyQueue[0]!.tournamentName).toBe('Idle T');
        expect(alerts.count).toBe(1);
    });

    it('does not suppress a pending placeholder — (a) outranks the suppression', async () => {
        // A running pick clock is an obligation regardless of what is active.
        const roomId = await createTestRoom('pa-live-pending', 'PA Live Pending');
        const tId = await createTestTournament(roomId, { name: 'PA Live Pending T' });
        await activatePlayerPick(tId, 'Attack from Mars', PLAYER);
        await createPlaceholder(tId, PLAYER);

        const alerts = await PickAlertService.getAlerts(roomId, PLAYER);

        expect(alerts.pendingPickCount).toBe(1);
        expect(alerts.count).toBe(1);
        expect(alerts.urgent).toBe(true);
    });
});

// =========================================================================
// (2) /pick-status filter alignment
// =========================================================================

describe('GET /:roomId/pick-status — tournament filters mirror the badge', () => {
    beforeEach(async () => {
        await setupTestDb();
        PickAwardGate.invalidate();
    });

    it('returns a pending pick for a live, gate-on tournament', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('ps-ok', 'PS Ok');
        const tId = await createTestTournament(roomId, { name: 'PS Ok T' });
        await createPlaceholder(tId, PLAYER);

        const res = await request(app)
            .get(`/api/rooms/${roomId}/pick-status`)
            .set('Authorization', `Bearer ${playerToken()}`);

        expect(res.status).toBe(200);
        expect(res.body.pendingPicks).toHaveLength(1);
        expect(res.body.pendingPicks[0].tournament_name).toBe('PS Ok T');
    });

    it('hides a pending pick whose tournament is archived (is_active = 0)', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('ps-archived', 'PS Archived');
        const tId = await createTestTournament(roomId, { name: 'PS Archived T' });
        await createPlaceholder(tId, PLAYER);
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET is_active = 0 WHERE id = ?', tId);

        const res = await request(app)
            .get(`/api/rooms/${roomId}/pick-status`)
            .set('Authorization', `Bearer ${playerToken()}`);

        expect(res.status).toBe(200);
        expect(res.body.pendingPicks).toHaveLength(0);
        // …and the badge agrees.
        expect((await PickAlertService.getAlerts(roomId, PLAYER)).count).toBe(0);
    });

    it('hides a pending pick whose tournament has winner_picks off', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('ps-gateoff', 'PS Gate Off');
        const tOff = await createTestTournament(roomId, { name: 'PS Gate Off T' });
        // A second, gate-on tournament so the room-level pickAwardEnabled flag
        // stays true and the page still renders — isolating the row filter.
        await createTestTournament(roomId, { name: 'PS Gate On T' });
        await createPlaceholder(tOff, PLAYER);
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET winner_picks = 0 WHERE id = ?', tOff);
        PickAwardGate.invalidate();

        const res = await request(app)
            .get(`/api/rooms/${roomId}/pick-status`)
            .set('Authorization', `Bearer ${playerToken()}`);

        expect(res.status).toBe(200);
        expect(res.body.pendingPicks).toHaveLength(0);
        expect((await PickAlertService.getAlerts(roomId, PLAYER)).count).toBe(0);
    });

    it('keeps legacy NULL winner_picks visible (PickAwardGate treats NULL as enabled)', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('ps-null', 'PS Null');
        const tId = await createTestTournament(roomId, { name: 'PS Null T' });
        await createPlaceholder(tId, PLAYER);
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET winner_picks = NULL WHERE id = ?', tId);
        PickAwardGate.invalidate();

        const res = await request(app)
            .get(`/api/rooms/${roomId}/pick-status`)
            .set('Authorization', `Bearer ${playerToken()}`);

        expect(res.status).toBe(200);
        expect(res.body.pendingPicks).toHaveLength(1);
    });

    it("does not leak another player's pending pick", async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('ps-other', 'PS Other');
        const tId = await createTestTournament(roomId, { name: 'PS Other T' });
        await createPlaceholder(tId, OTHER_PLAYER);

        const res = await request(app)
            .get(`/api/rooms/${roomId}/pick-status`)
            .set('Authorization', `Bearer ${playerToken()}`);

        expect(res.body.pendingPicks).toHaveLength(0);
    });
});

// =========================================================================
// (3) TimeoutManager placeholder leaks
// =========================================================================

vi.mock('../utils/discord.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/discord.js')>();
    return {
        ...actual,
        sendChannelEmbed: async () => undefined,
        sendChannelMessage: async () => undefined,
        sendDirectMessage: async () => true,
        resolveAnnouncementChannelId: () => null,
    };
});

describe('TimeoutManager.fallbackToAutoSelection — placeholder disposal', () => {
    beforeEach(async () => {
        await setupTestDb();
        PickAwardGate.invalidate();
    });

    /** Invoke the private fallback the same way checkTimeouts does. */
    async function runFallback(slotId: string, tournamentId: string) {
        const { TimeoutManager } = await import('../engine/TimeoutManager.js');
        const tm = TimeoutManager.getInstance() as any;
        await tm.fallbackToAutoSelection({ id: slotId, tournamentId });
    }

    it('DELETEs the placeholder when auto_pick is disabled (was: orphaned QUEUED row)', async () => {
        const roomId = await createTestRoom('tm-noautopick', 'TM No Autopick');
        const tId = await createTestTournament(roomId, { name: 'TM No Autopick T' });
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET auto_pick = 0 WHERE id = ?', tId);
        const slotId = await createPlaceholder(tId, PLAYER);

        await runFallback(slotId, tId);

        const row = await db.get('SELECT id FROM games WHERE id = ?', slotId);
        expect(row).toBeUndefined();
        // Nothing left at the head of the queue to block rotation.
        const leftovers = await db.all(
            "SELECT id FROM games WHERE tournament_id = ? AND status = 'QUEUED'", tId,
        );
        expect(leftovers).toHaveLength(0);
    });

    it('DELETEs the placeholder when no eligible games remain (was: orphaned QUEUED row)', async () => {
        const roomId = await createTestRoom('tm-noeligible', 'TM No Eligible');
        const tId = await createTestTournament(roomId, { name: 'TM No Eligible T' });
        // Empty catalogue → the eligible list is empty and the branch fires.
        const slotId = await createPlaceholder(tId, PLAYER);

        await runFallback(slotId, tId);

        const db = await getDatabase();
        const row = await db.get('SELECT id FROM games WHERE id = ?', slotId);
        expect(row).toBeUndefined();
    });

    it('KEEPS the placeholder AND its owner when the fallback throws (transient error)', async () => {
        // A transient failure must not cost the player their pick: the row
        // stays visible on the Picks page, badged, and retryable next sweep.
        const roomId = await createTestRoom('tm-error', 'TM Error');
        const tId = await createTestTournament(roomId, { name: 'TM Error T' });
        const slotId = await createPlaceholder(tId, PLAYER);

        // Fail inside the try block by making the engine's first call throw.
        const { TournamentEngine } = await import('../engine/TournamentEngine.js');
        const engine = TournamentEngine.getInstance() as any;
        const original = engine.getActiveGames;
        engine.getActiveGames = async () => { throw new Error('boom'); };
        try {
            await runFallback(slotId, tId);
        } finally {
            engine.getActiveGames = original;
        }

        const db = await getDatabase();
        const row = await db.get(
            'SELECT status, picker_discord_id, picker_type FROM games WHERE id = ?', slotId,
        );
        expect(row).toBeDefined();
        expect(row.status).toBe('QUEUED');
        expect(row.picker_discord_id).toBe(PLAYER);
        expect(row.picker_type).toBe('WINNER');

        // …and both surfaces still see it.
        expect((await PickAlertService.getAlerts(roomId, PLAYER)).pendingPickCount).toBe(1);
    });

    it('still DELETEs the orphaned slot when the tournament is already at max active games', async () => {
        // Pre-existing behaviour, locked here so the two new deletes read as a
        // consistent policy rather than a one-off.
        const roomId = await createTestRoom('tm-maxed', 'TM Maxed');
        const tId = await createTestTournament(roomId, { name: 'TM Maxed T' });
        await createTestGame(tId, { name: 'Already Active', status: 'ACTIVE' });
        const slotId = await createPlaceholder(tId, PLAYER);

        await runFallback(slotId, tId);

        const db = await getDatabase();
        expect(await db.get('SELECT id FROM games WHERE id = ?', slotId)).toBeUndefined();
    });
});
