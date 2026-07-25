import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { signToken } from '../api/auth.js';
import { conditionalRequireDiscordUser } from '../api/middleware.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';

// ---------------------------------------------------------------------------
// conditionalRequireDiscordUser — REQUIRE_DISCORD_LOGIN 3-state matrix
// (v2.35.0 Google-login contract, D4). Full cross product of
// {false, true, discord} x {guest, discord-token, google-token}.
// ---------------------------------------------------------------------------

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    app.get('/api/rooms/:roomId/probe', conditionalRequireDiscordUser('roomId'), (req, res) => {
        res.json({ ok: true, discordId: req.user?.discordId ?? null });
    });
    return app;
}

const discordToken = signToken({ role: 'player', gameRoomIds: [], discordId: '123456789012345678', provider: 'discord' });
const googleToken = signToken({ role: 'player', gameRoomIds: [], discordId: 'google:abc123', provider: 'google' });
// Legacy token minted before the provider claim existed — must behave as discord.
const legacyDiscordToken = signToken({ role: 'player', gameRoomIds: [], discordId: '987654321098765432' });

describe('conditionalRequireDiscordUser 3-state matrix', () => {
    it("REQUIRE_DISCORD_LOGIN='false' — guest, discord, and google all pass", async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('crd-false', 'CRD False');
        await GameRoomSettingsService.set(roomId, 'REQUIRE_DISCORD_LOGIN', 'false');

        const guestRes = await request(app).get(`/api/rooms/${roomId}/probe`);
        expect(guestRes.status).toBe(200);
        expect(guestRes.body.discordId).toBeNull();

        const discordRes = await request(app).get(`/api/rooms/${roomId}/probe`).set('Authorization', `Bearer ${discordToken}`);
        expect(discordRes.status).toBe(200);
        expect(discordRes.body.discordId).toBe('123456789012345678');

        const googleRes = await request(app).get(`/api/rooms/${roomId}/probe`).set('Authorization', `Bearer ${googleToken}`);
        expect(googleRes.status).toBe(200);
        expect(googleRes.body.discordId).toBe('google:abc123');
    });

    it("REQUIRE_DISCORD_LOGIN='true' — guest blocked, discord AND google pass (broadened semantics)", async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('crd-true', 'CRD True');
        await GameRoomSettingsService.set(roomId, 'REQUIRE_DISCORD_LOGIN', 'true');

        const guestRes = await request(app).get(`/api/rooms/${roomId}/probe`);
        expect(guestRes.status).toBe(401);

        const discordRes = await request(app).get(`/api/rooms/${roomId}/probe`).set('Authorization', `Bearer ${discordToken}`);
        expect(discordRes.status).toBe(200);

        const googleRes = await request(app).get(`/api/rooms/${roomId}/probe`).set('Authorization', `Bearer ${googleToken}`);
        expect(googleRes.status).toBe(200);

        // Legacy token (no provider claim) must be treated as discord and pass.
        const legacyRes = await request(app).get(`/api/rooms/${roomId}/probe`).set('Authorization', `Bearer ${legacyDiscordToken}`);
        expect(legacyRes.status).toBe(200);
    });

    it("REQUIRE_DISCORD_LOGIN='discord' — guest AND google blocked, only discord passes", async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('crd-discord', 'CRD Discord-only');
        await GameRoomSettingsService.set(roomId, 'REQUIRE_DISCORD_LOGIN', 'discord');

        const guestRes = await request(app).get(`/api/rooms/${roomId}/probe`);
        expect(guestRes.status).toBe(401);

        const googleRes = await request(app).get(`/api/rooms/${roomId}/probe`).set('Authorization', `Bearer ${googleToken}`);
        expect(googleRes.status).toBe(401);

        const discordRes = await request(app).get(`/api/rooms/${roomId}/probe`).set('Authorization', `Bearer ${discordToken}`);
        expect(discordRes.status).toBe(200);

        // Legacy token (no provider claim) derives discord via providerOfUserId and passes.
        const legacyRes = await request(app).get(`/api/rooms/${roomId}/probe`).set('Authorization', `Bearer ${legacyDiscordToken}`);
        expect(legacyRes.status).toBe(200);
    });
});
