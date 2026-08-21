import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
    setupTestDb, createTestRoom, createTestTournament, createTestGame, createTestSubmission,
} from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { CalloutService } from '../services/CalloutService.js';
import { NotificationService } from '../services/NotificationService.js';
import {
    handleCalloutMessage,
    resolveCalloutScope,
    resetCalloutCooldowns,
    CHAT_MUTE_CONFIRMATION,
    CHAT_UNMUTE_CONFIRMATION,
    CalloutMessageLike,
} from '../discord/callouts.js';
import {
    CHAT_RESPONSES_CATEGORIES_KEY,
    CHAT_RESPONSES_CHANNELS_KEY,
    CHAT_RESPONSES_COOLDOWN_KEY,
    CHAT_RESPONSES_ENABLED_KEY,
    LEGACY_CALLOUTS_CHANNEL_KEY,
    LEGACY_CALLOUTS_ENABLED_KEY,
    migrateLegacyCalloutSettings,
    parseCategories,
    resolveRoomChatConfig,
} from '../services/ChatResponseSettingsService.js';
import {
    CALLOUT_CATEGORIES,
    calloutCategoryOf,
    deriveCalloutCategory,
    filterByCategories,
    validateCalloutEntries,
    CalloutCategory,
} from '../utils/callouts.js';
import { BUILTIN_HELP_ENTRIES, BUILTIN_HELP_TRIGGERS } from '../utils/calloutBuiltins.js';
import { renderCalloutAction, formatDuration } from '../discord/calloutActions.js';
import { GuildReadScope } from '../utils/discordRoomFilter.js';

/**
 * Arcaid Chat Responses (v2.125.0) — everything the rename added on top of
 * v2.123.0's callouts. The pre-existing behaviour stays covered by
 * `callouts.test.ts`; this file covers only what is new:
 *
 *   1. Categories — inference, migration backfill, validation
 *   2. Per-room settings + the legacy CALLOUTS_* boot migration
 *   3. The gate matrix — master / category / channels / cooldown / user mute
 *   4. The in-chat mute toggle
 *   5. `ensureBuiltinHelpEntries`
 *   6. The six new live answers
 *   7. `GET /:roomId/admin/discord/channels`
 */

// ---------------------------------------------------------------------------
// 1. Categories
// ---------------------------------------------------------------------------

describe('category inference', () => {
    it('an action entry is help, whatever its triggers say', () => {
        expect(deriveCalloutCategory({ triggers: ['bot', 'seafood'], action: 'active_games' }))
            .toBe('help');
    });

    it('bot-directed triggers are banter', () => {
        expect(deriveCalloutCategory({ triggers: ['good bot'] })).toBe('banter');
        expect(deriveCalloutCategory({ triggers: ['ARCAID rules'] })).toBe('banter');
    });

    it('the three named in-jokes are easter_eggs', () => {
        for (const trigger of ['seafood', 'dork cow', 'secret cow']) {
            expect(deriveCalloutCategory({ triggers: [trigger] })).toBe('easter_eggs');
        }
    });

    it('everything else is an ordinary game callout', () => {
        expect(deriveCalloutCategory({ triggers: ['medieval madness'] })).toBe('callouts');
    });

    it('an explicit category always wins over inference', () => {
        expect(calloutCategoryOf({ triggers: ['seafood'], responses: ['x'], category: 'banter' }))
            .toBe('banter');
    });
});

describe('validateCalloutEntries — category', () => {
    it('defaults an omitted category through the inference rule', () => {
        const ok = validateCalloutEntries([
            { triggers: ['seafood'], responses: ['MEOW'] },
            { triggers: ['good bot'], responses: ['ty'] },
            { triggers: ['whatever'], action: 'leaders' },
        ]) as { entries: Array<{ category?: string }> };
        expect(ok.entries.map(e => e.category)).toEqual(['easter_eggs', 'banter', 'help']);
    });

    it('accepts every valid category verbatim', () => {
        for (const category of CALLOUT_CATEGORIES) {
            const ok = validateCalloutEntries([
                { triggers: ['x'], responses: ['y'], category },
            ]) as { entries: Array<{ category?: string }> };
            expect(ok.entries[0]!.category).toBe(category);
        }
    });

    it('rejects an unknown category, naming the index', () => {
        const result = validateCalloutEntries([
            { triggers: ['x'], responses: ['y'], category: 'chaos' },
        ]) as { error: string };
        expect(result.error).toMatch(/^entry 0: category must be one of help, callouts/);
    });
});

describe('migration 156 — category backfill', () => {
    /**
     * The migration itself runs inside `initDatabase`, so the backfill is
     * asserted by inserting rows the way the PRE-migration schema would have
     * (no category) and re-running the same UPDATE statements the migration
     * uses. Re-running is the point: the migration has to be safe to re-apply.
     */
    it('files existing rows by the owner rule', async () => {
        const db = await setupTestDb();
        await db.run(
            `INSERT INTO callouts (triggers, responses, action, category, enabled, sort_order)
             VALUES (?, '[]', 'active_games', 'callouts', 1, 0)`,
            JSON.stringify(['what table']),
        );
        await db.run(
            `INSERT INTO callouts (triggers, responses, action, category, enabled, sort_order)
             VALUES (?, ?, NULL, 'callouts', 1, 1)`,
            JSON.stringify(['good bot']), JSON.stringify(['ty']),
        );
        await db.run(
            `INSERT INTO callouts (triggers, responses, action, category, enabled, sort_order)
             VALUES (?, ?, NULL, 'callouts', 1, 2)`,
            JSON.stringify(['seafood', 'milk']), JSON.stringify(['MEOW']),
        );
        await db.run(
            `INSERT INTO callouts (triggers, responses, action, category, enabled, sort_order)
             VALUES (?, ?, NULL, 'callouts', 1, 3)`,
            JSON.stringify(['medieval madness']), JSON.stringify(['Troll!']),
        );

        // The three statements from migration 156, in order.
        await db.run(`UPDATE callouts SET category = 'help' WHERE action IS NOT NULL AND category = 'callouts'`);
        await db.run(`UPDATE callouts SET category = 'banter' WHERE action IS NULL AND category = 'callouts'
                      AND (LOWER(triggers) LIKE '%bot%' OR LOWER(triggers) LIKE '%arcaid%')`);
        await db.run(`UPDATE callouts SET category = 'easter_eggs' WHERE action IS NULL AND category = 'callouts'
                      AND (LOWER(triggers) LIKE '%seafood%' OR LOWER(triggers) LIKE '%dork cow%'
                        OR LOWER(triggers) LIKE '%secret cow%')`);

        const rows = await CalloutService.list();
        expect(rows.map(r => r.category)).toEqual(['help', 'banter', 'easter_eggs', 'callouts']);
    });

    it('the column exists with the documented default on a fresh DB', async () => {
        const db = await setupTestDb();
        const columns = (await db.all('PRAGMA table_info(callouts)')) as Array<{ name: string; dflt_value: string }>;
        const category = columns.find(c => c.name === 'category');
        expect(category).toBeDefined();
        expect(category!.dflt_value).toContain('callouts');
    });
});

describe('filterByCategories', () => {
    const list = [
        { triggers: ['good bot'], responses: ['ty'], category: 'banter' as const },
        { triggers: ['bot'], responses: ['game callout'], category: 'callouts' as const },
    ];

    it('drops entries whose category is off', () => {
        const allowed = new Set<CalloutCategory>(['callouts']);
        expect(filterByCategories(list, allowed).map(e => e.responses?.[0])).toEqual(['game callout']);
    });

    it('keeps list order for the survivors', () => {
        const allowed = new Set<CalloutCategory>(['banter', 'callouts']);
        expect(filterByCategories(list, allowed)).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// 2. Per-room settings + legacy migration
// ---------------------------------------------------------------------------

describe('resolveRoomChatConfig', () => {
    it('an absent master key means OFF', () => {
        expect(resolveRoomChatConfig(undefined).enabled).toBe(false);
        expect(resolveRoomChatConfig({}).enabled).toBe(false);
    });

    it('the modern keys win outright over the legacy pair', () => {
        const config = resolveRoomChatConfig({
            [CHAT_RESPONSES_ENABLED_KEY]: 'false',
            [LEGACY_CALLOUTS_ENABLED_KEY]: 'true',
        });
        expect(config.enabled).toBe(false);
    });

    it('falls back to the legacy pair for one release, with ALL categories', () => {
        const config = resolveRoomChatConfig({
            [LEGACY_CALLOUTS_ENABLED_KEY]: 'true',
            [LEGACY_CALLOUTS_CHANNEL_KEY]: 'chan-9',
        });
        expect(config.enabled).toBe(true);
        expect([...config.categories].sort()).toEqual([...CALLOUT_CATEGORIES].sort());
        expect(config.channelIds).toEqual(['chan-9']);
    });

    it('absent categories default to help + callouts; an empty array means none', () => {
        expect([...parseCategories(undefined)].sort()).toEqual(['callouts', 'help']);
        expect([...parseCategories('[]')]).toEqual([]);
    });

    it('an unparseable cooldown falls back to 30', () => {
        expect(resolveRoomChatConfig({
            [CHAT_RESPONSES_ENABLED_KEY]: 'true', [CHAT_RESPONSES_COOLDOWN_KEY]: 'soon',
        }).cooldownSec).toBe(30);
    });
});

describe('migrateLegacyCalloutSettings', () => {
    it('lifts an ON room to all four categories and deletes the legacy keys', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('legacy-on', 'Legacy On');
        await GameRoomSettingsService.set(roomId, LEGACY_CALLOUTS_ENABLED_KEY, 'true');
        await GameRoomSettingsService.set(roomId, LEGACY_CALLOUTS_CHANNEL_KEY, 'chan-1');

        expect(await migrateLegacyCalloutSettings()).toBe(1);

        expect(await GameRoomSettingsService.get(roomId, CHAT_RESPONSES_ENABLED_KEY)).toBe('true');
        expect(JSON.parse((await GameRoomSettingsService.get(roomId, CHAT_RESPONSES_CATEGORIES_KEY))!).sort())
            .toEqual([...CALLOUT_CATEGORIES].sort());
        expect(JSON.parse((await GameRoomSettingsService.get(roomId, CHAT_RESPONSES_CHANNELS_KEY))!))
            .toEqual(['chan-1']);
        expect(await GameRoomSettingsService.get(roomId, LEGACY_CALLOUTS_ENABLED_KEY)).toBeNull();
        expect(await GameRoomSettingsService.get(roomId, LEGACY_CALLOUTS_CHANNEL_KEY)).toBeNull();
    });

    it('an OFF room gets no new rows, but loses the legacy ones', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('legacy-off', 'Legacy Off');
        await GameRoomSettingsService.set(roomId, LEGACY_CALLOUTS_ENABLED_KEY, 'false');

        expect(await migrateLegacyCalloutSettings()).toBe(0);
        expect(await GameRoomSettingsService.get(roomId, CHAT_RESPONSES_ENABLED_KEY)).toBeNull();
        expect(await GameRoomSettingsService.get(roomId, LEGACY_CALLOUTS_ENABLED_KEY)).toBeNull();
    });

    it('is idempotent and never clobbers a hand-tuned category list', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('legacy-twice', 'Legacy Twice');
        await GameRoomSettingsService.set(roomId, LEGACY_CALLOUTS_ENABLED_KEY, 'true');

        expect(await migrateLegacyCalloutSettings()).toBe(1);
        // The admin narrows it afterwards…
        await GameRoomSettingsService.set(roomId, CHAT_RESPONSES_CATEGORIES_KEY, JSON.stringify(['help']));
        // …and a second boot must leave that alone.
        expect(await migrateLegacyCalloutSettings()).toBe(0);
        expect(JSON.parse((await GameRoomSettingsService.get(roomId, CHAT_RESPONSES_CATEGORIES_KEY))!))
            .toEqual(['help']);
    });
});

describe('category persistence through the service and the admin API', () => {
    const superToken = () => signToken({ userId: 'super', username: 'super', role: 'super_admin' } as any);

    async function adminApp() {
        const adminRouter = (await import('../api/routes/admin.js')).default;
        const app = express();
        app.use(express.json());
        app.use('/api/admin', adminRouter);
        return app;
    }

    beforeEach(() => CalloutService.invalidateCache());

    it('update() moves an entry between categories', async () => {
        await setupTestDb();
        await CalloutService.replaceAll([{ triggers: ['seafood'], responses: ['MEOW'] }]);
        const row = (await CalloutService.list())[0]!;
        expect(row.category).toBe('easter_eggs');

        const updated = await CalloutService.update(row.id, { category: 'banter' });
        expect(updated!.category).toBe('banter');
    });

    it('an unrelated trigger edit does NOT re-derive the category', async () => {
        await setupTestDb();
        await CalloutService.replaceAll([{ triggers: ['seafood'], responses: ['MEOW'], category: 'banter' }]);
        const row = (await CalloutService.list())[0]!;

        // 'seafood' still infers as easter_eggs — the admin's choice must win.
        const updated = await CalloutService.update(row.id, { triggers: ['seafood', 'milk'] });
        expect(updated!.category).toBe('banter');
    });

    it('PATCH /api/admin/callouts/:id accepts a category', async () => {
        await setupTestDb();
        const app = await adminApp();
        await CalloutService.replaceAll([{ triggers: ['seafood'], responses: ['MEOW'] }]);
        const row = (await CalloutService.list())[0]!;

        const res = await request(app)
            .patch(`/api/admin/callouts/${row.id}`)
            .set('Authorization', `Bearer ${superToken()}`)
            .send({ category: 'banter' });
        expect(res.status).toBe(200);
        expect(res.body.category).toBe('banter');
    });

    it('PATCH rejects an unknown category at the schema boundary', async () => {
        await setupTestDb();
        const app = await adminApp();
        await CalloutService.replaceAll([{ triggers: ['seafood'], responses: ['MEOW'] }]);
        const row = (await CalloutService.list())[0]!;

        const res = await request(app)
            .patch(`/api/admin/callouts/${row.id}`)
            .set('Authorization', `Bearer ${superToken()}`)
            .send({ category: 'chaos' });
        expect(res.status).toBe(400);
    });

    it('the admin action enum covers all ten live answers', async () => {
        await setupTestDb();
        const app = await adminApp();
        await CalloutService.replaceAll([{ triggers: ['seafood'], responses: ['MEOW'] }]);
        const row = (await CalloutService.list())[0]!;

        // The six added in v2.125.0 must be reachable through the API, not just
        // through a direct service call.
        for (const action of [
            'time_left', 'leaders', 'my_rank', 'pick_status', 'tournament_rules', 'how_to_claim',
        ]) {
            const res = await request(app)
                .patch(`/api/admin/callouts/${row.id}`)
                .set('Authorization', `Bearer ${superToken()}`)
                .send({ action });
            expect(res.status).toBe(200);
            expect(res.body.action).toBe(action);
        }
    });
});

// ---------------------------------------------------------------------------
// 3. The gate matrix
// ---------------------------------------------------------------------------

const GATE_ENTRIES = [
    { triggers: ['seafood'], responses: ['MEOW'], category: 'easter_eggs' as const },
    { triggers: ['medieval madness'], responses: ['Troll!'], category: 'callouts' as const },
    { triggers: ['how do i submit'], responses: ['Tap Submit Score.'], category: 'help' as const },
];

function message(overrides: Partial<CalloutMessageLike> & { replies: string[] }): CalloutMessageLike {
    return {
        author: { bot: false, id: 'user-1' },
        guildId: 'guild-1',
        channelId: 'channel-1',
        content: 'seafood tonight',
        reply: async (content: string) => { overrides.replies.push(content); },
        ...overrides,
    };
}

async function roomWith(slug: string, settings: Record<string, string>) {
    const roomId = await createTestRoom(slug, slug);
    await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-1');
    for (const [k, v] of Object.entries(settings)) {
        await GameRoomSettingsService.set(roomId, k, v);
    }
    return roomId;
}

describe('handleCalloutMessage — the v2.125.0 gate', () => {
    beforeEach(async () => {
        CalloutService.invalidateCache();
        resetCalloutCooldowns();
        NotificationService.invalidateChatResponseCache();
        delete process.env.ENABLE_CALLOUTS;
        delete process.env.DISCORD_GUILD_ID;
        await setupTestDb();
        await CalloutService.replaceAll(GATE_ENTRIES);
    });
    afterEach(() => {
        delete process.env.ENABLE_CALLOUTS;
        delete process.env.DISCORD_GUILD_ID;
    });

    it('master off (absent) → silent', async () => {
        await roomWith('master-absent', {});
        const replies: string[] = [];
        expect(await handleCalloutMessage(message({ replies }))).toBe(false);
        expect(replies).toEqual([]);
    });

    it('master on → replies', async () => {
        await roomWith('master-on', {
            [CHAT_RESPONSES_ENABLED_KEY]: 'true',
            [CHAT_RESPONSES_CATEGORIES_KEY]: JSON.stringify(['easter_eggs']),
        });
        const replies: string[] = [];
        expect(await handleCalloutMessage(message({ replies }))).toBe(true);
        expect(replies).toEqual(['MEOW']);
    });

    it('a category that is off is silent while another still replies', async () => {
        await roomWith('one-category', {
            [CHAT_RESPONSES_ENABLED_KEY]: 'true',
            // Easter eggs OFF, ordinary callouts ON.
            [CHAT_RESPONSES_CATEGORIES_KEY]: JSON.stringify(['callouts']),
        });

        const eggReplies: string[] = [];
        expect(await handleCalloutMessage(message({ replies: eggReplies }))).toBe(false);
        expect(eggReplies).toEqual([]);

        const calloutReplies: string[] = [];
        expect(await handleCalloutMessage(message({
            replies: calloutReplies, content: 'medieval madness tonight',
        }))).toBe(true);
        expect(calloutReplies).toEqual(['Troll!']);
    });

    it('an empty channel list accepts any channel; a set list confines it', async () => {
        await roomWith('channels', {
            [CHAT_RESPONSES_ENABLED_KEY]: 'true',
            [CHAT_RESPONSES_CATEGORIES_KEY]: JSON.stringify(['easter_eggs']),
        });
        const anywhere: string[] = [];
        expect(await handleCalloutMessage(message({ replies: anywhere, channelId: 'anything' })))
            .toBe(true);

        // Now pin it to one channel.
        const db = await getDatabase();
        const row = await db.get(`SELECT game_room_id FROM game_room_settings
                                  WHERE key = ? AND value = 'true'`, CHAT_RESPONSES_ENABLED_KEY);
        await GameRoomSettingsService.set(
            row!.game_room_id, CHAT_RESPONSES_CHANNELS_KEY, JSON.stringify(['channel-allowed']),
        );

        resetCalloutCooldowns();
        const wrong: string[] = [];
        expect(await handleCalloutMessage(message({ replies: wrong, channelId: 'channel-other' })))
            .toBe(false);

        const right: string[] = [];
        expect(await handleCalloutMessage(message({ replies: right, channelId: 'channel-allowed' })))
            .toBe(true);
    });

    it('the cooldown suppresses a second fun reply but lets a help answer through', async () => {
        await roomWith('cooldown', {
            [CHAT_RESPONSES_ENABLED_KEY]: 'true',
            [CHAT_RESPONSES_CATEGORIES_KEY]: JSON.stringify([...CALLOUT_CATEGORIES]),
            [CHAT_RESPONSES_COOLDOWN_KEY]: '30',
        });

        const first: string[] = [];
        expect(await handleCalloutMessage(message({ replies: first }))).toBe(true);

        // Same channel, well inside the 30s window — the fun half is throttled…
        const second: string[] = [];
        expect(await handleCalloutMessage(message({
            replies: second, content: 'medieval madness now',
        }))).toBe(false);

        // …but a question is still answered. This is the whole point of
        // exempting `help`.
        const helpReplies: string[] = [];
        expect(await handleCalloutMessage(message({
            replies: helpReplies, content: 'how do i submit a score',
        }))).toBe(true);
        expect(helpReplies).toEqual(['Tap Submit Score.']);
    });

    it('the cooldown is per channel, not global', async () => {
        await roomWith('cooldown-scope', {
            [CHAT_RESPONSES_ENABLED_KEY]: 'true',
            [CHAT_RESPONSES_CATEGORIES_KEY]: JSON.stringify([...CALLOUT_CATEGORIES]),
        });
        const a: string[] = [];
        expect(await handleCalloutMessage(message({ replies: a, channelId: 'chan-a' }))).toBe(true);
        const b: string[] = [];
        expect(await handleCalloutMessage(message({ replies: b, channelId: 'chan-b' }))).toBe(true);
    });

    it('a cooldown of 0 disables the throttle', async () => {
        await roomWith('cooldown-zero', {
            [CHAT_RESPONSES_ENABLED_KEY]: 'true',
            [CHAT_RESPONSES_CATEGORIES_KEY]: JSON.stringify([...CALLOUT_CATEGORIES]),
            [CHAT_RESPONSES_COOLDOWN_KEY]: '0',
        });
        const replies: string[] = [];
        expect(await handleCalloutMessage(message({ replies }))).toBe(true);
        expect(await handleCalloutMessage(message({ replies }))).toBe(true);
        expect(replies).toEqual(['MEOW', 'MEOW']);
    });

    it('a muted user gets silence', async () => {
        await roomWith('muted', {
            [CHAT_RESPONSES_ENABLED_KEY]: 'true',
            [CHAT_RESPONSES_CATEGORIES_KEY]: JSON.stringify([...CALLOUT_CATEGORIES]),
        });
        await NotificationService.setChatResponsesEnabled('user-1', false);

        const replies: string[] = [];
        expect(await handleCalloutMessage(message({ replies }))).toBe(false);

        // …and only THAT user. Someone else in the same channel is unaffected.
        const other: string[] = [];
        expect(await handleCalloutMessage(message({
            replies: other, author: { bot: false, id: 'user-2' },
        }))).toBe(true);
    });

    it('resolveCalloutScope reports the union of the permitting rooms categories', async () => {
        await roomWith('union-a', {
            [CHAT_RESPONSES_ENABLED_KEY]: 'true',
            [CHAT_RESPONSES_CATEGORIES_KEY]: JSON.stringify(['help']),
        });
        await roomWith('union-b', {
            [CHAT_RESPONSES_ENABLED_KEY]: 'true',
            [CHAT_RESPONSES_CATEGORIES_KEY]: JSON.stringify(['banter']),
        });
        const scope = await resolveCalloutScope('guild-1', 'channel-1');
        expect([...scope!.categories].sort()).toEqual(['banter', 'help']);
        expect(scope!.roomIds).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// 4. The in-chat mute toggle
// ---------------------------------------------------------------------------

describe('in-chat mute toggle', () => {
    beforeEach(async () => {
        CalloutService.invalidateCache();
        resetCalloutCooldowns();
        NotificationService.invalidateChatResponseCache();
        delete process.env.ENABLE_CALLOUTS;
        await setupTestDb();
        await CalloutService.replaceAll(GATE_ENTRIES);
        await roomWith('mute-room', {
            [CHAT_RESPONSES_ENABLED_KEY]: 'true',
            // Deliberately help-ONLY: the toggle must work in a room that has
            // turned every fun category off.
            [CHAT_RESPONSES_CATEGORIES_KEY]: JSON.stringify(['help']),
        });
    });

    it('"Arcaid, shush" mutes the author and confirms', async () => {
        const replies: string[] = [];
        expect(await handleCalloutMessage(message({
            replies, content: 'Arcaid, shush',
        }))).toBe(true);
        expect(replies).toEqual([CHAT_MUTE_CONFIRMATION]);
        expect(await NotificationService.chatResponsesEnabled('user-1')).toBe(false);
    });

    it('"Arcaid, unmute" turns it back on — even while muted', async () => {
        await NotificationService.setChatResponsesEnabled('user-1', false);
        const replies: string[] = [];
        expect(await handleCalloutMessage(message({
            replies, content: 'arcaid unmute please',
        }))).toBe(true);
        expect(replies).toEqual([CHAT_UNMUTE_CONFIRMATION]);
        expect(await NotificationService.chatResponsesEnabled('user-1')).toBe(true);
    });

    it('an @mention of the bot addresses it just as well as the prefix', async () => {
        const replies: string[] = [];
        expect(await handleCalloutMessage(message({
            replies,
            content: '<@bot-1> be quiet',
            mentions: { has: (id: string) => id === 'bot-1' },
            client: { user: { id: 'bot-1' } },
        }))).toBe(true);
        expect(replies).toEqual([CHAT_MUTE_CONFIRMATION]);
    });

    it('ignores mute words that are not addressed to the bot', async () => {
        const replies: string[] = [];
        expect(await handleCalloutMessage(message({
            replies, content: 'everyone be quiet, seafood is here',
        }))).toBe(false);
        expect(await NotificationService.chatResponsesEnabled('user-1')).toBe(true);
    });

    it('bypasses the cooldown — it answers right after a throttled reply', async () => {
        // Burn the channel's cooldown with a help answer first.
        await handleCalloutMessage(message({ replies: [], content: 'how do i submit' }));
        const replies: string[] = [];
        expect(await handleCalloutMessage(message({
            replies, content: 'arcaid mute',
        }))).toBe(true);
        expect(replies).toEqual([CHAT_MUTE_CONFIRMATION]);
    });

    it('unmute wins when a message somehow carries both words', async () => {
        await NotificationService.setChatResponsesEnabled('user-1', false);
        const replies: string[] = [];
        await handleCalloutMessage(message({ replies, content: 'arcaid stop being quiet, unmute' }));
        expect(replies).toEqual([CHAT_UNMUTE_CONFIRMATION]);
        expect(await NotificationService.chatResponsesEnabled('user-1')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 5. Built-in help entries
// ---------------------------------------------------------------------------

describe('ensureBuiltinHelpEntries', () => {
    beforeEach(() => CalloutService.invalidateCache());

    it('seeds one entry per action on an empty table', async () => {
        await setupTestDb();
        expect(await CalloutService.ensureBuiltinHelpEntries()).toBe(BUILTIN_HELP_ENTRIES.length);
        const rows = await CalloutService.list();
        expect(rows).toHaveLength(10);
        expect(rows.every(r => r.category === 'help')).toBe(true);
        expect(rows.map(r => r.action).sort())
            .toEqual(Object.keys(BUILTIN_HELP_TRIGGERS).sort());
    });

    it('is idempotent — a second run adds nothing', async () => {
        await setupTestDb();
        await CalloutService.ensureBuiltinHelpEntries();
        expect(await CalloutService.ensureBuiltinHelpEntries()).toBe(0);
        expect(await CalloutService.list()).toHaveLength(10);
    });

    it('never re-adds an action the admin DISABLED', async () => {
        await setupTestDb();
        await CalloutService.ensureBuiltinHelpEntries();
        const leaders = (await CalloutService.list()).find(r => r.action === 'leaders')!;
        await CalloutService.update(leaders.id, { enabled: false });

        expect(await CalloutService.ensureBuiltinHelpEntries()).toBe(0);
        const rows = (await CalloutService.list()).filter(r => r.action === 'leaders');
        expect(rows).toHaveLength(1);
        expect(rows[0]!.enabled).toBe(false);
    });

    it('leaves an admin-edited trigger list alone', async () => {
        await setupTestDb();
        await CalloutService.ensureBuiltinHelpEntries();
        const row = (await CalloutService.list()).find(r => r.action === 'my_rank')!;
        await CalloutService.update(row.id, { triggers: ['how am i doing'] });

        await CalloutService.ensureBuiltinHelpEntries();
        const after = (await CalloutService.list()).filter(r => r.action === 'my_rank');
        expect(after).toHaveLength(1);
        expect(after[0]!.triggers).toEqual(['how am i doing']);
    });

    it('appends behind an existing list so it can never shadow it', async () => {
        await setupTestDb();
        await CalloutService.replaceAll([{ triggers: ['my rank'], responses: ['ask me later'] }]);
        await CalloutService.ensureBuiltinHelpEntries();
        const rows = await CalloutService.list();
        expect(rows[0]!.responses).toEqual(['ask me later']);
        expect(rows[0]!.sort_order).toBeLessThan(rows[1]!.sort_order);
    });

    it('fills only the actions that are missing', async () => {
        await setupTestDb();
        await CalloutService.replaceAll([{ triggers: ['x'], action: 'leaders' }]);
        expect(await CalloutService.ensureBuiltinHelpEntries()).toBe(9);
    });
});

// ---------------------------------------------------------------------------
// 6. The six new live answers
// ---------------------------------------------------------------------------

describe('live answers', () => {
    const scope: GuildReadScope = { roomIds: [], legacyEnv: false };

    beforeEach(() => {
        process.env.PUBLIC_URL = 'https://test.arcaid.app';
        delete process.env.BOT_TIMEZONE;
    });
    afterEach(() => { delete process.env.PUBLIC_URL; });

    /** A room with one tournament, one active game, and a fixed cron. */
    async function seed(opts: {
        cron?: string;
        platformRules?: string;
        eligibilityDays?: number;
    } = {}) {
        const roomId = await createTestRoom('live', 'Live Room');
        const db = await getDatabase();
        const tournamentId = await createTestTournament(roomId, { name: 'Daily Grind', type: 'daily' });
        await db.run(
            `UPDATE tournaments SET cadence = ?, platform_rules = ?, eligibility_days = ?,
                                    winner_pick_window_min = 60, runnerup_pick_window_min = 30
             WHERE id = ?`,
            JSON.stringify({ cron: opts.cron ?? '0 22 * * *', timezone: 'UTC', autoRotate: true, autoLock: true }),
            opts.platformRules ?? '{}',
            opts.eligibilityDays ?? 120,
            tournamentId,
        );
        const gameId = await createTestGame(tournamentId, { name: 'WHO dunnit', status: 'ACTIVE' });
        return {
            roomId, tournamentId, gameId,
            rooms: [{ id: roomId, name: 'Live Room', slug: 'live' }],
            scope: { roomIds: [roomId], legacyEnv: false } as GuildReadScope,
        };
    }

    it('formatDuration rounds down and never prints a bare 0m', () => {
        expect(formatDuration(0)).toBe('any moment now');
        expect(formatDuration(30_000)).toBe('any moment now');
        expect(formatDuration(6 * 3600_000 + 12 * 60_000)).toBe('6h 12m');
        expect(formatDuration(45 * 60_000)).toBe('45m');
        expect(formatDuration(2 * 86400_000 + 3 * 3600_000)).toBe('2d 3h');
    });

    it('time_left counts down to the next cron fire, against a fixed clock', async () => {
        await setupTestDb();
        const { rooms, scope: s } = await seed({ cron: '0 22 * * *' });
        // 15:48 UTC → 6h 12m until the 22:00 UTC fire.
        const now = new Date('2026-08-21T15:48:00Z');
        const out = await renderCalloutAction('time_left', s, rooms, { now });
        expect(out).toContain('Daily Grind');
        expect(out).toContain('WHO dunnit');
        expect(out).toContain('ends in **6h 12m**');
        expect(out).toContain('next rotation <t:');
    });

    it('time_left says so plainly when a tournament has no cron', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('nocron', 'No Cron');
        const tId = await createTestTournament(roomId, { name: 'Manual Cup' });
        await createTestGame(tId, { name: 'Attack From Mars', status: 'ACTIVE' });
        const out = await renderCalloutAction(
            'time_left',
            { roomIds: [roomId], legacyEnv: false },
            [{ id: roomId, name: 'No Cron', slug: 'nocron' }],
        );
        expect(out).toContain('no scheduled rotation');
    });

    it('leaders names the top score per active game', async () => {
        await setupTestDb();
        const { gameId, rooms, scope: s } = await seed();
        await createTestSubmission(gameId, { username: 'Krobs', score: 5_000_000 });
        await createTestSubmission(gameId, { username: 'Someone', score: 1_000 });

        const out = await renderCalloutAction('leaders', s, rooms);
        expect(out).toContain('WHO dunnit');
        expect(out).toContain('Krobs');
        expect(out).toContain('5,000,000');
    });

    it('leaders invites the first score when a game has none', async () => {
        await setupTestDb();
        const { rooms, scope: s } = await seed();
        expect(await renderCalloutAction('leaders', s, rooms)).toContain('no scores yet');
    });

    it('my_rank finds a LINKED asker via user_mappings', async () => {
        await setupTestDb();
        const { gameId, rooms, scope: s } = await seed();
        const db = await getDatabase();
        await createTestSubmission(gameId, { username: 'Krobs', score: 9_000 });
        await createTestSubmission(gameId, { username: 'Rival', score: 12_000 });
        await db.run(
            'INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, ?)',
            'discord-krobs', 'Krobs',
        );

        const out = await renderCalloutAction('my_rank', s, rooms, { authorId: 'discord-krobs' });
        expect(out).toContain('Your standing');
        expect(out).toContain('#2');
        expect(out).toContain('3,000 behind #1');
    });

    it('my_rank gives an UNLINKED asker the claim nudge', async () => {
        await setupTestDb();
        const { gameId, rooms, scope: s } = await seed();
        await createTestSubmission(gameId, { username: 'Krobs', score: 9_000 });

        const out = await renderCalloutAction('my_rank', s, rooms, { authorId: 'discord-nobody' });
        expect(out).toContain('Claiming your name');
        expect(out).toContain('https://test.arcaid.app/account/settings');
    });

    it('pick_status names the pending picker and the time left', async () => {
        await setupTestDb();
        const { tournamentId, rooms, scope: s } = await seed();
        const db = await getDatabase();
        const placeholder = await createTestGame(tournamentId, {
            name: '[Pending Pick]', status: 'QUEUED',
        });
        await db.run(
            `UPDATE games SET picker_discord_id = ?, picker_type = 'WINNER',
                              picker_designated_at = ? WHERE id = ?`,
            'discord-krobs', new Date(Date.now() - 20 * 60_000).toISOString(), placeholder,
        );

        const out = await renderCalloutAction('pick_status', s, rooms);
        expect(out).toContain('Waiting on a pick');
        expect(out).toContain('<@discord-krobs>');
        // 60-minute window, 20 minutes elapsed.
        expect(out).toMatch(/\*\*(39|40)m\*\* left to pick/);
    });

    it('pick_status says nobody owes one, with the Picks link', async () => {
        await setupTestDb();
        const { rooms, scope: s } = await seed();
        const out = await renderCalloutAction('pick_status', s, rooms);
        expect(out).toContain('Nobody owes a pick');
        expect(out).toContain('https://test.arcaid.app/live/picks');
    });

    it('tournament_rules reports both axes plus the eligibility cooldown', async () => {
        await setupTestDb();
        const { rooms, scope: s } = await seed({
            platformRules: JSON.stringify({
                engines: { required: ['vpx'], excluded: [] },
                devices: { required: [], excluded: ['atgames'] },
            }),
            eligibilityDays: 90,
        });
        const out = await renderCalloutAction('tournament_rules', s, rooms);
        expect(out).toContain('engines: must be on vpx');
        expect(out).toContain('devices: not allowed on atgames');
        expect(out).toContain('cannot repeat within 90 days');
    });

    it('tournament_rules says "no restrictions" when the column is empty', async () => {
        await setupTestDb();
        const { rooms, scope: s } = await seed({ platformRules: '{}', eligibilityDays: 0 });
        expect(await renderCalloutAction('tournament_rules', s, rooms))
            .toContain('no platform restrictions');
    });

    it('how_to_claim is static and points at Account Settings', async () => {
        await setupTestDb();
        const { rooms, scope: s } = await seed();
        const out = await renderCalloutAction('how_to_claim', s, rooms);
        expect(out).toContain('Claiming your name');
        expect(out).toContain('https://test.arcaid.app/account/settings');
        expect(out).toContain('/map-user');
    });

    it('every live answer degrades to null with no room, rather than throwing', async () => {
        await setupTestDb();
        for (const action of [
            'time_left', 'leaders', 'my_rank', 'pick_status', 'tournament_rules', 'how_to_claim',
        ] as const) {
            expect(await renderCalloutAction(action, scope, [])).toBeNull();
        }
    });
});

// ---------------------------------------------------------------------------
// 7. GET /:roomId/admin/discord/channels
// ---------------------------------------------------------------------------

const mockDiscord = vi.hoisted(() => ({
    ready: true,
    inGuild: true,
    channels: [] as Array<{ id: string; name: string; parent: string | null }>,
    client: null as unknown,
}));

vi.mock('../discord/DiscordClient.js', () => ({
    getDiscordClient: () => mockDiscord.client,
}));

describe('GET /:roomId/admin/discord/channels', () => {
    let roomId: string;

    const superToken = () => signToken({ userId: 'super', username: 'super', role: 'super_admin' } as any);
    const otherRoomToken = (id: string) =>
        signToken({ userId: 'ra', username: 'ra', role: 'room_admin', gameRoomIds: [id] } as any);

    async function createApp() {
        const roomsRouter = (await import('../api/routes/rooms.js')).default;
        const app = express();
        app.use(express.json());
        app.use('/api/rooms', roomsRouter);
        return app;
    }

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom('channels-room', 'Channels Room');
        mockDiscord.client = {
            isReady: () => mockDiscord.ready,
            isInGuild: () => mockDiscord.inGuild,
            listGuildTextChannels: () => mockDiscord.channels,
        };
        mockDiscord.ready = true;
        mockDiscord.inGuild = true;
        mockDiscord.channels = [
            { id: '1', name: 'general', parent: 'TEXT CHANNELS' },
            { id: '2', name: 'scores', parent: null },
        ];
    });

    it('returns the channel list for a linked, joined guild', async () => {
        const app = await createApp();
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-1');

        const res = await request(app)
            .get(`/api/rooms/${roomId}/admin/discord/channels`)
            .set('Authorization', `Bearer ${superToken()}`);
        expect(res.status).toBe(200);
        expect(res.body.channels).toEqual([
            { id: '1', name: 'general', parent: 'TEXT CHANNELS' },
            { id: '2', name: 'scores', parent: null },
        ]);
    });

    it('400s with distinct copy for each failure mode', async () => {
        const app = await createApp();

        // No guild linked.
        let res = await request(app)
            .get(`/api/rooms/${roomId}/admin/discord/channels`)
            .set('Authorization', `Bearer ${superToken()}`);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/no Discord server linked/);

        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-1');

        // Gateway down.
        mockDiscord.ready = false;
        res = await request(app)
            .get(`/api/rooms/${roomId}/admin/discord/channels`)
            .set('Authorization', `Bearer ${superToken()}`);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/isn't connected/);

        // Bot not in the guild.
        mockDiscord.ready = true;
        mockDiscord.inGuild = false;
        res = await request(app)
            .get(`/api/rooms/${roomId}/admin/discord/channels`)
            .set('Authorization', `Bearer ${superToken()}`);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/isn't a member/);
    });

    it('is room-scoped: anonymous 401s, an admin of ANOTHER room 403s', async () => {
        const app = await createApp();
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-1');
        const otherRoom = await createTestRoom('other-room', 'Other');

        expect((await request(app).get(`/api/rooms/${roomId}/admin/discord/channels`)).status)
            .toBe(401);
        expect((await request(app)
            .get(`/api/rooms/${roomId}/admin/discord/channels`)
            .set('Authorization', `Bearer ${otherRoomToken(otherRoom)}`)).status).toBe(403);
    });
});
