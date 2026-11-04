import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { PickAwardGate } from '../services/PickAwardGate.js';
import { TournamentEngine } from '../engine/TournamentEngine.js';
import { getTerminology } from '../utils/terminology.js';

// ---------------------------------------------------------------------------
// Auto-pick ranked choice, end to end through both sites (v2.219.0, ADR 0036,
// WORK.md A25). The pure ranking has its own file (autopick-ranking.test.ts);
// this one proves the effects: the winning queues' rows are spent, each queue
// is compacted, the others are untouched, the audit carries the tier, and the
// announcement names the players without a raw id or a ping.
// ---------------------------------------------------------------------------

const sent: Array<{ channelId: string; description: string; opts: unknown }> = [];

vi.mock('../utils/discord.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/discord.js')>();
    return {
        ...actual,
        sendChannelEmbed: async (channelId: string, embed: any, opts?: unknown) => {
            sent.push({ channelId, description: embed?.data?.description ?? '', opts });
            return undefined;
        },
        sendChannelMessage: async () => undefined,
        sendDirectMessage: async () => true,
        resolveAnnouncementChannelId: () => 'chan-autopick',
    };
});

const P1 = '100000000000000001';
const P2 = '100000000000000002';
const P3 = '100000000000000003';

const SHARED = 'Attack from Mars';
const TABLES = [SHARED, 'Space Shuttle Deluxe', 'Medieval Madness', 'Twilight Zone', 'Fish Tales', 'Funhouse'];

let counter = 0;

async function setup() {
    const db = await getDatabase();
    const slug = `autopick-${++counter}`;
    const roomId = await createTestRoom(slug, `Autopick Room ${counter}`);
    await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
    const tournamentId = await createTestTournament(roomId, { name: `Autopick Cup ${counter}` });
    await db.run('UPDATE tournaments SET max_active_games = 1, winner_picks = 1 WHERE id = ?', tournamentId);
    for (const name of TABLES) {
        await db.run(
            `INSERT OR REPLACE INTO global_games (id, name, type, platforms, status)
             VALUES (?, ?, 'pinball', '["vpx"]', 'approved')`,
            `gg-${name.toLowerCase().replace(/\W+/g, '-')}`, name,
        );
    }
    // Two of the three players have a profile name; P3 resolves to nothing.
    await db.run(`INSERT OR REPLACE INTO user_profiles (discord_user_id, display_name) VALUES (?, 'Alpha'), (?, 'Bravo')`, P1, P2);
    PickAwardGate.invalidate();
    return { roomId, tournamentId };
}

/** Queue `names` for `player` so the FIRST name ends up at position 1 (newest-first). */
async function queueAll(tournamentId: string, player: string, names: string[]) {
    const engine = TournamentEngine.getInstance();
    const ids: Record<string, string> = {};
    for (const name of [...names].reverse()) {
        const g = await engine.queueGame(tournamentId, name, undefined, undefined, player);
        ids[name] = g.id;
    }
    return ids;
}

async function queueOf(tournamentId: string, player: string) {
    const db = await getDatabase();
    return db.all(
        `SELECT id, name, queue_order FROM games
          WHERE tournament_id = ? AND status = 'QUEUED' AND picker_discord_id = ? AND name != '[Pending Pick]'
          ORDER BY queue_order`,
        tournamentId, player,
    );
}

async function seedQueues(tournamentId: string) {
    // AfM: P1 #2 (2) + P2 #1 (3) + P3 #3 (1) = 6. Space Shuttle: P1 #1 = 3.
    const q1 = await queueAll(tournamentId, P1, ['Space Shuttle Deluxe', SHARED, 'Fish Tales']);
    const q2 = await queueAll(tournamentId, P2, [SHARED, 'Twilight Zone']);
    const q3 = await queueAll(tournamentId, P3, ['Medieval Madness', 'Funhouse', SHARED, 'Fish Tales']);
    return { q1, q2, q3 };
}

async function expectSpent(tournamentId: string, q: { q1: Record<string, string>; q2: Record<string, string>; q3: Record<string, string> }) {
    const db = await getDatabase();
    for (const id of [q.q1[SHARED], q.q2[SHARED], q.q3[SHARED]]) {
        expect(await db.get('SELECT id FROM games WHERE id = ?', id)).toBeUndefined();
    }
    const after1 = await queueOf(tournamentId, P1);
    const after2 = await queueOf(tournamentId, P2);
    const after3 = await queueOf(tournamentId, P3);
    expect(after1.map((r: any) => [r.name, r.queue_order])).toEqual([['Space Shuttle Deluxe', 1], ['Fish Tales', 2]]);
    expect(after2.map((r: any) => [r.name, r.queue_order])).toEqual([['Twilight Zone', 1]]);
    expect(after3.map((r: any) => [r.name, r.queue_order])).toEqual([['Medieval Madness', 1], ['Funhouse', 2], ['Fish Tales', 3]]);
    // The non-contributing rows are the same rows as before.
    expect(after1[0].id).toBe(q.q1['Space Shuttle Deluxe']);
    expect(after3[2].id).toBe(q.q3['Fish Tales']);
}

async function auditRow(tournamentId: string) {
    const db = await getDatabase();
    const row = await db.get(
        `SELECT source, game_name, details FROM rotation_events
          WHERE tournament_id = ? AND event_type = 'game_activated' ORDER BY id DESC LIMIT 1`,
        tournamentId,
    );
    return row ? { ...row, details: JSON.parse(row.details) } : undefined;
}

/** The audit log is fire-and-forget; give it a tick. */
const flush = () => new Promise(r => setTimeout(r, 20));

describe('auto-pick ranked choice over the queues', () => {
    beforeEach(async () => {
        await setupTestDb();
        PickAwardGate.invalidate();
        sent.length = 0;
    });

    it('TimeoutManager.fallbackToAutoSelection: the shared table wins and the queues that chose it pay for it', async () => {
        const { roomId, tournamentId } = await setup();
        const db = await getDatabase();
        const q = await seedQueues(tournamentId);
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, start_date, game_room_id, picker_discord_id, picker_type, picker_designated_at)
             VALUES ('slot-ap', ?, '[Pending Pick]', 'QUEUED', ?, ?, ?, 'WINNER', ?)`,
            tournamentId, new Date().toISOString(), roomId, P1, new Date().toISOString(),
        );

        const { TimeoutManager } = await import('../engine/TimeoutManager.js');
        await (TimeoutManager.getInstance() as any).fallbackToAutoSelection({
            id: 'slot-ap', tournamentId, name: '[Pending Pick]', status: 'QUEUED', pickerDiscordId: P1,
        });
        await flush();

        // The placeholder became the ACTIVE game.
        const slot = await db.get('SELECT name, status, picker_discord_id FROM games WHERE id = ?', 'slot-ap');
        expect(slot).toMatchObject({ name: SHARED, status: 'ACTIVE', picker_discord_id: null });

        await expectSpent(tournamentId, q);

        const audit = await auditRow(tournamentId);
        expect(audit?.source).toBe('timeout_auto');
        expect(audit?.details.autoPick.tier).toBe(1);
        expect(audit?.details.autoPick.points).toBe(6);
        expect(audit?.details.autoPick.contributors).toEqual([P2, P1, P3]);
        // The `[Pending Pick]` placeholder is never a vote, so never a contributor.
        expect(JSON.stringify(audit?.details.autoPick)).not.toContain('slot-ap');
        expect(audit?.details.autoPick.tally[0]).toEqual({ name: SHARED, points: 6 });

        const post = sent.find(s => s.channelId === 'chan-autopick');
        expect(post?.description).toBe(
            `All pickers timed out! **${SHARED}** has been auto-selected for **Autopick Cup ${counter}** from the queues of Bravo, Alpha and a member.`,
        );
        expect(post?.description).not.toMatch(/\d{17,}/);
        expect(post?.description).not.toContain('<@');
        expect(post?.opts).toBeUndefined();
    });

    it('TournamentEngine.autoPickAndActivate: same ranking, a fresh ACTIVE row, same consumption', async () => {
        const { tournamentId } = await setup();
        const db = await getDatabase();
        const q = await seedQueues(tournamentId);

        const row = await db.get('SELECT * FROM tournaments WHERE id = ?', tournamentId);
        await (TournamentEngine.getInstance() as any).autoPickAndActivate(
            db, row, tournamentId, { id: 'prev', name: 'Previous Game' }, null,
            getTerminology('pinball'), 'chan-autopick',
        );
        await flush();

        const active = await db.all(`SELECT name FROM games WHERE tournament_id = ? AND status = 'ACTIVE'`, tournamentId);
        expect(active.map((g: any) => g.name)).toEqual([SHARED]);
        await expectSpent(tournamentId, q);

        const audit = await auditRow(tournamentId);
        expect(audit?.source).toBe('auto_pick');
        expect(audit?.details.autoPick.tier).toBe(1);
        expect(sent.at(-1)?.description).toBe(
            `**${SHARED}** has been auto-selected for **Autopick Cup ${counter}** from the queues of Bravo, Alpha and a member.`,
        );
    });

    it('AutoPickSignalService.load reads ratings per user, room reach and per-run turnout', async () => {
        const { roomId, tournamentId } = await setup();
        const db = await getDatabase();
        const ggId = 'gg-attack-from-mars';
        // P1 (a room member) rated two platforms of one table: ONE vote, avg 2 → memberLow.
        await db.run(`INSERT INTO room_members (user_id, room_id, source) VALUES (?, ?, 'admin_invite')`, P1, roomId);
        await db.run(
            `INSERT INTO global_game_ratings (global_game_id, discord_user_id, platform, rating) VALUES
             (?, ?, '', 1), (?, ?, 'vpx', 3), (?, ?, '', 5)`,
            ggId, P1, ggId, P1, ggId, P2,
        );
        // One completed run with two players in it, plus a score from another room.
        const start = new Date(Date.now() - 3600_000).toISOString();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, start_date, end_date) VALUES ('run-1', ?, ?, 'COMPLETED', ?, ?)`,
            tournamentId, SHARED, start, new Date().toISOString(),
        );
        for (const [user, alias] of [[P1, 'alpha'], [P2, 'bravo']]) {
            await db.run(
                `INSERT INTO score_history (game_name, game_room_id, iscored_username, discord_user_id, submitted_by_user_id, score, source, submitted_during_tournament_id)
                 VALUES (?, ?, ?, ?, ?, 100, 'tournament', ?)`,
                SHARED, roomId, alias, user, user, tournamentId,
            );
        }
        await db.run(
            `INSERT INTO score_history (game_name, game_room_id, iscored_username, discord_user_id, score, source)
             VALUES (?, ?, 'charlie', ?, 100, 'community')`,
            SHARED, await createTestRoom(`other-${counter}`, 'Other Room'), P3,
        );

        const { AutoPickSignalService } = await import('../services/AutoPickSignalService.js');
        const s = await AutoPickSignalService.load({ tournamentId, gameRoomId: roomId, names: TABLES });
        expect(s.ratings.get('attack from mars')).toEqual({ sum: 2 + 5, count: 2, memberLow: true });
        expect(s.siteMean).toBe(3);
        expect(s.roomPlayers.get('attack from mars')).toBe(2);
        expect(s.rounds).toEqual([{ name: SHARED, startDate: start, participants: 2 }]);
    });

    it('with no queues it roams (Tier 2) and keeps the old wording', async () => {
        const { tournamentId } = await setup();
        const db = await getDatabase();
        const row = await db.get('SELECT * FROM tournaments WHERE id = ?', tournamentId);
        await (TournamentEngine.getInstance() as any).autoPickAndActivate(
            db, row, tournamentId, { id: 'prev', name: 'Previous Game' }, null,
            getTerminology('pinball'), 'chan-autopick',
        );
        await flush();

        const audit = await auditRow(tournamentId);
        expect(audit?.details.autoPick.tier).toBe(2);
        expect(audit?.details.autoPick.contributors).toEqual([]);
        expect(audit?.details.autoPick.poolSize).toBe(TABLES.length);
        expect(sent.at(-1)?.description).toMatch(/has been auto-selected and activated for/);
    });
});
