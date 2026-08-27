import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { TournamentEngine } from '../engine/TournamentEngine.js';
import { TimeoutManager } from '../engine/TimeoutManager.js';
import { PickAwardGate } from '../services/PickAwardGate.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';

/**
 * Slot reservation — prod incident 2026-08-27, room rtx_pinball.
 *
 * A `[Pending Pick]` placeholder (status QUEUED, picker_discord_id +
 * picker_designated_at set) RESERVES its tournament slot. Every "how many
 * slots are free?" computation had counted only ACTIVE rows, so the reserved
 * slot was invisible:
 *   1. The `runMaintenanceWork` extra-slot fill loop activated OTHER players'
 *      queued games into a slot a live pick window was about to fill ("Junk
 *      Yard"/"Fathom" stolen the moment the windows opened).
 *   2. `TimeoutManager.activateQueuedIntoSlot` (via `pivotToRunnerUp` /
 *      `pivotToThirdPlaceQueue`) had no capacity check — unlike its sibling
 *      `fallbackToAutoSelection` — so an already-full tournament kept growing
 *      past `max_active_games` when a robbed pick window expired.
 *   3. The ordinary pick endpoints (web + Discord) had the same blindness:
 *      during someone's live pick window the slot LOOKS empty, so any other
 *      player's pick activated straight into the reserved slot.
 *   4. A pick made while slots are full repurposes the placeholder but used
 *      to leave `picker_designated_at`/`picker_type` set, so TimeoutManager
 *      kept treating it as an unfulfilled pick window — reminders kept
 *      firing, and expiry would have overwritten the chosen game.
 *
 * `TournamentEngine.countPendingPickSlots` is the one place that counts
 * reserved slots; every guard below routes through it.
 */

let roomCounter = 0;

async function setup(opts: { maxActive?: number } = {}) {
    const roomId = await createTestRoom(`slot-res-room-${++roomCounter}`, 'Slot Reservation Room');
    await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
    const tournamentId = await createTestTournament(roomId, { name: `Slot Reservation Cup ${roomCounter}` });
    const db = await getDatabase();
    await db.run(
        'UPDATE tournaments SET max_active_games = ?, winner_picks = 1 WHERE id = ?',
        opts.maxActive ?? 1, tournamentId,
    );
    PickAwardGate.invalidate();
    return { roomId, tournamentId };
}

/** Seed a live `[Pending Pick]` placeholder row — a reserved slot. */
async function seedPendingPick(tournamentId: string, opts: {
    pickerDiscordId: string;
    pickerType: 'WINNER' | 'RUNNER_UP';
    wonGameId: string;
    designatedAt?: string;
}) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, picker_discord_id, picker_type, picker_designated_at, reminder_count, won_game_id)
         VALUES (?, ?, '[Pending Pick]', 'QUEUED', ?, ?, ?, 0, ?)`,
        id, tournamentId, opts.pickerDiscordId, opts.pickerType,
        opts.designatedAt ?? new Date().toISOString(), opts.wonGameId,
    );
    return id;
}

async function gameRow(id: string) {
    const db = await getDatabase();
    return db.get('SELECT * FROM games WHERE id = ?', id);
}

/**
 * An approved catalogue entry — required by `checkPickQueueEligibility`
 * (the web `POST /pick-game` route resolves the game against `global_games`
 * before doing anything else; an unseeded name 404s as GAME_NOT_FOUND).
 */
async function seedCatalogue(name: string, opts: { type?: string } = {}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO global_games (id, name, type, platforms, features, status)
         VALUES (?, ?, ?, ?, '[]', 'approved')`,
        crypto.randomUUID(), name, opts.type ?? 'pinball', JSON.stringify(['vpx']),
    );
}

describe('Slot reservation — countPendingPickSlots', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('counts a live placeholder', async () => {
        const { tournamentId } = await setup();
        const wonGameId = await createTestGame(tournamentId, { status: 'COMPLETED', name: 'Won Game' });
        await seedPendingPick(tournamentId, { pickerDiscordId: 'WINNER_X', pickerType: 'RUNNER_UP', wonGameId });

        const engine = TournamentEngine.getInstance();
        expect(await engine.countPendingPickSlots(tournamentId)).toBe(1);
    });

    it('excludes the named picker\'s own placeholder', async () => {
        const { tournamentId } = await setup();
        const wonGameId = await createTestGame(tournamentId, { status: 'COMPLETED', name: 'Won Game' });
        await seedPendingPick(tournamentId, { pickerDiscordId: 'WINNER_X', pickerType: 'RUNNER_UP', wonGameId });

        const engine = TournamentEngine.getInstance();
        expect(await engine.countPendingPickSlots(tournamentId, 'WINNER_X')).toBe(0);
        expect(await engine.countPendingPickSlots(tournamentId, 'SOMEONE_ELSE')).toBe(1);
    });
});

describe('Slot reservation — runMaintenanceWork extra-slot fill loop', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('a reserved slot blocks another player\'s queued game from activating (max=1)', async () => {
        const { tournamentId } = await setup({ maxActive: 1 });
        const engine = TournamentEngine.getInstance();
        const wonGameId = await createTestGame(tournamentId, { status: 'COMPLETED', name: 'Won Game' });

        await seedPendingPick(tournamentId, { pickerDiscordId: 'WINNER_X', pickerType: 'RUNNER_UP', wonGameId });
        const otherQueued = await engine.queueGame(tournamentId, 'Junk Yard', undefined, undefined, 'OTHER_PLAYER');

        await engine.runMaintenance(tournamentId);

        // The other player's game must still be QUEUED — the reserved slot
        // was not handed away.
        const row = await gameRow(otherQueued.id);
        expect(row.status).toBe('QUEUED');
        const db = await getDatabase();
        const activeCount = await db.get(
            `SELECT COUNT(*) AS n FROM games WHERE tournament_id = ? AND status = 'ACTIVE'`, tournamentId,
        );
        expect(activeCount.n).toBe(0);
    });

    it('a genuinely free slot still fills normally (max=2, one reserved)', async () => {
        const { tournamentId } = await setup({ maxActive: 2 });
        const engine = TournamentEngine.getInstance();
        const wonGameId = await createTestGame(tournamentId, { status: 'COMPLETED', name: 'Won Game' });

        await seedPendingPick(tournamentId, { pickerDiscordId: 'WINNER_X', pickerType: 'RUNNER_UP', wonGameId });
        const otherQueued = await engine.queueGame(tournamentId, 'Fathom', undefined, undefined, 'OTHER_PLAYER');

        await engine.runMaintenance(tournamentId);

        // One slot is reserved by the placeholder, the other is genuinely
        // free — the queued game activates into it.
        const row = await gameRow(otherQueued.id);
        expect(row.status).toBe('ACTIVE');
    });
});

describe('Slot reservation — TimeoutManager pivot capacity guard', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('an expired RUNNER_UP window is dropped (not activated) when the tournament is already full', async () => {
        const { tournamentId } = await setup({ maxActive: 1 });
        const engine = TournamentEngine.getInstance();

        // The one slot is already occupied by an ACTIVE game (someone stole it
        // before this pick window expired — exactly the 2026-08-27 shape).
        await createTestGame(tournamentId, { status: 'ACTIVE', name: 'Currently Active' });

        const wonGameId = await createTestGame(tournamentId, { status: 'COMPLETED', name: 'Whirlwind' });
        const expiredAt = new Date(Date.now() - 40 * 60 * 1000).toISOString(); // 40min ago > 30min default
        const placeholderId = await seedPendingPick(tournamentId, {
            pickerDiscordId: 'RUNNER_UP_X', pickerType: 'RUNNER_UP', wonGameId, designatedAt: expiredAt,
        });

        const otherQueued = await engine.queueGame(tournamentId, 'Back to the Future', undefined, undefined, 'OTHER_PLAYER');

        await TimeoutManager.getInstance().checkTimeouts();

        // Placeholder removed, not fulfilled.
        expect(await gameRow(placeholderId)).toBeUndefined();
        // The other player's queued game is untouched.
        expect((await gameRow(otherQueued.id)).status).toBe('QUEUED');
        // Still exactly 1 ACTIVE row — no over-activation.
        const db = await getDatabase();
        const activeRows = await db.all(`SELECT id FROM games WHERE tournament_id = ? AND status = 'ACTIVE'`, tournamentId);
        expect(activeRows).toHaveLength(1);
    });

    it('an expired WINNER window (pivotToRunnerUp) activates normally when the slot is genuinely free', async () => {
        const { tournamentId } = await setup({ maxActive: 1 });
        const engine = TournamentEngine.getInstance();
        const db = await getDatabase();

        // A completed game with a real podium so resolvePick has somewhere to
        // walk: W (winner, whose window just expired) and R (runner-up, who
        // has a queued pick ready to go).
        const wonGameId = await createTestGame(tournamentId, { status: 'COMPLETED', name: 'Whirlwind' });
        const seedScore = async (username: string, playerId: string, score: number) => db.run(
            `INSERT INTO submissions (id, game_id, discord_user_id, submitted_by_user_id, iscored_username, score, timestamp)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            `${wonGameId}-${username.toLowerCase()}`, wonGameId, playerId, playerId, username, score, new Date().toISOString(),
        );
        await seedScore('Winner', 'W', 300);
        await seedScore('Runner', 'R', 200);

        const expiredAt = new Date(Date.now() - 90 * 60 * 1000).toISOString(); // > default 60min winner window
        const placeholderId = await seedPendingPick(tournamentId, {
            pickerDiscordId: 'W', pickerType: 'WINNER', wonGameId, designatedAt: expiredAt,
        });
        const queued = await engine.queueGame(tournamentId, 'Back to the Future', undefined, undefined, 'R');

        // No other ACTIVE game and no other placeholder — the slot this
        // placeholder itself reserves is the only thing at stake, so the
        // guard must NOT block: over-tightness would be its own bug.
        await TimeoutManager.getInstance().checkTimeouts();

        const activeRows = await db.all(`SELECT id, name FROM games WHERE tournament_id = ? AND status = 'ACTIVE'`, tournamentId);
        expect(activeRows).toHaveLength(1);
        expect(activeRows[0].name).toBe('Back to the Future');
        // activateQueuedIntoSlot reuses the placeholder row and deletes the
        // consumed queued row.
        expect(activeRows[0].id).toBe(placeholderId);
        expect(await gameRow(queued.id)).toBeUndefined();
    });
});

describe('Slot reservation — repurposed pick exits the timeout sweep', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('a repurposed QUEUED row (picker_designated_at cleared) is left untouched by checkTimeouts', async () => {
        const { tournamentId } = await setup({ maxActive: 1 });
        const db = await getDatabase();
        const id = crypto.randomUUID();
        // Shape produced by the fixed repurpose UPDATE: real name, picker_discord_id
        // kept (attribution), picker_type/picker_designated_at cleared.
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, picker_discord_id, picker_type, picker_designated_at, reminder_count)
             VALUES (?, ?, 'Repurposed Pick', 'QUEUED', 'PLAYER_X', NULL, NULL, 0)`,
            id, tournamentId,
        );

        await TimeoutManager.getInstance().checkTimeouts();

        const row = await gameRow(id);
        expect(row).toBeDefined();
        expect(row.status).toBe('QUEUED');
        expect(row.name).toBe('Repurposed Pick');
        expect(row.picker_designated_at).toBeNull();
        expect(row.reminder_count).toBe(0);
    });
});

describe('Slot reservation — web pick-game repurpose clears pick-window fields', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('rooms.ts repurposes the placeholder AND clears picker_type/picker_designated_at', async () => {
        const express = (await import('express')).default;
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const { roomId, tournamentId } = await setup({ maxActive: 1 });
        const db = await getDatabase();

        // Slot already full — someone else's game is ACTIVE.
        await createTestGame(tournamentId, { status: 'ACTIVE', name: 'Someone Else Active' });

        await seedCatalogue('My Chosen Game');
        const wonGameId = await createTestGame(tournamentId, { status: 'COMPLETED', name: 'Won Game' });
        const placeholderId = await seedPendingPick(tournamentId, {
            pickerDiscordId: 'WEB_PLAYER', pickerType: 'WINNER', wonGameId,
        });

        const app = express();
        app.use(express.json());
        const { default: roomsRouter } = await import('../api/routes/rooms.js');
        app.use('/api/rooms', roomsRouter);

        const token = signToken({ role: 'player', gameRoomIds: [roomId], discordId: 'WEB_PLAYER', username: 'WebPlayer' } as never);
        const res = await request(app)
            .post(`/api/rooms/${roomId}/pick-game`)
            .set('Authorization', `Bearer ${token}`)
            .send({ tournamentId, gameName: 'My Chosen Game' });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('queued');

        const row = await db.get('SELECT * FROM games WHERE id = ?', placeholderId);
        expect(row.name).toBe('My Chosen Game');
        expect(row.status).toBe('QUEUED');
        expect(row.picker_type).toBeNull();
        expect(row.picker_designated_at).toBeNull();
        expect(row.reminder_count).toBe(0);

        // The stale pick-window fields being cleared means a later
        // checkTimeouts() sweep leaves this row alone (proves the exit from
        // the timeout sweep end-to-end, not just at the field level).
        await TimeoutManager.getInstance().checkTimeouts();
        const after = await db.get('SELECT * FROM games WHERE id = ?', placeholderId);
        expect(after.status).toBe('QUEUED');
        expect(after.name).toBe('My Chosen Game');
    });
});

describe('Slot reservation — pick during someone else\'s window queues instead of activating', () => {
    beforeEach(async () => { await setupTestDb(); });

    function makeInteraction(opts: {
        tournamentName: string;
        userId: string;
        guildId?: string | null;
        game?: string | null;
    }) {
        const replies: unknown[] = [];
        const interaction = {
            user: { id: opts.userId, tag: `${opts.userId}#0000`, displayName: 'Tester', toString: () => `<@${opts.userId}>` },
            guildId: opts.guildId ?? null,
            options: {
                getString: (name: string) => {
                    if (name === 'tournament') return opts.tournamentName;
                    if (name === 'game') return opts.game ?? null;
                    return null;
                },
                getBoolean: () => null,
                getUser: () => null,
            },
            deferReply: async () => {},
            editReply: async (payload: unknown) => { replies.push(payload); return payload; },
            reply: async (payload: unknown) => { replies.push(payload); return payload; },
            channel: undefined,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        return { interaction, replies };
    }

    it('web route: another player picking during a live window queues rather than activates', async () => {
        const express = (await import('express')).default;
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const { roomId, tournamentId } = await setup({ maxActive: 1 });
        const db = await getDatabase();

        await seedCatalogue('Not Yours');
        const wonGameId = await createTestGame(tournamentId, { status: 'COMPLETED', name: 'Won Game' });
        // PLAYER_A's window is live — this reserves the tournament's only slot.
        await seedPendingPick(tournamentId, { pickerDiscordId: 'PLAYER_A', pickerType: 'WINNER', wonGameId });

        const app = express();
        app.use(express.json());
        const { default: roomsRouter } = await import('../api/routes/rooms.js');
        app.use('/api/rooms', roomsRouter);

        const token = signToken({ role: 'player', gameRoomIds: [roomId], discordId: 'PLAYER_B', username: 'PlayerB' } as never);
        const res = await request(app)
            .post(`/api/rooms/${roomId}/pick-game`)
            .set('Authorization', `Bearer ${token}`)
            .send({ tournamentId, gameName: 'Not Yours' });

        expect(res.status).toBe(200);
        // Pre-fix this activated straight into PLAYER_A's reserved slot.
        expect(res.body.status).toBe('queued');
        const active = await db.all(`SELECT id, name FROM games WHERE tournament_id = ? AND status = 'ACTIVE'`, tournamentId);
        expect(active).toHaveLength(0);
    });

    it('Discord /pick-game: another player picking during a live window queues rather than activates', async () => {
        const { pickgame } = await import('../discord/commands/pickgame.js');
        const { roomId, tournamentId } = await setup({ maxActive: 1 });
        const guildId = `guild-${roomId}`;
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', guildId);
        const db = await getDatabase();
        const tournamentRow = await db.get('SELECT name FROM tournaments WHERE id = ?', tournamentId);

        const wonGameId = await createTestGame(tournamentId, { status: 'COMPLETED', name: 'Won Game' });
        await seedPendingPick(tournamentId, { pickerDiscordId: 'PLAYER_A', pickerType: 'WINNER', wonGameId });

        const { interaction, replies } = makeInteraction({
            tournamentName: tournamentRow.name,
            guildId,
            userId: 'PLAYER_B',
            game: 'Not Yours Either',
        });

        await pickgame.execute(interaction);

        const text = JSON.stringify(replies[replies.length - 1]);
        // Reply copy for the queued (not activated) branch. Newest-first
        // (owner ruling 2026-08-27) changed the exact wording to name the
        // queue position rather than a bare "has been queued".
        expect(text).toMatch(/top of your queue/i);

        const active = await db.all(`SELECT id FROM games WHERE tournament_id = ? AND status = 'ACTIVE'`, tournamentId);
        expect(active).toHaveLength(0);
        const queuedRow = await db.get(
            `SELECT status FROM games WHERE tournament_id = ? AND name = 'Not Yours Either'`, tournamentId,
        );
        expect(queuedRow.status).toBe('QUEUED');
    });
});
