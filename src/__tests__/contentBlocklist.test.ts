import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { getDatabase } from '../database/database.js';
import { setupTestDb, createTestRoom } from './helpers.js';
import { signToken } from '../api/auth.js';
import {
    normalizeForBlocklist,
    containsBlockedTerm,
    assertNameAllowed,
    sanitizeProviderUsername,
} from '../utils/contentBlocklist.js';
import { RoomNameClaimService } from '../services/RoomNameClaimService.js';

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

    // M1a (S22 Phase 1 adversarial review) — the separator-collapse algorithm
    // previously stripped EVERY separator, so terms matched across word
    // boundaries between two ordinary multi-character words. Fixed rule:
    // only strip a separator run when BOTH adjacent alphanumeric runs are
    // exactly 1 character (the real letter-spacing attack shape). These ten
    // names were reviewer-verified false positives under the old algorithm
    // and must all pass now.
    it('M1a: does not false-positive on ordinary two-word names (separator-collapse false positives)', () => {
        const falsePositiveNames = [
            'Ski Kelly',
            'Nikki Kern',
            'Loki Kelvin',
            'Bean Erickson',
            'Jelly Bean Ernie',
            'Mango OK',
            'Bingo Okada',
            'Lego Oktoberfest',
            'Chicago Okay',
            'Wet Backspin',
        ];
        for (const name of falsePositiveNames) {
            expect(containsBlockedTerm(name), `expected "${name}" to PASS`).toBe(false);
        }
    });

    it('M1a: still catches the real letter-spacing attack shape (both sides of the separator are single characters)', () => {
        expect(containsBlockedTerm('n.i.g.g.e.r')).toBe(true);
        expect(containsBlockedTerm('n_i_g_g_e_r')).toBe(true);
        expect(containsBlockedTerm('n i g g e r')).toBe(true);
        expect(containsBlockedTerm('n-i-g-g-e-r')).toBe(true);
    });

    it('M1a: keeps a real word boundary when only ONE side of the separator is a single character', () => {
        // "G Ookami" — a single-letter initial ("G") followed by a real
        // multi-letter surname ("Ookami"). If the separator were collapsed
        // (the old, buggy always-collapse behavior), this becomes
        // "gookami", which contains "gook" — a false positive formed from
        // the initial's letter plus the surname's leading letters. The fix
        // requires BOTH sides to be exactly 1 character before collapsing,
        // so a 1-char + 6-char boundary like this one must NOT collapse.
        expect(containsBlockedTerm('G Ookami')).toBe(false);
    });

    // M1b (S22 Phase 1 adversarial review) — 'kike' (Spanish diminutive of
    // Enrique) and 'beaner' (substring of "beanery") were dropped from the
    // term list for real-name/real-word collision risk.
    it('M1b: no longer blocks the terms dropped for real-name collision risk', () => {
        expect(containsBlockedTerm('Kike Rodriguez')).toBe(false);
        expect(containsBlockedTerm('The Beanery')).toBe(false);
    });

    // m9 (S22 Phase 1 adversarial review) — additional l33t fold ('6'/'9' → 'g')
    // and additional invisible-character strip (soft hyphen U+00AD, word
    // joiner U+2060), without adding doubled-letter collapsing (would
    // multiply M1a's false-positive surface).
    it('m9: catches the 6/9-as-g l33t shape', () => {
        expect(containsBlockedTerm('ni66er')).toBe(true);
        expect(containsBlockedTerm('ni99er')).toBe(true);
    });

    it('m9: strips soft hyphen and word joiner like the other zero-width characters', () => {
        const softHyphen = String.fromCharCode(0x00ad);
        const wordJoiner = String.fromCharCode(0x2060);
        expect(containsBlockedTerm(`nig${softHyphen}ger`)).toBe(true);
        expect(containsBlockedTerm(`nig${wordJoiner}ger`)).toBe(true);
    });

    // v2.47.0 (S22 follow-ups Workstream 3) — homoglyph confusables: cross-
    // script (Cyrillic/Greek) lookalikes folded to their Latin visual twin.
    it('folds Cyrillic confusable characters to their Latin twin', () => {
        expect(normalizeForBlocklist('а')).toBe('a'); // а CYRILLIC A
        expect(normalizeForBlocklist('е')).toBe('e'); // е CYRILLIC IE
        expect(normalizeForBlocklist('о')).toBe('o'); // о CYRILLIC O
        expect(normalizeForBlocklist('р')).toBe('p'); // р CYRILLIC ER
        expect(normalizeForBlocklist('с')).toBe('c'); // с CYRILLIC ES
        expect(normalizeForBlocklist('х')).toBe('x'); // х CYRILLIC HA
        expect(normalizeForBlocklist('у')).toBe('y'); // у CYRILLIC U
        expect(normalizeForBlocklist('к')).toBe('k'); // к CYRILLIC KA
        expect(normalizeForBlocklist('і')).toBe('i'); // і CYRILLIC I
    });

    it('folds Greek confusable characters to their Latin twin', () => {
        expect(normalizeForBlocklist('α')).toBe('a'); // α ALPHA
        expect(normalizeForBlocklist('ο')).toBe('o'); // ο OMICRON
        expect(normalizeForBlocklist('ν')).toBe('v'); // ν NU
        expect(normalizeForBlocklist('ε')).toBe('e'); // ε EPSILON
        expect(normalizeForBlocklist('ι')).toBe('i'); // ι IOTA
        expect(normalizeForBlocklist('κ')).toBe('k'); // κ KAPPA
        expect(normalizeForBlocklist('ρ')).toBe('p'); // ρ RHO
        expect(normalizeForBlocklist('τ')).toBe('t'); // τ TAU
        expect(normalizeForBlocklist('υ')).toBe('u'); // υ UPSILON
        expect(normalizeForBlocklist('χ')).toBe('x'); // χ CHI
    });

    it('catches a mixed-script spelling of a blocked term', () => {
        // "gооk" with both o's replaced by Cyrillic о (U+043E).
        const mixedGook = `g${'о'}${'о'}k`;
        expect(containsBlockedTerm(mixedGook)).toBe(true);
        // "nіgger" with the i replaced by Cyrillic і (U+0456).
        const mixedNigger = `n${'і'}gger`;
        expect(containsBlockedTerm(mixedNigger)).toBe(true);
        // "faggot" with the first 'a' replaced by Cyrillic а (U+0430) and the
        // 'o' replaced by Greek ο (U+03BF) — both fold back to ASCII.
        const mixedFaggot = `f${'а'}gg${'ο'}t`;
        expect(containsBlockedTerm(mixedFaggot)).toBe(true);
    });

    it('passes legitimate non-colliding Cyrillic/Greek words', () => {
        // "Привет" (Russian "hello") — none of its normalized letters spell a
        // blocked term.
        expect(containsBlockedTerm('Привет')).toBe(false);
        // "Αθήνα" (Greek "Athens") — decomposes/folds to letters that don't
        // spell a blocked term either.
        expect(containsBlockedTerm('Αθήνα')).toBe(false);
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
    const { default: adminRouter } = await import('../api/routes/admin.js');
    app.use('/api/users', usersRouter);
    app.use('/api/rooms', roomsRouter);
    app.use('/api/admin', adminRouter);
    app.use('/api', globalRouter);
    return app;
}

function playerToken(discordId: string) {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username: 'Tester' });
}

function superToken(discordId = '999888777666555444') {
    return signToken({ role: 'super_admin', gameRoomIds: [], discordId, username: 'admin' });
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

// v2.79.0 (login mandate) — the `POST /:roomId/submit/name-check` route was
// removed with the guest submission flow, so the claim-path blocklist
// chokepoint is now covered at the service seam the submit paths call.
describe('chokepoint: RoomNameClaimService.checkAvailability (claim path pre-check)', () => {
    it('throws the coded NAME_NOT_ALLOWED error for a blocked name', async () => {
        const roomId = await createTestRoom('bl-claim-room');
        const { RoomNameClaimService } = await import('../services/RoomNameClaimService.js');
        const claimant = RoomNameClaimService.buildClaimant({ discordUserId: 'bl-claim-user' });
        await expect(RoomNameClaimService.checkAvailability(roomId, 'towelhead', claimant))
            .rejects.toMatchObject({ code: 'NAME_NOT_ALLOWED' });
    });

    it('allows a clean name through', async () => {
        const roomId = await createTestRoom('bl-claim-room-2');
        const { RoomNameClaimService } = await import('../services/RoomNameClaimService.js');
        const claimant = RoomNameClaimService.buildClaimant({ discordUserId: 'bl-claim-user-2' });
        const result = await RoomNameClaimService.checkAvailability(roomId, 'HighScorer', claimant);
        expect(result.available).toBe(true);
    });
});

// m2 (S22 Phase 1 adversarial review) — provider-supplied OAuth usernames
// must never block login, but a blocked one must not be persisted as the
// public username fallback either. The OAuth flow itself is expensive to
// exercise end-to-end (mocks Discord/Google token+userinfo endpoints), so
// per the contract's own guidance this covers the small extracted helper
// that the auth.ts write sites call instead.
describe('sanitizeProviderUsername (m2)', () => {
    it('returns the value unchanged when clean', () => {
        expect(sanitizeProviderUsername('CleanDiscordName')).toBe('CleanDiscordName');
    });

    it('returns null when the provider name is blocked — login is not rejected, only the stored fallback is nulled', () => {
        expect(sanitizeProviderUsername('n1gg3r')).toBeNull();
    });

    it('returns null for empty/null/undefined input', () => {
        expect(sanitizeProviderUsername('')).toBeNull();
        expect(sanitizeProviderUsername(null)).toBeNull();
        expect(sanitizeProviderUsername(undefined)).toBeNull();
    });
});

// M2 (S22 Phase 1 adversarial review, orchestrator-decided policy) —
// prevention-at-input ONLY per the ROADMAP's stated doctrine. An established
// player must keep submitting under a name they already own even if a later
// blocklist update would now reject it; only a genuinely NEW claim is
// asserted against the blocklist.
describe('RoomNameClaimService.resolveAndClaim — M2 grandfather rule', () => {
    it('lets an existing claimant re-submit their own already-owned name even if it is now blocked', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('bl-grandfather-room');
        const db = await getDatabase();
        const discordUserId = 'discord-grandfathered-1';
        // Directly seed a room_members row with a display_name containing a
        // blocked term — simulating a name claimed before the blocklist
        // existed (or before this term was added to it).
        await db.run(
            `INSERT INTO room_members (user_id, room_id, joined_at, source, display_name)
             VALUES (?, ?, datetime('now'), 'submission', ?)`,
            discordUserId, roomId, 'xXn1gg3rXx',
        );

        const result = await RoomNameClaimService.resolveAndClaim(
            roomId, 'xXn1gg3rXx', { kind: 'discord', discordUserId },
        );
        expect(result.displayName).toBe('xXn1gg3rXx');
        expect(result.suffixed).toBe(false);
    });

    it('rejects the SAME blocked name for a DIFFERENT claimant (it is a new claim for them)', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('bl-grandfather-room-2');
        const db = await getDatabase();
        const ownerDiscordId = 'discord-grandfathered-owner';
        await db.run(
            `INSERT INTO room_members (user_id, room_id, joined_at, source, display_name)
             VALUES (?, ?, datetime('now'), 'submission', ?)`,
            ownerDiscordId, roomId, 'xXn1gg3rXx',
        );

        await expect(
            RoomNameClaimService.resolveAndClaim(
                roomId, 'xXn1gg3rXx', { kind: 'discord', discordUserId: 'discord-different-claimant' },
            ),
        ).rejects.toMatchObject({ code: 'NAME_NOT_ALLOWED' });
    });

    it('still rejects a genuinely new blocked-name claim (no prior owner at all)', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('bl-grandfather-room-3');
        await expect(
            RoomNameClaimService.resolveAndClaim(
                roomId, 'n1gg3r', { kind: 'discord', discordUserId: 'discord-brand-new' },
            ),
        ).rejects.toMatchObject({ code: 'NAME_NOT_ALLOWED' });
    });
});

// n3 (S22 Phase 1 adversarial review) — short_tag renders publicly on room
// cards; a 6-char field is short but some blocked terms fit whole.
describe('chokepoint: short_tag (room create/update)', () => {
    it('400s a blocked short_tag on super-admin room create', async () => {
        const app = await createApp();
        const res = await request(app)
            .post('/api/admin/rooms')
            .set('Authorization', `Bearer ${superToken()}`)
            .send({ name: 'Clean Room Name', slug: 'clean_shorttag_room', short_tag: 'GOOK' });
        expect(res.status).toBe(400);
    });

    it('400s a blocked short_tag on room update', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('bl-update-shorttag-room');
        const res = await request(app)
            .put(`/api/admin/rooms/${roomId}`)
            .set('Authorization', `Bearer ${superToken()}`)
            .send({ short_tag: 'GOOK' });
        expect(res.status).toBe(400);
    });

    it('allows a clean short_tag through', async () => {
        const app = await createApp();
        const res = await request(app)
            .post('/api/admin/rooms')
            .set('Authorization', `Bearer ${superToken()}`)
            .send({ name: 'Another Clean Room', slug: 'clean_shorttag_room_2', short_tag: 'ARC' });
        expect(res.status).toBe(200);
    });
});

// n4 (S22 Phase 1 adversarial review) — the name part of a room+name-keyed
// target_key is normalized (NFKC, trim, collapse internal whitespace,
// lowercase) so trivial variation doesn't dodge the anti-spam dedup index.
describe('ContentReportService dedup key normalization (n4)', () => {
    it('treats differing case/whitespace/Unicode-form as the SAME dedup target', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('bl-n4-room');
        const { ContentReportService } = await import('../services/ContentReportService.js');

        const first = await ContentReportService.submitNameReport({
            roomId, targetName: 'Bad  Troll', reporterUserId: 'discord-n4-1',
        });
        expect(first.id).toBeGreaterThan(0);

        // Same name, different case + collapsed-vs-double internal whitespace.
        await expect(
            ContentReportService.submitNameReport({
                roomId, targetName: 'bad troll', reporterUserId: 'discord-n4-1',
            }),
        ).rejects.toMatchObject({ code: 'DUPLICATE_REPORT' });
    });
});
