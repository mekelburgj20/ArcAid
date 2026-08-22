import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { PickAwardGate } from '../services/PickAwardGate.js';
import { PickDispositionService } from '../services/PickDispositionService.js';
import { pickgame } from '../discord/commands/pickgame.js';

/**
 * `/pick-game` consolidation (ROADMAP "[FEATURE] /pick-game consolidation",
 * owner-designed 2026-08-12) — folds the retired `/my-pick` into `/pick-game`
 * via optional, mutually-exclusive `game` / `forfeit` / `pass-pick` / `clear`
 * params, context-sensitive on whether the invoker currently HOLDS the pick
 * (a live `[Pending Pick]` games row for the tournament with
 * `picker_discord_id` = invoker).
 *
 * No full discord.js gateway exists in this test suite (same constraint as
 * pickgame-iscored-optional.test.ts / discord-suspension-gate.test.ts), so
 * `execute()` is driven with a minimal plain-object interaction stub.
 */

function makeInteraction(opts: {
    tournamentName: string;
    userId: string;
    guildId?: string | null;
    game?: string | null;
    forfeit?: boolean | null;
    passPickId?: string | null;
    clear?: boolean | null;
    withChannel?: boolean;
}) {
    const replies: unknown[] = [];
    const channelMessages: string[] = [];
    const interaction = {
        user: { id: opts.userId, tag: `${opts.userId}#0000`, displayName: 'Tester', toString: () => `<@${opts.userId}>` },
        guildId: opts.guildId ?? null,
        options: {
            getString: (name: string) => {
                if (name === 'tournament') return opts.tournamentName;
                if (name === 'game') return opts.game ?? null;
                return null;
            },
            getBoolean: (name: string) => {
                if (name === 'forfeit') return opts.forfeit ?? null;
                if (name === 'clear') return opts.clear ?? null;
                return null;
            },
            getUser: (name: string) => {
                if (name === 'pass-pick' && opts.passPickId) {
                    return { id: opts.passPickId, toString: () => `<@${opts.passPickId}>` };
                }
                return null;
            },
        },
        deferReply: async (_o?: unknown) => {},
        editReply: async (payload: unknown) => { replies.push(payload); return payload; },
        reply: async (payload: unknown) => { replies.push(payload); return payload; },
        channel: opts.withChannel
            ? { send: async (msg: string) => { channelMessages.push(msg); return {}; } }
            : undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    return { interaction, replies, channelMessages };
}

async function setupTournament(roomSlug: string) {
    const roomId = await createTestRoom(roomSlug, roomSlug);
    const guildId = `guild-${roomSlug}`;
    await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
    // Link the room to the invoking guild so the cross-room write guard
    // (validateDiscordWriteTarget) doesn't refuse the command first — same
    // requirement as pickgame-iscored-optional.test.ts.
    await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', guildId);
    const tournamentId = await createTestTournament(roomId, { name: `${roomSlug} Tournament` });
    PickAwardGate.invalidate();
    return { roomId, tournamentId, guildId };
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

/** Insert a live `[Pending Pick]` placeholder row — "the invoker HOLDS the pick". */
async function seedHeldPick(tournamentId: string, opts: { pickerDiscordId: string; wonGameId?: string | null; gameRoomId?: string | null }) {
    const db = await getDatabase();
    const id = `pending-${Math.random().toString(36).slice(2)}`;
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, picker_discord_id, picker_type, picker_designated_at, reminder_count, won_game_id, game_room_id)
         VALUES (?, ?, '[Pending Pick]', 'QUEUED', ?, 'WINNER', ?, 0, ?, ?)`,
        id, tournamentId, opts.pickerDiscordId, new Date().toISOString(), opts.wonGameId ?? null, opts.gameRoomId ?? null,
    );
    return id;
}

async function getGame(id: string) {
    const db = await getDatabase();
    return db.get('SELECT * FROM games WHERE id = ?', id);
}

describe('/pick-game consolidation — mutual exclusion', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('rejects more than one of {game, forfeit, pass-pick, clear}', async () => {
        const { tournamentId, guildId } = await setupTournament('pgc-mutex-1');
        const { interaction, replies } = makeInteraction({
            tournamentName: `pgc-mutex-1 Tournament`,
            guildId,
            userId: 'mutex-user-1',
            game: 'Some Game',
            forfeit: true,
        });
        await pickgame.execute(interaction);
        expect(JSON.stringify(replies[replies.length - 1])).toMatch(/only one of/i);

        // No disposition should have been written.
        expect(await PickDispositionService.get(tournamentId, 'mutex-user-1')).toBeNull();
    });

    it('rejects forfeit + pass-pick together', async () => {
        const { guildId } = await setupTournament('pgc-mutex-2');
        const { interaction, replies } = makeInteraction({
            tournamentName: `pgc-mutex-2 Tournament`,
            guildId,
            userId: 'mutex-user-2',
            forfeit: true,
            passPickId: 'target-1',
        });
        await pickgame.execute(interaction);
        expect(JSON.stringify(replies[replies.length - 1])).toMatch(/only one of/i);
    });
});

describe('/pick-game consolidation — bare invoke (status)', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('reports the default disposition and queue count when nothing is set', async () => {
        const { guildId } = await setupTournament('pgc-status-1');
        const { interaction, replies } = makeInteraction({
            tournamentName: 'pgc-status-1 Tournament',
            guildId,
            userId: 'status-user-1',
        });
        await pickgame.execute(interaction);
        const text = JSON.stringify(replies[replies.length - 1]);
        expect(text).toMatch(/use my queue/i);
        expect(text).toMatch(/0\/30/);
    });

    it('reports a stored forfeit disposition', async () => {
        const { tournamentId, guildId } = await setupTournament('pgc-status-2');
        await PickDispositionService.set(tournamentId, 'status-user-2', 'forfeit');
        const { interaction, replies } = makeInteraction({
            tournamentName: 'pgc-status-2 Tournament',
            guildId,
            userId: 'status-user-2',
        });
        await pickgame.execute(interaction);
        const text = JSON.stringify(replies[replies.length - 1]);
        expect(text).toMatch(/forfeited straight to the runner-up/i);
    });

    it('reports a stored nominate disposition with the nominee mentioned', async () => {
        const { tournamentId, guildId } = await setupTournament('pgc-status-3');
        await PickDispositionService.set(tournamentId, 'status-user-3', 'nominate', 'nominee-3');
        const { interaction, replies } = makeInteraction({
            tournamentName: 'pgc-status-3 Tournament',
            guildId,
            userId: 'status-user-3',
        });
        await pickgame.execute(interaction);
        const text = JSON.stringify(replies[replies.length - 1]);
        expect(text).toMatch(/<@nominee-3>/);
    });

    it('flags when the invoker currently holds a live pick', async () => {
        const { tournamentId, roomId, guildId } = await setupTournament('pgc-status-4');
        const wonGameId = await createTestGame(tournamentId, { status: 'COMPLETED', name: 'Won Game' });
        await seedHeldPick(tournamentId, { pickerDiscordId: 'status-user-4', wonGameId, gameRoomId: roomId });

        const { interaction, replies } = makeInteraction({
            tournamentName: 'pgc-status-4 Tournament',
            guildId,
            userId: 'status-user-4',
        });
        await pickgame.execute(interaction);
        const text = JSON.stringify(replies[replies.length - 1]);
        expect(text).toMatch(/holding the pick/i);
        expect(text).toMatch(/Won Game/);
    });
});

describe('/pick-game consolidation — disposition-set path (NOT holding the pick)', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('forfeit:True with no held pick sets the next-win forfeit disposition', async () => {
        const { tournamentId, guildId } = await setupTournament('pgc-disp-forfeit');
        const { interaction, replies } = makeInteraction({
            tournamentName: 'pgc-disp-forfeit Tournament',
            guildId,
            userId: 'disp-user-1',
            forfeit: true,
        });
        await pickgame.execute(interaction);

        const stored = await PickDispositionService.get(tournamentId, 'disp-user-1');
        expect(stored?.disposition).toBe('forfeit');
        expect(JSON.stringify(replies[replies.length - 1])).toMatch(/NEXT win/i);
    });

    it('pass-pick with no held pick sets the next-win nominate disposition', async () => {
        const { tournamentId, guildId } = await setupTournament('pgc-disp-nominate');
        const { interaction, replies } = makeInteraction({
            tournamentName: 'pgc-disp-nominate Tournament',
            guildId,
            userId: 'disp-user-2',
            passPickId: 'nominee-target-2',
        });
        await pickgame.execute(interaction);

        const stored = await PickDispositionService.get(tournamentId, 'disp-user-2');
        expect(stored?.disposition).toBe('nominate');
        expect(stored?.nominee_discord_id).toBe('nominee-target-2');
        expect(JSON.stringify(replies[replies.length - 1])).toMatch(/NEXT win/i);
    });

    it('clear:True clears a stored disposition', async () => {
        const { tournamentId, guildId } = await setupTournament('pgc-disp-clear');
        await PickDispositionService.set(tournamentId, 'disp-user-3', 'forfeit');
        const { interaction, replies } = makeInteraction({
            tournamentName: 'pgc-disp-clear Tournament',
            guildId,
            userId: 'disp-user-3',
            clear: true,
        });
        await pickgame.execute(interaction);

        expect(await PickDispositionService.get(tournamentId, 'disp-user-3')).toBeNull();
        expect(JSON.stringify(replies[replies.length - 1])).toMatch(/cleared/i);
    });

    it('rejects self-nomination via pass-pick when not holding the pick', async () => {
        const { tournamentId, guildId } = await setupTournament('pgc-disp-self');
        const { interaction, replies } = makeInteraction({
            tournamentName: 'pgc-disp-self Tournament',
            guildId,
            userId: 'disp-user-4',
            passPickId: 'disp-user-4',
        });
        await pickgame.execute(interaction);

        expect(await PickDispositionService.get(tournamentId, 'disp-user-4')).toBeNull();
        expect(JSON.stringify(replies[replies.length - 1])).toMatch(/yourself/i);
    });
});

describe('/pick-game consolidation — immediate path (HOLDING the pick)', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('live forfeit resolves the pick to the runner-up now (RUNNER_UP, no wait)', async () => {
        const { tournamentId, roomId, guildId } = await setupTournament('pgc-live-forfeit');
        const wonGameId = await createTestGame(tournamentId, { status: 'COMPLETED', name: 'Won Game' });
        await seedSubmission(wonGameId, { iscoredUsername: 'Winner', submittedByUserId: 'live-fwinner', score: 500 });
        await seedSubmission(wonGameId, { iscoredUsername: 'Runner', submittedByUserId: 'live-frunner', score: 400 });
        const slotId = await seedHeldPick(tournamentId, { pickerDiscordId: 'live-fwinner', wonGameId, gameRoomId: roomId });

        const { interaction, replies, channelMessages } = makeInteraction({
            tournamentName: 'pgc-live-forfeit Tournament',
            guildId,
            userId: 'live-fwinner',
            forfeit: true,
            withChannel: true,
        });
        await pickgame.execute(interaction);

        const slot = await getGame(slotId);
        expect(slot.picker_discord_id).toBe('live-frunner');
        expect(slot.picker_type).toBe('RUNNER_UP');

        const text = JSON.stringify(replies[replies.length - 1]);
        expect(text).toMatch(/holding the pick/i);
        expect(text).toMatch(/<@live-frunner>/);
        expect(channelMessages.join(' ')).toMatch(/forfeited/i);

        // No disposition row should have been touched — this was the
        // immediate path, not the disposition-set path.
        expect(await PickDispositionService.get(tournamentId, 'live-fwinner')).toBeNull();
    });

    it('live forfeit with no won_game_id on the placeholder errors without guessing', async () => {
        const { tournamentId, guildId } = await setupTournament('pgc-live-forfeit-nolink');
        const slotId = await seedHeldPick(tournamentId, { pickerDiscordId: 'live-nolink-user', wonGameId: null });

        const { interaction, replies } = makeInteraction({
            tournamentName: 'pgc-live-forfeit-nolink Tournament',
            guildId,
            userId: 'live-nolink-user',
            forfeit: true,
        });
        await pickgame.execute(interaction);

        const text = JSON.stringify(replies[replies.length - 1]);
        expect(text).toMatch(/nominate-picker/i);

        const slot = await getGame(slotId);
        expect(slot.picker_discord_id).toBe('live-nolink-user'); // unchanged
    });

    it('live forfeit with no eligible runner-up (only one submission) errors and suggests /nominate-picker', async () => {
        const { tournamentId, roomId, guildId } = await setupTournament('pgc-live-forfeit-norunner');
        const wonGameId = await createTestGame(tournamentId, { status: 'COMPLETED', name: 'Solo Game' });
        await seedSubmission(wonGameId, { iscoredUsername: 'OnlyWinner', submittedByUserId: 'live-solo-winner', score: 500 });
        const slotId = await seedHeldPick(tournamentId, { pickerDiscordId: 'live-solo-winner', wonGameId, gameRoomId: roomId });

        const { interaction, replies } = makeInteraction({
            tournamentName: 'pgc-live-forfeit-norunner Tournament',
            guildId,
            userId: 'live-solo-winner',
            forfeit: true,
        });
        await pickgame.execute(interaction);

        const text = JSON.stringify(replies[replies.length - 1]);
        expect(text).toMatch(/no eligible runner-up/i);
        expect(text).toMatch(/nominate-picker/i);

        const slot = await getGame(slotId);
        expect(slot.picker_discord_id).toBe('live-solo-winner'); // unchanged
        expect(slot.picker_type).toBe('WINNER'); // unchanged
    });

    it('live pass-pick reassigns the placeholder to the target immediately (WINNER, full window)', async () => {
        const { tournamentId, roomId, guildId } = await setupTournament('pgc-live-pass');
        const slotId = await seedHeldPick(tournamentId, { pickerDiscordId: 'live-pass-holder', gameRoomId: roomId });

        const { interaction, replies, channelMessages } = makeInteraction({
            tournamentName: 'pgc-live-pass Tournament',
            guildId,
            userId: 'live-pass-holder',
            passPickId: 'live-pass-target',
            withChannel: true,
        });
        await pickgame.execute(interaction);

        const slot = await getGame(slotId);
        expect(slot.picker_discord_id).toBe('live-pass-target');
        expect(slot.picker_type).toBe('WINNER');

        const text = JSON.stringify(replies[replies.length - 1]);
        expect(text).toMatch(/holding the pick/i);
        expect(text).toMatch(/passed it/i);
        expect(channelMessages.join(' ')).toMatch(/passed their pick/i);

        expect(await PickDispositionService.get(tournamentId, 'live-pass-holder')).toBeNull();
    });

    it('rejects live self-pass', async () => {
        const { tournamentId, roomId, guildId } = await setupTournament('pgc-live-self');
        const slotId = await seedHeldPick(tournamentId, { pickerDiscordId: 'live-self-user', gameRoomId: roomId });

        const { interaction, replies } = makeInteraction({
            tournamentName: 'pgc-live-self Tournament',
            guildId,
            userId: 'live-self-user',
            passPickId: 'live-self-user',
        });
        await pickgame.execute(interaction);

        expect(JSON.stringify(replies[replies.length - 1])).toMatch(/yourself/i);
        const slot = await getGame(slotId);
        expect(slot.picker_discord_id).toBe('live-self-user'); // unchanged
    });
});
