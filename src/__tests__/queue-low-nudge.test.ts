import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { PickAwardGate } from '../services/PickAwardGate.js';
import { NotificationService } from '../services/NotificationService.js';
import { QueueLowNudgeService, QUEUE_LOW_THRESHOLD } from '../services/QueueLowNudgeService.js';

// ---------------------------------------------------------------------------
// queueLow nudge (v2.126.0).
//
// Fires ONLY when the engine consumes one of a player's queued picks, and only
// while the remaining queue is at or below QUEUE_LOW_THRESHOLD. `queue_low_nudges`
// is the dedupe ledger: send on a first sighting, on any LOWER count than the
// one last reported, or after a week of silence — never twice for the same
// standing count inside that week.
// ---------------------------------------------------------------------------

const PLAYER = '111111111111111111';
let counter = 0;

async function setupTournament() {
    const db = await getDatabase();
    const roomId = await createTestRoom(`qln-${++counter}`, `QLN Room ${counter}`);
    const tournamentId = await createTestTournament(roomId, { name: `QLN Cup ${counter}` });
    await db.run('UPDATE tournaments SET winner_picks = 1 WHERE id = ?', tournamentId);
    PickAwardGate.invalidate();
    return { roomId, tournamentId };
}

/** `n` named QUEUED picks owned by PLAYER. */
async function seedQueue(tournamentId: string, n: number) {
    const db = await getDatabase();
    for (let i = 1; i <= n; i++) {
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, picker_discord_id, queue_order)
             VALUES (?, ?, ?, 'QUEUED', ?, ?)`,
            crypto.randomUUID(), tournamentId, `Queued ${i}`, PLAYER, i,
        );
    }
}

async function dropOne(tournamentId: string) {
    const db = await getDatabase();
    const row = await db.get(
        `SELECT id FROM games WHERE tournament_id = ? AND status = 'QUEUED' AND picker_discord_id = ?
         ORDER BY queue_order DESC LIMIT 1`,
        tournamentId, PLAYER,
    );
    if (row) await db.run('DELETE FROM games WHERE id = ?', row.id);
}

async function ledger(tournamentId: string) {
    const db = await getDatabase();
    return db.get(
        'SELECT last_count, sent_at FROM queue_low_nudges WHERE user_id = ? AND tournament_id = ?',
        PLAYER, tournamentId,
    );
}

describe('QueueLowNudgeService.maybeNudge', () => {
    let notify: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
        await setupTestDb();
        PickAwardGate.invalidate();
        notify = vi.spyOn(NotificationService, 'notify').mockResolvedValue(true);
    });

    afterEach(() => { vi.restoreAllMocks(); });

    it('stays quiet while the queue is comfortably stocked', async () => {
        const { tournamentId } = await setupTournament();
        await seedQueue(tournamentId, QUEUE_LOW_THRESHOLD + 1);

        await QueueLowNudgeService.maybeNudge(PLAYER, tournamentId);

        expect(notify).not.toHaveBeenCalled();
        expect(await ledger(tournamentId)).toBeUndefined();
    });

    it('nudges when the queue drops to the threshold (4 -> 3)', async () => {
        const { tournamentId } = await setupTournament();
        await seedQueue(tournamentId, 3);

        await QueueLowNudgeService.maybeNudge(PLAYER, tournamentId);

        expect(notify).toHaveBeenCalledTimes(1);
        const params = notify.mock.calls[0]![0] as { type: string; userId: string; message: string };
        expect(params.type).toBe('queueLow');
        expect(params.userId).toBe(PLAYER);
        expect(params.message).toContain('3 games');
        expect((await ledger(tournamentId)).last_count).toBe(3);
    });

    it('nudges again on a LOWER count (3 -> 2)', async () => {
        const { tournamentId } = await setupTournament();
        await seedQueue(tournamentId, 3);
        await QueueLowNudgeService.maybeNudge(PLAYER, tournamentId);

        await dropOne(tournamentId);
        await QueueLowNudgeService.maybeNudge(PLAYER, tournamentId);

        expect(notify).toHaveBeenCalledTimes(2);
        expect((await ledger(tournamentId)).last_count).toBe(2);
    });

    it('does NOT repeat the same count inside a week (2 -> 2)', async () => {
        const { tournamentId } = await setupTournament();
        await seedQueue(tournamentId, 2);

        await QueueLowNudgeService.maybeNudge(PLAYER, tournamentId);
        await QueueLowNudgeService.maybeNudge(PLAYER, tournamentId);
        await QueueLowNudgeService.maybeNudge(PLAYER, tournamentId);

        expect(notify).toHaveBeenCalledTimes(1);
    });

    it('re-sends a flat count once the last nudge is more than a week old', async () => {
        const db = await getDatabase();
        const { tournamentId } = await setupTournament();
        await seedQueue(tournamentId, 2);
        await QueueLowNudgeService.maybeNudge(PLAYER, tournamentId);

        const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
        await db.run(
            'UPDATE queue_low_nudges SET sent_at = ? WHERE user_id = ? AND tournament_id = ?',
            eightDaysAgo, PLAYER, tournamentId,
        );

        await QueueLowNudgeService.maybeNudge(PLAYER, tournamentId);
        expect(notify).toHaveBeenCalledTimes(2);
    });

    it('says "is empty" when the last pick was just spent', async () => {
        const { tournamentId } = await setupTournament();

        await QueueLowNudgeService.maybeNudge(PLAYER, tournamentId);

        const params = notify.mock.calls[0]![0] as { message: string };
        expect(params.message).toContain('is empty');
        expect((await ledger(tournamentId)).last_count).toBe(0);
    });

    it('stays quiet for a tournament with winner-picks turned off', async () => {
        const db = await getDatabase();
        const { tournamentId } = await setupTournament();
        await db.run('UPDATE tournaments SET winner_picks = 0 WHERE id = ?', tournamentId);
        PickAwardGate.invalidate();
        await seedQueue(tournamentId, 1);

        await QueueLowNudgeService.maybeNudge(PLAYER, tournamentId);

        expect(notify).not.toHaveBeenCalled();
    });
});

describe('queueLow opt-out', () => {
    beforeEach(async () => { await setupTestDb(); });
    afterEach(() => { vi.restoreAllMocks(); });

    it('is off by default and declined by notify() when the user has it off', async () => {
        const db = await getDatabase();
        // Default prefs: opt-in only, so a brand-new user is not subscribed.
        expect((await NotificationService.getPrefs(PLAYER)).queueLow).toBe(false);

        // An explicit `false` must keep it off no matter what else changes.
        await db.run(
            `INSERT INTO user_preferences (discord_user_id, notification_prefs) VALUES (?, ?)`,
            PLAYER, JSON.stringify({ queueLow: false }),
        );
        expect((await NotificationService.getPrefs(PLAYER)).queueLow).toBe(false);

        const previousToken = process.env.DISCORD_BOT_TOKEN;
        process.env.DISCORD_BOT_TOKEN = 'test-token';
        try {
            const delivered = await NotificationService.notify({
                userId: PLAYER, type: 'queueLow', message: 'queue is empty',
            });
            expect(delivered).toBe(false);
        } finally {
            if (previousToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
            else process.env.DISCORD_BOT_TOKEN = previousToken;
        }
    });
});
