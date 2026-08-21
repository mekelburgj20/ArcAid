import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame, createTestSubmission } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { StatsService } from '../services/StatsService.js';
import { activategame } from '../discord/commands/activategame.js';
import { pickgame } from '../discord/commands/pickgame.js';
import { forcemaintenance } from '../discord/commands/forcemaintenance.js';
import { deactivategame } from '../discord/commands/deactivategame.js';
import { submitscore } from '../discord/commands/submitscore.js';
import { viewstats } from '../discord/commands/viewstats.js';
import { mystats } from '../discord/commands/mystats.js';
import { nominatepicker } from '../discord/commands/nominatepicker.js';

// v2.120.2 — the residue left by v2.120.1's read-command scoping.
//
// v2.120.1 scoped the read commands' EXECUTE paths to the invoking guild, but
// three leaks survived:
//   1. Autocomplete handlers still queried every room — the picker listed
//      other servers' tournament and game names before any guard ran.
//   2. `/view-stats` headline numbers (times played, average, unique players,
//      all-time high + record holder) and all of `/my-stats` aggregated
//      deployment-wide; only view-stats' two supplementary queries were scoped.
//   3. `/nominate-picker designate` ran `UPDATE ... LIMIT 1`, which stock
//      SQLite rejects — a pre-existing break, not a scoping one.

const GUILD_A = '2000000000000000001';
const GUILD_B = '2000000000000000002';
const GUILD_UNLINKED = '2000000000000000003';
const NOT_LINKED_FRAGMENT = 'linked to an Arcaid game room';

function replyText(replies: unknown[]): string {
    return JSON.stringify(replies);
}

/** Chat-input interaction double — same shape as discord-read-guild-scope.test.ts. */
function makeInteraction(guildId: string | null, overrides: Record<string, unknown> = {}) {
    const replies: unknown[] = [];
    const interaction = {
        id: 'interaction-autocomplete-scope',
        user: {
            id: 'scope-user-1', tag: 'scope-user-1#0000', displayName: 'Scope User',
            displayAvatarURL: () => 'https://example.invalid/avatar.png',
            toString: () => '<@scope-user-1>',
        },
        guildId,
        options: {
            getString: () => null,
            getUser: () => null,
            getInteger: () => null,
            getFocused: () => '',
        },
        deferReply: async (_o?: unknown) => {},
        editReply: async (payload: unknown) => { replies.push(payload); return payload; },
        reply: async (payload: unknown) => { replies.push(payload); return payload; },
        respond: async (payload: unknown) => { replies.push(payload); return payload; },
        ...overrides,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    return { interaction, replies };
}

/**
 * Autocomplete interaction double. `getFocused(true)` returns `{name, value}`
 * (the form every handler but force-maintenance uses); `getFocused()` returns
 * the bare string force-maintenance reads.
 */
function makeAutocomplete(
    guildId: string | null,
    focused: { name: string; value?: string },
    strings: Record<string, string> = {},
) {
    const responses: Array<Array<{ name: string; value: string }>> = [];
    const interaction = {
        guildId,
        options: {
            getFocused: (withType?: boolean) =>
                (withType ? { name: focused.name, value: focused.value ?? '' } : (focused.value ?? '')),
            getString: (name: string) => strings[name] ?? null,
            getInteger: () => null,
            getUser: () => null,
        },
        respond: async (choices: Array<{ name: string; value: string }>) => { responses.push(choices); },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    return { interaction, responses };
}

/** Flattens every choice a handler responded with into one searchable string. */
function choiceText(responses: Array<Array<{ name: string; value: string }>>): string {
    return JSON.stringify(responses);
}

function lastChoices(responses: Array<Array<{ name: string; value: string }>>) {
    return responses[responses.length - 1] ?? [];
}

async function seedRoom(opts: {
    slug: string;
    guildId?: string | null;
    tournamentName: string;
    gameName: string;
    status?: string;
}) {
    const roomId = await createTestRoom(opts.slug, opts.slug);
    if (opts.guildId) await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', opts.guildId);
    const tournamentId = await createTestTournament(roomId, { name: opts.tournamentName });
    const gameId = await createTestGame(tournamentId, {
        name: opts.gameName,
        status: opts.status ?? 'ACTIVE',
        endDate: new Date().toISOString(),
    });
    return { roomId, tournamentId, gameId };
}

/** A catalogue row so the catalogue-driven autocomplete branches have something to offer. */
async function seedCatalogueGame(name: string, type = 'pinball') {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO global_games (id, name, type, status, platforms)
         VALUES (?, ?, ?, 'approved', '[]')`,
        `cat-${name.toLowerCase().replace(/\s+/g, '-')}`, name, type,
    );
}

describe('autocomplete handlers — guild scoping', () => {
    const savedEnv = process.env.DISCORD_GUILD_ID;
    beforeEach(async () => {
        await setupTestDb();
        delete process.env.DISCORD_GUILD_ID;
    });
    afterEach(() => {
        if (savedEnv === undefined) delete process.env.DISCORD_GUILD_ID;
        else process.env.DISCORD_GUILD_ID = savedEnv;
    });

    async function seedTwoGuilds() {
        const a = await seedRoom({ slug: 'auto-a', guildId: GUILD_A, tournamentName: 'Cup Alpha', gameName: 'Game Alpha' });
        const b = await seedRoom({ slug: 'auto-b', guildId: GUILD_B, tournamentName: 'Cup Bravo', gameName: 'Game Bravo' });
        return { a, b };
    }

    it('/activate-game tournament autocomplete lists only the invoking guild rooms', async () => {
        await seedTwoGuilds();

        const alpha = makeAutocomplete(GUILD_A, { name: 'tournament' });
        await activategame.autocomplete!(alpha.interaction);
        expect(choiceText(alpha.responses)).toContain('Cup Alpha');
        expect(choiceText(alpha.responses)).not.toContain('Cup Bravo');

        const bravo = makeAutocomplete(GUILD_B, { name: 'tournament' });
        await activategame.autocomplete!(bravo.interaction);
        expect(choiceText(bravo.responses)).toContain('Cup Bravo');
        expect(choiceText(bravo.responses)).not.toContain('Cup Alpha');
    });

    it('/activate-game autocomplete responds with an empty list in an unlinked guild and a DM', async () => {
        await seedTwoGuilds();

        const unlinked = makeAutocomplete(GUILD_UNLINKED, { name: 'tournament' });
        await activategame.autocomplete!(unlinked.interaction);
        expect(lastChoices(unlinked.responses)).toEqual([]);

        const dm = makeAutocomplete(null, { name: 'tournament' });
        await activategame.autocomplete!(dm.interaction);
        expect(lastChoices(dm.responses)).toEqual([]);
    });

    it("/activate-game game_name autocomplete ignores another guild's tournament when filtering by mode", async () => {
        await seedTwoGuilds();
        await seedCatalogueGame('Catalogue Table');
        // Guild A naming guild B's tournament: the catalogue is global (no
        // leak), but B's mode must not drive A's filtering.
        const { interaction, responses } = makeAutocomplete(
            GUILD_A, { name: 'game_name' }, { tournament: 'Cup Bravo' },
        );
        await activategame.autocomplete!(interaction);
        expect(choiceText(responses)).toContain('Catalogue Table');
    });

    it('/pick-game tournament autocomplete lists only the invoking guild rooms', async () => {
        await seedTwoGuilds();

        const alpha = makeAutocomplete(GUILD_A, { name: 'tournament' });
        await pickgame.autocomplete!(alpha.interaction);
        expect(choiceText(alpha.responses)).toContain('Cup Alpha');
        expect(choiceText(alpha.responses)).not.toContain('Cup Bravo');

        const bravo = makeAutocomplete(GUILD_B, { name: 'tournament' });
        await pickgame.autocomplete!(bravo.interaction);
        expect(choiceText(bravo.responses)).toContain('Cup Bravo');
        expect(choiceText(bravo.responses)).not.toContain('Cup Alpha');
    });

    it('/pick-game autocomplete responds with an empty list in an unlinked guild', async () => {
        await seedTwoGuilds();
        const { interaction, responses } = makeAutocomplete(GUILD_UNLINKED, { name: 'tournament' });
        await pickgame.autocomplete!(interaction);
        expect(lastChoices(responses)).toEqual([]);
    });

    it('/force-maintenance tournament autocomplete lists only the invoking guild rooms', async () => {
        const { a, b } = await seedTwoGuilds();

        const alpha = makeAutocomplete(GUILD_A, { name: 'tournament' });
        await forcemaintenance.autocomplete!(alpha.interaction);
        expect(choiceText(alpha.responses)).toContain('Cup Alpha');
        expect(choiceText(alpha.responses)).toContain(a.tournamentId);
        expect(choiceText(alpha.responses)).not.toContain('Cup Bravo');
        expect(choiceText(alpha.responses)).not.toContain(b.tournamentId);

        const bravo = makeAutocomplete(GUILD_B, { name: 'tournament' });
        await forcemaintenance.autocomplete!(bravo.interaction);
        expect(choiceText(bravo.responses)).toContain('Cup Bravo');
        expect(choiceText(bravo.responses)).not.toContain('Cup Alpha');
    });

    it('/force-maintenance autocomplete responds with an empty list in an unlinked guild', async () => {
        await seedTwoGuilds();
        const { interaction, responses } = makeAutocomplete(GUILD_UNLINKED, { name: 'tournament' });
        await forcemaintenance.autocomplete!(interaction);
        expect(lastChoices(responses)).toEqual([]);
    });

    it('/deactivate-game game autocomplete lists only the invoking guild games and tournament names', async () => {
        await seedTwoGuilds();

        const alpha = makeAutocomplete(GUILD_A, { name: 'game' });
        await deactivategame.autocomplete!(alpha.interaction);
        expect(choiceText(alpha.responses)).toContain('Game Alpha');
        expect(choiceText(alpha.responses)).toContain('Cup Alpha');
        expect(choiceText(alpha.responses)).not.toContain('Game Bravo');
        expect(choiceText(alpha.responses)).not.toContain('Cup Bravo');

        const bravo = makeAutocomplete(GUILD_B, { name: 'game' });
        await deactivategame.autocomplete!(bravo.interaction);
        expect(choiceText(bravo.responses)).toContain('Game Bravo');
        expect(choiceText(bravo.responses)).not.toContain('Game Alpha');
    });

    it('/deactivate-game autocomplete responds with an empty list in an unlinked guild', async () => {
        await seedTwoGuilds();
        const { interaction, responses } = makeAutocomplete(GUILD_UNLINKED, { name: 'game' });
        await deactivategame.autocomplete!(interaction);
        expect(lastChoices(responses)).toEqual([]);
    });

    it('/submit-score game autocomplete lists only the invoking guild active games', async () => {
        await seedTwoGuilds();

        const alpha = makeAutocomplete(GUILD_A, { name: 'game' });
        await submitscore.autocomplete!(alpha.interaction);
        expect(choiceText(alpha.responses)).toContain('Game Alpha');
        expect(choiceText(alpha.responses)).not.toContain('Game Bravo');
        expect(choiceText(alpha.responses)).not.toContain('Cup Bravo');

        const bravo = makeAutocomplete(GUILD_B, { name: 'game' });
        await submitscore.autocomplete!(bravo.interaction);
        expect(choiceText(bravo.responses)).toContain('Game Bravo');
        expect(choiceText(bravo.responses)).not.toContain('Game Alpha');
    });

    it('/submit-score autocomplete responds with an empty list in an unlinked guild and a DM', async () => {
        await seedTwoGuilds();

        const unlinked = makeAutocomplete(GUILD_UNLINKED, { name: 'game' });
        await submitscore.autocomplete!(unlinked.interaction);
        expect(lastChoices(unlinked.responses)).toEqual([]);

        const dm = makeAutocomplete(null, { name: 'game' });
        await submitscore.autocomplete!(dm.interaction);
        expect(lastChoices(dm.responses)).toEqual([]);
    });

    it("/submit-score engine autocomplete refuses a hand-typed game from another guild", async () => {
        await seedTwoGuilds();
        const { interaction, responses } = makeAutocomplete(
            GUILD_A, { name: 'engine' }, { game: 'Game Bravo' },
        );
        await submitscore.autocomplete!(interaction);
        expect(lastChoices(responses)).toEqual([]);
    });
});

describe('StatsService room scoping', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    /**
     * Two rooms, same game name. Room A: one COMPLETED instance, one
     * tournament score + one community score. Room B: two COMPLETED
     * instances and a much higher score, so any leak is unmistakable.
     */
    async function seedSharedGame() {
        const db = await getDatabase();
        const a = await seedRoom({
            slug: 'stats-room-a', guildId: GUILD_A, tournamentName: 'Cup A',
            gameName: 'Shared Table', status: 'COMPLETED',
        });
        await createTestSubmission(a.gameId, { username: 'alice', discordUserId: 'user-alice', score: 1000 });

        const b = await seedRoom({
            slug: 'stats-room-b', guildId: GUILD_B, tournamentName: 'Cup B',
            gameName: 'Shared Table', status: 'COMPLETED',
        });
        await createTestSubmission(b.gameId, { username: 'bob', discordUserId: 'user-bob', score: 999_000 });
        const bGame2 = await createTestGame(b.tournamentId, {
            name: 'Shared Table', status: 'COMPLETED', endDate: new Date().toISOString(),
        });
        await createTestSubmission(bGame2, { username: 'bob', discordUserId: 'user-bob', score: 500_000 });

        // Community/freeplay scores: one per room. They dual-write into
        // score_history (source='community'), which is what getGameStats reads.
        for (const [roomId, name, score] of [
            [a.roomId, 'carol', 2000],
            [b.roomId, 'dave', 888_000],
        ] as Array<[string, string, number]>) {
            await db.run(
                `INSERT INTO community_scores (game_name, game_room_id, iscored_username, discord_user_id, score)
                 VALUES ('Shared Table', ?, ?, 'ANON', ?)`,
                roomId, name, score,
            );
            await db.run(
                `INSERT INTO score_history (game_name, game_room_id, iscored_username, discord_user_id, score, source, submitted_from_room_id)
                 VALUES ('Shared Table', ?, ?, 'ANON', ?, 'community', ?)`,
                roomId, name, score, roomId,
            );
        }

        return { a, b };
    }

    it('getGameStats without room args keeps the pre-v2.120.2 deployment-wide totals', async () => {
        await seedSharedGame();
        const stats = await StatsService.getGameStats('Shared Table');
        expect(stats).not.toBeNull();
        expect(stats!.timesPlayed).toBe(3);
        expect(stats!.uniquePlayers).toBe(4); // alice, bob, carol, dave
        expect(stats!.allTimeHigh).toBe(999_000);
        expect(stats!.allTimeHighPlayer).toBe('bob');
    });

    it('getGameStats with gameRoomIds counts only that room across games, score_history and community rows', async () => {
        const { a } = await seedSharedGame();

        const scoped = await StatsService.getGameStats('Shared Table', undefined, [a.roomId]);
        expect(scoped).not.toBeNull();
        expect(scoped!.timesPlayed).toBe(1);
        expect(scoped!.uniquePlayers).toBe(2); // alice + carol only
        expect(scoped!.allTimeHigh).toBe(2000); // carol's community score, not bob's 999k
        expect(scoped!.allTimeHighPlayer).toBe('carol');
        expect(scoped!.avgScore).toBe(1500); // (1000 + 2000) / 2
        expect(scoped!.recentResults.every(r => r.tournament_name === 'Cup A')).toBe(true);
    });

    it('getGameStats with several room ids unions exactly those rooms', async () => {
        const { a, b } = await seedSharedGame();
        const both = await StatsService.getGameStats('Shared Table', undefined, [a.roomId, b.roomId]);
        const all = await StatsService.getGameStats('Shared Table');
        expect(both!.timesPlayed).toBe(all!.timesPlayed);
        expect(both!.uniquePlayers).toBe(all!.uniquePlayers);
        expect(both!.allTimeHigh).toBe(all!.allTimeHigh);
    });

    it('getGameStats with an EMPTY room list matches nothing (linked guild, everything excluded)', async () => {
        await seedSharedGame();
        expect(await StatsService.getGameStats('Shared Table', undefined, [])).toBeNull();
    });

    it('getGameStats single-room arg is unchanged by the new parameter', async () => {
        const { a } = await seedSharedGame();
        const single = await StatsService.getGameStats('Shared Table', a.roomId);
        const asList = await StatsService.getGameStats('Shared Table', undefined, [a.roomId]);
        expect(single).toEqual(asList);
    });

    /** One Discord player scoring in both rooms. */
    async function seedSharedPlayer() {
        const a = await seedRoom({
            slug: 'player-room-a', guildId: GUILD_A, tournamentName: 'Cup A',
            gameName: 'Table A', status: 'COMPLETED',
        });
        await createTestSubmission(a.gameId, { username: 'nomad', discordUserId: 'user-nomad', score: 1000 });

        const b = await seedRoom({
            slug: 'player-room-b', guildId: GUILD_B, tournamentName: 'Cup B',
            gameName: 'Table B', status: 'COMPLETED',
        });
        await createTestSubmission(b.gameId, { username: 'nomad', discordUserId: 'user-nomad', score: 50_000 });
        const bGame2 = await createTestGame(b.tournamentId, {
            name: 'Table B2', status: 'COMPLETED', endDate: new Date().toISOString(),
        });
        await createTestSubmission(bGame2, { username: 'nomad', discordUserId: 'user-nomad', score: 30_000 });

        return { a, b };
    }

    it('getPlayerStats without room args keeps the pre-v2.120.2 cross-room totals', async () => {
        await seedSharedPlayer();
        const stats = await StatsService.getPlayerStats('user-nomad');
        expect(stats.totalGamesPlayed).toBe(3);
        expect(stats.totalWins).toBe(3);
        expect(stats.bestScore).toBe(50_000);
        expect(stats.bestGame).toBe('Table B');
        expect(stats.recentScores.length).toBe(3);
    });

    it('getPlayerStats with gameRoomIds restricts every aggregate to those rooms', async () => {
        const { a, b } = await seedSharedPlayer();

        const scopedA = await StatsService.getPlayerStats('user-nomad', undefined, [a.roomId]);
        expect(scopedA.totalGamesPlayed).toBe(1);
        expect(scopedA.totalWins).toBe(1);
        expect(scopedA.bestScore).toBe(1000);
        expect(scopedA.bestGame).toBe('Table A');
        expect(scopedA.averageScore).toBe(1000);
        expect(scopedA.recentScores.map(r => r.game_name)).toEqual(['Table A']);

        const scopedB = await StatsService.getPlayerStats('user-nomad', undefined, [b.roomId]);
        expect(scopedB.totalGamesPlayed).toBe(2);
        expect(scopedB.bestScore).toBe(50_000);
        expect(scopedB.recentScores.map(r => r.game_name).sort()).toEqual(['Table B', 'Table B2']);
    });

    it('getPlayerStats with an EMPTY room list reports nothing', async () => {
        await seedSharedPlayer();
        const stats = await StatsService.getPlayerStats('user-nomad', undefined, []);
        expect(stats.totalGamesPlayed).toBe(0);
        expect(stats.totalWins).toBe(0);
        expect(stats.bestScore).toBe(0);
        expect(stats.recentScores).toEqual([]);
    });

    it('getPlayerStats single-room arg is unchanged by the new parameter', async () => {
        const { a } = await seedSharedPlayer();
        const single = await StatsService.getPlayerStats('user-nomad', a.roomId);
        const asList = await StatsService.getPlayerStats('user-nomad', undefined, [a.roomId]);
        expect(single).toEqual(asList);
    });
});

describe('/view-stats and /my-stats — guild-scoped aggregates', () => {
    const savedEnv = process.env.DISCORD_GUILD_ID;
    beforeEach(async () => {
        await setupTestDb();
        delete process.env.DISCORD_GUILD_ID;
    });
    afterEach(() => {
        if (savedEnv === undefined) delete process.env.DISCORD_GUILD_ID;
        else process.env.DISCORD_GUILD_ID = savedEnv;
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function embedField(replies: unknown[], name: string): string | undefined {
        for (const reply of replies as any[]) {
            const fields = reply?.embeds?.[0]?.data?.fields ?? [];
            const hit = fields.find((f: any) => f.name === name);
            if (hit) return hit.value;
        }
        return undefined;
    }

    it('/view-stats: 1 play in RTX, 3 in The Fridge — the RTX guild sees 1', async () => {
        const rtx = await seedRoom({
            slug: 'rtx-pinball', guildId: GUILD_A, tournamentName: 'WG-VPXS',
            gameName: 'WHO dunnit', status: 'COMPLETED',
        });
        await createTestSubmission(rtx.gameId, { username: 'rtx-player', discordUserId: 'user-rtx', score: 1000 });

        const fridge = await seedRoom({
            slug: 'the-fridge', guildId: GUILD_B, tournamentName: 'Freeze Play',
            gameName: 'WHO dunnit', status: 'COMPLETED',
        });
        await createTestSubmission(fridge.gameId, { username: 'fridge-player', discordUserId: 'user-fridge', score: 7_000_000 });
        for (const label of ['x2', 'x3']) {
            const extra = await createTestGame(fridge.tournamentId, {
                name: 'WHO dunnit', status: 'COMPLETED', endDate: new Date().toISOString(),
            });
            await createTestSubmission(extra, { username: `fridge-${label}`, discordUserId: `user-${label}`, score: 6_000_000 });
        }

        const { interaction, replies } = makeInteraction(GUILD_A, {
            options: { getString: () => 'WHO dunnit', getUser: () => null, getInteger: () => null, getFocused: () => '' },
        });
        await viewstats.execute(interaction);

        expect(embedField(replies, 'Times Played')).toBe('1');
        expect(embedField(replies, 'Unique Players')).toBe('1');
        expect(embedField(replies, 'All-Time High')).toBe((1000).toLocaleString());
        expect(replyText(replies)).not.toContain('fridge-player');
        expect(replyText(replies)).not.toContain('7,000,000');
    });

    it('/view-stats in the other guild sees only its own three instances', async () => {
        const rtx = await seedRoom({
            slug: 'rtx-pinball', guildId: GUILD_A, tournamentName: 'WG-VPXS',
            gameName: 'WHO dunnit', status: 'COMPLETED',
        });
        await createTestSubmission(rtx.gameId, { username: 'rtx-player', discordUserId: 'user-rtx', score: 1000 });

        const fridge = await seedRoom({
            slug: 'the-fridge', guildId: GUILD_B, tournamentName: 'Freeze Play',
            gameName: 'WHO dunnit', status: 'COMPLETED',
        });
        await createTestSubmission(fridge.gameId, { username: 'fridge-player', discordUserId: 'user-fridge', score: 7_000_000 });
        for (const label of ['x2', 'x3']) {
            const extra = await createTestGame(fridge.tournamentId, {
                name: 'WHO dunnit', status: 'COMPLETED', endDate: new Date().toISOString(),
            });
            await createTestSubmission(extra, { username: `fridge-${label}`, discordUserId: `user-${label}`, score: 6_000_000 });
        }

        const { interaction, replies } = makeInteraction(GUILD_B, {
            options: { getString: () => 'WHO dunnit', getUser: () => null, getInteger: () => null, getFocused: () => '' },
        });
        await viewstats.execute(interaction);

        expect(embedField(replies, 'Times Played')).toBe('3');
        expect(embedField(replies, 'Unique Players')).toBe('3');
    });

    it('/my-stats only counts the invoking guild rooms', async () => {
        const a = await seedRoom({
            slug: 'mystats-a', guildId: GUILD_A, tournamentName: 'Cup A',
            gameName: 'Table A', status: 'COMPLETED',
        });
        await createTestSubmission(a.gameId, { username: 'nomad', discordUserId: 'user-nomad', score: 1000 });

        const b = await seedRoom({
            slug: 'mystats-b', guildId: GUILD_B, tournamentName: 'Cup B',
            gameName: 'Table B', status: 'COMPLETED',
        });
        await createTestSubmission(b.gameId, { username: 'nomad', discordUserId: 'user-nomad', score: 900_000 });

        const { interaction, replies } = makeInteraction(GUILD_A, {
            user: {
                id: 'user-nomad', tag: 'nomad#0', displayName: 'Nomad',
                displayAvatarURL: () => 'https://example.invalid/a.png',
                toString: () => '<@user-nomad>',
            },
        });
        await mystats.execute(interaction);

        expect(embedField(replies, 'Games Played')).toBe('1');
        expect(embedField(replies, 'Best Game')).toBe('Table A');
        expect(replyText(replies)).not.toContain('Table B');
        expect(replyText(replies)).not.toContain('900,000');
    });

    it('/my-stats in an unlinked guild replies not-linked and shows no data', async () => {
        const a = await seedRoom({
            slug: 'mystats-only', guildId: GUILD_A, tournamentName: 'Cup A',
            gameName: 'Table A', status: 'COMPLETED',
        });
        await createTestSubmission(a.gameId, { username: 'nomad', discordUserId: 'user-nomad-2', score: 1000 });

        const { interaction, replies } = makeInteraction(GUILD_UNLINKED, {
            user: {
                id: 'user-nomad-2', tag: 'nomad2#0', displayName: 'Nomad2',
                displayAvatarURL: () => 'https://example.invalid/a.png',
                toString: () => '<@user-nomad-2>',
            },
        });
        await mystats.execute(interaction);

        const text = replyText(replies);
        expect(text).toContain(NOT_LINKED_FRAGMENT);
        expect(text).toContain('ephemeral');
        expect(text).not.toContain('Table A');
    });

    it('/my-stats in a DM replies not-linked (owner ruling: every command is per-server)', async () => {
        const a = await seedRoom({
            slug: 'mystats-dm', guildId: GUILD_A, tournamentName: 'Cup A',
            gameName: 'Table A', status: 'COMPLETED',
        });
        await createTestSubmission(a.gameId, { username: 'nomad', discordUserId: 'user-nomad-3', score: 1000 });

        const { interaction, replies } = makeInteraction(null, {
            user: {
                id: 'user-nomad-3', tag: 'nomad3#0', displayName: 'Nomad3',
                displayAvatarURL: () => 'https://example.invalid/a.png',
                toString: () => '<@user-nomad-3>',
            },
        });
        await mystats.execute(interaction);

        expect(replyText(replies)).toContain(NOT_LINKED_FRAGMENT);
        expect(replyText(replies)).not.toContain('Table A');
    });
});

describe('/nominate-picker designate — portable UPDATE', () => {
    const savedEnv = process.env.DISCORD_GUILD_ID;
    beforeEach(async () => {
        await setupTestDb();
        delete process.env.DISCORD_GUILD_ID;
    });
    afterEach(() => {
        if (savedEnv === undefined) delete process.env.DISCORD_GUILD_ID;
        else process.env.DISCORD_GUILD_ID = savedEnv;
    });

    it('designate assigns picker rights to the QUEUED slot (was SQLITE_ERROR: near "LIMIT")', async () => {
        const own = await seedRoom({
            slug: 'nom-designate', guildId: GUILD_A, tournamentName: 'Own Cup', gameName: 'OG',
        });
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET winner_picks = 1 WHERE id = ?', own.tournamentId);
        await db.run(
            "INSERT INTO games (id, tournament_id, name, status) VALUES ('nom-queued-1', ?, '[Pending Pick]', 'QUEUED')",
            own.tournamentId,
        );

        const { interaction, replies } = makeInteraction(GUILD_A, {
            id: 'interaction-designate-1',
            options: {
                getSubcommand: () => 'designate',
                getString: () => own.tournamentId,
                getUser: () => ({ id: 'nominee-9', toString: () => '<@nominee-9>' }),
            },
            user: { id: 'admin-9', tag: 'admin9#0', displayName: 'Admin', toString: () => '<@admin-9>' },
        });
        await nominatepicker.execute(interaction);

        const text = replyText(replies);
        expect(text).toContain('successfully nominated');
        expect(text).not.toContain('An error occurred');

        const row = await db.get("SELECT picker_discord_id, picker_type FROM games WHERE id = 'nom-queued-1'");
        expect(row.picker_discord_id).toBe('nominee-9');
        expect(row.picker_type).toBe('WINNER');
    });

    it('designate touches exactly one QUEUED row when several exist', async () => {
        const own = await seedRoom({
            slug: 'nom-designate-multi', guildId: GUILD_A, tournamentName: 'Own Cup', gameName: 'OG',
        });
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET winner_picks = 1 WHERE id = ?', own.tournamentId);
        for (const id of ['nom-q-1', 'nom-q-2', 'nom-q-3']) {
            await db.run(
                "INSERT INTO games (id, tournament_id, name, status) VALUES (?, ?, '[Pending Pick]', 'QUEUED')",
                id, own.tournamentId,
            );
        }

        const { interaction } = makeInteraction(GUILD_A, {
            id: 'interaction-designate-2',
            options: {
                getSubcommand: () => 'designate',
                getString: () => own.tournamentId,
                getUser: () => ({ id: 'nominee-10', toString: () => '<@nominee-10>' }),
            },
            user: { id: 'admin-10', tag: 'admin10#0', displayName: 'Admin', toString: () => '<@admin-10>' },
        });
        await nominatepicker.execute(interaction);

        const assigned = await db.all(
            "SELECT id FROM games WHERE tournament_id = ? AND picker_discord_id = 'nominee-10'",
            own.tournamentId,
        );
        expect(assigned.length).toBe(1);
        expect(assigned[0].id).toBe('nom-q-1');
    });
});
