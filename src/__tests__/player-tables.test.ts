import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import {
    PlayerTablesService, GameNotFoundError, PlatformInvalidError,
} from '../services/PlayerTablesService.js';

/**
 * C2 - My Tables (migration 204, PlayerTablesService). A player's inventory
 * is private; the only thing others see is a COUNT of distinct owners.
 */

let seq = 0;

async function seedGame(name: string, opts: { platforms?: string[]; localImagePath?: string | null; displayName?: string | null } = {}) {
    const db = await getDatabase();
    const id = `pt-gg-${++seq}`;
    await db.run(
        `INSERT INTO global_games (id, name, display_name, type, manufacturer, year, platforms, local_image_path, status)
         VALUES (?, ?, ?, 'pinball', 'Williams', 1997, ?, ?, 'approved')`,
        id, name, opts.displayName ?? null, JSON.stringify(opts.platforms ?? []), opts.localImagePath ?? null,
    );
    return id;
}

async function rowsFor(userId: string, gameId: string): Promise<string[]> {
    const db = await getDatabase();
    const rows = await db.all<Array<{ platform: string }>>(
        'SELECT platform FROM player_tables WHERE user_id = ? AND global_game_id = ? ORDER BY platform',
        userId, gameId,
    );
    return rows.map(r => r.platform);
}

async function globalApp() {
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    return app;
}

function token(discordId: string) {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username: 'Tester' });
}

beforeEach(async () => {
    await setupTestDb();
});

describe('PlayerTablesService.setOwnership', () => {
    it('[] stores exactly one generic row', async () => {
        const g = await seedGame('Medieval Madness');
        const t = await PlayerTablesService.setOwnership('u1', g, []);
        expect(await rowsFor('u1', g)).toEqual(['']);
        expect(t.platforms).toEqual([]);
        expect(t.global_game_id).toBe(g);
    });

    it('REPLACES the player rows for that game, dedupes, and drops the generic row', async () => {
        const g = await seedGame('Attack From Mars');
        await PlayerTablesService.setOwnership('u1', g, []);
        const t = await PlayerTablesService.setOwnership('u1', g, ['vpx', 'real', 'vpx', '']);
        expect(await rowsFor('u1', g)).toEqual(['real', 'vpx']);
        expect(t.platforms).toEqual(['real', 'vpx']);

        await PlayerTablesService.setOwnership('u1', g, ['fx']);
        expect(await rowsFor('u1', g)).toEqual(['fx']);

        // Back to generic.
        await PlayerTablesService.setOwnership('u1', g, []);
        expect(await rowsFor('u1', g)).toEqual(['']);
    });

    it('does not touch another player or another game', async () => {
        const a = await seedGame('Game A');
        const b = await seedGame('Game B');
        await PlayerTablesService.setOwnership('u2', a, ['vpx']);
        await PlayerTablesService.setOwnership('u1', b, ['real']);
        await PlayerTablesService.setOwnership('u1', a, []);
        expect(await rowsFor('u2', a)).toEqual(['vpx']);
        expect(await rowsFor('u1', b)).toEqual(['real']);
    });

    it('throws GameNotFoundError for an unknown game', async () => {
        await expect(PlayerTablesService.setOwnership('u1', 'nope', [])).rejects.toBeInstanceOf(GameNotFoundError);
    });

    it('throws PlatformInvalidError for a non-engine id and writes nothing', async () => {
        const g = await seedGame('Twilight Zone');
        await PlayerTablesService.setOwnership('u1', g, ['vpx']);
        await expect(PlayerTablesService.setOwnership('u1', g, ['vpx', 'ps5-ish'])).rejects.toBeInstanceOf(PlatformInvalidError);
        // The previous rows survive a refused save.
        expect(await rowsFor('u1', g)).toEqual(['vpx']);
    });

    it('removeOwnership deletes all rows and reports whether anything was removed', async () => {
        const g = await seedGame('Theatre of Magic');
        await PlayerTablesService.setOwnership('u1', g, ['vpx', 'real']);
        expect(await PlayerTablesService.removeOwnership('u1', g)).toBe(true);
        expect(await rowsFor('u1', g)).toEqual([]);
        expect(await PlayerTablesService.removeOwnership('u1', g)).toBe(false);
    });
});

describe('PlayerTablesService reads', () => {
    it('ownerCounts counts DISTINCT players and omits unowned ids', async () => {
        const a = await seedGame('Count A');
        const b = await seedGame('Count B');
        const c = await seedGame('Count C');
        await PlayerTablesService.setOwnership('u1', a, ['vpx', 'real']); // two rows, one player
        await PlayerTablesService.setOwnership('u2', a, []);
        await PlayerTablesService.setOwnership('u3', b, ['fx']);
        const counts = await PlayerTablesService.ownerCounts([a, b, c, a]);
        expect(counts).toEqual({ [a]: 2, [b]: 1 });
        expect(await PlayerTablesService.ownerCount(c)).toBe(0);
        expect(await PlayerTablesService.ownerCounts([])).toEqual({});
    });

    it('ownerCounts handles more ids than one IN chunk', async () => {
        const g = await seedGame('Big List');
        await PlayerTablesService.setOwnership('u1', g, []);
        const ids = Array.from({ length: 1200 }, (_, i) => `missing-${i}`);
        ids.splice(700, 0, g);
        expect(await PlayerTablesService.ownerCounts(ids)).toEqual({ [g]: 1 });
    });

    it('listForUser returns the OwnedTable shape sorted by name', async () => {
        const z = await seedGame('Zebra', { platforms: ['vpx', 'fx'] });
        const a = await seedGame('apple', { localImagePath: 'data/catalogue-images/apple.png' });
        const d = await seedGame('internal', { displayName: 'Display Name' });
        await PlayerTablesService.setOwnership('u1', z, ['vpx']);
        await PlayerTablesService.setOwnership('u1', a, []);
        await PlayerTablesService.setOwnership('u1', d, []);
        await PlayerTablesService.setOwnership('u2', z, []);

        const list = await PlayerTablesService.listForUser('u1');
        expect(list.map(t => t.name)).toEqual(['apple', 'Display Name', 'Zebra']);
        const zebra = list[2];
        expect(zebra).toMatchObject({
            global_game_id: z,
            manufacturer: 'Williams',
            year: 1997,
            type: 'pinball',
            catalogue_platforms: ['vpx', 'fx'],
            platforms: ['vpx'],
        });
        expect(typeof zebra.created_at).toBe('string');
        expect(list[0].platforms).toEqual([]);
        expect(typeof list[0].image_url).toBe('string');
        expect(await PlayerTablesService.listForUser('nobody')).toEqual([]);
    });

    it('ownedPlatforms / ownedGameIds', async () => {
        const a = await seedGame('Owned A');
        const b = await seedGame('Owned B');
        await PlayerTablesService.setOwnership('u1', a, ['real']);
        await PlayerTablesService.setOwnership('u1', b, []);
        expect(await PlayerTablesService.ownedPlatforms('u1', a)).toEqual(['real']);
        expect(await PlayerTablesService.ownedPlatforms('u1', b)).toEqual([]);
        expect(await PlayerTablesService.ownedPlatforms('u2', a)).toBeNull();
        expect((await PlayerTablesService.ownedGameIds('u1')).sort()).toEqual([a, b].sort());
    });
});

describe('My Tables routes', () => {
    it('PUT / GET / DELETE /api/me/tables round-trip, with error codes', async () => {
        const app = await globalApp();
        const g = await seedGame('Route Game', { platforms: ['vpx'] });
        const auth = { Authorization: `Bearer ${token('route-user')}` };

        expect((await request(app).get('/api/me/tables')).status).toBe(401);

        const put = await request(app).put(`/api/me/tables/${g}`).set(auth).send({ platforms: ['vpx'] });
        expect(put.status).toBe(200);
        expect(put.body.table.platforms).toEqual(['vpx']);

        const list = await request(app).get('/api/me/tables').set(auth);
        expect(list.status).toBe(200);
        expect(list.body.tables).toHaveLength(1);

        expect((await request(app).put(`/api/me/tables/${g}`).set(auth).send({})).status).toBe(400);
        const bad = await request(app).put(`/api/me/tables/${g}`).set(auth).send({ platforms: ['nope'] });
        expect(bad.status).toBe(400);
        expect(bad.body.error).toBe('PLATFORM_INVALID');
        const missing = await request(app).put('/api/me/tables/no-such-game').set(auth).send({ platforms: [] });
        expect(missing.status).toBe(404);
        expect(missing.body.error).toBe('GAME_NOT_FOUND');

        const del = await request(app).delete(`/api/me/tables/${g}`).set(auth);
        expect(del.body).toEqual({ ok: true, removed: true });
        const del2 = await request(app).delete(`/api/me/tables/${g}`).set(auth);
        expect(del2.body).toEqual({ ok: true, removed: false });
    });

    it('GET /api/global/games/:id/owners: count for all, mine only for a viewer, never names', async () => {
        const app = await globalApp();
        const g = await seedGame('Owners Game');
        await PlayerTablesService.setOwnership('owner-1', g, ['vpx']);
        await PlayerTablesService.setOwnership('owner-2', g, []);

        const anon = await request(app).get(`/api/global/games/${g}/owners`);
        expect(anon.status).toBe(200);
        expect(anon.body).toEqual({ count: 2, mine: null });

        const me = await request(app).get(`/api/global/games/${g}/owners`)
            .set('Authorization', `Bearer ${token('owner-1')}`);
        expect(me.body).toEqual({ count: 2, mine: { owned: true, platforms: ['vpx'] } });

        const other = await request(app).get(`/api/global/games/${g}/owners`)
            .set('Authorization', `Bearer ${token('not-an-owner')}`);
        expect(other.body).toEqual({ count: 2, mine: { owned: false, platforms: [] } });
    });
});

describe('account deletion', () => {
    it('anonymizeUser removes the player inventory', async () => {
        const g = await seedGame('Deleted Inventory');
        await PlayerTablesService.setOwnership('gone-user', g, ['vpx', 'real']);
        await PlayerTablesService.setOwnership('kept-user', g, []);
        const { AccountDeletionService } = await import('../services/AccountDeletionService.js');
        await AccountDeletionService.anonymizeUser('gone-user', { actor: 'self' });
        expect(await rowsFor('gone-user', g)).toEqual([]);
        expect(await rowsFor('kept-user', g)).toEqual(['']);
    });
});

describe('game-availability owner_count', () => {
    it('every entry carries owner_count (0 when none)', async () => {
        const roomId = await createTestRoom(`pt-room-${++seq}`);
        const owned = await seedGame('Owned Table', { platforms: ['vpx'] });
        await seedGame('Unowned Table', { platforms: ['vpx'] });
        await PlayerTablesService.setOwnership('u1', owned, []);
        await PlayerTablesService.setOwnership('u2', owned, ['vpx']);

        const db = await getDatabase();
        const tId = `pt-t-${++seq}`;
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id)
             VALUES (?, 'T', 'weekly', 'pinball', '{}', 1, ?)`,
            tId, roomId,
        );

        const app = express();
        app.use(express.json());
        const { default: roomsRouter } = await import('../api/routes/rooms.js');
        app.use('/api/rooms', roomsRouter);
        const res = await request(app).get(`/api/rooms/${roomId}/game-availability/${tId}`);
        expect(res.status).toBe(200);
        const byName = Object.fromEntries(res.body.games.map((g: any) => [g.name, g.owner_count]));
        expect(byName['Owned Table']).toBe(2);
        expect(byName['Unowned Table']).toBe(0);
    });
});
