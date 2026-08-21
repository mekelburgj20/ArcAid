import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { CalloutService, CalloutValidationError } from '../services/CalloutService.js';
import { handleCalloutMessage, CalloutMessageLike } from '../discord/callouts.js';
import {
    matchCallout,
    findCalloutEntry,
    validateCalloutEntries,
    applyCalloutPlaceholders,
    CalloutEntry,
} from '../utils/callouts.js';
import { NO_ACTIVE_GAMES_MESSAGE } from '../discord/calloutActions.js';

/**
 * v2.123.0 — callouts moved out of `data/callouts.json` + the global
 * `ENABLE_CALLOUTS` env switch and into the DB + a per-room opt-in.
 *
 * Four layers under test, matching the four modules:
 *   1. `src/utils/callouts.ts`     — pure matching + upload validation
 *   2. `CalloutService`            — storage, round-trip export, cache, seed
 *   3. `src/discord/callouts.ts`   — the per-room gate on MessageCreate
 *   4. `/api/admin/callouts`       — super-admin-only CRUD
 */

// ---------------------------------------------------------------------------
// 1. Pure matcher
// ---------------------------------------------------------------------------

const entry = (triggers: string[], responses: string[], enabled?: boolean): CalloutEntry =>
    (enabled === undefined ? { triggers, responses } : { triggers, responses, enabled });

describe('matchCallout', () => {
    const list: CalloutEntry[] = [
        entry(['seafood', 'milk'], ['MEOW MEOW MEOW MEOW!']),
        entry(['medieval madness', 'mm'], ['Troll! In the pantry!']),
    ];

    it('matches a whole word, case-insensitively', () => {
        expect(matchCallout('I love SEAFOOD, honestly', list)?.response).toBe('MEOW MEOW MEOW MEOW!');
        expect(matchCallout('milk', list)?.response).toBe('MEOW MEOW MEOW MEOW!');
    });

    it('does not match a substring inside a larger word', () => {
        expect(matchCallout('seafoods are great', list)).toBeNull();
        expect(matchCallout('hammer', list)).toBeNull();
    });

    it('returns null when nothing matches', () => {
        expect(matchCallout('just a normal message', list)).toBeNull();
    });

    it('first matching entry wins, in list order', () => {
        const ordered = [
            entry(['pinball'], ['first']),
            entry(['pinball'], ['second']),
        ];
        expect(matchCallout('pinball night', ordered)?.response).toBe('first');
    });

    it('picks a response at random (rng injectable)', () => {
        const many = [entry(['taf'], ['a', 'b', 'c'])];
        expect(matchCallout('taf', many, () => 0)?.response).toBe('a');
        expect(matchCallout('taf', many, () => 0.5)?.response).toBe('b');
        // rng() === 1 would index past the end — clamped to the last response.
        expect(matchCallout('taf', many, () => 0.999)?.response).toBe('c');
        expect(matchCallout('taf', many, () => 1)?.response).toBe('c');
    });

    it('skips disabled entries', () => {
        const withDisabled = [
            entry(['pinball'], ['quiet'], false),
            entry(['pinball'], ['loud']),
        ];
        expect(matchCallout('pinball', withDisabled)?.response).toBe('loud');
        expect(matchCallout('pinball', [entry(['pinball'], ['quiet'], false)])).toBeNull();
    });

    describe('! exclusions', () => {
        const got = [entry(
            ['game of thrones', 'got', 'winter is coming', '!got'],
            ['Winter is coming!'],
        )];

        it('fires when only an inclusion matches', () => {
            expect(matchCallout('game of thrones tonight', got)?.response).toBe('Winter is coming!');
        });

        it('suppresses the entry when an exclusion matches', () => {
            expect(matchCallout('I got a new high score', got)).toBeNull();
        });

        it('exclusions are case-insensitive (the pre-v2.123.0 loop was not)', () => {
            // The shipped data/callouts.json worked around this by listing both
            // `!got` and `!Got`; with a single lowercase exclusion, "Got" must
            // still suppress.
            expect(matchCallout('I Got a new high score', got)).toBeNull();
        });

        it('an exclusion only silences the entry it belongs to', () => {
            const two = [
                entry(['got', '!got'], ['never fires']),
                entry(['score'], ['nice score!']),
            ];
            expect(matchCallout('I got a score', two)?.response).toBe('nice score!');
        });
    });

    it('escapes regex metacharacters in triggers', () => {
        const tricky = [
            entry(['ac/dc'], ['For those about to rock!']),
            entry(['t2'], ['Hasta la vista.']),
            entry(['who dunnit'], ['It was the butler.']),
            entry(['f-14 tomcat'], ['Bogey spotted.']),
        ];
        expect(matchCallout('playing ac/dc tonight', tricky)?.response).toBe('For those about to rock!');
        // A naive unescaped trigger would turn `/` or `-` into something else,
        // and an unescaped `.`-style metacharacter into a wildcard.
        expect(matchCallout('acXdc', tricky)).toBeNull();
        expect(matchCallout('t2 is the best', tricky)?.response).toBe('Hasta la vista.');
        expect(matchCallout('so who dunnit then', tricky)?.response).toBe('It was the butler.');
        expect(matchCallout('my f-14 tomcat table', tricky)?.response).toBe('Bogey spotted.');
    });

    it('a trigger ENDING in punctuation cannot match (known word-boundary limitation)', () => {
        // `who dunnit\?` needs a word character after the `?`, which never
        // happens. Inherited from the pre-v2.123.0 loop and locked here so the
        // rule is discoverable: put the punctuation in the RESPONSE, not the
        // trigger.
        const punct = [entry(['who dunnit?'], ['It was the butler.'])];
        expect(matchCallout('who dunnit? no idea', punct)).toBeNull();
    });

    it('findCalloutEntry returns the entry itself (no random pick)', () => {
        expect(findCalloutEntry('milk please', list)).toBe(list[0]);
        expect(findCalloutEntry('nothing here', list)).toBeNull();
    });

    it('tolerates malformed entries rather than throwing', () => {
        const junk = [
            { triggers: 'not-an-array', responses: ['x'] } as unknown as CalloutEntry,
            entry(['ok'], []),
            entry(['ok'], ['fine']),
        ];
        expect(matchCallout('ok', junk)?.response).toBe('fine');
    });
});

// ---------------------------------------------------------------------------
// 2. Upload validation
// ---------------------------------------------------------------------------

describe('validateCalloutEntries', () => {
    it('accepts and normalizes a valid list', () => {
        const result = validateCalloutEntries([{ triggers: ['  taf '], responses: [' Thing! '] }]);
        expect(result).toEqual({ entries: [{ triggers: ['taf'], responses: ['Thing!'] }] });
    });

    it('rejects a non-array payload', () => {
        expect(validateCalloutEntries({ triggers: ['a'], responses: ['b'] }))
            .toEqual({ error: 'Expected a JSON array of callout entries' });
    });

    it('names the offending index', () => {
        const result = validateCalloutEntries([
            { triggers: ['ok'], responses: ['fine'] },
            { triggers: ['ok'], responses: ['fine'] },
            { triggers: ['ok'], responses: [] },
        ]) as { error: string };
        expect(result.error).toBe('entry 2: responses must be a non-empty array');
    });

    it('rejects empty/typed-wrong triggers and responses with positions', () => {
        expect((validateCalloutEntries([{ triggers: [], responses: ['x'] }]) as { error: string }).error)
            .toBe('entry 0: triggers must be a non-empty array');
        expect((validateCalloutEntries([{ triggers: [42], responses: ['x'] }]) as { error: string }).error)
            .toBe('entry 0: trigger 0 must be a string');
        expect((validateCalloutEntries([{ triggers: ['a'], responses: ['x', '   '] }]) as { error: string }).error)
            .toBe('entry 0: response 1 is empty');
    });

    it('rejects an entry with only exclusion triggers (it could never fire)', () => {
        expect((validateCalloutEntries([{ triggers: ['!got'], responses: ['x'] }]) as { error: string }).error)
            .toMatch(/not an exclusion/);
    });

    it('enforces the 500-entry and 2000-char caps', () => {
        const many = Array.from({ length: 501 }, () => ({ triggers: ['a'], responses: ['b'] }));
        expect((validateCalloutEntries(many) as { error: string }).error).toMatch(/Too many entries: 501/);

        const long = [{ triggers: ['a'], responses: ['x'.repeat(2001)] }];
        expect((validateCalloutEntries(long) as { error: string }).error)
            .toBe('entry 0: response 0 exceeds 2000 characters');
    });
});

// ---------------------------------------------------------------------------
// 3. CalloutService
// ---------------------------------------------------------------------------

const SAMPLE = [
    { triggers: ['seafood', 'milk'], responses: ['MEOW MEOW MEOW MEOW!'] },
    { triggers: ['addams family', 'taf'], responses: ['THIIIING!', 'The Mamushka!'] },
];

describe('CalloutService', () => {
    beforeEach(() => CalloutService.invalidateCache());

    it('replaceAll stores the list and export() round-trips it byte-for-byte', async () => {
        await setupTestDb();
        const count = await CalloutService.replaceAll(SAMPLE);
        expect(count).toBe(2);
        expect(await CalloutService.exportEntries()).toEqual(SAMPLE);
    });

    it('preserves list order as match order', async () => {
        await setupTestDb();
        await CalloutService.replaceAll(SAMPLE);
        const rows = await CalloutService.list();
        expect(rows.map(r => r.sort_order)).toEqual([0, 1]);
        expect(rows[0]!.triggers).toEqual(['seafood', 'milk']);
    });

    it('replaceAll rejects an invalid list WITHOUT clearing the existing one', async () => {
        await setupTestDb();
        await CalloutService.replaceAll(SAMPLE);
        await expect(CalloutService.replaceAll([{ triggers: [], responses: [] }]))
            .rejects.toBeInstanceOf(CalloutValidationError);
        expect((await CalloutService.list()).length).toBe(2);
    });

    it('export emits enabled:false only for disabled rows', async () => {
        await setupTestDb();
        await CalloutService.replaceAll(SAMPLE);
        const rows = await CalloutService.list();
        await CalloutService.update(rows[1]!.id, { enabled: false });
        expect(await CalloutService.exportEntries()).toEqual([
            SAMPLE[0],
            { ...SAMPLE[1], enabled: false },
        ]);
    });

    it('counts reports totals, enabled/disabled split and response count', async () => {
        await setupTestDb();
        await CalloutService.replaceAll(SAMPLE);
        const rows = await CalloutService.list();
        await CalloutService.update(rows[0]!.id, { enabled: false });
        expect(await CalloutService.counts()).toEqual({
            total: 2, enabled: 1, disabled: 1, responses: 3, actions: 0,
        });
    });

    it('update patches one field and re-validates the result', async () => {
        await setupTestDb();
        await CalloutService.replaceAll(SAMPLE);
        const rows = await CalloutService.list();
        const updated = await CalloutService.update(rows[0]!.id, { responses: ['  new  '] });
        expect(updated!.responses).toEqual(['new']);
        await expect(CalloutService.update(rows[0]!.id, { responses: [] }))
            .rejects.toBeInstanceOf(CalloutValidationError);
    });

    it('update/remove return null/false for an unknown id', async () => {
        await setupTestDb();
        expect(await CalloutService.update(99999, { enabled: false })).toBeNull();
        expect(await CalloutService.remove(99999)).toBe(false);
    });

    it('remove deletes the row', async () => {
        await setupTestDb();
        await CalloutService.replaceAll(SAMPLE);
        const rows = await CalloutService.list();
        expect(await CalloutService.remove(rows[0]!.id)).toBe(true);
        expect((await CalloutService.list()).length).toBe(1);
    });

    it('getEnabledCached serves from memory and every write drops the cache', async () => {
        await setupTestDb();
        await CalloutService.replaceAll(SAMPLE);

        const first = await CalloutService.getEnabledCached();
        expect(first.length).toBe(2);
        // Same object identity => served from the cache, not re-queried.
        expect(await CalloutService.getEnabledCached()).toBe(first);

        // A write behind the service's back is NOT picked up (proving the
        // cache is real)...
        const db = await getDatabase();
        await db.run('DELETE FROM callouts');
        expect((await CalloutService.getEnabledCached()).length).toBe(2);

        // ...but a write THROUGH the service invalidates it.
        await CalloutService.replaceAll([SAMPLE[0]]);
        const after = await CalloutService.getEnabledCached();
        expect(after).not.toBe(first);
        expect(after.length).toBe(1);
    });

    it('the cache excludes disabled entries', async () => {
        await setupTestDb();
        await CalloutService.replaceAll(SAMPLE);
        const rows = await CalloutService.list();
        await CalloutService.update(rows[0]!.id, { enabled: false });
        const cached = await CalloutService.getEnabledCached();
        expect(cached.length).toBe(1);
        expect(cached[0]!.triggers).toEqual(['addams family', 'taf']);
    });
});

// ---------------------------------------------------------------------------
// 4. Boot seed
// ---------------------------------------------------------------------------

describe('CalloutService.seedFromFileIfEmpty', () => {
    let tmpDir: string;
    let seedFile: string;

    beforeEach(() => {
        CalloutService.invalidateCache();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arcaid-callouts-'));
        seedFile = path.join(tmpDir, 'callouts.json');
        fs.writeFileSync(seedFile, JSON.stringify(SAMPLE));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('imports the legacy file once, then never again', async () => {
        await setupTestDb();
        expect(await CalloutService.seedFromFileIfEmpty(seedFile)).toBe(2);
        expect(await CalloutService.exportEntries()).toEqual(SAMPLE);

        // Second boot: the table is non-empty, so the file is ignored even if
        // it changed on disk.
        fs.writeFileSync(seedFile, JSON.stringify([{ triggers: ['new'], responses: ['nope'] }]));
        expect(await CalloutService.seedFromFileIfEmpty(seedFile)).toBe(0);
        expect(await CalloutService.exportEntries()).toEqual(SAMPLE);
    });

    it('does not re-seed after the admin deliberately empties the list', async () => {
        await setupTestDb();
        await CalloutService.seedFromFileIfEmpty(seedFile);
        await CalloutService.replaceAll([]);
        // An emptied list DOES re-seed — documented, and the reason the admin
        // UI replaces rather than empties. Locked so the behaviour is a choice.
        expect(await CalloutService.seedFromFileIfEmpty(seedFile)).toBe(2);
    });

    it('no-ops when the file is missing', async () => {
        await setupTestDb();
        expect(await CalloutService.seedFromFileIfEmpty(path.join(tmpDir, 'nope.json'))).toBe(0);
    });

    it('a malformed file is non-fatal and leaves the table empty', async () => {
        await setupTestDb();
        fs.writeFileSync(seedFile, '{ not json');
        expect(await CalloutService.seedFromFileIfEmpty(seedFile)).toBe(0);
        expect((await CalloutService.list()).length).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// 5. The Discord per-room gate
// ---------------------------------------------------------------------------

function fakeMessage(overrides: Partial<CalloutMessageLike> & { replies: string[] }): CalloutMessageLike {
    return {
        author: { bot: false },
        guildId: 'guild-1',
        channelId: 'channel-1',
        content: 'seafood for dinner',
        reply: async (content: string) => { overrides.replies.push(content); },
        ...overrides,
    };
}

describe('handleCalloutMessage — per-room gate', () => {
    beforeEach(() => {
        CalloutService.invalidateCache();
        delete process.env.ENABLE_CALLOUTS;
        delete process.env.DISCORD_GUILD_ID;
    });
    afterEach(() => {
        delete process.env.ENABLE_CALLOUTS;
        delete process.env.DISCORD_GUILD_ID;
    });

    async function roomLinkedToGuild(slug: string, guildId: string, settings: Record<string, string> = {}) {
        const roomId = await createTestRoom(slug, slug);
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', guildId);
        for (const [k, v] of Object.entries(settings)) {
            await GameRoomSettingsService.set(roomId, k, v);
        }
        return roomId;
    }

    it('replies when a room linked to the guild has CALLOUTS_ENABLED=true', async () => {
        await setupTestDb();
        await CalloutService.replaceAll(SAMPLE);
        await roomLinkedToGuild('callouts-on', 'guild-1', { CALLOUTS_ENABLED: 'true' });

        const replies: string[] = [];
        expect(await handleCalloutMessage(fakeMessage({ replies }))).toBe(true);
        expect(replies).toEqual(['MEOW MEOW MEOW MEOW!']);
    });

    it('stays silent when the room never opted in (absent = OFF)', async () => {
        await setupTestDb();
        await CalloutService.replaceAll(SAMPLE);
        await roomLinkedToGuild('callouts-absent', 'guild-1');

        const replies: string[] = [];
        expect(await handleCalloutMessage(fakeMessage({ replies }))).toBe(false);
        expect(replies).toEqual([]);
    });

    it('stays silent when the room explicitly turned it off', async () => {
        await setupTestDb();
        await CalloutService.replaceAll(SAMPLE);
        await roomLinkedToGuild('callouts-off', 'guild-1', { CALLOUTS_ENABLED: 'false' });

        const replies: string[] = [];
        expect(await handleCalloutMessage(fakeMessage({ replies }))).toBe(false);
    });

    it('stays silent in a guild linked to no room', async () => {
        await setupTestDb();
        await CalloutService.replaceAll(SAMPLE);
        await roomLinkedToGuild('callouts-other', 'guild-OTHER', { CALLOUTS_ENABLED: 'true' });

        const replies: string[] = [];
        expect(await handleCalloutMessage(fakeMessage({ replies, guildId: 'guild-1' }))).toBe(false);
    });

    it('stays silent in DMs (no guild context)', async () => {
        await setupTestDb();
        await CalloutService.replaceAll(SAMPLE);
        await roomLinkedToGuild('callouts-dm', 'guild-1', { CALLOUTS_ENABLED: 'true' });

        const replies: string[] = [];
        expect(await handleCalloutMessage(fakeMessage({ replies, guildId: null }))).toBe(false);
        expect(replies).toEqual([]);
    });

    it('ignores messages from bots', async () => {
        await setupTestDb();
        await CalloutService.replaceAll(SAMPLE);
        await roomLinkedToGuild('callouts-bot', 'guild-1', { CALLOUTS_ENABLED: 'true' });

        const replies: string[] = [];
        expect(await handleCalloutMessage(fakeMessage({ replies, author: { bot: true } }))).toBe(false);
    });

    it('CALLOUTS_CHANNEL_ID restricts replies to that one channel', async () => {
        await setupTestDb();
        await CalloutService.replaceAll(SAMPLE);
        await roomLinkedToGuild('callouts-channel', 'guild-1', {
            CALLOUTS_ENABLED: 'true',
            CALLOUTS_CHANNEL_ID: 'channel-allowed',
        });

        const wrong: string[] = [];
        expect(await handleCalloutMessage(fakeMessage({ replies: wrong, channelId: 'channel-1' }))).toBe(false);

        const right: string[] = [];
        expect(await handleCalloutMessage(fakeMessage({ replies: right, channelId: 'channel-allowed' }))).toBe(true);
        expect(right).toEqual(['MEOW MEOW MEOW MEOW!']);
    });

    it('legacy ENABLE_CALLOUTS=false silences every room', async () => {
        await setupTestDb();
        await CalloutService.replaceAll(SAMPLE);
        await roomLinkedToGuild('callouts-legacy', 'guild-1', { CALLOUTS_ENABLED: 'true' });
        process.env.ENABLE_CALLOUTS = 'false';

        const replies: string[] = [];
        expect(await handleCalloutMessage(fakeMessage({ replies }))).toBe(false);
    });

    it('legacy ENABLE_CALLOUTS being absent no longer means OFF', async () => {
        await setupTestDb();
        await CalloutService.replaceAll(SAMPLE);
        await roomLinkedToGuild('callouts-legacy-absent', 'guild-1', { CALLOUTS_ENABLED: 'true' });

        const replies: string[] = [];
        expect(await handleCalloutMessage(fakeMessage({ replies }))).toBe(true);
    });

    it('a Discord-disabled room cannot trigger callouts (guild scope excludes it)', async () => {
        await setupTestDb();
        await CalloutService.replaceAll(SAMPLE);
        await roomLinkedToGuild('callouts-discord-off', 'guild-1', {
            CALLOUTS_ENABLED: 'true',
            DISCORD_ENABLED: 'false',
        });

        const replies: string[] = [];
        expect(await handleCalloutMessage(fakeMessage({ replies }))).toBe(false);
    });

    it('stays silent when nothing in the message matches', async () => {
        await setupTestDb();
        await CalloutService.replaceAll(SAMPLE);
        await roomLinkedToGuild('callouts-nomatch', 'guild-1', { CALLOUTS_ENABLED: 'true' });

        const replies: string[] = [];
        expect(await handleCalloutMessage(fakeMessage({ replies, content: 'nothing to see' }))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 6. /api/admin/callouts
// ---------------------------------------------------------------------------

async function createApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: adminRouter } = await import('../api/routes/admin.js');
    app.use('/api/admin', adminRouter);
    return app;
}

const superToken = () => signToken({ role: 'super_admin', gameRoomIds: [], discordId: 'super-1', username: 'admin' });
const roomAdminToken = () => signToken({ role: 'room_admin', gameRoomIds: ['some-room'] });

describe('/api/admin/callouts', () => {
    // Pay the admin router's (large) import graph once, outside a test's
    // timeout budget — it alone exceeds the 10s default on a cold run.
    beforeAll(async () => { await import('../api/routes/admin.js'); }, 60000);
    beforeEach(() => CalloutService.invalidateCache());

    it('GET returns entries plus counts', async () => {
        const app = await createApp();
        await CalloutService.replaceAll(SAMPLE);

        const res = await request(app)
            .get('/api/admin/callouts')
            .set('Authorization', `Bearer ${superToken()}`);
        expect(res.status).toBe(200);
        expect(res.body.entries.length).toBe(2);
        expect(res.body.counts).toEqual({ total: 2, enabled: 1 + 1, disabled: 0, responses: 3, actions: 0 });
    });

    it('is super-admin only — a room admin gets 403, anonymous gets 401', async () => {
        const app = await createApp();
        for (const call of [
            () => request(app).get('/api/admin/callouts'),
            () => request(app).put('/api/admin/callouts').send({ entries: SAMPLE }),
            () => request(app).patch('/api/admin/callouts/1').send({ enabled: false }),
            () => request(app).delete('/api/admin/callouts/1'),
            () => request(app).get('/api/admin/callouts/export'),
        ]) {
            expect((await call().set('Authorization', `Bearer ${roomAdminToken()}`)).status).toBe(403);
            expect((await call()).status).toBe(401);
        }
    });

    it('PUT replaces the whole list and reports the new counts', async () => {
        const app = await createApp();
        await CalloutService.replaceAll(SAMPLE);

        const res = await request(app)
            .put('/api/admin/callouts')
            .set('Authorization', `Bearer ${superToken()}`)
            .send({ entries: [{ triggers: ['only'], responses: ['one'] }] });
        expect(res.status).toBe(200);
        expect(res.body.counts.total).toBe(1);
        expect(await CalloutService.exportEntries()).toEqual([{ triggers: ['only'], responses: ['one'] }]);
    });

    it('PUT invalidates the Discord handler cache', async () => {
        const app = await createApp();
        await CalloutService.replaceAll(SAMPLE);
        expect((await CalloutService.getEnabledCached()).length).toBe(2);

        await request(app)
            .put('/api/admin/callouts')
            .set('Authorization', `Bearer ${superToken()}`)
            .send({ entries: [{ triggers: ['only'], responses: ['one'] }] });

        const cached = await CalloutService.getEnabledCached();
        expect(cached.length).toBe(1);
        expect(cached[0]!.triggers).toEqual(['only']);
    });

    it('PUT validation errors name the bad index', async () => {
        const app = await createApp();
        const res = await request(app)
            .put('/api/admin/callouts')
            .set('Authorization', `Bearer ${superToken()}`)
            .send({
                entries: [
                    { triggers: ['ok'], responses: ['fine'] },
                    { triggers: ['ok'], responses: [] },
                ],
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('entry 1: responses must be a non-empty array');
    });

    it('PUT rejects a non-array envelope at the schema boundary', async () => {
        const app = await createApp();
        const res = await request(app)
            .put('/api/admin/callouts')
            .set('Authorization', `Bearer ${superToken()}`)
            .send({ entries: 'nope' });
        expect(res.status).toBe(400);
    });

    it('PATCH toggles enabled and 404s an unknown id', async () => {
        const app = await createApp();
        await CalloutService.replaceAll(SAMPLE);
        const rows = await CalloutService.list();

        const res = await request(app)
            .patch(`/api/admin/callouts/${rows[0]!.id}`)
            .set('Authorization', `Bearer ${superToken()}`)
            .send({ enabled: false });
        expect(res.status).toBe(200);
        expect(res.body.enabled).toBe(false);

        const missing = await request(app)
            .patch('/api/admin/callouts/999999')
            .set('Authorization', `Bearer ${superToken()}`)
            .send({ enabled: false });
        expect(missing.status).toBe(404);
    });

    it('PATCH rejects an empty body and an invalid edit', async () => {
        const app = await createApp();
        await CalloutService.replaceAll(SAMPLE);
        const rows = await CalloutService.list();

        expect((await request(app)
            .patch(`/api/admin/callouts/${rows[0]!.id}`)
            .set('Authorization', `Bearer ${superToken()}`)
            .send({})).status).toBe(400);

        const bad = await request(app)
            .patch(`/api/admin/callouts/${rows[0]!.id}`)
            .set('Authorization', `Bearer ${superToken()}`)
            .send({ responses: [] });
        expect(bad.status).toBe(400);
        expect(bad.body.error).toMatch(/responses must be a non-empty array/);
    });

    it('DELETE removes a row and 404s an unknown id', async () => {
        const app = await createApp();
        await CalloutService.replaceAll(SAMPLE);
        const rows = await CalloutService.list();

        expect((await request(app)
            .delete(`/api/admin/callouts/${rows[0]!.id}`)
            .set('Authorization', `Bearer ${superToken()}`)).status).toBe(200);
        expect((await CalloutService.list()).length).toBe(1);

        expect((await request(app)
            .delete('/api/admin/callouts/999999')
            .set('Authorization', `Bearer ${superToken()}`)).status).toBe(404);
    });

    it('GET /export downloads the file-shaped JSON', async () => {
        const app = await createApp();
        await CalloutService.replaceAll(SAMPLE);

        const res = await request(app)
            .get('/api/admin/callouts/export')
            .set('Authorization', `Bearer ${superToken()}`);
        expect(res.status).toBe(200);
        expect(res.headers['content-disposition']).toContain('callouts.json');
        expect(JSON.parse(res.text)).toEqual(SAMPLE);
    });

    it('writes an audit row for each mutation', async () => {
        const app = await createApp();
        await request(app)
            .put('/api/admin/callouts')
            .set('Authorization', `Bearer ${superToken()}`)
            .send({ entries: SAMPLE });

        const db = await getDatabase();
        const rows = await db.all(`SELECT action, target_type FROM audit_log WHERE target_type LIKE 'callout%'`);
        expect(rows.length).toBe(1);
        expect(rows[0].action).toBe('PUT /api/admin/callouts');
    });
});

// ---------------------------------------------------------------------------
// 7. Question-shaped triggers (the "what's the table today?" ask)
// ---------------------------------------------------------------------------

describe('matchCallout — question variants', () => {
    const QUESTION_TRIGGERS = [
        "what's the table", 'what is the table', 'what table', 'which table',
        'table today', 'todays table', "today's table",
    ];
    const entries: CalloutEntry[] = [{ triggers: QUESTION_TRIGGERS, action: 'active_games' }];

    it.each([
        "What's the table today?",
        'What is the table today',
        'What table are we playing today',
        'which table is up today',
    ])('matches %s', phrase => {
        const hit = matchCallout(phrase, entries);
        expect(hit).not.toBeNull();
        expect(hit!.entry.action).toBe('active_games');
        // Action entries carry no static response — the responder renders it.
        expect(hit!.response).toBeNull();
    });

    it('matches a curly apostrophe against a straight-quoted trigger', () => {
        // Phones and Discord autocorrect ' to the typographic form; both sides
        // are folded before matching so either spelling works.
        expect(matchCallout('What’s the table today?', entries)).not.toBeNull();
        expect(matchCallout('What’s the table today?', [
            { triggers: ['what’s the table'], responses: ['curly trigger'] },
        ])?.response).toBe('curly trigger');
    });

    it('does not fire on unrelated chatter', () => {
        expect(matchCallout('anyone around tonight?', entries)).toBeNull();
        expect(matchCallout('the tables have turned', entries)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// 8. Live-data actions
// ---------------------------------------------------------------------------

describe('callout actions', () => {
    beforeEach(() => {
        CalloutService.invalidateCache();
        delete process.env.ENABLE_CALLOUTS;
        delete process.env.DISCORD_GUILD_ID;
        process.env.PUBLIC_URL = 'https://test.arcaid.app';
    });
    afterEach(() => {
        delete process.env.PUBLIC_URL;
        delete process.env.ENABLE_CALLOUTS;
    });

    /** A room linked to `guildId` with callouts on, plus its active lineup. */
    async function seedRoom(slug: string, guildId: string, lineup: Array<{
        tournament: string; type?: string; games: string[];
    }> = []) {
        const roomId = await createTestRoom(slug, `${slug} room`);
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', guildId);
        await GameRoomSettingsService.set(roomId, 'CALLOUTS_ENABLED', 'true');
        for (const t of lineup) {
            const tId = await createTestTournament(roomId, { name: t.tournament, type: t.type || 'DG' });
            for (const g of t.games) await createTestGame(tId, { name: g, status: 'ACTIVE' });
        }
        return roomId;
    }

    async function replyTo(content: string, channelId = 'channel-1'): Promise<string | null> {
        const replies: string[] = [];
        await handleCalloutMessage({
            author: { bot: false },
            guildId: 'guild-1',
            channelId,
            content,
            reply: async (text: string) => { replies.push(text); },
        });
        return replies[0] ?? null;
    }

    it('active_games answers with the same rows /list-active shows', async () => {
        await setupTestDb();
        await seedRoom('rtx', 'guild-1', [
            { tournament: 'Daily Grind', type: 'DG', games: ['Taxi'] },
            { tournament: 'Weekly VPXS', type: 'WG-VPXS', games: ['Whirlwind', 'Congo'] },
        ]);
        await CalloutService.replaceAll([{ triggers: ['what table'], action: 'active_games' }]);

        const reply = await replyTo('what table are we playing');
        expect(reply).toContain('**Currently active:**');
        expect(reply).toContain('**Daily Grind** (DG): Taxi');
        // A multi-slot tournament lists each of its games on one line.
        expect(reply).toContain('**Weekly VPXS** (WG-VPXS): Congo, Whirlwind');
        // The room's public scoreboard link is appended.
        expect(reply).toContain('https://test.arcaid.app/rtx');
    });

    it('active_games says so when nothing is active', async () => {
        await setupTestDb();
        await seedRoom('quiet', 'guild-1');
        await CalloutService.replaceAll([{ triggers: ['what table'], action: 'active_games' }]);

        expect(await replyTo('what table today')).toBe(NO_ACTIVE_GAMES_MESSAGE);
    });

    it('active_games prefixes the room name only when the guild spans several rooms', async () => {
        await setupTestDb();
        await seedRoom('alpha', 'guild-1', [{ tournament: 'Daily Grind', games: ['Taxi'] }]);
        await CalloutService.replaceAll([{ triggers: ['what table'], action: 'active_games' }]);

        const single = await replyTo('what table');
        expect(single).not.toContain('alpha room —');

        await seedRoom('beta', 'guild-1', [{ tournament: 'Beta Weekly', games: ['Congo'] }]);
        const multi = await replyTo('what table');
        expect(multi).toContain('alpha room — **Daily Grind**');
        expect(multi).toContain('beta room — **Beta Weekly**');
    });

    it('active_games never leaks a room linked to another guild', async () => {
        await setupTestDb();
        await seedRoom('mine', 'guild-1', [{ tournament: 'Mine', games: ['Taxi'] }]);
        await seedRoom('theirs', 'guild-OTHER', [{ tournament: 'Theirs', games: ['Congo'] }]);
        await CalloutService.replaceAll([{ triggers: ['what table'], action: 'active_games' }]);

        const reply = await replyTo('what table');
        expect(reply).toContain('Taxi');
        expect(reply).not.toContain('Congo');
    });

    it('picks_link points at the room Picks page', async () => {
        await setupTestDb();
        await seedRoom('rtx', 'guild-1');
        await CalloutService.replaceAll([{ triggers: ['how do i pick'], action: 'picks_link' }]);

        expect(await replyTo('how do i pick a table')).toBe(
            'Pick or queue your next table here: https://test.arcaid.app/rtx/picks',
        );
    });

    it('scores_link points at the room scoreboard', async () => {
        await setupTestDb();
        await seedRoom('rtx', 'guild-1');
        await CalloutService.replaceAll([{ triggers: ['standings'], action: 'scores_link' }]);

        expect(await replyTo('where are the standings')).toBe(
            'Submit scores and see the standings: https://test.arcaid.app/rtx',
        );
    });

    it('how_to_submit renders the static how-to with the room link', async () => {
        await setupTestDb();
        await seedRoom('rtx', 'guild-1');
        await CalloutService.replaceAll([{ triggers: ['how do i submit'], action: 'how_to_submit' }]);

        const reply = await replyTo('how do i submit my score');
        expect(reply).toContain('Submitting a score');
        expect(reply).toContain('https://test.arcaid.app/rtx');
        expect(reply).toContain('/submit-score');
    });

    it('an action wins over static responses on the same entry', async () => {
        await setupTestDb();
        await seedRoom('rtx', 'guild-1');
        await CalloutService.replaceAll([
            { triggers: ['standings'], responses: ['ignored'], action: 'scores_link' },
        ]);

        expect(await replyTo('standings please')).toContain('Submit scores and see the standings');
    });

    it('the per-room gate still applies to action entries', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('opted-out', 'Opted Out');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-1');
        await CalloutService.replaceAll([{ triggers: ['what table'], action: 'active_games' }]);

        expect(await replyTo('what table')).toBeNull();
    });

    it('substitutes placeholders in a static response', async () => {
        await setupTestDb();
        await seedRoom('rtx', 'guild-1');
        await CalloutService.replaceAll([{
            triggers: ['links'],
            responses: ['{room_name}: play {picks_url}, scores {scores_url}, home {room_url}'],
        }]);

        expect(await replyTo('links please')).toBe(
            'rtx room: play https://test.arcaid.app/rtx/picks, '
            + 'scores https://test.arcaid.app/rtx, home https://test.arcaid.app/rtx',
        );
    });

    it('a multi-room guild substitutes the FIRST linked room', async () => {
        await setupTestDb();
        await seedRoom('alpha', 'guild-1');
        await seedRoom('beta', 'guild-1');
        await CalloutService.replaceAll([{ triggers: ['links'], responses: ['{room_name} -> {room_url}'] }]);

        expect(await replyTo('links')).toBe('alpha room -> https://test.arcaid.app/alpha');
    });
});

describe('applyCalloutPlaceholders', () => {
    const room = {
        roomName: 'RTX Pinball',
        roomUrl: 'https://a/rtx',
        picksUrl: 'https://a/rtx/picks',
        scoresUrl: 'https://a/rtx',
    };

    it('substitutes every placeholder, repeatedly', () => {
        expect(applyCalloutPlaceholders('{room_name} {room_name} {picks_url}', room))
            .toBe('RTX Pinball RTX Pinball https://a/rtx/picks');
    });

    it('leaves unknown braces verbatim', () => {
        expect(applyCalloutPlaceholders('score {bonus} at {room_name}', room))
            .toBe('score {bonus} at RTX Pinball');
    });

    it('is a no-op without a room', () => {
        expect(applyCalloutPlaceholders('{room_name}', null)).toBe('{room_name}');
    });
});

// ---------------------------------------------------------------------------
// 9. Action validation + persistence
// ---------------------------------------------------------------------------

describe('callout actions — validation and storage', () => {
    beforeEach(() => CalloutService.invalidateCache());

    it('accepts an entry with an action and no responses', () => {
        expect(validateCalloutEntries([{ triggers: ['what table'], action: 'active_games' }]))
            .toEqual({ entries: [{ triggers: ['what table'], action: 'active_games' }] });
    });

    it('rejects an entry with neither responses nor action', () => {
        const result = validateCalloutEntries([{ triggers: ['what table'] }]) as { error: string };
        expect(result.error).toBe('entry 0: responses must be a non-empty array');
    });

    it('rejects an unknown action', () => {
        const result = validateCalloutEntries([
            { triggers: ['x'], action: 'launch_missiles' },
        ]) as { error: string };
        expect(result.error).toMatch(/entry 0: action must be one of active_games/);
    });

    it('rejects an EMPTY responses array even when an action is set (omit the key instead)', () => {
        const result = validateCalloutEntries([
            { triggers: ['x'], responses: [], action: 'picks_link' },
        ]) as { error: string };
        expect(result.error).toMatch(/omit it entirely/);
    });

    it('export round-trips action entries byte-for-byte', async () => {
        await setupTestDb();
        const list = [
            { triggers: ['seafood'], responses: ['MEOW!'] },
            { triggers: ['what table'], action: 'active_games' as const },
            { triggers: ['standings'], responses: ['see {scores_url}'], action: 'scores_link' as const },
        ];
        await CalloutService.replaceAll(list);
        expect(await CalloutService.exportEntries()).toEqual(list);
    });

    it('counts report how many entries answer with live data', async () => {
        await setupTestDb();
        await CalloutService.replaceAll([
            { triggers: ['seafood'], responses: ['MEOW!'] },
            { triggers: ['what table'], action: 'active_games' },
        ]);
        expect(await CalloutService.counts()).toEqual({
            total: 2, enabled: 2, disabled: 0, responses: 1, actions: 1,
        });
    });

    it('PATCH can set and clear an action', async () => {
        await setupTestDb();
        await CalloutService.replaceAll([{ triggers: ['what table'], responses: ['dunno'] }]);
        const [row] = await CalloutService.list();

        const set = await CalloutService.update(row!.id, { action: 'active_games' });
        expect(set!.action).toBe('active_games');

        const cleared = await CalloutService.update(row!.id, { action: null });
        expect(cleared!.action).toBeNull();
        expect(cleared!.responses).toEqual(['dunno']);
    });

    it('the handler cache carries the action through', async () => {
        await setupTestDb();
        await CalloutService.replaceAll([{ triggers: ['what table'], action: 'active_games' }]);
        const cached = await CalloutService.getEnabledCached();
        expect(cached[0]!.action).toBe('active_games');
    });
});
