import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { PickAwardGate } from '../services/PickAwardGate.js';
import { getTerminology } from '../utils/terminology.js';

/**
 * ADR 0016 P2 — Section 1: `parseTournamentRules` is the single parse for
 * `tournaments.platform_rules`.
 *
 * Ten runtime sites read that blob. Each one silently fell back to "no rules"
 * on an unexpected shape, and "no rules" means *a tournament that restricts
 * nothing* — so a site degraded to wide-open is indistinguishable, from the
 * outside, from a site working correctly. That is why there is a test per site
 * asserting the resolved rules actually GATE the behaviour that site owns,
 * rather than a test asserting the parser returns an object.
 *
 * Site inventory (verified by sweep, 2026-07-31):
 *   1. discord/commands/pickgame.ts        — autocomplete choice list
 *   2. discord/commands/activategame.ts    — admin activation gate
 *   3. engine/TournamentEngine.ts          — autoPickAndActivate eligibility
 *   4. engine/TimeoutManager.ts            — fallbackToAutoSelection eligibility
 *   5. api/routes/global.ts                — GET /api/submit/platforms picker
 *   6. api/routes/rooms.ts (:520)          — GET game-availability catalogue filter
 *   7+8. api/routes/rooms.ts (:770/:777)   — POST pick-game gate AND its message
 *   9. api/routes/rooms.ts (:2912)         — POST activate-game gate
 *  10. services/ScoreProvenanceService.ts  — submission validation authority
 *
 * The three MIGRATION parses (database.ts's 101, platformTaxonomyExpansion's
 * 083/089) are deliberately exempt — they are frozen transforms of stored rows,
 * not runtime gates — and are commented as such at each site.
 */

vi.mock('../utils/logger.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/logger.js')>();
    return { ...actual, logWarn: vi.fn() };
});
import { logWarn } from '../utils/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Rules used by most sites: only games available on AtGames qualify. */
const ATGAMES_ONLY = { required: ['atgames'], excluded: [] };

/** The game that satisfies ATGAMES_ONLY, and the one that does not. */
const MATCH = 'Rule Match';
const MISS = 'Rule Miss';
/** Carries both platforms — used where `excluded` (not `required`) is the axis. */
const BOTH = 'Rule Both';

async function seedCatalogue() {
    const db = await getDatabase();
    const rows: Array<[string, string[]]> = [
        [MATCH, ['atgames']],
        [MISS, ['vpx']],
        [BOTH, ['vpx', 'atgames']],
    ];
    for (const [name, platforms] of rows) {
        await db.run(
            `INSERT OR REPLACE INTO global_games (id, name, type, platforms, status)
             VALUES (?, ?, 'pinball', ?, 'approved')`,
            `gg-${name.toLowerCase().replace(/\W+/g, '-')}`, name, JSON.stringify(platforms),
        );
    }
}

/**
 * Drop the dual-platform game so exactly ONE catalogue entry satisfies
 * `required: ['atgames']`. The auto-pick paths choose at random, so a
 * single-candidate catalogue turns "the rule was applied" into a deterministic
 * assertion instead of a set-membership one.
 */
async function narrowCatalogueToOneMatch() {
    const db = await getDatabase();
    await db.run('DELETE FROM global_games WHERE name = ?', BOTH);
}

/** Room with iScored disabled so no engine path can reach Playwright. */
async function seedRoom(slug: string) {
    const roomId = await createTestRoom(slug, `Room ${slug}`);
    await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
    return roomId;
}

async function seedTournament(roomId: string, name: string, rules: unknown) {
    const tournamentId = await createTestTournament(roomId, { name });
    const db = await getDatabase();
    await db.run(
        'UPDATE tournaments SET platform_rules = ?, winner_picks = 1 WHERE id = ?',
        typeof rules === 'string' ? rules : JSON.stringify(rules), tournamentId,
    );
    PickAwardGate.invalidate();
    return tournamentId;
}

async function roomsApp() {
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

async function globalApp() {
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    return app;
}

const playerToken = (discordId: string) =>
    signToken({ role: 'player', gameRoomIds: [], discordId, username: 'Tester' });
const adminToken = (roomId: string) =>
    signToken({ role: 'room_admin', gameRoomIds: [roomId] });

/** Minimal stand-in for a Discord autocomplete interaction. */
// `game_name` was renamed to `game` in the /pick-game consolidation
// (ROADMAP, owner-designed 2026-08-12).
function fakeAutocomplete(tournamentName: string, focused = 'game') {
    const responded: Array<Array<{ name: string; value: string }>> = [];
    return {
        responded,
        interaction: {
            options: {
                getFocused: () => ({ name: focused, value: '' }),
                getString: (n: string) => (n === 'tournament' ? tournamentName : null),
            },
            respond: async (choices: Array<{ name: string; value: string }>) => {
                responded.push(choices);
            },
        },
    };
}

/** Fixed guild id used by `fakeCommand` interactions — pair with
 *  `seedRoom`'s room via `GameRoomSettingsService.set(roomId,
 *  'DISCORD_GUILD_ID', FAKE_COMMAND_GUILD_ID)` so the drift-audit fix #4
 *  cross-room write guard (`validateDiscordWriteTarget`) doesn't refuse
 *  these interactions before the platform-rules gate under test even runs. */
const FAKE_COMMAND_GUILD_ID = 'guild-tournament-rules-parse-sites';

/** Minimal stand-in for a Discord slash-command interaction. */
function fakeCommand(tournamentName: string, gameName: string) {
    const replies: any[] = [];
    return {
        replies,
        interaction: {
            guildId: FAKE_COMMAND_GUILD_ID,
            options: {
                getString: (n: string) => (n === 'tournament' ? tournamentName : gameName),
            },
            user: { tag: 'tester#0001', displayName: 'Tester', id: '123456789012345678' },
            deferReply: async () => {},
            editReply: async (payload: any) => { replies.push(payload); return payload; },
        },
    };
}

beforeEach(async () => {
    await setupTestDb();
    await seedCatalogue();
    PickAwardGate.invalidate();
    vi.mocked(logWarn).mockClear();
});

// ─────────────────────────────────────────────────────────────────────────────
// Site 1 — discord/commands/pickgame.ts (autocomplete choice list)
// ─────────────────────────────────────────────────────────────────────────────

describe('site 1: pickgame autocomplete', () => {
    it('offers only games that satisfy the tournament `required` rule', async () => {
        const roomId = await seedRoom('pg-auto');
        await seedTournament(roomId, 'PG Auto', ATGAMES_ONLY);

        const { pickgame } = await import('../discord/commands/pickgame.js');
        const { interaction, responded } = fakeAutocomplete('PG Auto');
        await pickgame.autocomplete!(interaction as any);

        const offered = responded[0]!.map(c => c.value);
        expect(offered).toContain(MATCH);
        expect(offered).not.toContain(MISS);
    });

    it('offers everything when the tournament has no rules', async () => {
        const roomId = await seedRoom('pg-auto-open');
        await seedTournament(roomId, 'PG Open', {});

        const { pickgame } = await import('../discord/commands/pickgame.js');
        const { interaction, responded } = fakeAutocomplete('PG Open');
        await pickgame.autocomplete!(interaction as any);

        const offered = responded[0]!.map(c => c.value);
        expect(offered).toEqual(expect.arrayContaining([MATCH, MISS, BOTH]));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Site 2 — discord/commands/activategame.ts (admin activation gate)
// ─────────────────────────────────────────────────────────────────────────────

describe('site 2: /activate-game', () => {
    it('refuses a game that fails the tournament `required` rule', async () => {
        const roomId = await seedRoom('ag-block');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', FAKE_COMMAND_GUILD_ID);
        await seedTournament(roomId, 'AG Block', ATGAMES_ONLY);

        const { activategame } = await import('../discord/commands/activategame.js');
        const { interaction, replies } = fakeCommand('AG Block', MISS);
        await activategame.execute!(interaction as any);

        expect(String(replies[replies.length - 1])).toMatch(/does not meet the platform requirements/i);
        const db = await getDatabase();
        const activated = await db.get('SELECT id FROM games WHERE name = ?', MISS);
        expect(activated).toBeUndefined();
    });

    it('activates a game that satisfies the rule', async () => {
        const roomId = await seedRoom('ag-allow');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', FAKE_COMMAND_GUILD_ID);
        const tournamentId = await seedTournament(roomId, 'AG Allow', ATGAMES_ONLY);

        const { activategame } = await import('../discord/commands/activategame.js');
        const { interaction } = fakeCommand('AG Allow', MATCH);
        await activategame.execute!(interaction as any);

        const db = await getDatabase();
        const activated = await db.get(
            `SELECT name FROM games WHERE tournament_id = ? AND status = 'ACTIVE'`, tournamentId,
        );
        expect(activated?.name).toBe(MATCH);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Site 3 — engine/TournamentEngine.ts (autoPickAndActivate)
// ─────────────────────────────────────────────────────────────────────────────

describe('site 3: TournamentEngine.autoPickAndActivate', () => {
    async function autoPick(tournamentId: string) {
        const db = await getDatabase();
        const { TournamentEngine } = await import('../engine/TournamentEngine.js');
        const row = await db.get('SELECT * FROM tournaments WHERE id = ?', tournamentId);
        await (TournamentEngine.getInstance() as any).autoPickAndActivate(
            db, row, tournamentId, { id: 'prev', name: 'Previous Game' }, null,
            getTerminology('pinball'), null,
        );
        return db.all(
            `SELECT name FROM games WHERE tournament_id = ? AND status = 'ACTIVE'`, tournamentId,
        );
    }

    it('can only auto-pick a game that satisfies `required`', async () => {
        await narrowCatalogueToOneMatch();
        const roomId = await seedRoom('ap-gated');
        const tournamentId = await seedTournament(roomId, 'AP Gated', ATGAMES_ONLY);

        const active = await autoPick(tournamentId);
        expect(active.map((g: any) => g.name)).toEqual([MATCH]);
    });

    it('picks nothing when no catalogue game satisfies `required`', async () => {
        const roomId = await seedRoom('ap-empty');
        const tournamentId = await seedTournament(
            roomId, 'AP Empty', { required: ['star_wars_pinball_vr'], excluded: [] },
        );

        const active = await autoPick(tournamentId);
        expect(active).toHaveLength(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Site 4 — engine/TimeoutManager.ts (fallbackToAutoSelection)
// ─────────────────────────────────────────────────────────────────────────────

describe('site 4: TimeoutManager.fallbackToAutoSelection', () => {
    async function runFallback(tournamentId: string, roomId: string) {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, start_date, game_room_id)
             VALUES ('slot-1', ?, '[Pending Pick]', 'QUEUED', ?, ?)`,
            tournamentId, new Date().toISOString(), roomId,
        );
        const { TimeoutManager } = await import('../engine/TimeoutManager.js');
        await (TimeoutManager.getInstance() as any).fallbackToAutoSelection({
            id: 'slot-1', tournamentId, name: '[Pending Pick]', status: 'QUEUED',
        });
        return db.get(`SELECT name, status FROM games WHERE id = 'slot-1'`);
    }

    it('auto-selects only from games satisfying `required`', async () => {
        await narrowCatalogueToOneMatch();
        const roomId = await seedRoom('tm-gated');
        const tournamentId = await seedTournament(roomId, 'TM Gated', ATGAMES_ONLY);

        const slot = await runFallback(tournamentId, roomId);
        expect(slot?.name).toBe(MATCH);
        expect(slot?.status).toBe('ACTIVE');
    });

    it('activates nothing when no catalogue game satisfies `required`', async () => {
        const roomId = await seedRoom('tm-empty');
        const tournamentId = await seedTournament(
            roomId, 'TM Empty', { required: ['star_wars_pinball_vr'], excluded: [] },
        );

        const slot = await runFallback(tournamentId, roomId);

        // The point of this site test is that `required` is honoured — nothing
        // outside the rule gets activated. v2.77.0 changed WHAT happens to the
        // unfillable slot: it used to be left QUEUED with picker_discord_id
        // NULLed, which made it invisible to both the Picks page and the nav
        // badge while still wedged at the head of the queue. It is now deleted.
        // (Disposal policy is locked in picks-badge-page-agreement.test.ts.)
        expect(slot).toBeUndefined();
        const db = await getDatabase();
        const active = await db.all(
            `SELECT name FROM games WHERE tournament_id = ? AND status = 'ACTIVE'`, tournamentId,
        );
        expect(active).toHaveLength(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Site 5 — api/routes/global.ts (GET /api/submit/platforms)
// ─────────────────────────────────────────────────────────────────────────────

describe('site 5: GET /api/submit/platforms', () => {
    it("strips the tournament's `excluded` platforms from the picker", async () => {
        const roomId = await seedRoom('sp-excl');
        const tournamentId = await seedTournament(
            roomId, 'SP Excl', { required: [], excluded: ['atgames'] },
        );
        const db = await getDatabase();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, game_room_id)
             VALUES ('g-sp', ?, ?, 'ACTIVE', ?)`, tournamentId, BOTH, roomId,
        );

        const app = await globalApp();
        const res = await request(app).get('/api/submit/platforms')
            .query({ roomId, gameName: BOTH });

        expect(res.status).toBe(200);
        expect(res.body.platforms).toEqual(expect.arrayContaining(['vpx', 'atgames']));
        expect(res.body.submittable).toContain('vpx');
        expect(res.body.submittable).not.toContain('atgames');
        // ADR 0016 P2 §2 — the legacy flat blob is lifted at read time, so the
        // response ships two axes. `atgames` has no engine (an AtGames cabinet
        // runs four of them), so it lifts to the DEVICE axis alone.
        expect(res.body.tournamentRules.devices.excluded).toEqual(['atgames']);
        expect(res.body.tournamentRules.engines.excluded).toEqual([]);
    });

    it('leaves the picker whole when the tournament excludes nothing', async () => {
        const roomId = await seedRoom('sp-open');
        const tournamentId = await seedTournament(roomId, 'SP Open', ATGAMES_ONLY);
        const db = await getDatabase();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, game_room_id)
             VALUES ('g-sp2', ?, ?, 'ACTIVE', ?)`, tournamentId, BOTH, roomId,
        );

        const app = await globalApp();
        const res = await request(app).get('/api/submit/platforms')
            .query({ roomId, gameName: BOTH });

        // ADR 0009: `required` is an eligibility axis, never a picker filter.
        expect(res.body.submittable).toEqual(expect.arrayContaining(['vpx', 'atgames']));
    });

    /**
     * v2.70.0 — the endpoint used to strip `restrictedText` deliberately ("the
     * rejection message, not picker input"). The info bubble's "What's allowed"
     * section is a second, legitimate consumer: it answers "may I play this,
     * and how" before the submit sheet is ever opened, and the admin's own
     * wording is the most useful line on that panel. Sites 7+8 above still
     * prove the rejection-message use is intact.
     */
    it("ships the tournament's restrictedText alongside the two axes", async () => {
        const roomId = await seedRoom('sp-text');
        const tournamentId = await seedTournament(roomId, 'SP Text', {
            required: [], excluded: ['atgames'], restrictedText: 'Cabinet play only this round.',
        });
        const db = await getDatabase();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, game_room_id)
             VALUES ('g-sp3', ?, ?, 'ACTIVE', ?)`, tournamentId, BOTH, roomId,
        );

        const app = await globalApp();
        const res = await request(app).get('/api/submit/platforms')
            .query({ roomId, gameName: BOTH });

        expect(res.status).toBe(200);
        expect(res.body.tournamentRules.restrictedText).toBe('Cabinet play only this round.');
        // Shipping the prose must not disturb the axes the picker reads.
        expect(res.body.tournamentRules.devices.excluded).toEqual(['atgames']);
        expect(res.body.submittable).not.toContain('atgames');
    });

    it('omits restrictedText when the tournament set none', async () => {
        const roomId = await seedRoom('sp-notext');
        const tournamentId = await seedTournament(
            roomId, 'SP NoText', { required: [], excluded: ['atgames'] },
        );
        const db = await getDatabase();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, game_room_id)
             VALUES ('g-sp4', ?, ?, 'ACTIVE', ?)`, tournamentId, BOTH, roomId,
        );

        const app = await globalApp();
        const res = await request(app).get('/api/submit/platforms')
            .query({ roomId, gameName: BOTH });

        // Absent or empty — either is falsy to the FE's `.trim()` guard, and
        // the amber line is suppressed. What must NOT happen is a stray
        // "undefined"/"null" string reaching the bubble.
        expect(res.body.tournamentRules.restrictedText ?? '').toBe('');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Site 6 — api/routes/rooms.ts:520 (GET game-availability)
// ─────────────────────────────────────────────────────────────────────────────

describe('site 6: GET /api/rooms/:roomId/game-availability/:tournamentId', () => {
    it('lists only catalogue games satisfying `required`', async () => {
        const roomId = await seedRoom('ga-req');
        const tournamentId = await seedTournament(roomId, 'GA Req', ATGAMES_ONLY);

        const app = await roomsApp();
        const res = await request(app).get(`/api/rooms/${roomId}/game-availability/${tournamentId}`);

        expect(res.status).toBe(200);
        const names = res.body.games.map((g: any) => g.name);
        expect(names).toContain(MATCH);
        expect(names).toContain(BOTH);
        expect(names).not.toContain(MISS);
    });

    it('drops catalogue games carrying an `excluded` platform', async () => {
        const roomId = await seedRoom('ga-exc');
        const tournamentId = await seedTournament(
            roomId, 'GA Exc', { required: [], excluded: ['atgames'] },
        );

        const app = await roomsApp();
        const res = await request(app).get(`/api/rooms/${roomId}/game-availability/${tournamentId}`);

        const names = res.body.games.map((g: any) => g.name);
        expect(names).toContain(MISS);
        expect(names).not.toContain(MATCH);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sites 7 + 8 — api/routes/rooms.ts:770 (gate) and :777 (its message)
//
// These were two independent parses of the SAME row. One test, but it must
// assert BOTH outputs the two parses fed: the gate decision and the custom
// message, which now provably come from one read of the blob.
// ─────────────────────────────────────────────────────────────────────────────

describe('sites 7+8: POST /api/rooms/:roomId/pick-game', () => {
    it('rejects a non-qualifying game AND answers with the rules blob\'s restrictedText', async () => {
        const roomId = await seedRoom('pk-block');
        const tournamentId = await seedTournament(roomId, 'PK Block', {
            required: ['atgames'], excluded: [], restrictedText: 'AtGames cabinets only, please.',
        });

        const app = await roomsApp();
        const res = await request(app)
            .post(`/api/rooms/${roomId}/pick-game`)
            .set('Authorization', `Bearer ${playerToken('111111111111111111')}`)
            .send({ tournamentId, gameName: MISS });

        // Site 770: the gate fired.
        expect(res.status).toBe(400);
        // Site 777: the message came from the same blob, not the generic fallback.
        expect(res.body.error).toBe('AtGames cabinets only, please.');
    });

    it('accepts a qualifying game', async () => {
        const roomId = await seedRoom('pk-allow');
        const tournamentId = await seedTournament(roomId, 'PK Allow', {
            required: ['atgames'], excluded: [], restrictedText: 'AtGames cabinets only, please.',
        });

        const app = await roomsApp();
        const res = await request(app)
            .post(`/api/rooms/${roomId}/pick-game`)
            .set('Authorization', `Bearer ${playerToken('222222222222222222')}`)
            .send({ tournamentId, gameName: MATCH });

        expect(res.status).toBe(200);
        expect(res.body.gameName).toBe(MATCH);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Site 9 — api/routes/rooms.ts:2912 (POST activate-game)
// ─────────────────────────────────────────────────────────────────────────────

describe('site 9: POST /api/rooms/:roomId/tournaments/:id/activate-game', () => {
    it('refuses a game that fails `required`', async () => {
        const roomId = await seedRoom('aa-block');
        const tournamentId = await seedTournament(roomId, 'AA Block', ATGAMES_ONLY);

        const app = await roomsApp();
        const res = await request(app)
            .post(`/api/rooms/${roomId}/tournaments/${tournamentId}/activate-game`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ gameName: MISS });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/platform requirements/i);
    });

    it('activates a game that satisfies `required`', async () => {
        const roomId = await seedRoom('aa-allow');
        const tournamentId = await seedTournament(roomId, 'AA Allow', ATGAMES_ONLY);

        const app = await roomsApp();
        const res = await request(app)
            .post(`/api/rooms/${roomId}/tournaments/${tournamentId}/activate-game`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ gameName: MATCH });

        expect(res.status).toBe(200);
        const db = await getDatabase();
        const active = await db.get(
            `SELECT name FROM games WHERE tournament_id = ? AND status = 'ACTIVE'`, tournamentId,
        );
        expect(active?.name).toBe(MATCH);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Site 10 — services/ScoreProvenanceService.ts (submission authority)
//
// Missing from the contract's inventory; it is the ONE server-side gate every
// submit path (web, Discord, draft-commit, global) runs through, so a silent
// degradation here opens all of them at once.
// ─────────────────────────────────────────────────────────────────────────────

describe('site 10: ScoreProvenanceService', () => {
    async function seedActiveTournamentGame(slug: string, rules: unknown) {
        const roomId = await seedRoom(slug);
        const tournamentId = await seedTournament(roomId, `SPS ${slug}`, rules);
        const db = await getDatabase();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, game_room_id)
             VALUES (?, ?, ?, 'ACTIVE', ?)`, `g-${slug}`, tournamentId, BOTH, roomId,
        );
        return { roomId, tournamentId };
    }

    it("blocks a submission on the tournament's `excluded` device", async () => {
        const { roomId } = await seedActiveTournamentGame(
            'sps-excl', { required: [], excluded: ['atgames'] },
        );
        const { ScoreProvenanceService } = await import('../services/ScoreProvenanceService.js');

        const blocked = await ScoreProvenanceService.validateForRoomGame(roomId, BOTH, 'vpx', 'atgames');
        expect(blocked.ok).toBe(false);

        const allowed = await ScoreProvenanceService.validateForRoomGame(roomId, BOTH, 'vpx', 'pc');
        expect(allowed.ok).toBe(true);
    });

    it('allows the same submission when the tournament excludes nothing', async () => {
        const { roomId } = await seedActiveTournamentGame('sps-open', ATGAMES_ONLY);
        const { ScoreProvenanceService } = await import('../services/ScoreProvenanceService.js');

        const result = await ScoreProvenanceService.validateForRoomGame(roomId, BOTH, 'vpx', 'atgames');
        expect(result.ok).toBe(true);
    });

    it('resolves the same rules by tournament id (the Discord submit path)', async () => {
        const { tournamentId } = await seedActiveTournamentGame(
            'sps-discord', { required: [], excluded: ['atgames'] },
        );
        const { ScoreProvenanceService } = await import('../services/ScoreProvenanceService.js');

        const scope = await ScoreProvenanceService.resolveForTournamentGame(tournamentId, BOTH);
        expect(scope.rules?.devices.excluded).toEqual(['atgames']);
        expect(scope.submittable).not.toContain('atgames');
    });

    it('reports no rules (null, not empty rules) when no tournament applies', async () => {
        const roomId = await seedRoom('sps-none');
        const { ScoreProvenanceService } = await import('../services/ScoreProvenanceService.js');

        const scope = await ScoreProvenanceService.resolveForRoomGame(roomId, BOTH);
        expect(scope.rules).toBeNull();
        expect(scope.submittable).toEqual(expect.arrayContaining(['vpx', 'atgames']));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Malformed input — degrade, but say so
// ─────────────────────────────────────────────────────────────────────────────

/** ADR 0016 P2 §2's "restricts nothing" value, spelled out. */
const NO_RULES = {
    engines: { required: [], excluded: [] },
    devices: { required: [], excluded: [] },
};

describe('parseTournamentRules — malformed platform_rules', () => {
    it('logs a WARN naming the tournament and returns empty rules', async () => {
        const { parseTournamentRules } = await import('../utils/platformRules.js');

        const rules = parseTournamentRules('{ not json', 't-broken-42');

        expect(rules).toEqual(NO_RULES);
        expect(logWarn).toHaveBeenCalledTimes(1);
        const message = vi.mocked(logWarn).mock.calls[0]![0] as string;
        expect(message).toContain('t-broken-42');
        expect(message).toMatch(/platform_rules/);
        expect(message).toMatch(/no rules/i);
    });

    it('warns for valid JSON that is not an object', async () => {
        const { parseTournamentRules } = await import('../utils/platformRules.js');

        expect(parseTournamentRules('["atgames"]', 't-array')).toEqual(NO_RULES);
        expect(logWarn).toHaveBeenCalledTimes(1);
        expect(vi.mocked(logWarn).mock.calls[0]![0]).toContain('t-array');
    });

    it('stays silent for the ordinary empty-rules cases', async () => {
        const { parseTournamentRules } = await import('../utils/platformRules.js');

        expect(parseTournamentRules(null)).toEqual(NO_RULES);
        expect(parseTournamentRules('')).toEqual(NO_RULES);
        expect(parseTournamentRules('{}', 't-empty')).toEqual(NO_RULES);
        expect(logWarn).not.toHaveBeenCalled();
    });

    it('takes the tournament id from the row when not passed explicitly', async () => {
        const { parseTournamentRules } = await import('../utils/platformRules.js');

        parseTournamentRules({ id: 't-from-row', platform_rules: 'nope' });

        expect(vi.mocked(logWarn).mock.calls[0]![0]).toContain('t-from-row');
    });

    it('coerces non-array required/excluded instead of throwing downstream', async () => {
        const { parseTournamentRules, passesplatformRules } = await import('../utils/platformRules.js');

        // Pre-fix this reached `passesplatformRules` as a string and threw on
        // `.some` — a crash, not a degradation. The coercion survives the
        // two-axis lift: a non-array field contributes nothing to either axis.
        const rules = parseTournamentRules('{"required":"atgames","excluded":null}', 't-shape');
        expect(rules).toEqual(NO_RULES);
        expect(() => passesplatformRules(['vpx'], rules)).not.toThrow();
    });

    it('degrades a real site to "restricts nothing" and logs the tournament id', async () => {
        const roomId = await seedRoom('bad-rules');
        const tournamentId = await seedTournament(roomId, 'Bad Rules', 'this is not json');
        vi.mocked(logWarn).mockClear();

        const app = await roomsApp();
        const res = await request(app).get(`/api/rooms/${roomId}/game-availability/${tournamentId}`);

        // Degraded open — every catalogue game is listed.
        expect(res.status).toBe(200);
        const names = res.body.games.map((g: any) => g.name);
        expect(names).toEqual(expect.arrayContaining([MATCH, MISS, BOTH]));

        // ...but not invisibly.
        const warned = vi.mocked(logWarn).mock.calls.map(c => String(c[0]));
        expect(warned.some(m => m.includes(tournamentId))).toBe(true);
    });
});
