import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import crypto from 'crypto';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { LinkNonceStore } from '../services/LinkNonceStore.js';
import { SettingsService } from '../services/SettingsService.js';
import { NotificationService } from '../services/NotificationService.js';
import { DmNudgeService } from '../services/DmNudgeService.js';
import {
    DiscordReachabilityService,
    GLOBAL_DISCORD_GUILD_ID,
    GLOBAL_DISCORD_INVITE_URL,
} from '../services/DiscordReachabilityService.js';
import { sendDirectMessage, isCannotDmError } from '../utils/discord.js';
import { drainBackgroundTasks } from '../utils/backgroundTasks.js';

/**
 * Discord HQ arc (v2.72.0) — global community server + web notification settings.
 *
 * The thing under test throughout is a promise the product must not break: a
 * bot can DM a user only while they share a server with it, so every surface
 * here either KNOWS that's true or says it doesn't. Discord.js is mocked
 * wholesale — nothing in this file touches the network.
 */

// ---------------------------------------------------------------------------
// Gateway mock. `getDiscordClient()` is the accessor every reachability read
// goes through; swapping its return value is the whole seam.
// ---------------------------------------------------------------------------

interface FakeClient {
    isReady(): boolean;
    isMemberOfGuild(guildId: string, userId: string): Promise<boolean>;
}

let fakeClient: FakeClient | null = null;

vi.mock('../discord/DiscordClient.js', () => ({
    getDiscordClient: () => fakeClient,
}));

/** Gateway up, with an explicit `guildId -> members` map. */
function gatewayWithMembership(membership: Record<string, string[]>): void {
    fakeClient = {
        isReady: () => true,
        isMemberOfGuild: async (guildId, userId) => (membership[guildId] ?? []).includes(userId),
    };
}

/** Gateway down — the "we couldn't tell" case, which must never suppress a DM. */
function gatewayDown(): void {
    fakeClient = null;
}

const USER = '111122223333444455';
const OTHER_USER = '999988887777666655';
const HQ_GUILD = 'hq-guild-1';
const ROOM_GUILD = 'room-guild-1';

function playerToken(userId = USER) {
    return signToken({ role: 'player', gameRoomIds: [], discordId: userId, provider: 'discord' });
}

async function setGlobalGuild(guildId: string | null): Promise<void> {
    if (guildId) await SettingsService.saveMany({ [GLOBAL_DISCORD_GUILD_ID]: guildId });
    else await SettingsService.saveMany({ [GLOBAL_DISCORD_GUILD_ID]: '' });
}

/** A room whose Discord integration points at `guildId`. */
async function createDiscordRoom(guildId: string, opts: { enabled?: boolean; name?: string } = {}) {
    // createTestRoom returns the room id string, not a row object.
    const roomId = await createTestRoom(`room-${guildId}`, opts.name ?? 'Pinball Palace');
    const db = await getDatabase();
    await db.run(
        `INSERT INTO game_room_settings (game_room_id, key, value) VALUES (?, 'DISCORD_GUILD_ID', ?)`,
        roomId, guildId,
    );
    if (opts.enabled === false) {
        await db.run(
            `INSERT INTO game_room_settings (game_room_id, key, value) VALUES (?, 'DISCORD_ENABLED', 'false')`,
            roomId,
        );
    }
    return roomId;
}

beforeEach(async () => {
    await setupTestDb();
    DiscordReachabilityService._resetForTesting();
    NotificationService._resetForTesting();
    LinkNonceStore._clearAll();
    gatewayDown();
    delete process.env.PUBLIC_URL;
    process.env.DISCORD_BOT_TOKEN = 'test-bot-token';
    process.env.DISCORD_CLIENT_ID = 'test-client-id';
    process.env.DISCORD_CLIENT_SECRET = 'test-client-secret';
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

// ===========================================================================
// Section 1 — canDm verdicts
// ===========================================================================

describe('DiscordReachabilityService.canDm — deliverability verdicts', () => {
    it('reports via:global for a member of the community server', async () => {
        await setGlobalGuild(HQ_GUILD);
        gatewayWithMembership({ [HQ_GUILD]: [USER] });

        const verdict = await DiscordReachabilityService.canDm(USER);
        expect(verdict).toMatchObject({ reachable: true, via: 'global', gatewayReady: true });
    });

    it('reports via:room_guild (naming the room) for a member of a room server', async () => {
        await setGlobalGuild(HQ_GUILD);
        await createDiscordRoom(ROOM_GUILD, { name: 'Pinball Palace' });
        gatewayWithMembership({ [ROOM_GUILD]: [USER] });

        const verdict = await DiscordReachabilityService.canDm(USER);
        expect(verdict).toMatchObject({ reachable: true, via: 'room_guild', viaRoomName: 'Pinball Palace' });
    });

    it('reports unreachable when the user is in neither', async () => {
        await setGlobalGuild(HQ_GUILD);
        await createDiscordRoom(ROOM_GUILD);
        gatewayWithMembership({ [HQ_GUILD]: [OTHER_USER], [ROOM_GUILD]: [OTHER_USER] });

        const verdict = await DiscordReachabilityService.canDm(USER);
        expect(verdict).toMatchObject({ reachable: false, via: null, gatewayReady: true });
    });

    it('flags gatewayReady:false — and never claims reachability — when the gateway is down', async () => {
        await setGlobalGuild(HQ_GUILD);
        gatewayDown();

        const verdict = await DiscordReachabilityService.canDm(USER);
        expect(verdict).toMatchObject({ reachable: false, via: null, gatewayReady: false });
    });

    it('does not cache a gateway-down verdict — the answer is "unknown", not "no"', async () => {
        await setGlobalGuild(HQ_GUILD);
        gatewayDown();
        expect((await DiscordReachabilityService.canDm(USER)).gatewayReady).toBe(false);

        gatewayWithMembership({ [HQ_GUILD]: [USER] });
        expect(await DiscordReachabilityService.canDm(USER)).toMatchObject({ reachable: true, via: 'global' });
    });

    it('ignores guilds of rooms with Discord switched off', async () => {
        // That room's DMs are suppressed by NotificationService step 0a, so
        // claiming reachability through it would promise a message we refuse
        // to send.
        await createDiscordRoom(ROOM_GUILD, { enabled: false });
        gatewayWithMembership({ [ROOM_GUILD]: [USER] });

        expect(await DiscordReachabilityService.canDm(USER)).toMatchObject({ reachable: false });
    });

    it('answers unreachable for a google identity without touching the gateway', async () => {
        await setGlobalGuild(HQ_GUILD);
        const probe = vi.fn(async () => true);
        fakeClient = { isReady: () => true, isMemberOfGuild: probe };

        expect(await DiscordReachabilityService.canDm('google:sub-abc')).toMatchObject({ reachable: false });
        expect(probe).not.toHaveBeenCalled();
    });

    it('caches a positive verdict instead of re-fetching per call', async () => {
        await setGlobalGuild(HQ_GUILD);
        const probe = vi.fn(async () => true);
        fakeClient = { isReady: () => true, isMemberOfGuild: probe };

        await DiscordReachabilityService.canDm(USER);
        await DiscordReachabilityService.canDm(USER);
        expect(probe).toHaveBeenCalledTimes(1);
    });

    it('invalidate() drops the cache so a fresh join shows up immediately', async () => {
        await setGlobalGuild(HQ_GUILD);
        gatewayWithMembership({ [HQ_GUILD]: [] });
        expect((await DiscordReachabilityService.canDm(USER)).reachable).toBe(false);

        gatewayWithMembership({ [HQ_GUILD]: [USER] });
        DiscordReachabilityService.invalidate(USER);
        expect((await DiscordReachabilityService.canDm(USER)).reachable).toBe(true);
    });
});

describe('DiscordReachabilityService — configuration', () => {
    it('is unconfigured, and answers unreachable, with no guild id set', async () => {
        gatewayWithMembership({ [HQ_GUILD]: [USER] });
        expect(await DiscordReachabilityService.isConfigured()).toBe(false);
        expect((await DiscordReachabilityService.canDm(USER)).reachable).toBe(false);
    });

    it('rejects a non-https invite URL rather than serving it to users', async () => {
        await SettingsService.saveMany({ [GLOBAL_DISCORD_INVITE_URL]: 'javascript:alert(1)' });
        expect(await DiscordReachabilityService.getInviteUrl()).toBeNull();

        await SettingsService.saveMany({ [GLOBAL_DISCORD_INVITE_URL]: 'https://discord.gg/arcaid' });
        expect(await DiscordReachabilityService.getInviteUrl()).toBe('https://discord.gg/arcaid');
    });
});

// ===========================================================================
// Section 2 — settings endpoints + both-surface pref parity
// ===========================================================================

async function createGlobalApp() {
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    return app;
}

describe('GET/PUT /api/me/notification-settings', () => {
    it('401s without a token', async () => {
        const app = await createGlobalApp();
        expect((await request(app).get('/api/me/notification-settings')).status).toBe(401);
    });

    it('round-trips the five typed opt-ins', async () => {
        const app = await createGlobalApp();
        const put = await request(app)
            .put('/api/me/notification-settings')
            .set('Authorization', `Bearer ${playerToken()}`)
            .send({ prefs: { tournamentWin: true, friendScore: true } });
        expect(put.status).toBe(200);
        expect(put.body.prefs).toMatchObject({ tournamentWin: true, friendScore: true });

        const get = await request(app)
            .get('/api/me/notification-settings')
            .set('Authorization', `Bearer ${playerToken()}`);
        expect(get.body.prefs).toMatchObject({ tournamentWin: true, friendScore: true });
    });

    it('drops unknown keys so a crafted body cannot forge channel flags or the nudge', async () => {
        const app = await createGlobalApp();
        await NotificationService.mergePrefs(USER, { webPush: true });

        const res = await request(app)
            .put('/api/me/notification-settings')
            .set('Authorization', `Bearer ${playerToken()}`)
            .send({ prefs: { tournamentWin: true, webPush: false, _dmNudge: { failedAt: 'x', reason: 'send_failed' } } });

        // webPush survives untouched; the forged nudge never lands.
        expect(res.body.prefs.webPush).toBe(true);
        expect(res.body.nudge).toBeNull();
    });

    it('renders prefs written by the Discord command, and vice versa (one storage, two surfaces)', async () => {
        const app = await createGlobalApp();
        // Discord-command side: the slash command writes through mergePrefs.
        await NotificationService.mergePrefs(USER, { rankDethroned: true });

        const get = await request(app)
            .get('/api/me/notification-settings')
            .set('Authorization', `Bearer ${playerToken()}`);
        expect(get.body.prefs.rankDethroned).toBe(true);

        // Web side: a PUT here is what the command would read back.
        await request(app)
            .put('/api/me/notification-settings')
            .set('Authorization', `Bearer ${playerToken()}`)
            .send({ prefs: { turnToPick: true } });
        expect(await NotificationService.getPrefs(USER)).toMatchObject({ rankDethroned: true, turnToPick: true });
    });

    it('makes no reachability claims and offers no connect button when unconfigured', async () => {
        const app = await createGlobalApp();
        gatewayWithMembership({ [HQ_GUILD]: [USER] });

        const res = await request(app)
            .get('/api/me/notification-settings')
            .set('Authorization', `Bearer ${playerToken()}`);
        expect(res.body.discord).toMatchObject({
            reachable: false,
            via: null,
            connectAvailable: false,
            inviteUrl: null,
        });
    });

    it('offers the connect flow once the community server is configured', async () => {
        await setGlobalGuild(HQ_GUILD);
        await SettingsService.saveMany({ [GLOBAL_DISCORD_INVITE_URL]: 'https://discord.gg/arcaid' });
        gatewayWithMembership({ [HQ_GUILD]: [] });
        const app = await createGlobalApp();

        const res = await request(app)
            .get('/api/me/notification-settings')
            .set('Authorization', `Bearer ${playerToken()}`);
        expect(res.body.discord).toMatchObject({
            available: true,
            reachable: false,
            connectAvailable: true,
            inviteUrl: 'https://discord.gg/arcaid',
        });
    });

    it('reports available:false for a google identity (no Discord account to DM)', async () => {
        await setGlobalGuild(HQ_GUILD);
        const app = await createGlobalApp();
        const res = await request(app)
            .get('/api/me/notification-settings')
            .set('Authorization', `Bearer ${playerToken('google:sub-abc')}`);
        expect(res.body.discord).toMatchObject({ available: false, connectAvailable: false });
    });
});

// ===========================================================================
// Section 3 — connect flow
// ===========================================================================

async function createAuthApp() {
    const app = express();
    app.use(express.json());
    const { default: authRouter } = await import('../api/routes/auth.js');
    app.use('/api/auth', authRouter);
    return app;
}

/** Discord OAuth + guild-join mock. `joinStatus` 201 = added, 204 = already in. */
function mockConnectFetch(opts: {
    userId?: string;
    scope?: string;
    joinStatus?: number;
    joinBody?: string;
} = {}) {
    const joins: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (url === 'https://discord.com/api/oauth2/token') {
            return {
                ok: true,
                json: async () => ({ access_token: 'user-access-token', scope: opts.scope ?? 'identify guilds.join' }),
            } as any;
        }
        if (url === 'https://discord.com/api/users/@me') {
            return { ok: true, json: async () => ({ id: opts.userId ?? USER }) } as any;
        }
        if (url.includes('/guilds/') && init?.method === 'PUT') {
            joins.push(url);
            const status = opts.joinStatus ?? 201;
            return {
                status,
                ok: status < 300,
                text: async () => opts.joinBody ?? '',
            } as any;
        }
        throw new Error(`Unexpected fetch URL in test: ${url}`);
    }));
    return joins;
}

describe('GET /api/auth/discord/connect-notifications — start', () => {
    it('401s without a token', async () => {
        const app = await createAuthApp();
        expect((await request(app).get('/api/auth/discord/connect-notifications')).status).toBe(401);
    });

    it('400s when the community server is not configured', async () => {
        const app = await createAuthApp();
        const res = await request(app)
            .get('/api/auth/discord/connect-notifications?redirectUri=https://arcaid.app/auth/discord/callback')
            .set('Authorization', `Bearer ${playerToken()}`);
        expect(res.status).toBe(400);
    });

    it('400s for a google identity — there is no Discord account to add', async () => {
        await setGlobalGuild(HQ_GUILD);
        const app = await createAuthApp();
        const res = await request(app)
            .get('/api/auth/discord/connect-notifications?redirectUri=https://arcaid.app/auth/discord/callback')
            .set('Authorization', `Bearer ${playerToken('google:sub-abc')}`);
        expect(res.status).toBe(400);
    });

    it('returns an authorize URL requesting identify + guilds.join, with a connect: state', async () => {
        await setGlobalGuild(HQ_GUILD);
        const app = await createAuthApp();
        const res = await request(app)
            .get('/api/auth/discord/connect-notifications?redirectUri=https://arcaid.app/auth/discord/callback')
            .set('Authorization', `Bearer ${playerToken()}`);

        expect(res.status).toBe(200);
        const url = new URL(res.body.authorizeUrl);
        expect(url.searchParams.get('scope')).toBe('identify guilds.join');
        expect(url.searchParams.get('state')).toBe(`connect:${res.body.nonce}`);
    });

    it('rejects a redirectUri pointing off-site', async () => {
        await setGlobalGuild(HQ_GUILD);
        process.env.PUBLIC_URL = 'https://arcaid.app';
        const app = await createAuthApp();
        const res = await request(app)
            .get('/api/auth/discord/connect-notifications?redirectUri=https://evil.example/steal')
            .set('Authorization', `Bearer ${playerToken()}`);
        expect(res.status).toBe(400);
    });
});

describe('POST /api/auth/discord/connect-notifications/callback', () => {
    beforeEach(async () => { await setGlobalGuild(HQ_GUILD); });

    it('joins the guild and reports a fresh membership', async () => {
        const joins = mockConnectFetch({ joinStatus: 201 });
        const app = await createAuthApp();
        const nonce = LinkNonceStore.create(USER);

        const res = await request(app)
            .post('/api/auth/discord/connect-notifications/callback')
            .set('Authorization', `Bearer ${playerToken()}`)
            .send({ code: 'abc', redirectUri: 'https://arcaid.app/auth/discord/callback', nonce });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ ok: true, alreadyMember: false });
        expect(joins).toHaveLength(1);
        expect(joins[0]).toContain(`/guilds/${HQ_GUILD}/members/${USER}`);
    });

    it('treats an existing member (204) as success — the flow is idempotent', async () => {
        mockConnectFetch({ joinStatus: 204 });
        const app = await createAuthApp();
        const nonce = LinkNonceStore.create(USER);

        const res = await request(app)
            .post('/api/auth/discord/connect-notifications/callback')
            .set('Authorization', `Bearer ${playerToken()}`)
            .send({ code: 'abc', redirectUri: 'https://arcaid.app/auth/discord/callback', nonce });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ ok: true, alreadyMember: true });
    });

    it('rejects an invalid or expired nonce', async () => {
        mockConnectFetch();
        const app = await createAuthApp();
        const res = await request(app)
            .post('/api/auth/discord/connect-notifications/callback')
            .set('Authorization', `Bearer ${playerToken()}`)
            .send({ code: 'abc', redirectUri: 'https://arcaid.app/auth/discord/callback', nonce: 'not-a-nonce' });
        expect(res.status).toBe(400);
    });

    it('rejects a replayed nonce — single use', async () => {
        mockConnectFetch();
        const app = await createAuthApp();
        const nonce = LinkNonceStore.create(USER);
        const body = { code: 'abc', redirectUri: 'https://arcaid.app/auth/discord/callback', nonce };

        expect((await request(app).post('/api/auth/discord/connect-notifications/callback')
            .set('Authorization', `Bearer ${playerToken()}`).send(body)).status).toBe(200);
        expect((await request(app).post('/api/auth/discord/connect-notifications/callback')
            .set('Authorization', `Bearer ${playerToken()}`).send(body)).status).toBe(400);
    });

    it('403s when the nonce was minted by a different account', async () => {
        const joins = mockConnectFetch();
        const app = await createAuthApp();
        const nonce = LinkNonceStore.create(OTHER_USER);

        const res = await request(app)
            .post('/api/auth/discord/connect-notifications/callback')
            .set('Authorization', `Bearer ${playerToken(USER)}`)
            .send({ code: 'abc', redirectUri: 'https://arcaid.app/auth/discord/callback', nonce });

        expect(res.status).toBe(403);
        expect(joins).toHaveLength(0);
    });

    it('403s when the authorizing Discord account is not the signed-in one', async () => {
        const joins = mockConnectFetch({ userId: OTHER_USER });
        const app = await createAuthApp();
        const nonce = LinkNonceStore.create(USER);

        const res = await request(app)
            .post('/api/auth/discord/connect-notifications/callback')
            .set('Authorization', `Bearer ${playerToken(USER)}`)
            .send({ code: 'abc', redirectUri: 'https://arcaid.app/auth/discord/callback', nonce });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('IDENTITY_MISMATCH');
        expect(joins).toHaveLength(0);
    });

    it('explains a declined guilds.join consent instead of failing opaquely at the PUT', async () => {
        const joins = mockConnectFetch({ scope: 'identify' });
        const app = await createAuthApp();
        const nonce = LinkNonceStore.create(USER);

        const res = await request(app)
            .post('/api/auth/discord/connect-notifications/callback')
            .set('Authorization', `Bearer ${playerToken()}`)
            .send({ code: 'abc', redirectUri: 'https://arcaid.app/auth/discord/callback', nonce });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('CONSENT_DECLINED');
        expect(joins).toHaveLength(0);
    });

    it("surfaces Discord's own message when the join is refused", async () => {
        mockConnectFetch({ joinStatus: 403, joinBody: JSON.stringify({ message: 'Missing Permissions' }) });
        const app = await createAuthApp();
        const nonce = LinkNonceStore.create(USER);

        const res = await request(app)
            .post('/api/auth/discord/connect-notifications/callback')
            .set('Authorization', `Bearer ${playerToken()}`)
            .send({ code: 'abc', redirectUri: 'https://arcaid.app/auth/discord/callback', nonce });

        expect(res.status).toBe(502);
        expect(res.body.error).toContain('Missing Permissions');
    });

    it('400s when the community server is unset (nothing to join)', async () => {
        await setGlobalGuild(null);
        mockConnectFetch();
        const app = await createAuthApp();
        const nonce = LinkNonceStore.create(USER);

        const res = await request(app)
            .post('/api/auth/discord/connect-notifications/callback')
            .set('Authorization', `Bearer ${playerToken()}`)
            .send({ code: 'abc', redirectUri: 'https://arcaid.app/auth/discord/callback', nonce });
        expect(res.status).toBe(400);
    });

    it('clears a standing nudge on a successful join', async () => {
        mockConnectFetch({ joinStatus: 201 });
        await DmNudgeService.record(USER, 'send_failed', 'tournamentWin');
        expect(await DmNudgeService.get(USER)).not.toBeNull();

        const app = await createAuthApp();
        const nonce = LinkNonceStore.create(USER);
        await request(app)
            .post('/api/auth/discord/connect-notifications/callback')
            .set('Authorization', `Bearer ${playerToken()}`)
            .send({ code: 'abc', redirectUri: 'https://arcaid.app/auth/discord/callback', nonce });

        expect(await DmNudgeService.get(USER)).toBeNull();
    });
});

// ===========================================================================
// Section 4 — failure-driven nudge
// ===========================================================================

describe('isCannotDmError — classifying Discord rejections', () => {
    it('recognises 50007 (cannot send messages to this user)', () => {
        expect(isCannotDmError({ code: 50007 })).toBe(true);
        expect(isCannotDmError({ rawError: { code: 50007 } })).toBe(true);
    });

    it('does NOT treat transient failures as un-DM-able', () => {
        // Nudging someone to fix their privacy settings over a rate limit or a
        // network blip would be a lie.
        expect(isCannotDmError({ code: 429 })).toBe(false);
        expect(isCannotDmError(new Error('socket hang up'))).toBe(false);
        expect(isCannotDmError(undefined)).toBe(false);
    });
});

describe('DM failure → nudge → dismissal', () => {
    it('raises the nudge when Discord rejects the DM with 50007', async () => {
        const err = Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
        vi.stubGlobal('fetch', vi.fn(async () => { throw err; }));
        // discord.js REST wraps fetch; stub the REST post path directly instead.
        const { REST } = await import('discord.js');
        vi.spyOn(REST.prototype, 'post').mockRejectedValue(err);

        expect(await sendDirectMessage(USER, 'hello')).toBe(false);
        await drainBackgroundTasks();

        const nudge = await DmNudgeService.get(USER);
        expect(nudge).toMatchObject({ reason: 'send_failed' });
    });

    it('does not raise the nudge on a transient failure', async () => {
        const { REST } = await import('discord.js');
        vi.spyOn(REST.prototype, 'post').mockRejectedValue(new Error('ECONNRESET'));

        await sendDirectMessage(USER, 'hello');
        await drainBackgroundTasks();

        expect(await DmNudgeService.get(USER)).toBeNull();
    });

    it('clears the nudge on the next successful DM', async () => {
        await DmNudgeService.record(USER, 'send_failed', 'tournamentWin');
        const { REST } = await import('discord.js');
        vi.spyOn(REST.prototype, 'post').mockResolvedValue({ id: 'dm-channel-1' } as never);

        expect(await sendDirectMessage(USER, 'hello')).toBe(true);
        await drainBackgroundTasks();

        expect(await DmNudgeService.get(USER)).toBeNull();
    });

    it('keeps the first failure timestamp across repeated failures', async () => {
        await DmNudgeService.record(USER, 'send_failed', 'tournamentWin');
        const first = await DmNudgeService.get(USER);
        await new Promise(r => setTimeout(r, 5));
        await DmNudgeService.record(USER, 'send_failed', 'rankDethroned');

        expect((await DmNudgeService.get(USER))?.failedAt).toBe(first?.failedAt);
    });

    it('never records for a google identity (it has no DM channel to fail)', async () => {
        await DmNudgeService.record('google:sub-abc', 'send_failed');
        expect(await DmNudgeService.get('google:sub-abc')).toBeNull();
    });

    it('serves the nudge over the API and clears it on dismiss', async () => {
        await DmNudgeService.record(USER, 'send_failed', 'tournamentWin');
        const app = await createGlobalApp();

        const before = await request(app)
            .get('/api/me/dm-nudge')
            .set('Authorization', `Bearer ${playerToken()}`);
        expect(before.body.nudge).toMatchObject({ reason: 'send_failed', type: 'tournamentWin' });

        await request(app)
            .post('/api/me/dm-nudge/dismiss')
            .set('Authorization', `Bearer ${playerToken()}`);

        const after = await request(app)
            .get('/api/me/dm-nudge')
            .set('Authorization', `Bearer ${playerToken()}`);
        expect(after.body.nudge).toBeNull();
    });

    it('survives alongside the other keys in the shared prefs blob', async () => {
        await NotificationService.mergePrefs(USER, { webPush: true, tournamentWin: true });
        await DmNudgeService.record(USER, 'send_failed');
        await DmNudgeService.clear(USER);

        expect(await NotificationService.getPrefs(USER)).toMatchObject({ tournamentWin: true });
        const app = await createGlobalApp();
        const res = await request(app)
            .get('/api/me/notification-settings')
            .set('Authorization', `Bearer ${playerToken()}`);
        expect(res.body.prefs.webPush).toBe(true);
    });
});

// ===========================================================================
// Section 5 — known-unreachable short-circuit
// ===========================================================================

describe('NotificationService — known-unreachable short-circuit', () => {
    beforeEach(async () => {
        await NotificationService.mergePrefs(USER, { tournamentWin: true });
    });

    it('skips the send and raises the nudge for an opted-in unreachable user', async () => {
        await setGlobalGuild(HQ_GUILD);
        gatewayWithMembership({ [HQ_GUILD]: [] });
        const { REST } = await import('discord.js');
        const post = vi.spyOn(REST.prototype, 'post').mockResolvedValue({ id: 'dm-1' } as never);

        const delivered = await NotificationService.notify({
            userId: USER, type: 'tournamentWin', message: 'You won!',
        });
        await drainBackgroundTasks();

        expect(delivered).toBe(false);
        expect(post).not.toHaveBeenCalled();
        expect(await DmNudgeService.get(USER)).toMatchObject({ reason: 'unreachable', type: 'tournamentWin' });
    });

    it('sends normally for a reachable user', async () => {
        await setGlobalGuild(HQ_GUILD);
        gatewayWithMembership({ [HQ_GUILD]: [USER] });
        const { REST } = await import('discord.js');
        const post = vi.spyOn(REST.prototype, 'post').mockResolvedValue({ id: 'dm-1' } as never);

        expect(await NotificationService.notify({
            userId: USER, type: 'tournamentWin', message: 'You won!',
        })).toBe(true);
        expect(post).toHaveBeenCalled();
        expect(await DmNudgeService.get(USER)).toBeNull();
    });

    it('still sends when the gateway is down — "we could not tell" never suppresses', async () => {
        // Reachability reads the gateway cache, but DMs ride REST. Suppressing
        // here would turn a cosmetic outage into silent notification loss.
        await setGlobalGuild(HQ_GUILD);
        gatewayDown();
        const { REST } = await import('discord.js');
        const post = vi.spyOn(REST.prototype, 'post').mockResolvedValue({ id: 'dm-1' } as never);

        expect(await NotificationService.notify({
            userId: USER, type: 'tournamentWin', message: 'You won!',
        })).toBe(true);
        expect(post).toHaveBeenCalled();
    });

    it('never short-circuits while the community server is unconfigured (ships inert)', async () => {
        gatewayWithMembership({ [HQ_GUILD]: [] });
        const { REST } = await import('discord.js');
        const post = vi.spyOn(REST.prototype, 'post').mockResolvedValue({ id: 'dm-1' } as never);

        expect(await NotificationService.notify({
            userId: USER, type: 'tournamentWin', message: 'You won!',
        })).toBe(true);
        expect(post).toHaveBeenCalled();
        expect(await DmNudgeService.get(USER)).toBeNull();
    });
});

// ===========================================================================
// Room-scoped Discord link nudge (2026-08-17)
//
// The owner's first instinct was to pop a modal at every Google-signed-in
// player in a Discord room, and again on every score submission. Both halves
// are wrong: the trigger is REACHABILITY not login provider (a linked Google
// login is fine; an unlinked Discord login sharing no guild is not), and a
// per-submission modal nags the players who deliberately chose not to link —
// for a restriction that does not even exist, since submitting never required
// Discord. These pin the honest-silence rules that replaced it.
// ===========================================================================

describe('GET /api/me/dm-nudge?roomId= — room Discord link status', () => {
    async function seedDiscordRoom(opts: { enabled?: string; guild?: string | null; invite?: string | null } = {}) {
        const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');
        const db = await getDatabase();
        const roomId = crypto.randomUUID();
        await db.run(
            `INSERT INTO game_rooms (id, slug, name) VALUES (?, ?, ?)`,
            roomId, 'nudge-room-' + roomId.slice(0, 8), 'RTX_Pinball',
        );
        if (opts.enabled !== undefined) await GameRoomSettingsService.set(roomId, 'DISCORD_ENABLED', opts.enabled);
        if (opts.guild !== null) await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', opts.guild ?? '999888777');
        if (opts.invite) await GameRoomSettingsService.set(roomId, 'DISCORD_INVITE_URL', opts.invite);
        return roomId;
    }

    it('a Google-only viewer in a Discord room is told to LINK', async () => {
        const app = await createGlobalApp();
        const roomId = await seedDiscordRoom({ invite: 'https://discord.gg/rtx' });
        const res = await request(app)
            .get(`/api/me/dm-nudge?roomId=${roomId}`)
            .set('Authorization', `Bearer ${signToken({ role: 'player', gameRoomIds: [], discordId: 'google:12345', provider: 'google' })}`);

        expect(res.status).toBe(200);
        expect(res.body.discordLink).toMatchObject({ state: 'no_discord', roomName: 'RTX_Pinball' });
    });

    it('says NOTHING when the room has no Discord integration', async () => {
        const app = await createGlobalApp();
        const roomId = await seedDiscordRoom({ enabled: 'false' });
        const res = await request(app)
            .get(`/api/me/dm-nudge?roomId=${roomId}`)
            .set('Authorization', `Bearer ${signToken({ role: 'player', gameRoomIds: [], discordId: 'google:12345', provider: 'google' })}`);

        expect(res.body.discordLink).toBeNull();
    });

    it('says NOTHING when the room has Discord on but no guild configured', async () => {
        const app = await createGlobalApp();
        const roomId = await seedDiscordRoom({ guild: null });
        const res = await request(app)
            .get(`/api/me/dm-nudge?roomId=${roomId}`)
            .set('Authorization', `Bearer ${signToken({ role: 'player', gameRoomIds: [], discordId: 'google:12345', provider: 'google' })}`);

        expect(res.body.discordLink).toBeNull();
    });

    it('says NOTHING for a Discord viewer when the gateway cannot answer (never nag on uncertainty)', async () => {
        const app = await createGlobalApp();
        const roomId = await seedDiscordRoom();
        // No live Discord client in tests, so reachability is indeterminate.
        const res = await request(app)
            .get(`/api/me/dm-nudge?roomId=${roomId}`)
            .set('Authorization', `Bearer ${playerToken()}`);

        expect(res.body.discordLink).toBeNull();
    });

    it('omits the status entirely when no roomId is supplied (the global banner case)', async () => {
        const app = await createGlobalApp();
        const res = await request(app)
            .get('/api/me/dm-nudge')
            .set('Authorization', `Bearer ${playerToken()}`);

        expect(res.status).toBe(200);
        expect(res.body.discordLink).toBeNull();
    });

    it('rejects a non-https invite url rather than rendering it', async () => {
        const app = await createGlobalApp();
        const roomId = await seedDiscordRoom({ invite: 'javascript:alert(1)' });
        const res = await request(app)
            .get(`/api/me/dm-nudge?roomId=${roomId}`)
            .set('Authorization', `Bearer ${signToken({ role: 'player', gameRoomIds: [], discordId: 'google:12345', provider: 'google' })}`);

        expect(res.body.discordLink.inviteUrl).toBeNull();
    });
});
