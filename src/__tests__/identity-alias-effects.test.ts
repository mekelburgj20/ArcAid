import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';

/**
 * v2.127.0 — identity tidy-up.
 *
 * Three prod symptoms (rtx_pinball, 2026-08-21) share one cause: linking an
 * iScored alias used to write a `user_mappings` row and stop there. These tests
 * pin the effects that now run alongside it, and — just as importantly — the
 * rows they must NOT touch:
 *
 *   • a COMPLETED tournament's rows are frozen (MergeService's rule),
 *   • rows someone already owns, and rows a merge owns, are off-limits,
 *   • community_scores / global_scores are never sync rows (ADR 0016 P2),
 *   • releasing the alias is an exact undo of the attribution, and nothing else
 *     — the person is still a member of the rooms they joined.
 */

// The Discord REST seam. `hydrateFromDiscord` reaches for exactly one function;
// mocking the module means no network and a countable call.
const discordUser: { value: { username: string; globalName: string | null; avatar: string | null } | null } = {
    value: { username: 'brickshot', globalName: 'BrickShotBobes', avatar: 'aa11bb22' },
};
const fetchDiscordUser = vi.fn(async (_id: string) => discordUser.value);

vi.mock('../utils/discord.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/discord.js')>();
    return { ...actual, fetchDiscordUser: (id: string) => fetchDiscordUser(id) };
});

const { IdentityAliasEffectsService } = await import('../services/IdentityAliasEffectsService.js');
const { IdentityClaimService } = await import('../services/IdentityClaimService.js');
const { UserProfileService, PROFILE_HYDRATION_SETTING } = await import('../services/UserProfileService.js');
const { RoomMembershipService } = await import('../services/RoomMembershipService.js');
const { drainBackgroundTasks } = await import('../utils/backgroundTasks.js');

const USER = '123456789012345678';   // a real-shaped Discord snowflake
const NAME = 'Wyo';

let roomCounter = 0;
async function room(slug?: string) {
    return createTestRoom(slug ?? `alias-fx-${++roomCounter}`, 'Alias FX Room');
}

async function addSyntheticMember(name: string, roomId: string, opts: {
    joinedAt?: string; displayName?: string | null;
} = {}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO room_members (user_id, room_id, joined_at, source, display_name)
         VALUES (?, ?, ?, 'submission', ?)`,
        `iscored:${name}`, roomId, opts.joinedAt ?? '2026-01-01 00:00:00', opts.displayName ?? null,
    );
}

async function addRealMember(userId: string, roomId: string, opts: {
    joinedAt?: string; displayName?: string | null; source?: string;
} = {}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO room_members (user_id, room_id, joined_at, source, display_name)
         VALUES (?, ?, ?, ?, ?)`,
        userId, roomId, opts.joinedAt ?? '2026-06-01 00:00:00', opts.source ?? 'self_join',
        opts.displayName ?? null,
    );
}

/** An unowned SYNCED score_history row — the poller's exact shape. */
async function addSyncHistory(roomId: string, name: string, opts: {
    score?: number; tournamentId?: string | null; source?: string;
    ownerId?: string | null; mergedFrom?: number | null;
} = {}) {
    const db = await getDatabase();
    const res = await db.run(
        `INSERT INTO score_history
            (game_name, game_room_id, iscored_username, discord_user_id, score, source,
             submitted_from_room_id, submitted_during_tournament_id,
             submitted_by_user_id, submitted_by_anonymous_name, merged_from_anonymous_identity_id)
         VALUES ('WHO dunnit', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        roomId, name,
        opts.ownerId ?? `iscored:${name}`,
        opts.score ?? 5000,
        opts.source ?? 'sync',
        roomId, opts.tournamentId ?? null,
        opts.ownerId ?? null, opts.ownerId ? null : name,
        opts.mergedFrom ?? null,
    );
    return res.lastID as number;
}

/** An unowned SYNCED submissions row (no `source` column — the id signature is all there is). */
async function addSyncSubmission(id: string, name: string, opts: {
    tournamentId?: string | null; ownerId?: string | null; mergedFrom?: number | null;
} = {}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO submissions
            (id, game_id, discord_user_id, iscored_username, score, timestamp,
             submitted_during_tournament_id, submitted_by_user_id, submitted_by_anonymous_name,
             merged_from_anonymous_identity_id)
         VALUES (?, NULL, ?, ?, 4200, datetime('now'), ?, ?, ?, ?)`,
        id, opts.ownerId ?? `iscored:${name}`, name,
        opts.tournamentId ?? null, opts.ownerId ?? null, opts.ownerId ? null : name,
        opts.mergedFrom ?? null,
    );
    return id;
}

async function makeTournament(roomId: string, isActive: 0 | 1) {
    const db = await getDatabase();
    const id = `t-${roomId}-${isActive}`;
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id)
         VALUES (?, 'Daily Grind', 'DG', 'pinball', '{}', ?, ?)`,
        id, isActive, roomId,
    );
    return id;
}

beforeEach(async () => {
    await setupTestDb();
    fetchDiscordUser.mockClear();
    discordUser.value = { username: 'brickshot', globalName: 'BrickShotBobes', avatar: 'aa11bb22' };
    delete process.env[PROFILE_HYDRATION_SETTING];
});
afterEach(async () => {
    await drainBackgroundTasks();
    delete process.env[PROFILE_HYDRATION_SETTING];
});

// ─────────────────────────────────────────────────────────────────────────────
// (a) room_members fold
// ─────────────────────────────────────────────────────────────────────────────

describe('onAliasLinked — (a) synthetic room_members fold', () => {
    it('keeps the real row and takes the EARLIER joined_at when both exist', async () => {
        const roomId = await room();
        await addSyntheticMember(NAME, roomId, { joinedAt: '2026-01-01 00:00:00' });
        await addRealMember(USER, roomId, { joinedAt: '2026-06-01 00:00:00', source: 'self_join' });

        const res = await IdentityAliasEffectsService.onAliasLinked(USER, NAME, { skipHydration: true });
        expect(res.membersFolded).toBe(1);

        const db = await getDatabase();
        const rows = await db.all(`SELECT user_id, joined_at, source FROM room_members WHERE room_id = ?`, roomId);
        expect(rows).toHaveLength(1);
        expect(rows[0].user_id).toBe(USER);
        expect(rows[0].joined_at).toBe('2026-01-01 00:00:00');
        // The real row survives — its source is not downgraded to the synthetic's.
        expect(rows[0].source).toBe('self_join');
    });

    it('carries the synthetic display_name over when the real row has none', async () => {
        const roomId = await room();
        await addSyntheticMember(NAME, roomId, { displayName: 'Wyo' });
        await addRealMember(USER, roomId, { displayName: null });

        await IdentityAliasEffectsService.onAliasLinked(USER, NAME, { skipHydration: true });

        const db = await getDatabase();
        const row = await db.get(`SELECT display_name FROM room_members WHERE room_id = ? AND user_id = ?`, roomId, USER);
        expect(row.display_name).toBe('Wyo');
    });

    it('keeps the real row display_name when it already has one', async () => {
        const roomId = await room();
        await addSyntheticMember(NAME, roomId, { displayName: 'Wyo' });
        await addRealMember(USER, roomId, { displayName: 'WyoReal' });

        await IdentityAliasEffectsService.onAliasLinked(USER, NAME, { skipHydration: true });

        const db = await getDatabase();
        const rows = await db.all(`SELECT user_id, display_name FROM room_members WHERE room_id = ?`, roomId);
        expect(rows).toHaveLength(1);
        expect(rows[0].display_name).toBe('WyoReal');
    });

    it('re-keys the synthetic row when the real account is not yet a member', async () => {
        const roomId = await room();
        await addSyntheticMember(NAME, roomId, { joinedAt: '2026-02-02 00:00:00', displayName: 'Wyo' });

        const res = await IdentityAliasEffectsService.onAliasLinked(USER, NAME, { skipHydration: true });
        expect(res.membersFolded).toBe(1);

        const db = await getDatabase();
        const rows = await db.all(`SELECT user_id, joined_at, display_name, source FROM room_members WHERE room_id = ?`, roomId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            user_id: USER, joined_at: '2026-02-02 00:00:00', display_name: 'Wyo', source: 'submission',
        });
    });

    it('folds across every room the synthetic id appears in', async () => {
        const a = await room();
        const b = await room();
        await addSyntheticMember(NAME, a);
        await addSyntheticMember(NAME, b);
        await addRealMember(USER, a);

        const res = await IdentityAliasEffectsService.onAliasLinked(USER, NAME, { skipHydration: true });
        expect(res.membersFolded).toBe(2);

        const db = await getDatabase();
        const left = await db.all(`SELECT user_id FROM room_members WHERE user_id LIKE 'iscored:%'`);
        expect(left).toHaveLength(0);
        const mine = await db.all(`SELECT room_id FROM room_members WHERE user_id = ?`, USER);
        expect(mine.map((r: any) => r.room_id).sort()).toEqual([a, b].sort());
    });

    it('is a no-op when there is no synthetic row', async () => {
        const roomId = await room();
        await addRealMember(USER, roomId);

        const res = await IdentityAliasEffectsService.onAliasLinked(USER, NAME, { skipHydration: true });
        expect(res).toEqual({ membersFolded: 0, rowsAttributed: 0 });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) re-attribution
// ─────────────────────────────────────────────────────────────────────────────

describe('onAliasLinked — (b) re-attributing unowned sync rows', () => {
    it('attributes score_history and submissions rows across BOTH rooms the name plays in', async () => {
        const a = await room();
        const b = await room();
        const h1 = await addSyncHistory(a, NAME);
        const h2 = await addSyncHistory(b, NAME);
        await addSyncSubmission('sub-1', NAME);

        const res = await IdentityAliasEffectsService.onAliasLinked(USER, NAME, { skipHydration: true });
        expect(res.rowsAttributed).toBe(3);

        const db = await getDatabase();
        for (const id of [h1, h2]) {
            const row = await db.get(
                `SELECT submitted_by_user_id, discord_user_id, submitted_by_anonymous_name
                   FROM score_history WHERE id = ?`, id);
            expect(row).toMatchObject({
                submitted_by_user_id: USER, discord_user_id: USER, submitted_by_anonymous_name: null,
            });
        }
        const sub = await db.get(
            `SELECT submitted_by_user_id, discord_user_id FROM submissions WHERE id = 'sub-1'`);
        expect(sub).toMatchObject({ submitted_by_user_id: USER, discord_user_id: USER });
    });

    it('matches the alias case-insensitively', async () => {
        const roomId = await room();
        await addSyncHistory(roomId, 'wyo');

        const res = await IdentityAliasEffectsService.onAliasLinked(USER, 'WYO', { skipHydration: true });
        expect(res.rowsAttributed).toBe(1);
    });

    it('FREEZES rows inside a COMPLETED tournament and moves the active-tournament ones', async () => {
        const roomId = await room();
        const done = await makeTournament(roomId, 0);
        const live = await makeTournament(roomId, 1);
        const frozen = await addSyncHistory(roomId, NAME, { tournamentId: done });
        const moving = await addSyncHistory(roomId, NAME, { tournamentId: live });
        await addSyncSubmission('sub-frozen', NAME, { tournamentId: done });

        const res = await IdentityAliasEffectsService.onAliasLinked(USER, NAME, { skipHydration: true });
        expect(res.rowsAttributed).toBe(1);

        const db = await getDatabase();
        const f = await db.get(`SELECT submitted_by_user_id, discord_user_id FROM score_history WHERE id = ?`, frozen);
        expect(f.submitted_by_user_id).toBeNull();
        expect(f.discord_user_id).toBe(`iscored:${NAME}`);
        const m = await db.get(`SELECT submitted_by_user_id FROM score_history WHERE id = ?`, moving);
        expect(m.submitted_by_user_id).toBe(USER);
        const s = await db.get(`SELECT submitted_by_user_id FROM submissions WHERE id = 'sub-frozen'`);
        expect(s.submitted_by_user_id).toBeNull();
    });

    it('skips rows someone already owns and rows a merge owns', async () => {
        const roomId = await room();
        const owned = await addSyncHistory(roomId, NAME, { ownerId: 'other-user' });
        const merged = await addSyncHistory(roomId, NAME, { mergedFrom: 7 });

        const res = await IdentityAliasEffectsService.onAliasLinked(USER, NAME, { skipHydration: true });
        expect(res.rowsAttributed).toBe(0);

        const db = await getDatabase();
        expect((await db.get(`SELECT submitted_by_user_id FROM score_history WHERE id = ?`, owned)).submitted_by_user_id)
            .toBe('other-user');
        expect((await db.get(`SELECT submitted_by_user_id FROM score_history WHERE id = ?`, merged)).submitted_by_user_id)
            .toBeNull();
    });

    it('skips a non-sync score_history row even when it carries the iscored: signature', async () => {
        const roomId = await room();
        const web = await addSyncHistory(roomId, NAME, { source: 'tournament' });

        const res = await IdentityAliasEffectsService.onAliasLinked(USER, NAME, { skipHydration: true });
        expect(res.rowsAttributed).toBe(0);
        const db = await getDatabase();
        expect((await db.get(`SELECT submitted_by_user_id FROM score_history WHERE id = ?`, web)).submitted_by_user_id)
            .toBeNull();
    });

    it('never touches community_scores or global_scores', async () => {
        const roomId = await room();
        const db = await getDatabase();
        await db.run(
            `INSERT INTO community_scores
                (game_name, game_room_id, iscored_username, discord_user_id, score,
                 submitted_by_user_id, submitted_by_anonymous_name)
             VALUES ('WHO dunnit', ?, ?, ?, 100, NULL, ?)`,
            roomId, NAME, `iscored:${NAME}`, NAME,
        );
        await db.run(
            `INSERT INTO global_games (id, name, type, status) VALUES ('gg-1', 'WHO dunnit', 'pinball', 'approved')`);
        await db.run(
            `INSERT INTO global_scores
                (id, global_game_id, player_id, iscored_username, score, origin_type, submitted_at,
                 submitted_by_user_id, submitted_by_anonymous_name)
             VALUES ('gs-1', 'gg-1', ?, ?, 100, 'global', datetime('now'), NULL, ?)`,
            `iscored:${NAME}`, NAME, NAME,
        );

        await IdentityAliasEffectsService.onAliasLinked(USER, NAME, { skipHydration: true });

        expect((await db.get(`SELECT submitted_by_user_id FROM community_scores`)).submitted_by_user_id).toBeNull();
        expect((await db.get(`SELECT submitted_by_user_id FROM global_scores`)).submitted_by_user_id).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// onAliasUnlinked
// ─────────────────────────────────────────────────────────────────────────────

describe('onAliasUnlinked', () => {
    it('restores exactly the rows onAliasLinked attributed', async () => {
        const roomId = await room();
        const h = await addSyncHistory(roomId, NAME);
        await addSyncSubmission('sub-u', NAME);

        await IdentityAliasEffectsService.onAliasLinked(USER, NAME, { skipHydration: true });
        const res = await IdentityAliasEffectsService.onAliasUnlinked(USER, NAME);
        expect(res.rowsReanonymized).toBe(2);

        const db = await getDatabase();
        const row = await db.get(
            `SELECT submitted_by_user_id, discord_user_id, submitted_by_anonymous_name
               FROM score_history WHERE id = ?`, h);
        expect(row).toMatchObject({
            submitted_by_user_id: null, discord_user_id: `iscored:${NAME}`, submitted_by_anonymous_name: NAME,
        });
        const sub = await db.get(`SELECT discord_user_id FROM submissions WHERE id = 'sub-u'`);
        expect(sub.discord_user_id).toBe(`iscored:${NAME}`);
    });

    it('leaves a web-submitted tournament row owned by the same user alone', async () => {
        const roomId = await room();
        const web = await addSyncHistory(roomId, NAME, { source: 'tournament', ownerId: USER });

        const res = await IdentityAliasEffectsService.onAliasUnlinked(USER, NAME);
        expect(res.rowsReanonymized).toBe(0);
        const db = await getDatabase();
        expect((await db.get(`SELECT submitted_by_user_id FROM score_history WHERE id = ?`, web)).submitted_by_user_id)
            .toBe(USER);
    });

    it('leaves room_members alone — the membership is legitimately theirs', async () => {
        const roomId = await room();
        await addSyntheticMember(NAME, roomId);
        await IdentityAliasEffectsService.onAliasLinked(USER, NAME, { skipHydration: true });

        await IdentityAliasEffectsService.onAliasUnlinked(USER, NAME);

        const db = await getDatabase();
        const rows = await db.all(`SELECT user_id FROM room_members WHERE room_id = ?`, roomId);
        expect(rows).toHaveLength(1);
        expect(rows[0].user_id).toBe(USER);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wiring: the claim paths
// ─────────────────────────────────────────────────────────────────────────────

describe('claim paths trigger the effects', () => {
    it('auto-approve (exact match) folds members and attributes rows', async () => {
        const roomId = await room();
        const db = await getDatabase();
        await db.run(`INSERT INTO user_profiles (discord_user_id, username) VALUES (?, ?)`, USER, NAME);
        await addSyntheticMember(NAME, roomId);
        const h = await addSyncHistory(roomId, NAME);

        const outcome = await IdentityClaimService.claim(USER, roomId, NAME);
        expect(outcome.result).toBe('auto_approved');

        expect((await db.get(`SELECT submitted_by_user_id FROM score_history WHERE id = ?`, h)).submitted_by_user_id)
            .toBe(USER);
        expect(await db.get(`SELECT 1 FROM room_members WHERE user_id LIKE 'iscored:%'`)).toBeUndefined();
    });

    it('mod approval of a pending claim runs the same effects', async () => {
        const roomId = await room();
        const db = await getDatabase();
        await db.run(`INSERT INTO user_profiles (discord_user_id, username) VALUES (?, ?)`, USER, 'somethingelse');
        const h = await addSyncHistory(roomId, NAME);

        const outcome = await IdentityClaimService.claim(USER, roomId, NAME);
        expect(outcome.result).toBe('pending');
        // Not linked yet — the queue decides.
        expect((await db.get(`SELECT submitted_by_user_id FROM score_history WHERE id = ?`, h)).submitted_by_user_id)
            .toBeNull();

        await IdentityClaimService.approve((outcome as { claimId: number }).claimId, roomId, 'mod-1');
        expect((await db.get(`SELECT submitted_by_user_id FROM score_history WHERE id = ?`, h)).submitted_by_user_id)
            .toBe(USER);
    });

    it('releaseAlias re-anonymizes what the claim attributed', async () => {
        const roomId = await room();
        const db = await getDatabase();
        await db.run(`INSERT INTO user_profiles (discord_user_id, username) VALUES (?, ?)`, USER, NAME);
        const h = await addSyncHistory(roomId, NAME);

        await IdentityClaimService.claim(USER, roomId, NAME);
        expect(await IdentityClaimService.releaseAlias(USER, NAME)).toBe(true);

        const row = await db.get(
            `SELECT submitted_by_user_id, discord_user_id FROM score_history WHERE id = ?`, h);
        expect(row).toMatchObject({ submitted_by_user_id: null, discord_user_id: `iscored:${NAME}` });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) profile hydration
// ─────────────────────────────────────────────────────────────────────────────

describe('UserProfileService.hydrateFromDiscord', () => {
    it('writes avatar_hash, avatar_fetched_at and username for a user with no profile row', async () => {
        expect(await UserProfileService.hydrateFromDiscord(USER)).toBe(true);

        const db = await getDatabase();
        const row = await db.get(
            `SELECT avatar_hash, avatar_fetched_at, username, display_name FROM user_profiles WHERE discord_user_id = ?`,
            USER,
        );
        expect(row.avatar_hash).toBe('aa11bb22');
        expect(row.avatar_fetched_at).toBeTruthy();
        // globalName wins over username, matching the OAuth login path.
        expect(row.username).toBe('BrickShotBobes');
        expect(row.display_name).toBeNull();
    });

    it('stamps avatar_fetched_at even when the user has NO avatar', async () => {
        discordUser.value = { username: 'plainuser', globalName: null, avatar: null };
        expect(await UserProfileService.hydrateFromDiscord(USER)).toBe(true);

        const db = await getDatabase();
        const row = await db.get(
            `SELECT avatar_hash, avatar_fetched_at, username FROM user_profiles WHERE discord_user_id = ?`, USER);
        expect(row.avatar_hash).toBeNull();
        expect(row.avatar_fetched_at).toBeTruthy();
        expect(row.username).toBe('plainuser');
    });

    it('fills username ONLY when it is NULL — the login path stays authoritative', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, username) VALUES (?, 'LoginName')`, USER);

        await UserProfileService.hydrateFromDiscord(USER);

        const row = await db.get(`SELECT username, avatar_hash FROM user_profiles WHERE discord_user_id = ?`, USER);
        expect(row.username).toBe('LoginName');
        expect(row.avatar_hash).toBe('aa11bb22');
    });

    it('skips a profile fetched inside 24h unless forced', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, avatar_hash, avatar_fetched_at)
             VALUES (?, 'old', datetime('now', '-1 hours'))`, USER);

        expect(await UserProfileService.hydrateFromDiscord(USER)).toBe(false);
        expect(fetchDiscordUser).not.toHaveBeenCalled();

        expect(await UserProfileService.hydrateFromDiscord(USER, { force: true })).toBe(true);
        expect((await db.get(`SELECT avatar_hash FROM user_profiles WHERE discord_user_id = ?`, USER)).avatar_hash)
            .toBe('aa11bb22');
    });

    it('re-fetches once the 24h window has passed', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, avatar_hash, avatar_fetched_at)
             VALUES (?, 'old', datetime('now', '-30 hours'))`, USER);

        expect(await UserProfileService.hydrateFromDiscord(USER)).toBe(true);
        expect(fetchDiscordUser).toHaveBeenCalledTimes(1);
    });

    it('skips google: ids — there is no Discord user behind them', async () => {
        expect(await UserProfileService.hydrateFromDiscord('google:sub-123')).toBe(false);
        expect(fetchDiscordUser).not.toHaveBeenCalled();
    });

    it('respects the PROFILE_HYDRATION_ENABLED kill switch', async () => {
        process.env[PROFILE_HYDRATION_SETTING] = 'false';
        expect(await UserProfileService.hydrateFromDiscord(USER)).toBe(false);
        expect(fetchDiscordUser).not.toHaveBeenCalled();
    });
});

describe('UserProfileService.refreshStaleDiscordProfiles', () => {
    const OTHER = '223456789012345678';

    it('picks stale + never-fetched Discord rows and skips fresh ones and google ids', async () => {
        const db = await getDatabase();
        await db.run(`INSERT INTO user_profiles (discord_user_id, avatar_fetched_at) VALUES (?, NULL)`, USER);
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, avatar_fetched_at) VALUES (?, datetime('now', '-30 days'))`,
            OTHER);
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, avatar_fetched_at) VALUES ('323456789012345678', datetime('now'))`);
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, avatar_fetched_at) VALUES ('google:sub-9', NULL)`);

        const res = await UserProfileService.refreshStaleDiscordProfiles({ staleDays: 7, limit: 50 });

        expect(res.scanned).toBe(2);
        expect(res.refreshed).toBe(2);
        const seen = fetchDiscordUser.mock.calls.map(c => c[0]).sort();
        expect(seen).toEqual([USER, OTHER].sort());
    });

    /**
     * v2.127.1. Link-time hydration is non-fatal: if the Discord REST call is
     * down when the alias is mapped, NO user_profiles row is ever created — and
     * a sweep that reads only user_profiles can never retry it. The candidate
     * set therefore also covers Discord ids known from user_mappings and
     * room_members that have no profile row, treated as never-fetched.
     */
    it('also picks up mapped/member Discord ids that have NO user_profiles row', async () => {
        const db = await getDatabase();
        const roomId = await room();
        await db.run(`INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, 'MappedOnly')`, USER);
        await db.run(`INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES ('google:sub-7', 'GoogleOnly')`);
        await db.run(
            `INSERT INTO room_members (user_id, room_id, joined_at, source) VALUES (?, ?, datetime('now'), 'self_join')`,
            OTHER, roomId);

        const res = await UserProfileService.refreshStaleDiscordProfiles({ staleDays: 7, limit: 50 });

        expect(res.scanned).toBe(2);
        expect(res.refreshed).toBe(2);
        expect(fetchDiscordUser.mock.calls.map(c => c[0]).sort()).toEqual([USER, OTHER].sort());
        // hydrateFromDiscord creates the row on upsert, so the sweep is self-closing.
        const profiles = await db.all(`SELECT discord_user_id FROM user_profiles ORDER BY discord_user_id`);
        expect(profiles.map((r: { discord_user_id: string }) => r.discord_user_id).sort()).toEqual([USER, OTHER].sort());
    });

    it('does not re-list an id that already has a fresh profile row', async () => {
        const db = await getDatabase();
        await db.run(`INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, 'MappedFresh')`, USER);
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, avatar_fetched_at) VALUES (?, datetime('now'))`, USER);

        expect(await UserProfileService.refreshStaleDiscordProfiles({ staleDays: 7, limit: 50 }))
            .toEqual({ scanned: 0, refreshed: 0 });
        expect(fetchDiscordUser).not.toHaveBeenCalled();
    });

    it('honours the kill switch', async () => {
        const db = await getDatabase();
        await db.run(`INSERT INTO user_profiles (discord_user_id, avatar_fetched_at) VALUES (?, NULL)`, USER);
        process.env[PROFILE_HYDRATION_SETTING] = 'false';

        expect(await UserProfileService.refreshStaleDiscordProfiles({})).toEqual({ scanned: 0, refreshed: 0 });
        expect(fetchDiscordUser).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The belt-and-braces guard
// ─────────────────────────────────────────────────────────────────────────────

describe('RoomMembershipService.addMember rejects synthetic ids', () => {
    it('refuses to create an iscored: membership row', async () => {
        const roomId = await room();
        await RoomMembershipService.addMember(`iscored:${NAME}`, roomId, 'submission');
        await RoomMembershipService.addMember(`ISCORED:${NAME}`, roomId, 'submission');
        await drainBackgroundTasks();

        const db = await getDatabase();
        expect(await db.all(`SELECT user_id FROM room_members WHERE room_id = ?`, roomId)).toHaveLength(0);
    });

    it('still creates a real membership row', async () => {
        const roomId = await room();
        await RoomMembershipService.addMember(USER, roomId, 'submission');
        await drainBackgroundTasks();

        const db = await getDatabase();
        expect(await db.all(`SELECT user_id FROM room_members WHERE room_id = ?`, roomId)).toHaveLength(1);
    });
});
