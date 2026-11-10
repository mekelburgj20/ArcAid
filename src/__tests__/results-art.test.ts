import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GameArtService } from '../services/GameArtService.js';

/**
 * v2.240.0 (B25) — table art and winner avatars on the results pages
 * (owner 2026-11-10: "History pages need some love").
 *
 * Art follows the score card's fallback rule: the approved catalogue row
 * matched by name, local file before wheel before remote URL, as a public URL.
 * Avatars come from the one profile chain, resolved at read.
 */

async function catalogue(id: string, name: string, imgs: { local?: string; wheel?: string; remote?: string; status?: string }) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO global_games (id, name, type, local_image_path, wheel_image_path, image_url, status)
         VALUES (?, ?, 'pinball', ?, ?, ?, ?)`,
        id, name, imgs.local ?? null, imgs.wheel ?? null, imgs.remote ?? null, imgs.status ?? 'approved',
    );
}

async function score(opts: { roomId: string; tournamentId: string; game: string; user: string; owner?: string; score: number; at: string }) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO score_history (game_name, game_room_id, game_id, iscored_username, discord_user_id,
            submitted_by_user_id, score, source, submitted_from_room_id, submitted_during_tournament_id, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, 'tournament', ?, ?, ?)`,
        opts.game, opts.roomId, opts.user, opts.owner ?? 'SYSTEM', opts.owner ?? null, opts.score,
        opts.roomId, opts.tournamentId, opts.at,
    );
}

async function app() {
    await setupTestDb();
    const a = express();
    a.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    a.use('/api/rooms', roomsRouter);
    return a;
}

describe('GameArtService.artForNames', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('picks local art, then wheel, then the remote URL, by name in any casing', async () => {
        await catalogue('gg-1', 'Godzilla', { local: 'data/catalogue-images/godzilla.png', wheel: 'data/catalogue-images/godzilla-wheel.png' });
        await catalogue('gg-2', 'Darius', { wheel: 'data/catalogue-images/darius-wheel.png', remote: 'https://cdn.example/darius.jpg' });
        await catalogue('gg-3', 'Funhouse', { remote: 'https://cdn.example/funhouse.jpg' });

        const art = await GameArtService.artForNames(['GODZILLA', 'darius', 'Funhouse', 'Nothing Here', null, '']);

        expect(art.get('godzilla')).toBe('/api/catalogue-images/godzilla.png');
        expect(art.get('darius')).toBe('/api/catalogue-images/darius-wheel.png');
        expect(art.get('funhouse')).toBe('https://cdn.example/funhouse.jpg');
        expect(art.has('nothing here')).toBe(false);
    });

    it('ignores catalogue rows that are not approved, and rows with no art', async () => {
        await catalogue('gg-p', 'Pending Table', { local: 'data/catalogue-images/p.png', status: 'pending' });
        await catalogue('gg-n', 'Bare Table', {});

        const art = await GameArtService.artForNames(['Pending Table', 'Bare Table']);

        expect(art.has('pending table')).toBe(false);
        expect(art.has('bare table')).toBe(false);
    });
});

describe('results pages carry art and avatars', () => {
    it('History rows carry the table art and the winner\'s avatar', async () => {
        const a = await app();
        const db = await getDatabase();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId, { name: 'Daily Grind', type: 'DG' });
        await createTestGame(tId, {
            name: 'Godzilla', status: 'COMPLETED',
            startDate: '2026-11-01T00:00:00.000Z', endDate: '2026-11-02T00:00:00.000Z',
        });
        await catalogue('gg-1', 'Godzilla', { local: 'data/catalogue-images/godzilla.png' });
        await db.run(`INSERT INTO user_profiles (discord_user_id, display_name, avatar_hash) VALUES ('111111111111111111', 'Pete', 'abc123')`);
        await score({ roomId, tournamentId: tId, game: 'Godzilla', user: 'PeteG', owner: '111111111111111111', score: 900, at: '2026-11-01T05:00:00.000Z' });

        const res = await request(a).get(`/api/rooms/${roomId}/history`);

        expect(res.body.results[0]).toMatchObject({
            image_url: '/api/catalogue-images/godzilla.png',
            winner_name: 'Pete',
            winner_discord_user_id: '111111111111111111',
            winner_avatar_hash: 'abc123',
            winner_avatar_url: null,
        });
    });

    it('a History row whose table has no art and no winner ships nulls', async () => {
        const a = await app();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId);
        await createTestGame(tId, { name: 'Unknown Table', status: 'COMPLETED', endDate: '2026-11-02T00:00:00.000Z' });

        const res = await request(a).get(`/api/rooms/${roomId}/history`);

        expect(res.body.results[0]).toMatchObject({
            image_url: null, winner_discord_user_id: null, winner_avatar_hash: null, winner_avatar_url: null,
        });
    });

    it('the tournament page\'s per-table boards carry their art', async () => {
        const a = await app();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId);
        await createTestGame(tId, { name: 'Godzilla', status: 'COMPLETED', endDate: '2026-11-02T00:00:00.000Z' });
        await catalogue('gg-1', 'Godzilla', { wheel: 'data/catalogue-images/godzilla-wheel.png' });
        await score({ roomId, tournamentId: tId, game: 'Godzilla', user: 'Ann', score: 10, at: new Date().toISOString() });
        await score({ roomId, tournamentId: tId, game: 'No Art Table', user: 'Ann', score: 10, at: new Date().toISOString() });

        const res = await request(a).get(`/api/rooms/${roomId}/tournaments/${tId}/scores`);

        const byName = new Map(res.body.boards.map((b: { game_name: string }) => [b.game_name, b]));
        expect(byName.get('Godzilla')).toMatchObject({ image_url: '/api/catalogue-images/godzilla-wheel.png' });
        expect(byName.get('No Art Table')).toMatchObject({ image_url: null });
    });

    it('the Stats Players list carries avatars, and the Games list carries art', async () => {
        const a = await app();
        const db = await getDatabase();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Godzilla', status: 'COMPLETED', endDate: '2026-11-02T00:00:00.000Z' });
        await catalogue('gg-1', 'Godzilla', { local: 'data/catalogue-images/godzilla.png' });
        await db.run(`INSERT INTO user_profiles (discord_user_id, display_name, avatar_hash) VALUES ('222222222222222222', 'Bea', 'beef')`);
        await db.run(
            `INSERT INTO submissions (id, game_id, discord_user_id, submitted_by_user_id, iscored_username, score, timestamp)
             VALUES (?, ?, '222222222222222222', '222222222222222222', 'BeaB', 500, ?)`,
            `${gameId}-beab`, gameId, new Date().toISOString(),
        );

        const players = await request(a).get(`/api/rooms/${roomId}/stats/enhanced/players`);
        expect(players.body.find((p: { iscored_username: string }) => p.iscored_username === 'BeaB'))
            .toMatchObject({ avatar_hash: 'beef', display_name: 'Bea' });

        const games = await request(a).get(`/api/rooms/${roomId}/stats/games-activity`);
        expect(games.body.find((g: { name: string }) => g.name === 'Godzilla'))
            .toMatchObject({ image_url: '/api/catalogue-images/godzilla.png' });
    });

    it('the player page carries the player\'s name and avatar, and art for the games it names', async () => {
        const a = await app();
        const db = await getDatabase();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Godzilla', status: 'COMPLETED', endDate: '2026-11-02T00:00:00.000Z' });
        await catalogue('gg-1', 'Godzilla', { local: 'data/catalogue-images/godzilla.png' });
        await db.run(`INSERT INTO user_profiles (discord_user_id, display_name, avatar_url) VALUES ('333333333333333333', 'Cy', 'https://lh3.example/cy.png')`);
        await db.run(`INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES ('333333333333333333', 'CyX')`);
        await db.run(
            `INSERT INTO submissions (id, game_id, discord_user_id, submitted_by_user_id, iscored_username, score, timestamp)
             VALUES (?, ?, '333333333333333333', '333333333333333333', 'CyX', 700, ?)`,
            `${gameId}-cyx`, gameId, new Date().toISOString(),
        );

        const res = await request(a).get(`/api/rooms/${roomId}/stats/enhanced/player/333333333333333333`);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            displayName: 'Cy',
            avatarUrl: 'https://lh3.example/cy.png',
            gameArt: { godzilla: '/api/catalogue-images/godzilla.png' },
        });
    });
});
