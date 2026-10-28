import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildBotInviteUrl, BOT_INVITE_PERMISSIONS } from '../utils/discordBotInvite.js';
import { setupTestDb } from './helpers.js';

// G6 — the "add the bot to your server" link.

describe('buildBotInviteUrl', () => {
    it('is null without a client id', () => {
        expect(buildBotInviteUrl(undefined)).toBeNull();
        expect(buildBotInviteUrl('  ')).toBeNull();
    });

    it('builds the bot + slash-command invite with the shared permission set', () => {
        const url = new URL(buildBotInviteUrl('1478923808873255094')!);
        expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
        expect(url.searchParams.get('client_id')).toBe('1478923808873255094');
        expect(url.searchParams.get('scope')).toBe('bot applications.commands');
        expect(url.searchParams.get('permissions')).toBe(BOT_INVITE_PERMISSIONS);
        expect(url.searchParams.has('guild_id')).toBe(false);
    });

    it('permission set = view, send, embed, attach, history, polls', () => {
        const bits = BigInt(BOT_INVITE_PERMISSIONS);
        const expected = (1n << 10n) | (1n << 11n) | (1n << 14n) | (1n << 15n) | (1n << 16n) | (1n << 49n);
        expect(bits).toBe(expected);
    });

    it('pre-selects a server only for a Discord-shaped id', () => {
        expect(new URL(buildBotInviteUrl('1', '123456789012345678')!).searchParams.get('guild_id')).toBe('123456789012345678');
        expect(new URL(buildBotInviteUrl('1', 'not-a-guild')!).searchParams.has('guild_id')).toBe(false);
        expect(new URL(buildBotInviteUrl('1', '')!).searchParams.has('guild_id')).toBe(false);
    });
});

describe('GET /api/auth/discord/bot-invite', () => {
    const saved = process.env.DISCORD_CLIENT_ID;
    afterEach(() => {
        if (saved === undefined) delete process.env.DISCORD_CLIENT_ID; else process.env.DISCORD_CLIENT_ID = saved;
    });

    let testApp: express.Express;
    beforeAll(async () => {
        await setupTestDb();
        const { default: authRouter } = await import('../api/routes/auth.js');
        testApp = express();
        testApp.use('/api/auth', authRouter);
    }, 60_000);
    const app = async () => testApp;

    it('answers the link, with the server pre-selected, without auth', async () => {
        process.env.DISCORD_CLIENT_ID = '1478923808873255094';
        const res = await request(await app()).get('/api/auth/discord/bot-invite?guildId=123456789012345678');
        expect(res.status).toBe(200);
        const url = new URL(res.body.url);
        expect(url.searchParams.get('client_id')).toBe('1478923808873255094');
        expect(url.searchParams.get('guild_id')).toBe('123456789012345678');
    });

    it('answers url null when the Discord application is not configured', async () => {
        delete process.env.DISCORD_CLIENT_ID;
        const res = await request(await app()).get('/api/auth/discord/bot-invite');
        expect(res.status).toBe(200);
        expect(res.body.url).toBeNull();
    });
});
