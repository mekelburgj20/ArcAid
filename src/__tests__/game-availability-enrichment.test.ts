import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';

/**
 * `GET /:roomId/game-availability/:tournamentId` is the web Picks page's
 * catalogue read. It has to answer the same question the two WRITE paths answer
 * — POST /pick-game and the Discord `/pick-game` autocomplete — because a game
 * the list hides is a game a player never learns they could have picked.
 *
 * Two parity gaps closed here, plus the row enrichment the Picks page filters
 * and searches on client-side:
 *
 *   1. **Room tags.** Effective platforms are catalogue ∪ `room_game_tags`
 *      (ADR 0008). The read path gated on catalogue platforms alone, in SQL, so
 *      a game qualifying only through a room tag was missing from the list even
 *      though picking it succeeded. The SQL is now a pre-filter widened by the
 *      room's tagged names; `passesplatformRules` over the union is the
 *      authority, exactly as in pickgame.ts.
 *   2. **Tournament mode.** The write paths reject a mode mismatch; the read
 *      path listed video-game entries in a pinball tournament.
 */

async function roomsApp() {
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

let seq = 0;

async function seedCatalogue(name: string, opts: {
    platforms?: string[];
    features?: string[];
    type?: string;
    manufacturer?: string | null;
    year?: number | null;
    localImagePath?: string | null;
    wheelImagePath?: string | null;
    imageUrl?: string | null;
} = {}) {
    const db = await getDatabase();
    const id = `gg-${++seq}`;
    await db.run(
        `INSERT INTO global_games (
            id, name, type, manufacturer, year, platforms, features,
            local_image_path, wheel_image_path, image_url, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')`,
        id, name, opts.type ?? 'pinball', opts.manufacturer ?? null, opts.year ?? null,
        JSON.stringify(opts.platforms ?? []), JSON.stringify(opts.features ?? []),
        opts.localImagePath ?? null, opts.wheelImagePath ?? null, opts.imageUrl ?? null,
    );
    return id;
}

async function tagGame(roomId: string, globalGameId: string, tag: string) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO room_game_tags (game_room_id, global_game_id, tag) VALUES (?, ?, ?)`,
        roomId, globalGameId, tag,
    );
}

async function seedTournament(roomId: string, platformRules: unknown, mode = 'pinball') {
    const db = await getDatabase();
    const id = `t-${++seq}`;
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, platform_rules)
         VALUES (?, 'T', 'weekly', ?, '{}', 1, ?, ?)`,
        id, mode, roomId,
        platformRules === undefined ? null : JSON.stringify(platformRules),
    );
    return id;
}

async function availability(roomId: string, tournamentId: string) {
    const app = await roomsApp();
    const res = await request(app).get(`/api/rooms/${roomId}/game-availability/${tournamentId}`);
    expect(res.status).toBe(200);
    return res.body;
}

beforeEach(async () => {
    await setupTestDb();
    seq = 0;
});

// ─────────────────────────────────────────────────────────────────────────────
// Gap 1 — room tags are part of eligibility
// ─────────────────────────────────────────────────────────────────────────────

describe('game-availability unions the room game tags', () => {
    it('lists a game that qualifies ONLY through a room tag', async () => {
        const roomId = await createTestRoom(`ga-tag-${++seq}`);
        // Catalogue says VPX only — the rule wants AtGames. The room knows this
        // table runs on its cabinet and has tagged it as such.
        const taggedId = await seedCatalogue('Tagged Table', { platforms: ['vpx'] });
        await seedCatalogue('Plain Table', { platforms: ['vpx'] });
        await tagGame(roomId, taggedId, 'atgames');

        const tournamentId = await seedTournament(roomId, { required: ['atgames'], excluded: [] });
        const names = (await availability(roomId, tournamentId)).games.map((g: any) => g.name);

        expect(names).toContain('Tagged Table');
        // …and the untagged twin, identical in the catalogue, still does not.
        expect(names).not.toContain('Plain Table');
    });

    it('agrees with POST /pick-game on that same game', async () => {
        // The gap this closes, stated as the symptom: the list hid a game the
        // pick endpoint accepted.
        const roomId = await createTestRoom(`ga-tag-pick-${++seq}`);
        const taggedId = await seedCatalogue('Tagged Table', { platforms: ['vpx'] });
        await tagGame(roomId, taggedId, 'atgames');
        const tournamentId = await seedTournament(roomId, { required: ['atgames'], excluded: [] });

        const db = await getDatabase();
        await db.run('UPDATE tournaments SET winner_picks = 1 WHERE id = ?', tournamentId);
        const { PickAwardGate } = await import('../services/PickAwardGate.js');
        PickAwardGate.invalidate();
        const { signToken } = await import('../api/auth.js');

        const app = await roomsApp();
        const pick = await request(app)
            .post(`/api/rooms/${roomId}/pick-game`)
            .set('Authorization', `Bearer ${signToken({
                role: 'player', gameRoomIds: [], discordId: '333333333333333333', username: 'Tester',
            })}`)
            .send({ tournamentId, gameName: 'Tagged Table' });
        expect(pick.status).toBe(200);

        const names = (await availability(roomId, tournamentId)).games.map((g: any) => g.name);
        expect(names).toContain('Tagged Table');
    });

    it('does not let a tagged game through on a tag that fails the rule', async () => {
        // The other direction: the widened SQL returns a superset, and the JS
        // gate — not the SQL — decides. A game pulled in by name because it
        // carries SOME tag must still be rejected when no platform, catalogue
        // or tag, satisfies `required`.
        const roomId = await createTestRoom(`ga-tag-miss-${++seq}`);
        const taggedId = await seedCatalogue('Wrong Tag', { platforms: ['vpx'] });
        await tagGame(roomId, taggedId, 'wms');

        const tournamentId = await seedTournament(roomId, { required: ['atgames'], excluded: [] });
        const names = (await availability(roomId, tournamentId)).games.map((g: any) => g.name);

        expect(names).not.toContain('Wrong Tag');
    });

    it('keeps hiding an excluded-platform game even when the room tagged it', async () => {
        // `excluded` stays a SQL-side filter on this endpoint (the pre-existing
        // ADR 0009 divergence pinned in catalogue-engine-readers.test.ts). The
        // tag widening must not become a hole in it.
        const roomId = await createTestRoom(`ga-tag-exc-${++seq}`);
        const id = await seedCatalogue('Who Dunnit', { platforms: ['vpx', 'vpxs', 'real', 'atgames'] });
        await tagGame(roomId, id, 'atgames');

        const tournamentId = await seedTournament(roomId, { required: ['vpxs'], excluded: ['real'] });
        const names = (await availability(roomId, tournamentId)).games.map((g: any) => g.name);

        expect(names).not.toContain('Who Dunnit');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gap 2 — tournament mode
// ─────────────────────────────────────────────────────────────────────────────

describe('game-availability filters by tournament mode', () => {
    it('drops catalogue entries whose mode differs from the tournament', async () => {
        const roomId = await createTestRoom(`ga-mode-${++seq}`);
        await seedCatalogue('Pinball Entry', { platforms: ['vpx'] });
        await seedCatalogue('Video Entry', { platforms: ['nes'], type: 'video_game' });

        const tournamentId = await seedTournament(roomId, {}, 'pinball');
        const names = (await availability(roomId, tournamentId)).games.map((g: any) => g.name);

        expect(names).toContain('Pinball Entry');
        expect(names).not.toContain('Video Entry');
    });

    it('is a filter, not a blanket drop — the other mode lists the other games', async () => {
        const roomId = await createTestRoom(`ga-mode2-${++seq}`);
        await seedCatalogue('Pinball Entry', { platforms: ['vpx'] });
        await seedCatalogue('Video Entry', { platforms: ['nes'], type: 'video_game' });

        const tournamentId = await seedTournament(roomId, {}, 'video_game');
        const names = (await availability(roomId, tournamentId)).games.map((g: any) => g.name);

        expect(names).toContain('Video Entry');
        expect(names).not.toContain('Pinball Entry');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// A rule-free tournament still lists its whole mode
// ─────────────────────────────────────────────────────────────────────────────

describe('a tournament with no platform rules', () => {
    it('lists every approved catalogue game of the matching mode', async () => {
        const roomId = await createTestRoom(`ga-open-${++seq}`);
        await seedCatalogue('A Table', { platforms: ['vpx'] });
        await seedCatalogue('B Table', { platforms: ['atgames'] });
        await seedCatalogue('C Table', { platforms: [] });
        await seedCatalogue('Video Entry', { platforms: ['nes'], type: 'video_game' });

        const tournamentId = await seedTournament(roomId, {});
        const names = (await availability(roomId, tournamentId)).games.map((g: any) => g.name).sort();

        expect(names).toEqual(['A Table', 'B Table', 'C Table']);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The enriched row
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The full row contract, sorted. The ten pre-existing fields plus the seven
 * additive ones — the Picks page and MysteryAwardPage both read this shape, so
 * a rename or a drop has to fail loudly here.
 */
const EXPECTED_KEYS = [
    'allTimeHigh', 'allTimeHighPlayer', 'available', 'daysUntilAvailable',
    'features', 'global_game_id', 'image_url', 'lastEndDate', 'lastPlayedDate',
    'lastStatus', 'manufacturer', 'name', 'platforms', 'room_tags',
    'winnerName', 'winnerScore', 'year',
];

describe('the enriched availability row', () => {
    it('ships catalogue metadata, platforms, features and this room\'s tags', async () => {
        const roomId = await createTestRoom(`ga-rows-${++seq}`);
        const id = await seedCatalogue('Medieval Madness', {
            platforms: ['vpx'], features: ['vpxs'], manufacturer: 'Williams', year: 1997,
            localImagePath: 'data/catalogue-images/mm.png',
        });
        await seedCatalogue('No Metadata', { platforms: ['vpx'] });
        await tagGame(roomId, id, 'wms');
        await tagGame(roomId, id, 'cabinet');

        const tournamentId = await seedTournament(roomId, {});
        const body = await availability(roomId, tournamentId);
        const byName = new Map(body.games.map((g: any) => [g.name, g]));

        const mm = byName.get('Medieval Madness') as any;
        expect(mm.manufacturer).toBe('Williams');
        expect(mm.year).toBe(1997);
        expect(mm.platforms).toEqual(['vpx']);
        expect(mm.features).toEqual(['vpxs']);
        expect(mm.room_tags).toEqual(['cabinet', 'wms']);
        // The catalogue id the GameQuickView popup opens on…
        expect(mm.global_game_id).toBe(id);
        // …and its art, through `normalizeImageUrl` — a stored catalogue path
        // must arrive as the public URL, not as `data/…`.
        expect(mm.image_url).toBe('/api/catalogue-images/mm.png');

        // Nulls stay nulls and the arrays stay arrays — the FE filters on these
        // without guarding for undefined.
        const plain = byName.get('No Metadata') as any;
        expect(plain.manufacturer).toBeNull();
        expect(plain.year).toBeNull();
        expect(plain.platforms).toEqual(['vpx']);
        expect(plain.features).toEqual([]);
        expect(plain.room_tags).toEqual([]);
        expect(plain.image_url).toBeNull();
        expect(typeof plain.global_game_id).toBe('string');
    });

    it('applies the catalogue image precedence and leaves absolute URLs alone', async () => {
        const roomId = await createTestRoom(`ga-img-${++seq}`);
        // local_image_path wins over wheel_image_path wins over image_url —
        // the same precedence RoomScoresService and the library list use.
        await seedCatalogue('All Three', {
            platforms: ['vpx'],
            localImagePath: 'data/catalogue-images/local.png',
            wheelImagePath: 'data/catalogue-images/wheel.png',
            imageUrl: 'https://example.test/remote.png',
        });
        await seedCatalogue('Wheel Only', {
            platforms: ['vpx'],
            wheelImagePath: 'data/catalogue-images/wheel-only.png',
            imageUrl: 'https://example.test/remote.png',
        });
        await seedCatalogue('Remote Only', {
            platforms: ['vpx'], imageUrl: 'https://example.test/remote.png',
        });

        const tournamentId = await seedTournament(roomId, {});
        const body = await availability(roomId, tournamentId);
        const byName = new Map(body.games.map((g: any) => [g.name, g.image_url]));

        expect(byName.get('All Three')).toBe('/api/catalogue-images/local.png');
        expect(byName.get('Wheel Only')).toBe('/api/catalogue-images/wheel-only.png');
        expect(byName.get('Remote Only')).toBe('https://example.test/remote.png');
    });

    it('keeps every pre-existing field on both the played and unplayed branches', async () => {
        // The Picks page and MysteryAwardPage both read this shape; the
        // enrichment is additive and must not disturb it.
        const roomId = await createTestRoom(`ga-shape-${++seq}`);
        await seedCatalogue('Played Table', { platforms: ['vpx'], manufacturer: 'Bally', year: 1980 });
        await seedCatalogue('Fresh Table', { platforms: ['vpx'] });
        const tournamentId = await seedTournament(roomId, {});

        const db = await getDatabase();
        const startDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, start_date, end_date, game_room_id)
             VALUES ('g-played', ?, 'Played Table', 'COMPLETED', ?, ?, ?)`,
            tournamentId, startDate, startDate, roomId,
        );
        await db.run(
            `INSERT INTO submissions (id, game_id, discord_user_id, iscored_username, score, timestamp)
             VALUES ('g-played-champ', 'g-played', 'SYSTEM', 'Champ', 4242, ?)`,
            startDate,
        );

        const body = await availability(roomId, tournamentId);
        const byName = new Map(body.games.map((g: any) => [g.name, g]));

        const played = byName.get('Played Table') as any;
        expect(Object.keys(played).sort()).toEqual(EXPECTED_KEYS);
        expect(played.available).toBe(false);
        expect(played.lastStatus).toBe('COMPLETED');
        expect(played.winnerName).toBe('Champ');
        expect(played.winnerScore).toBe(4242);
        expect(played.allTimeHigh).toBe(4242);
        expect(played.allTimeHighPlayer).toBe('Champ');
        expect(played.manufacturer).toBe('Bally');

        const fresh = byName.get('Fresh Table') as any;
        expect(Object.keys(fresh).sort()).toEqual(EXPECTED_KEYS);
        expect(fresh.available).toBe(true);
        expect(fresh.daysUntilAvailable).toBe(0);
        expect(fresh.lastPlayedDate).toBeNull();

        // The envelope is untouched.
        expect(body.tournament.mode).toBe('pinball');
        expect(body.eligibilityDays).toBe(120);
    });
});
