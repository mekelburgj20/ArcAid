import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { signToken } from '../api/auth.js';
import {
    normalizeForBlocklist,
    containsBlockedTerm,
    assertNameAllowed,
} from '../utils/contentBlocklist.js';

// S22 Phase 1 content moderation (v2.43.0) — unit coverage for the
// normalization/matching logic, plus one integration test per chokepoint
// (room create, display name, room-name claim) asserting the coded 4xx.

describe('normalizeForBlocklist / containsBlockedTerm', () => {
    it('matches the exact term (lowercased)', () => {
        expect(containsBlockedTerm('NIGGER')).toBe(true);
        expect(containsBlockedTerm('nigger')).toBe(true);
    });

    it('matches l33t-speak substitutions', () => {
        expect(containsBlockedTerm('n1gg3r')).toBe(true);
        expect(containsBlockedTerm('f4gg0t')).toBe(true);
    });

    it('matches diacritic-stripped variants', () => {
        expect(containsBlockedTerm('nígger')).toBe(true);
        expect(containsBlockedTerm('fâggot')).toBe(true);
    });

    it('matches zero-width-character-inserted variants', () => {
        const zw = String.fromCharCode(0x200b); // zero width space
        expect(containsBlockedTerm(`nig${zw}ger`)).toBe(true);
    });

    it('matches separator-inserted variants', () => {
        expect(containsBlockedTerm('n.i.g.g.e.r')).toBe(true);
        expect(containsBlockedTerm('n_i_g_g_e_r')).toBe(true);
        expect(containsBlockedTerm('n-i-g-g-e-r')).toBe(true);
        expect(containsBlockedTerm('n i g g e r')).toBe(true);
    });

    it('matches the term embedded inside a longer string', () => {
        expect(containsBlockedTerm('xXn1gg3rXx')).toBe(true);
    });

    it('passes clean, ordinary names', () => {
        expect(containsBlockedTerm('Pinball Wizard')).toBe(false);
        expect(containsBlockedTerm('The Arcade Room')).toBe(false);
        expect(containsBlockedTerm('Bob_2')).toBe(false);
        expect(containsBlockedTerm('')).toBe(false);
        expect(containsBlockedTerm(null)).toBe(false);
        expect(containsBlockedTerm(undefined)).toBe(false);
    });

    it('passes a Scunthorpe-style embedded-profanity name (general profanity is out of scope)', () => {
        // The classic Scunthorpe-problem example — contains a common profane
        // substring but is an ordinary place name. Must NOT be blocked: this
        // blocklist targets unambiguous hate slurs only, not general profanity.
        expect(containsBlockedTerm('Scunthorpe Arcade')).toBe(false);
        // Same rationale for a common English idiom containing a substring
        // some naive blocklists incorrectly flag.
        expect(containsBlockedTerm('chink in the armor arcade')).toBe(false);
    });

    it('normalizeForBlocklist lowercases and l33t-folds without collapsing separators', () => {
        expect(normalizeForBlocklist('N1GG3R')).toBe('nigger'); // n-1(i)-g-g-3(e)-r
        // '2' has no l33t mapping, so it passes through unchanged; separators
        // (the space) are kept — collapsing is `collapseSeparators`'s job, not this one's.
        expect(normalizeForBlocklist('Test 123')).toBe('test i2e');
        expect(normalizeForBlocklist('ABC')).toBe('abc');
        expect(normalizeForBlocklist('1')).toBe('i');
        expect(normalizeForBlocklist('0')).toBe('o');
    });
});

describe('assertNameAllowed', () => {
    it('throws a coded NAME_NOT_ALLOWED error without echoing the matched term', () => {
        try {
            assertNameAllowed('nigger', 'room_name');
            expect.unreachable();
        } catch (err) {
            const e = err as Error & { code?: string; kind?: string };
            expect(e.code).toBe('NAME_NOT_ALLOWED');
            expect(e.kind).toBe('room_name');
            expect(e.message.toLowerCase()).not.toContain('nigger');
        }
    });

    it('does not throw for a clean name', () => {
        expect(() => assertNameAllowed('Pinball Palace', 'room_name')).not.toThrow();
    });
});

// ─── Chokepoint integration ───

async function createApp() {
    await setupTestDb();
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    const { default: usersRouter } = await import('../api/routes/users.js');
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/users', usersRouter);
    app.use('/api/rooms', roomsRouter);
    app.use('/api', globalRouter);
    return app;
}

function playerToken(discordId: string) {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username: 'Tester' });
}

describe('chokepoint: POST /api/rooms (public room create)', () => {
    it('400s a blocked room name', async () => {
        const app = await createApp();
        const res = await request(app)
            .post('/api/rooms')
            .set('Authorization', `Bearer ${playerToken('discord-blocklist-room-1')}`)
            .send({ name: 'nigger arcade', slug: 'clean_slug_1' });
        expect(res.status).toBe(400);
    });

    it('400s a blocked slug', async () => {
        const app = await createApp();
        const res = await request(app)
            .post('/api/rooms')
            .set('Authorization', `Bearer ${playerToken('discord-blocklist-room-2')}`)
            .send({ name: 'Clean Name', slug: 'faggot_room' });
        expect(res.status).toBe(400);
    });

    it('allows a clean room name/slug through', async () => {
        const app = await createApp();
        const res = await request(app)
            .post('/api/rooms')
            .set('Authorization', `Bearer ${playerToken('discord-blocklist-room-3')}`)
            .send({ name: 'Pinball Palace', slug: 'pinball_palace_bl' });
        expect(res.status).toBe(200);
    });
});

describe('chokepoint: PATCH /api/users/me/profile (display name)', () => {
    it('400s a blocked display name', async () => {
        const app = await createApp();
        const res = await request(app)
            .patch('/api/users/me/profile')
            .set('Authorization', `Bearer ${playerToken('discord-blocklist-dn-1')}`)
            .send({ display_name: 'n1gg3r' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('NAME_NOT_ALLOWED');
    });

    it('allows a clean display name through', async () => {
        const app = await createApp();
        const res = await request(app)
            .patch('/api/users/me/profile')
            .set('Authorization', `Bearer ${playerToken('discord-blocklist-dn-2')}`)
            .send({ display_name: 'CleanName' });
        expect(res.status).toBe(200);
    });
});

describe('chokepoint: POST /:roomId/submit/name-check (claim path pre-check)', () => {
    it('400s with a coded error for a blocked name rather than crashing/500ing', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('bl-claim-room');
        const res = await request(app)
            .post(`/api/rooms/${roomId}/submit/name-check`)
            .send({ name: 'towelhead' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('NAME_NOT_ALLOWED');
        expect(typeof res.body.error).toBe('string');
    });

    it('allows a clean name through', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('bl-claim-room-2');
        const res = await request(app)
            .post(`/api/rooms/${roomId}/submit/name-check`)
            .send({ name: 'HighScorer' });
        expect(res.status).toBe(200);
        expect(res.body.available).toBe(true);
    });
});
