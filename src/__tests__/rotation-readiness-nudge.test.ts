import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { PickAwardGate } from '../services/PickAwardGate.js';
import { PickDispositionService } from '../services/PickDispositionService.js';
import { RotationNudgeService } from '../services/RotationNudgeService.js';

// ---------------------------------------------------------------------------
// Rotation-readiness nudge (ROADMAP "Next-win disposition + dynasty option +
// rotation-readiness nudge", locked 2026-08-09). Two triggers sharing one
// dedupe mechanism (`rotation_nudges`). `NotificationService.notify` is a
// real call in these tests — with no DISCORD_BOT_TOKEN / VAPID config in the
// test env it safely no-ops on the delivery side, so assertions read the
// `rotation_nudges` table (the dedupe write), which happens BEFORE delivery
// is attempted and is unconditional once the has-queue-or-disposition check
// passes.
// ---------------------------------------------------------------------------

// `getNextRunTime` parses cron strings against `cadence.timezone ||
// BOT_TIMEZONE || 'America/Chicago'`. `cronInMinutes` below builds its cron
// string from the LOCAL wall clock (`Date.getHours()/getMinutes()`), so the
// two must agree on which timezone "local" means — otherwise a cron meant to
// fire in 30 minutes can resolve hours away depending on the CI runner's
// offset from Chicago. Pinning BOT_TIMEZONE to the actual system timezone for
// this file's duration keeps them in lockstep.
process.env.BOT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** A cron string that fires `minutesFromNow` minutes from the real clock. */
function cronInMinutes(minutesFromNow: number): string {
    const target = new Date(Date.now() + minutesFromNow * 60_000);
    return `${target.getMinutes()} ${target.getHours()} * * *`;
}

async function seedSubmission(gameId: string, opts: { iscoredUsername: string; submittedByUserId: string; score: number }) {
    const db = await getDatabase();
    const id = `${gameId}-${opts.iscoredUsername.toLowerCase()}`;
    await db.run(
        `INSERT INTO submissions (id, game_id, discord_user_id, submitted_by_user_id, iscored_username, score, timestamp)
         VALUES (?, ?, 'COMMUNITY', ?, ?, ?, ?)`,
        id, gameId, opts.submittedByUserId, opts.iscoredUsername, opts.score, new Date().toISOString(),
    );
}

async function nudgeRows(tournamentId: string) {
    const db = await getDatabase();
    return db.all('SELECT * FROM rotation_nudges WHERE tournament_id = ?', tournamentId);
}

let roomCounter = 0;

async function setupTournament(cadenceCron: string | null) {
    roomCounter += 1;
    const roomId = await createTestRoom(`rrn-room-${roomCounter}`, `RRN Room ${roomCounter}`);
    const tournamentId = await createTestTournament(roomId, { name: `RRN Tournament ${roomCounter}` });
    const db = await getDatabase();
    if (cadenceCron) {
        await db.run('UPDATE tournaments SET cadence = ? WHERE id = ?', JSON.stringify({ cron: cadenceCron }), tournamentId);
    }
    PickAwardGate.invalidate();
    return { roomId, tournamentId };
}

describe('RotationNudgeService.evaluateTournament — T-1h sweep', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    it('nudges the top-3 player who has neither a queued game nor a disposition, and suppresses the other two', async () => {
        const { roomId, tournamentId } = await setupTournament(cronInMinutes(30));
        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        await seedSubmission(gameId, { iscoredUsername: 'P1', submittedByUserId: 'P1', score: 900 });
        await seedSubmission(gameId, { iscoredUsername: 'P2', submittedByUserId: 'P2', score: 800 });
        await seedSubmission(gameId, { iscoredUsername: 'P3', submittedByUserId: 'P3', score: 700 });

        // P1 already has a queued (non-placeholder) game — suppressed.
        const db = await getDatabase();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, picker_discord_id, queue_order)
             VALUES (?, ?, 'P1 Queued Game', 'QUEUED', ?, 1)`,
            'p1-queued-game', tournamentId, 'P1',
        );
        // P2 has a stored disposition — suppressed.
        await PickDispositionService.set(tournamentId, 'P2', 'forfeit');
        // P3 has neither — should be nudged.

        const tournamentRow = await db.get('SELECT id, name, cadence, game_room_id FROM tournaments WHERE id = ?', tournamentId);
        await RotationNudgeService.evaluateTournament(tournamentRow);

        const rows = await nudgeRows(tournamentId);
        expect(rows.map(r => r.discord_user_id)).toEqual(['P3']);
        expect(roomId).toBeTruthy();
    });

    it('does not nudge when the next rotation is more than an hour away', async () => {
        const { tournamentId } = await setupTournament(cronInMinutes(180));
        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        await seedSubmission(gameId, { iscoredUsername: 'P4', submittedByUserId: 'P4', score: 900 });

        const db = await getDatabase();
        const tournamentRow = await db.get('SELECT id, name, cadence, game_room_id FROM tournaments WHERE id = ?', tournamentId);
        await RotationNudgeService.evaluateTournament(tournamentRow);

        expect(await nudgeRows(tournamentId)).toHaveLength(0);
    });

    it('does not nudge when pick-award is disabled for the tournament', async () => {
        const { tournamentId } = await setupTournament(cronInMinutes(30));
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET winner_picks = 0 WHERE id = ?', tournamentId);
        PickAwardGate.invalidate();

        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        await seedSubmission(gameId, { iscoredUsername: 'P5', submittedByUserId: 'P5', score: 900 });

        const tournamentRow = await db.get('SELECT id, name, cadence, game_room_id FROM tournaments WHERE id = ?', tournamentId);
        await RotationNudgeService.evaluateTournament(tournamentRow);

        expect(await nudgeRows(tournamentId)).toHaveLength(0);
    });

    it('dedupes across repeated sweeps for the same rotation boundary', async () => {
        const { tournamentId } = await setupTournament(cronInMinutes(30));
        const gameId = await createTestGame(tournamentId, { status: 'ACTIVE' });
        await seedSubmission(gameId, { iscoredUsername: 'P6', submittedByUserId: 'P6', score: 900 });

        const db = await getDatabase();
        const tournamentRow = await db.get('SELECT id, name, cadence, game_room_id FROM tournaments WHERE id = ?', tournamentId);

        await RotationNudgeService.evaluateTournament(tournamentRow);
        await RotationNudgeService.evaluateTournament(tournamentRow);
        await RotationNudgeService.evaluateTournament(tournamentRow);

        const rows = await nudgeRows(tournamentId);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.discord_user_id).toBe('P6');
    });
});

describe('RotationNudgeService.evaluateSubmitter — event trigger', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    it('nudges only when this submit lands the submitter in 1st AND the rotation is within the hour', async () => {
        const { roomId, tournamentId } = await setupTournament(cronInMinutes(30));
        const gameId = await createTestGame(tournamentId, { name: 'RRN Active Game', status: 'ACTIVE' });
        await seedSubmission(gameId, { iscoredUsername: 'Leader', submittedByUserId: 'LEADER', score: 900 });
        await seedSubmission(gameId, { iscoredUsername: 'Second', submittedByUserId: 'SECOND', score: 500 });

        // SECOND is not #1 — no nudge.
        await RotationNudgeService.evaluateSubmitter(roomId, 'RRN Active Game', 'SECOND');
        expect(await nudgeRows(tournamentId)).toHaveLength(0);

        // LEADER is #1 and within the window — nudged.
        await RotationNudgeService.evaluateSubmitter(roomId, 'RRN Active Game', 'LEADER');
        const rows = await nudgeRows(tournamentId);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.discord_user_id).toBe('LEADER');
    });

    it('does not nudge outside the T-1h window even for the #1 submitter', async () => {
        const { roomId, tournamentId } = await setupTournament(cronInMinutes(180));
        const gameId = await createTestGame(tournamentId, { name: 'RRN Far Game', status: 'ACTIVE' });
        await seedSubmission(gameId, { iscoredUsername: 'Leader', submittedByUserId: 'LEADER2', score: 900 });

        await RotationNudgeService.evaluateSubmitter(roomId, 'RRN Far Game', 'LEADER2');
        expect(await nudgeRows(tournamentId)).toHaveLength(0);
    });

    it('does not nudge a #1 submitter who already has a queued game or a disposition', async () => {
        const { roomId, tournamentId } = await setupTournament(cronInMinutes(30));
        const gameId = await createTestGame(tournamentId, { name: 'RRN Ready Game', status: 'ACTIVE' });
        await seedSubmission(gameId, { iscoredUsername: 'Leader', submittedByUserId: 'LEADER3', score: 900 });
        await PickDispositionService.set(tournamentId, 'LEADER3', 'forfeit');

        await RotationNudgeService.evaluateSubmitter(roomId, 'RRN Ready Game', 'LEADER3');
        expect(await nudgeRows(tournamentId)).toHaveLength(0);
    });

    it('no-ops silently for a guest submit (no discordUserId)', async () => {
        const { roomId, tournamentId } = await setupTournament(cronInMinutes(30));
        const gameId = await createTestGame(tournamentId, { name: 'RRN Guest Game', status: 'ACTIVE' });
        await seedSubmission(gameId, { iscoredUsername: 'Leader', submittedByUserId: 'LEADER4', score: 900 });

        await expect(RotationNudgeService.evaluateSubmitter(roomId, 'RRN Guest Game', undefined)).resolves.toBeUndefined();
        expect(await nudgeRows(tournamentId)).toHaveLength(0);
    });
});
