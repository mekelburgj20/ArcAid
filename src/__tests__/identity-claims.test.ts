import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { IdentityClaimService, ClaimError, MAX_ALIASES } from '../services/IdentityClaimService.js';

/**
 * Identity claims — guarded self-claim of an iScored name (P1 + P4).
 *
 * The hole this closes: `/map-user` gated on Administrator ONLY when mapping
 * someone else, so any guild member could claim any unclaimed iScored name.
 * Claimed names feed the leaderboard partition, stats, and the pick cascade —
 * so the auto-approve boundary is a security boundary, and most of these tests
 * exist to prove it does NOT move.
 */

let roomCounter = 0;

async function setup() {
    return createTestRoom(`claim-room-${++roomCounter}`, 'Claim Room');
}

async function seedUser(id: string, opts: {
    username?: string | null;
    display?: string | null;
    email?: string | null;
} = {}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO user_profiles (discord_user_id, username, display_name, email_local_part)
         VALUES (?, ?, ?, ?)`,
        id, opts.username ?? null, opts.display ?? null, opts.email ?? null,
    );
}

async function giveAlias(id: string, name: string) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO user_mappings (discord_user_id, iscored_username, created_at)
         VALUES (?, ?, datetime('now'))`,
        id, name,
    );
}

async function aliasesOf(id: string): Promise<string[]> {
    const db = await getDatabase();
    const rows = await db.all('SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?', id);
    return rows.map((r: any) => r.iscored_username);
}

describe('identity claims — what auto-approves', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('auto-approves an exact match on the account username', async () => {
        const roomId = await setup();
        await seedUser('U1', { username: 'ChalataLove' });

        const out = await IdentityClaimService.claim('U1', roomId, 'ChalataLove');

        expect(out.result).toBe('auto_approved');
        expect(await aliasesOf('U1')).toEqual(['ChalataLove']);
    });

    it('auto-approves ignoring case only', async () => {
        const roomId = await setup();
        await seedUser('U2', { username: 'ChalataLove' });

        const out = await IdentityClaimService.claim('U2', roomId, '  chalatalove  ');
        expect(out.result).toBe('auto_approved');
    });

    it('auto-approves on the chosen display name', async () => {
        const roomId = await setup();
        await seedUser('U3', { username: 'raw_handle', display: 'RetroTechX' });

        expect((await IdentityClaimService.claim('U3', roomId, 'retrotechx')).result).toBe('auto_approved');
    });

    it('auto-approves on a linked Google account local-part, never the domain', async () => {
        const roomId = await setup();
        await seedUser('U4', { username: 'Some Display Name', email: 'chalatalove' });

        expect((await IdentityClaimService.claim('U4', roomId, 'ChalataLove')).result).toBe('auto_approved');
    });

    it('auto-approves a second name matching an alias already held', async () => {
        const roomId = await setup();
        await seedUser('U5', { username: 'nothing-alike' });
        await giveAlias('U5', 'HeldName');

        expect((await IdentityClaimService.claim('U5', roomId, 'heldname')).result).toBe('already_yours');
    });
});

describe('identity claims — what does NOT auto-approve (the security boundary)', () => {
    beforeEach(async () => { await setupTestDb(); });

    /**
     * Owner ruling: case-insensitivity ONLY. Separators and spaces are not
     * normalized. Widening any of these re-opens the hole through the
     * auto-approve door, so each is asserted to reach the mod queue.
     */
    it.each([
        ['separator inserted', 'ChalataLove', 'Chalata_Love'],
        ['space inserted', 'ChalataLove', 'Chalata Love'],
        ['trailing digit', 'soggybacon', 'soggybacon2'],
        ['near miss', 'ChalataLove', 'ChalataLuv'],
        ['someone else entirely', 'soggybacon', 'RetroTechX'],
    ])('queues for review: %s', async (_label, known, requested) => {
        const roomId = await setup();
        await seedUser('U-' + requested, { username: known });

        const out = await IdentityClaimService.claim('U-' + requested, roomId, requested);

        expect(out.result).toBe('pending');
        expect(await aliasesOf('U-' + requested)).toEqual([]);   // nothing granted yet
        expect(await IdentityClaimService.pendingCount(roomId)).toBe(1);
    });

    it('a user with no stored names auto-approves nothing', async () => {
        const roomId = await setup();
        await seedUser('U-blank');
        expect((await IdentityClaimService.claim('U-blank', roomId, 'AnyName')).result).toBe('pending');
    });

    it("refuses a name already held by someone else, and grants nothing", async () => {
        const roomId = await setup();
        await seedUser('OWNER', { username: 'TakenName' });
        await giveAlias('OWNER', 'TakenName');
        await seedUser('THIEF', { username: 'TakenName' });   // same username, different account

        await expect(IdentityClaimService.claim('THIEF', roomId, 'TakenName'))
            .rejects.toMatchObject({ code: 'ALREADY_CLAIMED' });
        expect(await aliasesOf('THIEF')).toEqual([]);
    });
});

describe('identity claims — the alias cap', () => {
    beforeEach(async () => { await setupTestDb(); });

    it(`refuses a ${MAX_ALIASES + 1}th name`, async () => {
        const roomId = await setup();
        await seedUser('U-cap', { username: 'Capped' });
        for (let i = 0; i < MAX_ALIASES; i++) await giveAlias('U-cap', `Alias${i}`);

        await expect(IdentityClaimService.claim('U-cap', roomId, 'Capped'))
            .rejects.toMatchObject({ code: 'TOO_MANY_ALIASES' });
    });

    it('releasing one makes room again', async () => {
        const roomId = await setup();
        await seedUser('U-rel', { username: 'Freed' });
        for (let i = 0; i < MAX_ALIASES; i++) await giveAlias('U-rel', `Alias${i}`);

        expect(await IdentityClaimService.releaseAlias('U-rel', 'alias0')).toBe(true);
        expect((await IdentityClaimService.claim('U-rel', roomId, 'Freed')).result).toBe('auto_approved');
    });

    it("cannot release a name held by someone else", async () => {
        await setupTestDb();
        await seedUser('A'); await seedUser('B');
        await giveAlias('B', 'BsName');

        expect(await IdentityClaimService.releaseAlias('A', 'BsName')).toBe(false);
        expect(await aliasesOf('B')).toEqual(['BsName']);
    });
});

describe('identity claims — the mod queue', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('approving grants the alias and clears the queue', async () => {
        const roomId = await setup();
        await seedUser('U-q', { username: 'unrelated' });
        const out = await IdentityClaimService.claim('U-q', roomId, 'SomeoneElse');
        expect(out.result).toBe('pending');

        await IdentityClaimService.approve((out as any).claimId, roomId, 'admin-1');

        expect(await aliasesOf('U-q')).toEqual(['SomeoneElse']);
        expect(await IdentityClaimService.pendingCount(roomId)).toBe(0);
    });

    it('rejecting grants nothing', async () => {
        const roomId = await setup();
        await seedUser('U-r', { username: 'unrelated' });
        const out = await IdentityClaimService.claim('U-r', roomId, 'NotMine');

        await IdentityClaimService.reject((out as any).claimId, roomId, 'admin-1');

        expect(await aliasesOf('U-r')).toEqual([]);
        expect(await IdentityClaimService.pendingCount(roomId)).toBe(0);
    });

    it('a claim cannot be resolved twice', async () => {
        const roomId = await setup();
        await seedUser('U-d', { username: 'unrelated' });
        const out = await IdentityClaimService.claim('U-d', roomId, 'OnceOnly');
        await IdentityClaimService.approve((out as any).claimId, roomId, 'admin-1');

        await expect(IdentityClaimService.approve((out as any).claimId, roomId, 'admin-1'))
            .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('a claim cannot be resolved from a DIFFERENT room', async () => {
        const roomA = await setup();
        const roomB = await setup();
        await seedUser('U-x', { username: 'unrelated' });
        const out = await IdentityClaimService.claim('U-x', roomA, 'CrossRoom');

        await expect(IdentityClaimService.approve((out as any).claimId, roomB, 'admin-2'))
            .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('approval re-checks availability — the name can be taken while queued', async () => {
        const roomId = await setup();
        await seedUser('U-race', { username: 'unrelated' });
        const out = await IdentityClaimService.claim('U-race', roomId, 'Contested');

        // Someone else claims it legitimately while the request sits in the queue.
        await seedUser('U-fast', { username: 'Contested' });
        await IdentityClaimService.claim('U-fast', roomId, 'Contested');

        await expect(IdentityClaimService.approve((out as any).claimId, roomId, 'admin-1'))
            .rejects.toMatchObject({ code: 'ALREADY_CLAIMED' });
        expect(await aliasesOf('U-race')).toEqual([]);
    });

    it('the queue shows how much history the name carries in this room', async () => {
        const roomId = await setup();
        const db = await getDatabase();
        await seedUser('U-hist', { username: 'unrelated' });
        await IdentityClaimService.claim('U-hist', roomId, 'BigName');
        for (let i = 0; i < 3; i++) {
            await db.run(
                `INSERT INTO score_history (game_name, iscored_username, score, source, game_room_id, created_at)
                 VALUES (?, ?, ?, 'community', ?, datetime('now'))`,
                'Game' + i, 'bigname', 100 + i, roomId,
            );
        }

        const [row] = await IdentityClaimService.listPending(roomId);
        expect(row.scores_in_room).toBe(3);
        expect(row.iscored_username).toBe('BigName');
    });

    it('the same name cannot be requested twice while pending', async () => {
        const roomId = await setup();
        await seedUser('U-dup', { username: 'unrelated' });
        await IdentityClaimService.claim('U-dup', roomId, 'Dup');

        await expect(IdentityClaimService.claim('U-dup', roomId, 'dup'))
            .rejects.toMatchObject({ code: 'ALREADY_PENDING' });
    });
});

describe('identity claims — review-room routing (global surface)', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('routes review to the room where that name actually has history', async () => {
        const quiet = await setup();
        const busy = await setup();
        const db = await getDatabase();
        await seedUser('U-route', { username: 'unrelated' });

        await db.run(
            `INSERT INTO score_history (game_name, iscored_username, score, source, game_room_id, created_at)
             VALUES ('G', 'TargetName', 10, 'community', ?, datetime('now'))`, quiet);
        for (let i = 0; i < 3; i++) {
            await db.run(
                `INSERT INTO score_history (game_name, iscored_username, score, source, game_room_id, created_at)
                 VALUES ('G', 'TargetName', ?, 'community', ?, datetime('now'))`, 20 + i, busy);
        }

        expect(await IdentityClaimService.resolveReviewRoom('U-route', 'targetname')).toBe(busy);
    });

    it('falls back to a room the claimant belongs to when the name has no history', async () => {
        const roomId = await setup();
        const db = await getDatabase();
        await seedUser('U-mem', { username: 'unrelated' });
        await db.run(
            `INSERT INTO room_members (user_id, room_id, source) VALUES (?, ?, 'self_join')`,
            'U-mem', roomId);

        expect(await IdentityClaimService.resolveReviewRoom('U-mem', 'NoHistory')).toBe(roomId);
    });

    it('refuses to queue a claim it cannot route, rather than burying it', async () => {
        await setupTestDb();
        await seedUser('U-nowhere', { username: 'unrelated' });

        expect(await IdentityClaimService.resolveReviewRoom('U-nowhere', 'Orphan')).toBeNull();
        await expect(IdentityClaimService.claim('U-nowhere', null, 'Orphan'))
            .rejects.toMatchObject({ code: 'NO_REVIEW_ROOM' });
    });

    it('an auto-approved claim needs no room at all', async () => {
        await setupTestDb();
        await seedUser('U-auto', { username: 'MyOwnName' });

        const out = await IdentityClaimService.claim('U-auto', null, 'myownname');
        expect(out.result).toBe('auto_approved');
        expect(await aliasesOf('U-auto')).toEqual(['myownname']);
    });
});

describe('identity claims — the storage-layer guard (migration 153)', () => {
    beforeEach(async () => { await setupTestDb(); });

    /**
     * Migration 152 was meant to carry this CHECK; a bad string replace put it
     * on `join_requests` instead, and 152 shipped without it. Post-deploy
     * verification caught that, and 153 rebuilt the table with the guard.
     *
     * The service already refuses to create an unroutable pending claim, so
     * this is defence in depth — but a pending claim with no room would sit in
     * no queue and be invisible forever, which is exactly the class of bug a
     * CHECK should make unrepresentable.
     */
    it('the CHECK exists on identity_claims', async () => {
        const db = await getDatabase();
        const t = await db.get("SELECT sql FROM sqlite_master WHERE name='identity_claims'");
        expect(t.sql).toContain("status != 'pending'");
    });

    it('the database refuses a pending claim with no review room', async () => {
        const db = await getDatabase();
        await expect(db.run(
            `INSERT INTO identity_claims (game_room_id, claimant_user_id, iscored_username, status)
             VALUES (NULL, 'U', 'Orphan', 'pending')`,
        )).rejects.toThrow();
    });

    it('an approved claim with no room is still allowed', async () => {
        const db = await getDatabase();
        await expect(db.run(
            `INSERT INTO identity_claims (game_room_id, claimant_user_id, iscored_username, status)
             VALUES (NULL, 'U', 'AutoName', 'approved')`,
        )).resolves.toBeDefined();
    });

    it('join_requests did NOT keep the stray CHECK', async () => {
        const db = await getDatabase();
        const t = await db.get("SELECT sql FROM sqlite_master WHERE name='join_requests'");
        expect(t.sql).not.toContain("status != 'pending'");
    });
});
