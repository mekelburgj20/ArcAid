import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';

/**
 * Exact-match auto-linking (owner ruling, 2026-08-20 — "soggybacon should've
 * auto linked").
 *
 * THE INCIDENT. rtx_pinball's Daily Grind rotated at 22:00 CDT with its top TWO
 * scorers — StopNudgingMe and DennisB — sitting on the board as unclaimed
 * iScored names. The pick cascade strips unattributed rows (they can't be DM'd
 * and have no queue), so it skipped both and activated fourth place's queued
 * game. DennisB fixed his own case 59 minutes later by setting a display name:
 * an exact match, which P1 auto-approves instantly. The system already trusted
 * the match — it was only waiting to be asked.
 *
 * WHAT THESE TESTS DEFEND. Auto-linking is a TRIGGER, never a new rule: every
 * case here is one that `IdentityClaimService.claim` would decide the same way
 * for a hand-filed claim. So most of this file is about what does NOT link —
 * the alias cap, a name someone else holds, a name someone else is waiting on a
 * mod to decide, a near-miss, and the kill switch. If any of those start
 * linking, the auto-linker has grown a rule of its own and the P1 audit no
 * longer describes reality.
 */

// ─────────────────────────────────────────────────────────────────────────────
// iScored API seam (same shape as iscored-provenance.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

const iscored: { allScores: { scores: Array<{ name: string; game: string; gameName: string; score: string }> } } =
    { allScores: { scores: [] } };

vi.mock('../engine/IScoredApiClient.js', () => ({
    IScoredApiClient: class {
        constructor(_opts: unknown) { /* no network in tests */ }
        static parseGameroomName(url: string) { return url.split('/').pop() || null; }
        async getAllScores() { return iscored.allScores; }
        async getGameScores(_gameId: string, _limit: number) { return { scores: [] }; }
    },
}));

const { ScoreSyncPoller } = await import('../engine/ScoreSyncPoller.js');
const { IdentityAutoLinkService, AUTO_LINK_SETTING } = await import('../services/IdentityAutoLinkService.js');
const { IdentityClaimService, MAX_ALIASES } = await import('../services/IdentityClaimService.js');
const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');
const { RoomMembershipService } = await import('../services/RoomMembershipService.js');
const { drainBackgroundTasks } = await import('../utils/backgroundTasks.js');

const CREDS = {
    username: 'acct', password: 'pw', publicUrl: 'https://example.invalid/acct',
    gameroomName: 'acct', source: 'room' as const,
};

let roomCounter = 0;

async function seedUser(id: string, opts: { username?: string | null; display?: string | null } = {}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO user_profiles (discord_user_id, username, display_name) VALUES (?, ?, ?)`,
        id, opts.username ?? null, opts.display ?? null,
    );
}

/** A room with one iScored-synced score sitting under `name`, owned by nobody. */
async function seedRoomWithSyncedName(name: string) {
    const db = await getDatabase();
    const roomId = await createTestRoom(`autolink-${++roomCounter}`, 'Auto Link Room');
    await db.run(
        `INSERT INTO score_history (game_name, game_room_id, iscored_username, discord_user_id, score, source)
         VALUES ('WHO dunnit', ?, ?, ?, 5000, 'sync')`,
        roomId, name, `iscored:${name}`,
    );
    return roomId;
}

async function joinRoom(userId: string, roomId: string) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO room_members (user_id, room_id, source) VALUES (?, ?, 'claim')`,
        userId, roomId,
    );
}

async function aliasesOf(userId: string): Promise<string[]> {
    const db = await getDatabase();
    const rows = await db.all('SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?', userId);
    return rows.map((r: any) => r.iscored_username);
}

// ─────────────────────────────────────────────────────────────────────────────
// Login trigger
// ─────────────────────────────────────────────────────────────────────────────

describe('auto-link at login — what links', () => {
    beforeEach(async () => { await setupTestDb(); delete process.env[AUTO_LINK_SETTING]; });
    afterEach(() => { delete process.env[AUTO_LINK_SETTING]; });

    it('links an unclaimed iScored name that exactly matches the account username', async () => {
        // soggybacon: Discord login, no display name, never filed a claim.
        const roomId = await seedRoomWithSyncedName('soggybacon');
        await seedUser('U_SOGGY', { username: 'soggybacon' });
        await joinRoom('U_SOGGY', roomId);

        const linked = await IdentityAutoLinkService.autoLinkForUser('U_SOGGY');

        expect(linked).toEqual(['soggybacon']);
        expect(await aliasesOf('U_SOGGY')).toEqual(['soggybacon']);
    });

    it('links on the chosen display name, ignoring case only', async () => {
        // DennisB's actual fix, now automatic.
        const roomId = await seedRoomWithSyncedName('DennisB');
        await seedUser('U_DENNIS', { username: 'raw_handle', display: 'dennisb' });

        const linked = await IdentityAutoLinkService.autoLinkForUser('U_DENNIS', { roomId });

        expect(linked).toEqual(['DennisB']);
        expect(await aliasesOf('U_DENNIS')).toEqual(['DennisB']);
    });

    it('writes an auditable identity_claims row rather than a bare mapping', async () => {
        // The point of routing through IdentityClaimService: the link is
        // explainable after the fact.
        const roomId = await seedRoomWithSyncedName('soggybacon');
        await seedUser('U_AUDIT', { username: 'soggybacon' });

        await IdentityAutoLinkService.autoLinkForUser('U_AUDIT', { roomId });

        const db = await getDatabase();
        const claim = await db.get(
            `SELECT status, auto_matched_on, resolved_by FROM identity_claims WHERE claimant_user_id = ?`,
            'U_AUDIT',
        );
        expect(claim).toMatchObject({ status: 'approved', resolved_by: 'auto' });
        expect(claim.auto_matched_on).toBeTruthy();
    });
});

describe('auto-link at login — what does NOT link', () => {
    beforeEach(async () => { await setupTestDb(); delete process.env[AUTO_LINK_SETTING]; });
    afterEach(() => { delete process.env[AUTO_LINK_SETTING]; });

    it('does not link a NEAR match — separators are not normalized', async () => {
        // P1's rule, verbatim: `Chalata_Love` does not match `ChalataLove`.
        const roomId = await seedRoomWithSyncedName('Chalata_Love');
        await seedUser('U_NEAR', { username: 'ChalataLove' });

        expect(await IdentityAutoLinkService.autoLinkForUser('U_NEAR', { roomId })).toEqual([]);
        expect(await aliasesOf('U_NEAR')).toEqual([]);
    });

    it('does not exceed the alias cap', async () => {
        const db = await getDatabase();
        const roomId = await seedRoomWithSyncedName('CappedGuy');
        await seedUser('U_CAP', { username: 'CappedGuy' });
        for (let i = 0; i < MAX_ALIASES; i++) {
            await db.run(
                `INSERT INTO user_mappings (discord_user_id, iscored_username, created_at)
                 VALUES (?, ?, datetime('now'))`,
                'U_CAP', `held-alias-${i}`,
            );
        }

        expect(await IdentityAutoLinkService.autoLinkForUser('U_CAP', { roomId })).toEqual([]);
        expect(await aliasesOf('U_CAP')).not.toContain('CappedGuy');
    });

    it('does not steal a name already mapped to another account', async () => {
        const db = await getDatabase();
        const roomId = await seedRoomWithSyncedName('Contested');
        await seedUser('U_THIEF', { username: 'Contested' });
        await db.run(
            `INSERT INTO user_mappings (discord_user_id, iscored_username, created_at)
             VALUES ('U_OWNER', 'contested', datetime('now'))`,
        );

        expect(await IdentityAutoLinkService.autoLinkForUser('U_THIEF', { roomId })).toEqual([]);
        const owner = await db.get(
            'SELECT discord_user_id FROM user_mappings WHERE LOWER(iscored_username) = ?', 'contested');
        expect(owner.discord_user_id).toBe('U_OWNER');
    });

    it('does not pre-empt a pending claim filed by someone else', async () => {
        // A mod is deciding this name right now. An unattended link would settle
        // the dispute in favour of whoever happened to log in first.
        const db = await getDatabase();
        const roomId = await seedRoomWithSyncedName('Disputed');
        await seedUser('U_ME', { username: 'Disputed' });
        await db.run(
            `INSERT INTO identity_claims (game_room_id, claimant_user_id, iscored_username, status)
             VALUES (?, 'U_OTHER', 'Disputed', 'pending')`,
            roomId,
        );

        expect(await IdentityAutoLinkService.autoLinkForUser('U_ME', { roomId })).toEqual([]);
        expect(await aliasesOf('U_ME')).toEqual([]);
    });

    it('does nothing when the global kill switch is off', async () => {
        const roomId = await seedRoomWithSyncedName('soggybacon');
        await seedUser('U_KILL', { username: 'soggybacon' });
        process.env[AUTO_LINK_SETTING] = 'false';

        expect(await IdentityAutoLinkService.autoLinkForUser('U_KILL', { roomId })).toEqual([]);
        expect(await aliasesOf('U_KILL')).toEqual([]);
    });

    it('does nothing when the room turns it off', async () => {
        const roomId = await seedRoomWithSyncedName('soggybacon');
        await seedUser('U_ROOMKILL', { username: 'soggybacon' });
        await GameRoomSettingsService.set(roomId, AUTO_LINK_SETTING, 'false');

        expect(await IdentityAutoLinkService.autoLinkForUser('U_ROOMKILL', { roomId })).toEqual([]);
    });

    it('never links a Google-only account on its provider username', async () => {
        // A google:* canonical has no Discord username, so `username` is really
        // a Google display name. A human may still claim it by hand (P1 rule
        // unchanged); the unattended path will not.
        const roomId = await seedRoomWithSyncedName('GoogleHandle');
        await seedUser('google:123', { username: 'GoogleHandle' });

        expect(await IdentityAutoLinkService.autoLinkForUser('google:123', { roomId })).toEqual([]);
        // ...and the hand-filed claim still auto-approves, proving the P1 rule
        // was narrowed only for the trigger.
        expect((await IdentityClaimService.claim('google:123', roomId, 'GoogleHandle')).result)
            .toBe('auto_approved');
    });

    it('ignores rooms the user has nothing to do with', async () => {
        await seedRoomWithSyncedName('soggybacon');   // not joined, not passed in
        await seedUser('U_STRANGER', { username: 'soggybacon' });

        expect(await IdentityAutoLinkService.autoLinkForUser('U_STRANGER')).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sync trigger
// ─────────────────────────────────────────────────────────────────────────────

/** A tournament game wired to iScored GameID 95570, ready for the poller. */
async function seedSyncTournament(slug: string) {
    const db = await getDatabase();
    const roomId = await createTestRoom(slug, slug);
    const tournamentId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id)
         VALUES (?, 'Daily Grind', 'DG', 'pinball', '{}', 1, ?)`,
        tournamentId, roomId,
    );
    const gameId = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, iscored_id, status, game_room_id, created_at)
         VALUES (?, ?, 'WHO dunnit', '95570', 'ACTIVE', ?, datetime('now'))`,
        gameId, tournamentId, roomId,
    );
    return { db, roomId, tournamentId, gameId };
}

function pollOnce(db: any, roomId: string, mappingMap = new Map(), checked = new Set<string>()) {
    return (ScoreSyncPoller.getInstance() as unknown as {
        pollOneAccount: (...a: unknown[]) => Promise<void>;
    }).pollOneAccount(db, CREDS, [roomId], mappingMap, new Map(), new Set(), checked);
}

describe('auto-link during iScored sync', () => {
    beforeEach(async () => {
        await setupTestDb();
        delete process.env[AUTO_LINK_SETTING];
        iscored.allScores = { scores: [] };
        vi.restoreAllMocks();
    });
    afterEach(() => { delete process.env[AUTO_LINK_SETTING]; vi.restoreAllMocks(); });

    it('links on first import AND attributes that very score', async () => {
        // The whole reason the pass runs BEFORE the write loop: waiting for the
        // next cycle would leave this row as `iscored:soggybacon`.
        const { db, roomId, gameId } = await seedSyncTournament('sync-autolink');
        await seedUser('U_SOGGY', { username: 'soggybacon' });
        await joinRoom('U_SOGGY', roomId);
        iscored.allScores = {
            scores: [{ name: 'soggybacon', game: '95570', gameName: 'WHO dunnit', score: '1,000' }],
        };

        await pollOnce(db, roomId);

        expect(await aliasesOf('U_SOGGY')).toEqual(['soggybacon']);
        const sub = await db.get(
            'SELECT discord_user_id, submitted_by_user_id FROM submissions WHERE game_id = ?', gameId);
        expect(sub).toMatchObject({ discord_user_id: 'U_SOGGY', submitted_by_user_id: 'U_SOGGY' });
    });

    it('leaves an unmatched name unattributed, exactly as before', async () => {
        const { db, roomId, gameId } = await seedSyncTournament('sync-nomatch');
        iscored.allScores = {
            scores: [{ name: 'StopNudgingMe', game: '95570', gameName: 'WHO dunnit', score: '900' }],
        };

        await pollOnce(db, roomId);

        const sub = await db.get(
            'SELECT discord_user_id, submitted_by_user_id FROM submissions WHERE game_id = ?', gameId);
        expect(sub).toMatchObject({ discord_user_id: 'iscored:StopNudgingMe', submitted_by_user_id: null });
    });

    it('caches negatives for the whole cycle — one batched lookup, not one per account', async () => {
        const { db, roomId } = await seedSyncTournament('sync-negcache');
        iscored.allScores = {
            scores: [
                { name: 'Nobody1', game: '95570', gameName: 'WHO dunnit', score: '900' },
                { name: 'Nobody1', game: '95570', gameName: 'WHO dunnit', score: '901' },
                { name: 'Nobody2', game: '95570', gameName: 'WHO dunnit', score: '800' },
            ],
        };
        const spy = vi.spyOn(IdentityAutoLinkService, 'candidateOwnersForNames');

        const cycleCache = new Set<string>();
        await pollOnce(db, roomId, new Map(), cycleCache);
        await pollOnce(db, roomId, new Map(), cycleCache);   // second account, same cycle

        // One call, carrying the two DISTINCT names — never one per score, and
        // the second account re-queries nothing.
        expect(spy).toHaveBeenCalledTimes(1);
        expect((spy.mock.calls[0]![1] as string[]).sort()).toEqual(['nobody1', 'nobody2']);
    });

    it('never throws into the poll when the auto-link pass fails', async () => {
        const { db, roomId, gameId } = await seedSyncTournament('sync-throws');
        vi.spyOn(IdentityAutoLinkService, 'candidateOwnersForNames')
            .mockRejectedValue(new Error('user_profiles is on fire'));
        iscored.allScores = {
            scores: [{ name: 'SyncPlayer', game: '95570', gameName: 'WHO dunnit', score: '4,242' }],
        };

        await expect(pollOnce(db, roomId)).resolves.toBeUndefined();

        // The score still landed — sync is the load-bearing job here.
        const sub = await db.get('SELECT score FROM submissions WHERE game_id = ?', gameId);
        expect(sub.score).toBe(4242);
    });

    it('does NOT link a non-member who merely shares the name', async () => {
        // The scoping rule: an iScored "Jay" on this board must not attach to an
        // unrelated Arcaid `jay` who has never been in this room. Sync has no
        // proof of identity — only a string on someone else's leaderboard.
        const { db, roomId, gameId } = await seedSyncTournament('sync-nonmember');
        await seedUser('U_STRANGER', { username: 'Jay' });   // deliberately NOT a member
        iscored.allScores = {
            scores: [{ name: 'Jay', game: '95570', gameName: 'WHO dunnit', score: '700' }],
        };

        await pollOnce(db, roomId);

        expect(await aliasesOf('U_STRANGER')).toEqual([]);
        const sub = await db.get(
            'SELECT discord_user_id, submitted_by_user_id FROM submissions WHERE game_id = ?', gameId);
        expect(sub).toMatchObject({ discord_user_id: 'iscored:Jay', submitted_by_user_id: null });
    });

    it('honours the kill switch during sync', async () => {
        const { db, roomId } = await seedSyncTournament('sync-killswitch');
        await seedUser('U_SOGGY', { username: 'soggybacon' });
        await joinRoom('U_SOGGY', roomId);
        process.env[AUTO_LINK_SETTING] = 'false';
        iscored.allScores = {
            scores: [{ name: 'soggybacon', game: '95570', gameName: 'WHO dunnit', score: '1,000' }],
        };

        await pollOnce(db, roomId);

        expect(await aliasesOf('U_SOGGY')).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Membership trigger
// ─────────────────────────────────────────────────────────────────────────────

describe('auto-link on joining a room', () => {
    beforeEach(async () => { await setupTestDb(); delete process.env[AUTO_LINK_SETTING]; });
    afterEach(() => { delete process.env[AUTO_LINK_SETTING]; });

    it('links an exact-match synced name the moment the member row is created', async () => {
        // Joining (or first-submitting) is when the room's unclaimed names become
        // this player's problem; waiting for the next login is an arbitrary delay.
        const roomId = await seedRoomWithSyncedName('soggybacon');
        await seedUser('U_JOINER', { username: 'soggybacon' });

        await RoomMembershipService.addMember('U_JOINER', roomId, 'self_join');
        await drainBackgroundTasks();

        expect(await aliasesOf('U_JOINER')).toEqual(['soggybacon']);
    });

    it('does not re-run on every later write to an existing member row', async () => {
        // `addMember` is called on EVERY score submit; only creation should fire.
        const roomId = await seedRoomWithSyncedName('soggybacon');
        await seedUser('U_REPEAT', { username: 'soggybacon' });
        await RoomMembershipService.addMember('U_REPEAT', roomId, 'self_join');
        await drainBackgroundTasks();

        const spy = vi.spyOn(IdentityAutoLinkService, 'autoLinkForUser');
        await RoomMembershipService.addMember('U_REPEAT', roomId, 'submission');
        await drainBackgroundTasks();

        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('ignores sentinel ids and never throws into the caller', async () => {
        const roomId = await seedRoomWithSyncedName('soggybacon');
        await expect(RoomMembershipService.addMember('COMMUNITY', roomId, 'submission')).resolves.toBeUndefined();
        await expect(RoomMembershipService.addMember(null, roomId, 'submission')).resolves.toBeUndefined();
    });
});
