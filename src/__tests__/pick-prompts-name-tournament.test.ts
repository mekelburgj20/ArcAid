import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Every pick prompt names the tournament it is for.
 *
 * INCIDENT (2026-09-30). Daily Grind VPX, Weekly Grind VPX and Weekly Grind
 * VPXS all announce into ONE channel. bofgi was runner-up on the Weekly Grind
 * VPXS; the winner let the window lapse and the channel got
 *
 *     ⏰ Winner Timed Out
 *     @bofgi — as the runner-up, you now have 30 minutes to pick the next
 *     Table. Use /pick-game!
 *
 * — no tournament anywhere, not even a footer. He assumed the Daily Grind
 * (where he thought he had a pick queued) and picked for the wrong one.
 *
 * Three channel embeds hand a player a pick obligation: "Pick Needed" (the
 * winner's window), "Winner Timed Out" (the runner-up's window) and "Pick
 * Reminder" (the countdown nags). Each must carry the tournament name in the
 * TITLE and the DESCRIPTION — a footer alone is what the incident proved
 * insufficient.
 */

const sent: Array<{ channelId: string; embed: any; opts: any }> = [];

vi.mock('../utils/discord.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/discord.js')>();
    return {
        ...actual,
        resolveAnnouncementChannelId: async () => 'announce-channel',
        sendChannelEmbed: async (channelId: string, embed: any, opts?: any) => {
            sent.push({ channelId, embed: embed.data ?? embed, opts });
        },
    };
});

const { setupTestDb, createTestRoom, createTestTournament, createTestGame } = await import('./helpers.js');
const { getDatabase } = await import('../database/database.js');
const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');
const { PickAwardGate } = await import('../services/PickAwardGate.js');
const { TournamentEngine } = await import('../engine/TournamentEngine.js');
const { TimeoutManager } = await import('../engine/TimeoutManager.js');

const TOURNAMENT = 'Weekly Grind - VPXS';
const WINNER = '1452664655334867070';
const RUNNER_UP = '1452664655334867071';

let roomCounter = 0;

async function setup() {
    const db = await getDatabase();
    const roomId = await createTestRoom(`pick-name-${++roomCounter}`, 'Pick Prompt Room');
    await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
    const tournamentId = await createTestTournament(roomId, { name: TOURNAMENT });
    await db.run('UPDATE tournaments SET winner_picks = 1 WHERE id = ?', tournamentId);
    PickAwardGate.invalidate();
    return { db, roomId, tournamentId };
}

async function seedPodium(db: any, gameId: string) {
    const seed = (username: string, playerId: string, score: number) => db.run(
        `INSERT INTO submissions (id, game_id, discord_user_id, submitted_by_user_id, iscored_username, score, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        `${gameId}-${username.toLowerCase()}`, gameId, playerId, playerId, username, score, new Date().toISOString(),
    );
    await seed('Winner', WINNER, 300);
    await seed('Bofgi', RUNNER_UP, 200);
}

async function seedPendingPick(tournamentId: string, opts: {
    pickerDiscordId: string; pickerType: 'WINNER' | 'RUNNER_UP'; wonGameId: string; designatedAt: string;
}) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, picker_discord_id, picker_type, picker_designated_at, reminder_count, won_game_id)
         VALUES (?, ?, '[Pending Pick]', 'QUEUED', ?, ?, ?, 0, ?)`,
        id, tournamentId, opts.pickerDiscordId, opts.pickerType, opts.designatedAt, opts.wonGameId,
    );
    return id;
}

const byTitle = (pred: (t: string) => boolean) => sent.find((s) => pred(String(s.embed?.title ?? '')));

describe('pick prompts name the tournament they are for', () => {
    beforeEach(async () => {
        await setupTestDb();
        PickAwardGate.invalidate();
        sent.length = 0;
    });

    it('"Pick Needed" (winner window) names the tournament in title and body, not only the footer', async () => {
        const { db, tournamentId } = await setup();
        const activeId = await createTestGame(tournamentId, { name: 'Scared Stiff', status: 'ACTIVE' });
        await seedPodium(db, activeId);

        await TournamentEngine.getInstance().runMaintenance(tournamentId);

        const pick = byTitle((t) => t.startsWith('Pick Needed'));
        expect(pick, 'no Pick Needed embed was sent').toBeTruthy();
        expect(pick!.embed.title).toContain(TOURNAMENT);
        expect(pick!.embed.description).toContain(`**${TOURNAMENT}**`);
        expect(pick!.embed.description).toContain('Scared Stiff');
        expect(pick!.embed.description).not.toContain('for this slot');
    });

    it('"Winner Timed Out" (runner-up window) names the tournament in title, body and footer', async () => {
        const { db, tournamentId } = await setup();
        const wonGameId = await createTestGame(tournamentId, { status: 'COMPLETED', name: 'Whirlwind' });
        await seedPodium(db, wonGameId);
        // Winner's window expired (> default 60min); runner-up has nothing
        // queued, so the pivot grants them a window of their own.
        const expiredAt = new Date(Date.now() - 90 * 60 * 1000).toISOString();
        await seedPendingPick(tournamentId, { pickerDiscordId: WINNER, pickerType: 'WINNER', wonGameId, designatedAt: expiredAt });

        await TimeoutManager.getInstance().checkTimeouts();

        const timedOut = byTitle((t) => t.includes('Winner Timed Out'));
        expect(timedOut, 'no Winner Timed Out embed was sent').toBeTruthy();
        expect(timedOut!.embed.title).toContain(TOURNAMENT);
        expect(timedOut!.embed.description).toContain(`**${TOURNAMENT}**`);
        expect(timedOut!.embed.description).toContain('as the runner-up');
        expect(timedOut!.embed.footer?.text).toBe(TOURNAMENT);
        expect(timedOut!.opts?.pingUserIds).toEqual([RUNNER_UP]);
    });

    it('"Pick Reminder" names the tournament in title and body', async () => {
        const { db, tournamentId } = await setup();
        const wonGameId = await createTestGame(tournamentId, { status: 'COMPLETED', name: 'Whirlwind' });
        await seedPodium(db, wonGameId);
        // 17 minutes into a 60-minute winner window: past the first 15-minute
        // reminder mark, well short of expiry.
        const designatedAt = new Date(Date.now() - 17 * 60 * 1000).toISOString();
        await seedPendingPick(tournamentId, { pickerDiscordId: WINNER, pickerType: 'WINNER', wonGameId, designatedAt });

        await TimeoutManager.getInstance().checkTimeouts();

        const reminder = byTitle((t) => t.startsWith('Pick Reminder'));
        expect(reminder, 'no Pick Reminder embed was sent').toBeTruthy();
        expect(reminder!.embed.title).toContain(TOURNAMENT);
        expect(reminder!.embed.description).toContain(`**${TOURNAMENT}**`);
        expect(reminder!.embed.footer?.text).toBe(TOURNAMENT);
    });
});
