import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame, createTestSubmission } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import {
    resolveGuildReadScope,
    buildGuildScopedRoomSqlFilter,
    DISCORD_GUILD_NOT_LINKED_MESSAGE,
    isRoomInGuildScope,
    DISCORD_FOREIGN_TOURNAMENT_MESSAGE,
} from '../utils/discordRoomFilter.js';
import { listactive } from '../discord/commands/listactive.js';
import { listwinners } from '../discord/commands/listwinners.js';
import { viewqueue } from '../discord/commands/viewqueue.js';
import { listscores } from '../discord/commands/listscores.js';
import { viewstats } from '../discord/commands/viewstats.js';
import { runcleanup } from '../discord/commands/runcleanup.js';
import { nominatepicker } from '../discord/commands/nominatepicker.js';
import { pausepick } from '../discord/commands/pausepick.js';
import { TournamentEngine } from '../engine/TournamentEngine.js';

// v2.120.1 — Discord read commands are guild-scoped.
//
// Owner-reported bug: `/list-active` run in the RTX Pinball guild listed
// "Freeze Play: Medieval Madness", a tournament owned by a DIFFERENT room
// ("The Fridge") that has DISCORD_ENABLED=true and NO DISCORD_GUILD_ID.
// `discordRoomFilter` only ever SUBTRACTED rooms (Discord-off / approval /
// suspended); it never scoped results to the invoking guild, so every read
// command showed every room in the deployment.

const GUILD_A = '1000000000000000001';
const GUILD_B = '1000000000000000002';
const GUILD_UNLINKED = '1000000000000000003';
const GUILD_ENV = '1000000000000000004';
const NOT_LINKED_FRAGMENT = 'linked to an Arcaid game room';

function makeInteraction(guildId: string | null, overrides: Record<string, unknown> = {}) {
    const replies: unknown[] = [];
    const interaction = {
        user: { id: 'scope-user-1', tag: 'scope-user-1#0000', displayName: 'Scope User' },
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

function replyText(replies: unknown[]): string {
    return JSON.stringify(replies);
}

/** Seeds a room + tournament + one game (and a score) in one call. */
async function seedRoom(opts: {
    slug: string;
    guildId?: string | null;
    joinPolicy?: string;
    discordEnabled?: string;
    tournamentName: string;
    gameName: string;
    status?: string;
}) {
    const roomId = await createTestRoom(opts.slug, opts.slug);
    if (opts.guildId) await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', opts.guildId);
    if (opts.joinPolicy) await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', opts.joinPolicy);
    if (opts.discordEnabled) await GameRoomSettingsService.set(roomId, 'DISCORD_ENABLED', opts.discordEnabled);
    const tournamentId = await createTestTournament(roomId, { name: opts.tournamentName });
    const gameId = await createTestGame(tournamentId, {
        name: opts.gameName,
        status: opts.status ?? 'ACTIVE',
        endDate: new Date().toISOString(),
    });
    await createTestSubmission(gameId, { username: `${opts.slug}-player`, score: 4242 });
    return { roomId, tournamentId, gameId };
}

describe('resolveGuildReadScope — linkage resolution', () => {
    const savedEnv = process.env.DISCORD_GUILD_ID;
    beforeEach(async () => {
        await setupTestDb();
        delete process.env.DISCORD_GUILD_ID;
    });
    afterEach(() => {
        if (savedEnv === undefined) delete process.env.DISCORD_GUILD_ID;
        else process.env.DISCORD_GUILD_ID = savedEnv;
    });

    it('returns only the rooms linked to the invoking guild', async () => {
        const a = await seedRoom({ slug: 'scope-a', guildId: GUILD_A, tournamentName: 'T-A', gameName: 'Game A' });
        const b = await seedRoom({ slug: 'scope-b', guildId: GUILD_B, tournamentName: 'T-B', gameName: 'Game B' });

        const scopeA = await resolveGuildReadScope(GUILD_A);
        expect(scopeA).not.toBeNull();
        expect(scopeA!.roomIds).toEqual([a.roomId]);
        expect(scopeA!.legacyEnv).toBe(false);

        const scopeB = await resolveGuildReadScope(GUILD_B);
        expect(scopeB!.roomIds).toEqual([b.roomId]);
    });

    it('THE BUG: a Discord-enabled room with NO guild id is in no linked guild scope', async () => {
        const a = await seedRoom({ slug: 'rtx', guildId: GUILD_A, tournamentName: 'WG-VPXS', gameName: 'WHO dunnit' });
        const fridge = await seedRoom({
            slug: 'the-fridge', discordEnabled: 'true',
            tournamentName: 'Freeze Play', gameName: 'Medieval Madness',
        });

        const scope = await resolveGuildReadScope(GUILD_A);
        expect(scope!.roomIds).toContain(a.roomId);
        expect(scope!.roomIds).not.toContain(fridge.roomId);
    });

    it('returns null for a guild linked to nothing', async () => {
        await seedRoom({ slug: 'scope-only', guildId: GUILD_A, tournamentName: 'T', gameName: 'G' });
        expect(await resolveGuildReadScope(GUILD_UNLINKED)).toBeNull();
    });

    it('returns null for a DM interaction (no guild id)', async () => {
        await seedRoom({ slug: 'scope-dm', guildId: GUILD_A, tournamentName: 'T', gameName: 'G' });
        expect(await resolveGuildReadScope(null)).toBeNull();
        expect(await resolveGuildReadScope(undefined)).toBeNull();
    });

    it('env fallback: settingless rooms are the scope when no room is explicitly linked', async () => {
        process.env.DISCORD_GUILD_ID = GUILD_ENV;
        const legacy = await seedRoom({ slug: 'legacy-room', tournamentName: 'T-L', gameName: 'Legacy Game' });

        const scope = await resolveGuildReadScope(GUILD_ENV);
        expect(scope).not.toBeNull();
        expect(scope!.legacyEnv).toBe(true);
        expect(scope!.roomIds).toEqual([legacy.roomId]);
    });

    it('env fallback does not apply to a guild that is not the env guild', async () => {
        process.env.DISCORD_GUILD_ID = GUILD_ENV;
        await seedRoom({ slug: 'legacy-room-2', tournamentName: 'T-L', gameName: 'Legacy Game' });
        expect(await resolveGuildReadScope(GUILD_UNLINKED)).toBeNull();
    });

    it('an explicit link wins over the env fallback (no settingless rooms leak in)', async () => {
        process.env.DISCORD_GUILD_ID = GUILD_A;
        const linked = await seedRoom({ slug: 'linked-room', guildId: GUILD_A, tournamentName: 'T', gameName: 'G' });
        const settingless = await seedRoom({ slug: 'settingless-room', tournamentName: 'T2', gameName: 'G2' });

        const scope = await resolveGuildReadScope(GUILD_A);
        expect(scope!.legacyEnv).toBe(false);
        expect(scope!.roomIds).toEqual([linked.roomId]);
        expect(scope!.roomIds).not.toContain(settingless.roomId);
    });

    it('exclusions still apply inside a linked scope (approval room on the same guild is hidden)', async () => {
        const open = await seedRoom({ slug: 'scope-open', guildId: GUILD_A, tournamentName: 'T-Open', gameName: 'Open Game' });
        const approval = await seedRoom({
            slug: 'scope-approval', guildId: GUILD_A, joinPolicy: 'approval',
            tournamentName: 'T-Approval', gameName: 'Approval Game',
        });

        const scope = await resolveGuildReadScope(GUILD_A);
        expect(scope!.roomIds).toEqual([open.roomId]);
        expect(scope!.roomIds).not.toContain(approval.roomId);
    });

    it('exclusions apply to the env-fallback scope too (Discord-off settingless room is hidden)', async () => {
        process.env.DISCORD_GUILD_ID = GUILD_ENV;
        const off = await seedRoom({ slug: 'legacy-off', discordEnabled: 'false', tournamentName: 'T', gameName: 'G' });
        const scope = await resolveGuildReadScope(GUILD_ENV);
        expect(scope!.legacyEnv).toBe(true);
        expect(scope!.roomIds).not.toContain(off.roomId);
    });

    it('a linked-but-fully-excluded guild yields an EMPTY scope, not null', async () => {
        await seedRoom({
            slug: 'scope-all-excluded', guildId: GUILD_A, joinPolicy: 'approval',
            tournamentName: 'T', gameName: 'G',
        });
        const scope = await resolveGuildReadScope(GUILD_A);
        expect(scope).not.toBeNull();
        expect(scope!.roomIds).toEqual([]);
    });
});

describe('buildGuildScopedRoomSqlFilter — SQL shape', () => {
    it('emits a positive IN list for a normal scope and does NOT admit NULL rooms', () => {
        const { sql, params } = buildGuildScopedRoomSqlFilter('t.game_room_id', { roomIds: ['r1', 'r2'], legacyEnv: false });
        expect(sql).toBe('AND t.game_room_id IN (?, ?)');
        expect(sql).not.toContain('IS NULL');
        expect(params).toEqual(['r1', 'r2']);
    });

    it('emits a match-nothing fragment for an empty non-legacy scope', () => {
        const { sql, params } = buildGuildScopedRoomSqlFilter('t.game_room_id', { roomIds: [], legacyEnv: false });
        expect(sql).toBe('AND 1 = 0');
        expect(params).toEqual([]);
    });

    it('admits NULL-room rows only in the legacy env scope', () => {
        const legacy = buildGuildScopedRoomSqlFilter('t.game_room_id', { roomIds: ['r1'], legacyEnv: true });
        expect(legacy.sql).toBe('AND (t.game_room_id IS NULL OR t.game_room_id IN (?))');
        expect(legacy.params).toEqual(['r1']);

        const legacyEmpty = buildGuildScopedRoomSqlFilter('t.game_room_id', { roomIds: [], legacyEnv: true });
        expect(legacyEmpty.sql).toBe('AND t.game_room_id IS NULL');
        expect(legacyEmpty.params).toEqual([]);
    });
});

describe('read commands — end-to-end guild scoping', () => {
    const savedEnv = process.env.DISCORD_GUILD_ID;
    beforeEach(async () => {
        await setupTestDb();
        delete process.env.DISCORD_GUILD_ID;
    });
    afterEach(() => {
        if (savedEnv === undefined) delete process.env.DISCORD_GUILD_ID;
        else process.env.DISCORD_GUILD_ID = savedEnv;
    });

    it('/list-active in guild A shows only guild A rooms (regression: the RTX/Fridge leak)', async () => {
        await seedRoom({ slug: 'rtx-pinball', guildId: GUILD_A, tournamentName: 'WG-VPXS', gameName: 'WHO dunnit' });
        await seedRoom({ slug: 'the-fridge', discordEnabled: 'true', tournamentName: 'Freeze Play', gameName: 'Medieval Madness' });
        await seedRoom({ slug: 'other-guild', guildId: GUILD_B, tournamentName: 'Other Cup', gameName: 'Attack From Mars' });

        const { interaction, replies } = makeInteraction(GUILD_A);
        await listactive.execute(interaction);

        const text = replyText(replies);
        expect(text).toContain('WHO dunnit');
        expect(text).not.toContain('Medieval Madness');
        expect(text).not.toContain('Attack From Mars');
    });

    it('/list-active in guild B shows only guild B rooms', async () => {
        await seedRoom({ slug: 'rtx-pinball', guildId: GUILD_A, tournamentName: 'WG-VPXS', gameName: 'WHO dunnit' });
        await seedRoom({ slug: 'other-guild', guildId: GUILD_B, tournamentName: 'Other Cup', gameName: 'Attack From Mars' });

        const { interaction, replies } = makeInteraction(GUILD_B);
        await listactive.execute(interaction);

        const text = replyText(replies);
        expect(text).toContain('Attack From Mars');
        expect(text).not.toContain('WHO dunnit');
    });

    it('/list-active hides an approval room linked to the same guild', async () => {
        await seedRoom({ slug: 'open-room', guildId: GUILD_A, tournamentName: 'T-Open', gameName: 'Open Game' });
        await seedRoom({
            slug: 'approval-room', guildId: GUILD_A, joinPolicy: 'approval',
            tournamentName: 'T-Approval', gameName: 'Approval Game',
        });

        const { interaction, replies } = makeInteraction(GUILD_A);
        await listactive.execute(interaction);

        const text = replyText(replies);
        expect(text).toContain('Open Game');
        expect(text).not.toContain('Approval Game');
    });

    it('/list-active in the env-fallback guild sees settingless rooms', async () => {
        process.env.DISCORD_GUILD_ID = GUILD_ENV;
        await seedRoom({ slug: 'legacy-room', tournamentName: 'Legacy Cup', gameName: 'Legacy Game' });

        const { interaction, replies } = makeInteraction(GUILD_ENV);
        await listactive.execute(interaction);
        expect(replyText(replies)).toContain('Legacy Game');
    });

    it('/list-active in an unlinked guild replies not-linked and shows no data', async () => {
        await seedRoom({ slug: 'rtx-pinball', guildId: GUILD_A, tournamentName: 'WG-VPXS', gameName: 'WHO dunnit' });

        const { interaction, replies } = makeInteraction(GUILD_UNLINKED);
        await listactive.execute(interaction);

        const text = replyText(replies);
        expect(text).toContain(NOT_LINKED_FRAGMENT);
        expect(text).toContain('ephemeral');
        expect(text).not.toContain('WHO dunnit');
    });

    it('/list-active in a DM replies not-linked and shows no data', async () => {
        await seedRoom({ slug: 'rtx-pinball', guildId: GUILD_A, tournamentName: 'WG-VPXS', gameName: 'WHO dunnit' });

        const { interaction, replies } = makeInteraction(null);
        await listactive.execute(interaction);

        const text = replyText(replies);
        expect(text).toContain(DISCORD_GUILD_NOT_LINKED_MESSAGE);
        expect(text).not.toContain('WHO dunnit');
    });

    it('/list-winners scopes completed games to the invoking guild', async () => {
        await seedRoom({
            slug: 'winners-a', guildId: GUILD_A, tournamentName: 'Cup A',
            gameName: 'Winner Game A', status: 'COMPLETED',
        });
        await seedRoom({
            slug: 'winners-b', guildId: GUILD_B, tournamentName: 'Cup B',
            gameName: 'Winner Game B', status: 'COMPLETED',
        });

        const { interaction, replies } = makeInteraction(GUILD_A);
        await listwinners.execute(interaction);

        const text = replyText(replies);
        expect(text).toContain('Winner Game A');
        expect(text).not.toContain('Winner Game B');
    });

    // v2.121.0 — `/view-selection` became `/view-queue`: it shows only the
    // INVOKER's queue, so the seeded rows have to carry their picker id.
    it("/view-queue scopes the invoker's queued games to the invoking guild", async () => {
        const a = await seedRoom({
            slug: 'queue-a', guildId: GUILD_A, tournamentName: 'Queue Cup A',
            gameName: 'Queued Game A', status: 'QUEUED',
        });
        const b = await seedRoom({
            slug: 'queue-b', guildId: GUILD_B, tournamentName: 'Queue Cup B',
            gameName: 'Queued Game B', status: 'QUEUED',
        });
        const db = await getDatabase();
        await db.run("UPDATE games SET picker_discord_id = 'scope-user-1' WHERE id IN (?, ?)", a.gameId, b.gameId);

        const { interaction, replies } = makeInteraction(GUILD_A);
        await viewqueue.execute(interaction);

        const text = replyText(replies);
        expect(text).toContain('Queued Game A');
        expect(text).not.toContain('Queued Game B');
    });

    it('/list-scores scopes its embeds to the invoking guild', async () => {
        await seedRoom({ slug: 'scores-a', guildId: GUILD_A, tournamentName: 'Score Cup A', gameName: 'Score Game A' });
        await seedRoom({ slug: 'scores-b', guildId: GUILD_B, tournamentName: 'Score Cup B', gameName: 'Score Game B' });

        const { interaction, replies } = makeInteraction(GUILD_A);
        await listscores.execute(interaction);

        const text = replyText(replies);
        expect(text).toContain('Score Game A');
        expect(text).not.toContain('Score Game B');
    });

    it('/list-scores in an unlinked guild replies not-linked', async () => {
        await seedRoom({ slug: 'scores-only', guildId: GUILD_A, tournamentName: 'Score Cup', gameName: 'Score Game' });

        const { interaction, replies } = makeInteraction(GUILD_UNLINKED, {
            user: { id: 'scope-user-2', tag: 'u#0', displayName: 'U' },
        });
        await listscores.execute(interaction);

        const text = replyText(replies);
        expect(text).toContain(NOT_LINKED_FRAGMENT);
        expect(text).not.toContain('Score Game');
    });

    it('/view-stats only counts instances from the invoking guild', async () => {
        // Same game name played in two rooms on two guilds: guild A must see
        // one COMPLETED instance, not both.
        await seedRoom({
            slug: 'stats-a', guildId: GUILD_A, tournamentName: 'Stats Cup A',
            gameName: 'Shared Table', status: 'COMPLETED',
        });
        await seedRoom({
            slug: 'stats-b', guildId: GUILD_B, tournamentName: 'Stats Cup B',
            gameName: 'Shared Table', status: 'COMPLETED',
        });

        const db = await getDatabase();
        const rows = await db.all(`SELECT id FROM games WHERE name = 'Shared Table'`);
        expect(rows.length).toBe(2);

        const { interaction, replies } = makeInteraction(GUILD_A, {
            options: { getString: () => 'Shared Table', getUser: () => null, getInteger: () => null, getFocused: () => '' },
        });
        await viewstats.execute(interaction);

        const text = replyText(replies);
        expect(text).toContain('Completed Rounds');
        expect(text).toContain('1 of 1');
        expect(text).not.toContain('2 of 2');
    });

    it('/view-stats in an unlinked guild replies not-linked', async () => {
        await seedRoom({
            slug: 'stats-only', guildId: GUILD_A, tournamentName: 'Stats Cup',
            gameName: 'Solo Table', status: 'COMPLETED',
        });

        const { interaction, replies } = makeInteraction(GUILD_UNLINKED, {
            options: { getString: () => 'Solo Table', getUser: () => null, getInteger: () => null, getFocused: () => '' },
        });
        await viewstats.execute(interaction);

        expect(replyText(replies)).toContain(NOT_LINKED_FRAGMENT);
    });
});

describe('isRoomInGuildScope — point membership guard', () => {
    it('is false for a null scope (unlinked guild / DM)', () => {
        expect(isRoomInGuildScope('r1', null)).toBe(false);
    });

    it('is true only for rooms inside the scope', () => {
        const scope = { roomIds: ['r1'], legacyEnv: false };
        expect(isRoomInGuildScope('r1', scope)).toBe(true);
        expect(isRoomInGuildScope('r2', scope)).toBe(false);
    });

    it('admits an unattributed (null-room) tournament only under the legacy env scope', () => {
        expect(isRoomInGuildScope(null, { roomIds: ['r1'], legacyEnv: false })).toBe(false);
        expect(isRoomInGuildScope(null, { roomIds: [], legacyEnv: true })).toBe(true);
    });
});

describe('admin commands — guild gate (cross-room WRITE closures)', () => {
    const savedEnv = process.env.DISCORD_GUILD_ID;
    beforeEach(async () => {
        await setupTestDb();
        delete process.env.DISCORD_GUILD_ID;
        vi.restoreAllMocks();
    });
    afterEach(() => {
        vi.restoreAllMocks();
        if (savedEnv === undefined) delete process.env.DISCORD_GUILD_ID;
        else process.env.DISCORD_GUILD_ID = savedEnv;
    });

    it('/run-cleanup only cleans tournaments in the invoking guild rooms', async () => {
        const a = await seedRoom({ slug: 'cleanup-a', guildId: GUILD_A, tournamentName: 'Cup A', gameName: 'Game A' });
        const b = await seedRoom({ slug: 'cleanup-b', guildId: GUILD_B, tournamentName: 'Cup B', gameName: 'Game B' });

        const engine = TournamentEngine.getInstance();
        const spy = vi.spyOn(engine, 'runCleanup').mockResolvedValue(undefined as never);

        const { interaction, replies } = makeInteraction(GUILD_A);
        await runcleanup.execute(interaction);

        const calledIds = spy.mock.calls.map(c => c[0]);
        expect(calledIds).toEqual([a.tournamentId]);
        expect(calledIds).not.toContain(b.tournamentId);
        expect(replyText(replies)).toContain('Cup A');
        expect(replyText(replies)).not.toContain('Cup B');
    });

    it('/run-cleanup in an unlinked guild replies not-linked and cleans nothing', async () => {
        await seedRoom({ slug: 'cleanup-only', guildId: GUILD_A, tournamentName: 'Cup A', gameName: 'Game A' });

        const engine = TournamentEngine.getInstance();
        const spy = vi.spyOn(engine, 'runCleanup').mockResolvedValue(undefined as never);

        const { interaction, replies } = makeInteraction(GUILD_UNLINKED);
        await runcleanup.execute(interaction);

        expect(spy).not.toHaveBeenCalled();
        expect(replyText(replies)).toContain(NOT_LINKED_FRAGMENT);
    });

    it('/run-cleanup skips a room excluded inside its own guild scope (approval room)', async () => {
        const open = await seedRoom({ slug: 'cleanup-open', guildId: GUILD_A, tournamentName: 'Cup Open', gameName: 'G1' });
        const approval = await seedRoom({
            slug: 'cleanup-approval', guildId: GUILD_A, joinPolicy: 'approval',
            tournamentName: 'Cup Approval', gameName: 'G2',
        });

        const engine = TournamentEngine.getInstance();
        const spy = vi.spyOn(engine, 'runCleanup').mockResolvedValue(undefined as never);

        const { interaction } = makeInteraction(GUILD_A);
        await runcleanup.execute(interaction);

        const calledIds = spy.mock.calls.map(c => c[0]);
        expect(calledIds).toEqual([open.tournamentId]);
        expect(calledIds).not.toContain(approval.tournamentId);
    });

    it('/nominate-picker rejects a tournament belonging to another guild room', async () => {
        const foreign = await seedRoom({ slug: 'nom-foreign', guildId: GUILD_B, tournamentName: 'Foreign Cup', gameName: 'FG' });
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET winner_picks = 1 WHERE id = ?', foreign.tournamentId);
        await db.run(
            "INSERT INTO games (id, tournament_id, name, status) VALUES ('nom-foreign-queued', ?, 'Queued FG', 'QUEUED')",
            foreign.tournamentId,
        );

        const { interaction, replies } = makeInteraction(GUILD_A, {
            id: 'interaction-nom-1',
            options: {
                getSubcommand: () => 'designate',
                getString: () => foreign.tournamentId,
                getUser: () => ({ id: 'nominee-1', toString: () => '<@nominee-1>' }),
            },
        });
        await nominatepicker.execute(interaction);

        expect(replyText(replies)).toContain(DISCORD_FOREIGN_TOURNAMENT_MESSAGE);
        const row = await db.get("SELECT picker_discord_id FROM games WHERE id = 'nom-foreign-queued'");
        expect(row.picker_discord_id).toBeNull();
    });

    // Uses the `clear` subcommand rather than `designate` on purpose: the
    // `designate` branch's `UPDATE games ... LIMIT 1` is a PRE-EXISTING SQL
    // error in stock SQLite (SQLITE_ENABLE_UPDATE_DELETE_LIMIT is not
    // compiled in), so that branch always throws its generic error reply —
    // unrelated to guild scoping, reported separately.
    it('/nominate-picker allows a tournament in the invoking guild room', async () => {
        const own = await seedRoom({ slug: 'nom-own', guildId: GUILD_A, tournamentName: 'Own Cup', gameName: 'OG' });
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET winner_picks = 1 WHERE id = ?', own.tournamentId);

        const { interaction, replies } = makeInteraction(GUILD_A, {
            id: 'interaction-nom-2',
            options: {
                getSubcommand: () => 'clear',
                getString: () => own.tournamentId,
                getUser: () => ({ id: 'player-2', toString: () => '<@player-2>' }),
            },
            user: { id: 'admin-1', tag: 'admin#0', toString: () => '<@admin-1>' },
        });
        await nominatepicker.execute(interaction);

        const text = replyText(replies);
        expect(text).not.toContain(DISCORD_FOREIGN_TOURNAMENT_MESSAGE);
        expect(text).toContain('Cleared');
    });

    // --- /nominate-picker queue (v2.121.0, admin queue-on-behalf) ---

    /** An approved catalogue row so the shared pick pipeline can resolve a name. */
    async function seedCatalogueGame(name: string) {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_games (id, name, type, platforms, features, status)
             VALUES (?, ?, 'pinball', '["vpx"]', '[]', 'approved')`,
            `gg-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name,
        );
    }

    it('/nominate-picker queue puts the game in the TARGET player’s queue', async () => {
        const own = await seedRoom({ slug: 'nom-queue-own', guildId: GUILD_A, tournamentName: 'Queue Cup', gameName: 'OG' });
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET winner_picks = 1 WHERE id = ?', own.tournamentId);
        await seedCatalogueGame('Medieval Madness');

        const { interaction, replies } = makeInteraction(GUILD_A, {
            id: 'interaction-nom-queue-1',
            options: {
                getSubcommand: () => 'queue',
                getString: (name: string) => (name === 'tournament-id' ? own.tournamentId : 'Medieval Madness'),
                getUser: () => ({ id: 'target-player-1', toString: () => '<@target-player-1>' }),
            },
            user: { id: 'admin-q1', tag: 'admin#0', toString: () => '<@admin-q1>' },
        });
        await nominatepicker.execute(interaction);

        expect(replyText(replies)).toContain('Medieval Madness');
        const row = await db.get(
            `SELECT picker_discord_id, status FROM games WHERE tournament_id = ? AND name = 'Medieval Madness'`,
            own.tournamentId,
        );
        expect(row.picker_discord_id).toBe('target-player-1');
        expect(row.status).toBe('QUEUED');
    });

    it('/nominate-picker queue refuses a tournament belonging to another guild room', async () => {
        const foreign = await seedRoom({ slug: 'nom-queue-foreign', guildId: GUILD_B, tournamentName: 'Foreign Queue Cup', gameName: 'FG' });
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET winner_picks = 1 WHERE id = ?', foreign.tournamentId);
        await seedCatalogueGame('Attack From Mars');

        const { interaction, replies } = makeInteraction(GUILD_A, {
            id: 'interaction-nom-queue-2',
            options: {
                getSubcommand: () => 'queue',
                getString: (name: string) => (name === 'tournament-id' ? foreign.tournamentId : 'Attack From Mars'),
                getUser: () => ({ id: 'target-player-2', toString: () => '<@target-player-2>' }),
            },
            user: { id: 'admin-q2', tag: 'admin#0', toString: () => '<@admin-q2>' },
        });
        await nominatepicker.execute(interaction);

        expect(replyText(replies)).toContain(DISCORD_FOREIGN_TOURNAMENT_MESSAGE);
        expect(await db.get(`SELECT id FROM games WHERE name = 'Attack From Mars'`)).toBeUndefined();
    });

    it('/nominate-picker queue game autocomplete is guild scoped', async () => {
        const own = await seedRoom({ slug: 'nom-ac-own', guildId: GUILD_A, tournamentName: 'AC Own Cup', gameName: 'OG' });
        const foreign = await seedRoom({ slug: 'nom-ac-foreign', guildId: GUILD_B, tournamentName: 'AC Foreign Cup', gameName: 'FG' });
        await seedCatalogueGame('Autocomplete Table');

        const focus = { name: 'game', value: 'Auto' };

        const inScope = makeInteraction(GUILD_A, {
            options: {
                getFocused: () => focus,
                getString: () => own.tournamentId,
                getUser: () => null,
            },
        });
        await nominatepicker.autocomplete!(inScope.interaction);
        expect(replyText(inScope.replies)).toContain('Autocomplete Table');

        const outOfScope = makeInteraction(GUILD_A, {
            options: {
                getFocused: () => focus,
                getString: () => foreign.tournamentId,
                getUser: () => null,
            },
        });
        await nominatepicker.autocomplete!(outOfScope.interaction);
        expect(outOfScope.replies).toEqual([[]]);
    });

    it('/pause-pick rejects a tournament belonging to another guild room and injects nothing', async () => {
        const foreign = await seedRoom({ slug: 'pause-foreign', guildId: GUILD_B, tournamentName: 'Foreign Cup', gameName: 'FG' });
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET winner_picks = 1 WHERE id = ?', foreign.tournamentId);

        const { interaction, replies } = makeInteraction(GUILD_A, {
            options: {
                getString: (name: string) => (name === 'tournament-id' ? foreign.tournamentId : 'Injected Table'),
                getUser: () => null,
            },
        });
        await pausepick.execute(interaction);

        expect(replyText(replies)).toContain(DISCORD_FOREIGN_TOURNAMENT_MESSAGE);
        const injected = await db.get("SELECT id FROM games WHERE name = 'Injected Table'");
        expect(injected).toBeUndefined();
    });

    it('/pause-pick allows a tournament in the invoking guild room', async () => {
        const own = await seedRoom({ slug: 'pause-own', guildId: GUILD_A, tournamentName: 'Own Cup', gameName: 'OG' });
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET winner_picks = 1 WHERE id = ?', own.tournamentId);

        const { interaction, replies } = makeInteraction(GUILD_A, {
            options: {
                getString: (name: string) => (name === 'tournament-id' ? own.tournamentId : 'Injected Table'),
                getUser: () => null,
            },
        });
        await pausepick.execute(interaction);

        expect(replyText(replies)).not.toContain(DISCORD_FOREIGN_TOURNAMENT_MESSAGE);
        const injected = await db.get("SELECT id, status FROM games WHERE name = 'Injected Table'");
        expect(injected?.status).toBe('QUEUED');
    });

    it('/pause-pick rejects a DM invocation', async () => {
        const own = await seedRoom({ slug: 'pause-dm', guildId: GUILD_A, tournamentName: 'Own Cup', gameName: 'OG' });
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET winner_picks = 1 WHERE id = ?', own.tournamentId);

        const { interaction, replies } = makeInteraction(null, {
            options: {
                getString: (name: string) => (name === 'tournament-id' ? own.tournamentId : 'DM Table'),
                getUser: () => null,
            },
        });
        await pausepick.execute(interaction);

        expect(replyText(replies)).toContain(DISCORD_FOREIGN_TOURNAMENT_MESSAGE);
        expect(await db.get("SELECT id FROM games WHERE name = 'DM Table'")).toBeUndefined();
    });
});
