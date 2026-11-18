import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { getDatabase } from '../database/database.js';
import { setupTestDb } from './helpers.js';
import { GlobalGameService } from '../services/GlobalGameService.js';
import { signToken } from '../api/auth.js';

/**
 * An admin rename of a catalogue game (Super Admin -> Global Catalogue ->
 * Rename), and the question it has to answer: does the next import put the old
 * name back?
 *
 * Two different mechanisms keep it from doing so. A row an importer finds by
 * EXTERNAL ID is updated in place, and that UPDATE never writes `name`. A row
 * an importer finds only by NAME would be missed under its new name and
 * inserted again, so the rename records the old name as a dedup alias (the
 * same reason `merge` records one).
 */

async function createApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { correlationId } = await import('../api/correlationId.js');
    app.use(correlationId);
    const { default: adminRouter } = await import('../api/routes/admin.js');
    app.use('/api/admin', adminRouter);
    return app;
}

const superToken = () => signToken({ role: 'super_admin', gameRoomIds: [], discordId: 'super-1' });

async function aliasesOf(id: string): Promise<string[]> {
    const db = await getDatabase();
    const row = await db.get(`SELECT dedup_aliases FROM global_games WHERE id = ?`, id);
    return JSON.parse(row?.dedup_aliases || '[]');
}

describe('catalogue rename: the next import does not undo it', () => {
    it('a row matched by VPS id keeps its new name through a re-import', async () => {
        await setupTestDb();
        const { id } = await GlobalGameService.upsert({
            name: 'TRON Neon', type: 'pinball', manufacturer: 'Original', year: 2024,
            vps_id: 'vps-neon', imported_from: 'vps',
        });
        await GlobalGameService.update(id, { name: 'TRON Classic Neon' });

        const again = await GlobalGameService.upsert({
            name: 'TRON Neon', type: 'pinball', manufacturer: 'Original', year: 2024,
            vps_id: 'vps-neon', imported_from: 'vps',
        });
        expect(again).toEqual({ id, action: 'updated' });

        const db = await getDatabase();
        const rows = await db.all(`SELECT id, name FROM global_games`);
        expect(rows).toEqual([{ id, name: 'TRON Classic Neon' }]);
    });

    it('a row matched only by name: the old name lands on the renamed row, not a new one', async () => {
        await setupTestDb();
        const { id } = await GlobalGameService.upsert({
            name: 'Junk Yard Deluxe', type: 'pinball', manufacturer: 'Williams', year: 1996,
            imported_from: 'steam-pinball',
        });
        await GlobalGameService.update(id, { name: 'Scrap Heap' });
        expect(await aliasesOf(id)).toEqual(['Junk Yard Deluxe']);

        const again = await GlobalGameService.upsert({
            name: 'Junk Yard Deluxe', type: 'pinball', manufacturer: 'Williams', year: 1996,
            imported_from: 'steam-pinball',
        });
        expect(again).toEqual({ id, action: 'updated' });

        const db = await getDatabase();
        const rows = await db.all(`SELECT id, name FROM global_games`);
        expect(rows).toEqual([{ id, name: 'Scrap Heap' }]);
    });

    it('renaming back drops the alias that now equals the name, and keeps the other', async () => {
        await setupTestDb();
        const { id } = await GlobalGameService.upsert({
            name: 'First Name', type: 'pinball', manufacturer: 'Stern', year: 2010,
        });
        await GlobalGameService.update(id, { name: 'Second Name' });
        await GlobalGameService.update(id, { name: 'First Name' });
        expect(await aliasesOf(id)).toEqual(['Second Name']);
    });

    it('a respelling that normalizes to the same key records no alias', async () => {
        await setupTestDb();
        const { id } = await GlobalGameService.upsert({
            name: 'Scooby-Doo', type: 'pinball', manufacturer: 'Original', year: 2022,
        });
        await GlobalGameService.update(id, { name: 'Scooby-Doo!' });
        expect(await aliasesOf(id)).toEqual([]);
    });

    it('an edit that does not touch the name leaves the aliases alone', async () => {
        await setupTestDb();
        const { id } = await GlobalGameService.upsert({
            name: 'Some Table', type: 'pinball', manufacturer: 'Stern', year: 2010,
        });
        await GlobalGameService.update(id, { manufacturer: 'Bally' });
        const db = await getDatabase();
        const row = await db.get(`SELECT dedup_aliases FROM global_games WHERE id = ?`, id);
        expect(row.dedup_aliases).toBeNull();
    });
});

describe('PUT /api/admin/catalogue/games/:id', () => {
    it('renames, trimming the name', async () => {
        const app = await createApp();
        const { id } = await GlobalGameService.upsert({
            name: 'TRON Neon', type: 'pinball', manufacturer: 'Original', year: 2024,
        });

        const res = await request(app)
            .put(`/api/admin/catalogue/games/${id}`)
            .set('Authorization', `Bearer ${superToken()}`)
            .send({ name: '  TRON Classic Neon  ' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true });

        const db = await getDatabase();
        const row = await db.get(`SELECT name, normalized_name FROM global_games WHERE id = ?`, id);
        expect(row).toEqual({ name: 'TRON Classic Neon', normalized_name: 'tron classic neon' });
    });

    it('refuses a blank name with 400 and changes nothing', async () => {
        const app = await createApp();
        const { id } = await GlobalGameService.upsert({
            name: 'TRON Neon', type: 'pinball', manufacturer: 'Original', year: 2024,
        });

        for (const name of ['', '   ', null, 42]) {
            const res = await request(app)
                .put(`/api/admin/catalogue/games/${id}`)
                .set('Authorization', `Bearer ${superToken()}`)
                .send({ name });
            expect(res.status).toBe(400);
        }
        const db = await getDatabase();
        const row = await db.get(`SELECT name FROM global_games WHERE id = ?`, id);
        expect(row.name).toBe('TRON Neon');
    });

    it('answers 409 when the new name would duplicate another game, and changes nothing', async () => {
        const app = await createApp();
        await GlobalGameService.upsert({
            name: 'TRON Classic', type: 'pinball', manufacturer: 'Original', year: 2024,
        });
        const db = await getDatabase();
        // Seeded directly: `upsert` would fold a second same-identity row into the first.
        await db.run(
            `INSERT INTO global_games (id, name, normalized_name, type, manufacturer, year, status)
             VALUES ('neon-1', 'TRON Neon', 'tron neon', 'pinball', 'Original', 2024, 'approved')`,
        );

        const res = await request(app)
            .put('/api/admin/catalogue/games/neon-1')
            .set('Authorization', `Bearer ${superToken()}`)
            .send({ name: 'tron classic' });
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/Use Merge instead/);

        const row = await db.get(`SELECT name, dedup_aliases FROM global_games WHERE id = 'neon-1'`);
        expect(row).toEqual({ name: 'TRON Neon', dedup_aliases: null });
    });

    it('answers 404 for a game that does not exist', async () => {
        const app = await createApp();
        const res = await request(app)
            .put('/api/admin/catalogue/games/nope')
            .set('Authorization', `Bearer ${superToken()}`)
            .send({ name: 'Anything' });
        expect(res.status).toBe(404);
    });
});
