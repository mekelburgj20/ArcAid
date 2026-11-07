import { describe, it, expect, beforeEach } from 'vitest';

/**
 * E16 (v2.226.0) - per-tournament, per-kind announcement channels and the
 * fourth kind `scores`.
 *
 * `resolveAnnouncementChannelId(room, catchAll, kind, tournamentRoutes)`:
 *   Discord off -> tournament routes[kind] ('none' -> null) -> catch-all
 *   ('none' -> null) -> room routes[kind] (scores: else room tournament route)
 *   -> room default -> env -> null.
 */

process.env.DISCORD_BOT_TOKEN = 'test-token';

const { setupTestDb, createTestRoom, createTestTournament } = await import('./helpers.js');
const { getDatabase } = await import('../database/database.js');
const {
    parseTournamentAnnounceRoutes, serializeTournamentAnnounceRoutes, parseAnnounceRoutes,
    DISCORD_ANNOUNCE_ROUTES_KEY, ANNOUNCE_KINDS,
} = await import('../utils/discordAnnounceRoutes.js');
const { resolveAnnouncementChannelId, ANNOUNCE_NONE } = await import('../utils/discord.js');
const { CreateTournamentSchema } = await import('../api/schemas.js');
const { TournamentService } = await import('../services/TournamentService.js');

const DEFAULT = '111111111111111111';
const R_TOURN = '222222222222222222';
const R_SCORES = '333333333333333333';
const R_PICKS = '444444444444444444';
const CATCH = '555555555555555555';
const T_TOURN = '666666666666666666';
const T_SCORES = '777777777777777777';

const tr = (routes: Record<string, unknown>) => JSON.stringify({ version: 1, routes });

describe('ANNOUNCE_KINDS', () => {
    it('has the fourth kind, Top-score posts', () => {
        expect(ANNOUNCE_KINDS.map(k => k.kind)).toEqual(['tournament', 'picks', 'polls', 'scores']);
        expect(ANNOUNCE_KINDS.find(k => k.kind === 'scores')).toMatchObject({
            label: 'Top-score posts', description: 'Glory and dethrone posts for top-N scores',
        });
    });

    it("the room parser reads a scores route and never accepts 'none'", () => {
        expect(parseAnnounceRoutes(tr({ scores: R_SCORES, picks: 'none' })))
            .toEqual({ tournament: null, picks: null, polls: null, scores: R_SCORES });
    });
});

describe('parseTournamentAnnounceRoutes / serializeTournamentAnnounceRoutes', () => {
    it("accepts snowflakes and 'none'", () => {
        expect(parseTournamentAnnounceRoutes(tr({ tournament: T_TOURN, picks: 'none', scores: ' none ' })))
            .toEqual({ tournament: T_TOURN, picks: 'none', polls: null, scores: 'none' });
    });

    it('tolerant: garbage is empty, never a throw', () => {
        const empty = { tournament: null, picks: null, polls: null, scores: null };
        for (const raw of [null, undefined, '', '{oops', '[]', '"x"', tr({ picks: 'general' }),
            JSON.stringify({ version: 2, routes: { picks: T_TOURN } }), JSON.stringify({ version: 1, routes: [T_TOURN] })]) {
            expect(parseTournamentAnnounceRoutes(raw as string | null | undefined)).toEqual(empty);
        }
    });

    it('serialize keeps usable entries in kind order and empties to ""', () => {
        expect(serializeTournamentAnnounceRoutes(tr({ scores: 'none', extra: T_TOURN, tournament: T_TOURN, polls: 'nope' })))
            .toBe(tr({ tournament: T_TOURN, scores: 'none' }));
        expect(serializeTournamentAnnounceRoutes('garbage')).toBe('');
        expect(serializeTournamentAnnounceRoutes(tr({}))).toBe('');
    });
});

describe('resolveAnnouncementChannelId precedence with tournament routes', () => {
    let roomId: string;

    async function setSetting(key: string, value: string) {
        const db = await getDatabase();
        await db.run(
            `INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)`,
            roomId, key, value,
        );
    }

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
        delete process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID;
        await setSetting('DISCORD_ANNOUNCEMENT_CHANNEL_ID', DEFAULT);
        await setSetting(DISCORD_ANNOUNCE_ROUTES_KEY, tr({ tournament: R_TOURN, picks: R_PICKS }));
    });

    it('room Discord off -> null even with a per-kind snowflake', async () => {
        await setSetting('DISCORD_ENABLED', 'false');
        expect(await resolveAnnouncementChannelId(roomId, null, 'tournament', tr({ tournament: T_TOURN }))).toBeNull();
    });

    it('no 4th arg / null / garbage behaves exactly like the 3-arg form', async () => {
        for (const routes of [undefined, null, '', '{oops', tr({ picks: 'general' })]) {
            expect(await resolveAnnouncementChannelId(roomId, null, 'picks', routes)).toBe(R_PICKS);
            expect(await resolveAnnouncementChannelId(roomId, CATCH, 'picks', routes)).toBe(CATCH);
            expect(await resolveAnnouncementChannelId(roomId, ANNOUNCE_NONE, 'picks', routes)).toBeNull();
            expect(await resolveAnnouncementChannelId(roomId, null, 'polls', routes)).toBe(DEFAULT);
        }
    });

    it('a per-kind snowflake beats the catch-all and the room route', async () => {
        const routes = tr({ tournament: T_TOURN });
        expect(await resolveAnnouncementChannelId(roomId, CATCH, 'tournament', routes)).toBe(T_TOURN);
        expect(await resolveAnnouncementChannelId(roomId, null, 'tournament', routes)).toBe(T_TOURN);
        // Other kinds fall through to the catch-all / room routes.
        expect(await resolveAnnouncementChannelId(roomId, CATCH, 'picks', routes)).toBe(CATCH);
        expect(await resolveAnnouncementChannelId(roomId, null, 'picks', routes)).toBe(R_PICKS);
    });

    it("a per-kind 'none' beats a room route and a catch-all channel", async () => {
        const routes = tr({ picks: 'none' });
        expect(await resolveAnnouncementChannelId(roomId, null, 'picks', routes)).toBeNull();
        expect(await resolveAnnouncementChannelId(roomId, CATCH, 'picks', routes)).toBeNull();
        expect(await resolveAnnouncementChannelId(roomId, null, 'tournament', routes)).toBe(R_TOURN);
    });

    it("a catch-all 'none' still silences every kind without a per-kind entry", async () => {
        const routes = tr({ scores: T_SCORES });
        expect(await resolveAnnouncementChannelId(roomId, ANNOUNCE_NONE, 'scores', routes)).toBe(T_SCORES);
        for (const kind of ['tournament', 'picks', 'polls'] as const) {
            expect(await resolveAnnouncementChannelId(roomId, ANNOUNCE_NONE, kind, routes)).toBeNull();
        }
    });

    it('scores: room scores route, else the room tournament route, else room default, else env', async () => {
        expect(await resolveAnnouncementChannelId(roomId, null, 'scores')).toBe(R_TOURN);
        await setSetting(DISCORD_ANNOUNCE_ROUTES_KEY, tr({ tournament: R_TOURN, scores: R_SCORES }));
        expect(await resolveAnnouncementChannelId(roomId, null, 'scores')).toBe(R_SCORES);
        expect(await resolveAnnouncementChannelId(roomId, null, 'tournament')).toBe(R_TOURN);
        await setSetting(DISCORD_ANNOUNCE_ROUTES_KEY, tr({ picks: R_PICKS }));
        expect(await resolveAnnouncementChannelId(roomId, null, 'scores')).toBe(DEFAULT);
        await setSetting('DISCORD_ANNOUNCEMENT_CHANNEL_ID', '');
        process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID = CATCH;
        expect(await resolveAnnouncementChannelId(roomId, null, 'scores')).toBe(CATCH);
        delete process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID;
        expect(await resolveAnnouncementChannelId(roomId, null, 'scores')).toBeNull();
    });

    it('scores: a tournament catch-all beats the room routes; a per-kind tournament route does not leak to scores', async () => {
        expect(await resolveAnnouncementChannelId(roomId, CATCH, 'scores')).toBe(CATCH);
        expect(await resolveAnnouncementChannelId(roomId, null, 'scores', tr({ tournament: T_TOURN }))).toBe(R_TOURN);
    });
});

describe('API + service round-trip of discord_announce_routes', () => {
    it("the schema canonicalises the value, garbage becomes '', and 'none' is a valid catch-all", () => {
        const base = {
            id: '00000000-0000-4000-8000-000000000001', name: 'T', type: 'daily',
            cadence: { cron: '0 0 * * *' },
        };
        const ok = CreateTournamentSchema.safeParse({
            ...base, discord_channel_id: 'none',
            discord_announce_routes: tr({ polls: 'nope', scores: 'none', tournament: T_TOURN }),
        });
        expect(ok.success).toBe(true);
        expect(ok.data!.discord_channel_id).toBe('none');
        expect(ok.data!.discord_announce_routes).toBe(tr({ tournament: T_TOURN, scores: 'none' }));
        const junk = CreateTournamentSchema.safeParse({ ...base, discord_announce_routes: '{oops' });
        expect(junk.success).toBe(true);
        expect(junk.data!.discord_announce_routes).toBe('');
    });

    it('update writes, keeps on omission, and clears on ""', async () => {
        await setupTestDb();
        const roomId = await createTestRoom();
        const id = await createTestTournament(roomId, { name: 'Routes' });
        const db = await getDatabase();
        const row = async () => (await db.get<{ discord_announce_routes: string | null }>(
            'SELECT discord_announce_routes FROM tournaments WHERE id = ?', id))!.discord_announce_routes;
        const common = { name: 'Routes', type: 'daily', cadence: { cron: '0 0 * * *' }, game_room_id: roomId };
        await TournamentService.update(id, { ...common, discord_announce_routes: tr({ picks: 'none' }) });
        expect(await row()).toBe(tr({ picks: 'none' }));
        await TournamentService.update(id, { ...common });
        expect(await row()).toBe(tr({ picks: 'none' }));
        await TournamentService.update(id, { ...common, discord_announce_routes: '' });
        expect(await row()).toBeNull();
    });
});
