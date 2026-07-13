import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { getDatabase } from '../database/database.js';
import { setupTestDb } from './helpers.js';
import { GlobalGameService } from '../services/GlobalGameService.js';
import { signToken } from '../api/auth.js';

/**
 * catalogue-dedup-hardening (ADR 0014) — manufacturer is the dedup
 * discriminator; a virtual-only-manufacturer (Zen Studios, Original) or
 * missing-manufacturer row's ipdb_url is a thematic reference, not an
 * identity claim.
 *
 * WP-TESTS scope: this file only. WP-CORE (GlobalGameService guard +
 * upsert routing) and WP-AUDIT (admin dedup-audit/strip endpoints) are
 * already implemented — see git diff on src/services/GlobalGameService.ts,
 * src/api/routes/admin.ts, src/database/database.ts (migration
 * 109_global_games_based_on_ipdb_url).
 */

// ============================================================================
// WP-CORE — GlobalGameService.upsert guard + routing
// ============================================================================
describe('catalogue-dedup-hardening: GlobalGameService guard + routing', () => {
    it('(a) GUARD: a Zen Studios row sharing a real machine\'s IPDB link does NOT merge — separate row, ipdb_url routed to based_on_ipdb_url', async () => {
        await setupTestDb();
        const db = await getDatabase();

        const stern = await GlobalGameService.upsert({
            name: 'Deadpool', type: 'pinball', manufacturer: 'Stern', year: 2018,
            ipdb_url: 'https://www.ipdb.org/machine.cgi?id=1234', status: 'approved',
        });
        expect(stern.action).toBe('inserted');

        const zen = await GlobalGameService.upsert({
            name: 'Deadpool', type: 'pinball', manufacturer: 'Zen Studios', year: 2014,
            ipdb_url: 'https://www.ipdb.org/machine.cgi?id=1234', status: 'approved',
        });
        expect(zen.action).toBe('inserted');
        expect(zen.id).not.toBe(stern.id);

        const rows = await db.all(`SELECT id FROM global_games`);
        expect(rows.length).toBe(2);

        const zenRow = await db.get(`SELECT ipdb_url, based_on_ipdb_url FROM global_games WHERE id = ?`, zen.id);
        expect(zenRow!.ipdb_url).toBeNull();
        expect(zenRow!.based_on_ipdb_url).toBe('https://www.ipdb.org/machine.cgi?id=1234');

        const sternRow = await db.get(`SELECT ipdb_url, based_on_ipdb_url FROM global_games WHERE id = ?`, stern.id);
        expect(sternRow!.ipdb_url).toBe('https://www.ipdb.org/machine.cgi?id=1234');
        expect(sternRow!.based_on_ipdb_url).toBeNull();
    });

    it('(b) GUARD: two real-manufacturer rows sharing an IPDB link still merge (baseline unaffected)', async () => {
        await setupTestDb();
        const db = await getDatabase();

        const a = await GlobalGameService.upsert({
            name: 'Cavaleiro Negro', type: 'pinball', manufacturer: 'Taito do Brasil', year: 1982,
            ipdb_url: 'https://www.ipdb.org/machine.cgi?id=4321', status: 'approved',
        });
        expect(a.action).toBe('inserted');

        const b = await GlobalGameService.upsert({
            name: 'Cavaleiro Negro (VPX)', type: 'pinball', manufacturer: 'Taito do Brasil', year: 1982,
            ipdb_url: 'http://www.ipdb.org/machine.cgi?id=4321', status: 'approved',
        });
        expect(b.action).toBe('updated');
        expect(b.id).toBe(a.id);

        const rows = await db.all(`SELECT id FROM global_games`);
        expect(rows.length).toBe(1);
    });

    it('(c) ROUTING: missing manufacturer + ipdb_url routes to based_on_ipdb_url on insert', async () => {
        await setupTestDb();
        const db = await getDatabase();

        const result = await GlobalGameService.upsert({
            name: 'Homebrew Original Table', type: 'pinball', manufacturer: null,
            ipdb_url: 'https://www.ipdb.org/machine.cgi?id=5555', status: 'approved',
        });
        expect(result.action).toBe('inserted');

        const row = await db.get(`SELECT ipdb_url, based_on_ipdb_url FROM global_games WHERE id = ?`, result.id);
        expect(row!.ipdb_url).toBeNull();
        expect(row!.based_on_ipdb_url).toBe('https://www.ipdb.org/machine.cgi?id=5555');
    });

    it('(d) RE-SYNC regression: re-upserting an "Original" row with the same ipdb_url twice never re-plants ipdb_url', async () => {
        await setupTestDb();
        const db = await getDatabase();

        const first = await GlobalGameService.upsert({
            name: 'Fan Tribute Table', type: 'pinball', manufacturer: 'Original', year: 2020,
            ipdb_url: 'https://www.ipdb.org/machine.cgi?id=7777', status: 'approved',
        });
        expect(first.action).toBe('inserted');

        const second = await GlobalGameService.upsert({
            name: 'Fan Tribute Table', type: 'pinball', manufacturer: 'Original', year: 2020,
            ipdb_url: 'https://www.ipdb.org/machine.cgi?id=7777', status: 'approved',
        });
        expect(second.action).toBe('updated');
        expect(second.id).toBe(first.id);

        const rows = await db.all(`SELECT id, ipdb_url, based_on_ipdb_url FROM global_games WHERE LOWER(name) = 'fan tribute table'`);
        expect(rows.length).toBe(1);
        expect(rows[0].ipdb_url).toBeNull();
        expect(rows[0].based_on_ipdb_url).toBe('https://www.ipdb.org/machine.cgi?id=7777');
    });
});

// ============================================================================
// WP-AUDIT — GET/POST /api/admin/catalogue/dedup-audit(/strip)
// ============================================================================
describe('catalogue-dedup-hardening: admin dedup-audit endpoints', () => {
    // Mount the real admin router (router-level requireAuth + requireSuperAdmin)
    // so the authz + route behavior under test is the production middleware
    // chain. Bootstrap pattern copied from s12-account-deletion.test.ts.
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

    const superToken = (discordId = 'super-1') => signToken({ role: 'super_admin', gameRoomIds: [], discordId });

    it('(e) AUDIT: flags a virtual-manufacturer suspect and groups two real rows sharing an IPDB id', async () => {
        const app = await createApp();
        const db = await getDatabase();

        // Legacy-corrupted suspect row: virtual manufacturer but ipdb_url still
        // sitting in the identity column (simulates pre-hardening data — direct
        // SQL bypasses upsert's routing on purpose).
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, status, ipdb_url)
             VALUES ('suspect-1', 'Deadpool', 'pinball', 'Zen Studios', 2014, 'approved', 'https://www.ipdb.org/machine.cgi?id=3000')`
        );

        // Two real-manufacturer rows sharing an IPDB id — a legacy duplicate
        // pair (seeded directly to bypass upsert's own merge behavior, since
        // we want to observe the audit surfacing an already-existing dupe).
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, status, ipdb_url)
             VALUES ('real-a', 'Cavaleiro Negro', 'pinball', 'Taito do Brasil', 1982, 'approved', 'https://www.ipdb.org/machine.cgi?id=4000')`
        );
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, status, ipdb_url)
             VALUES ('real-b', 'Cavaleiro Negro (VPX)', 'pinball', 'Taito do Brasil', 1982, 'approved', 'http://www.ipdb.org/machine.cgi?id=4000')`
        );

        const res = await request(app)
            .get('/api/admin/catalogue/dedup-audit')
            .set('Authorization', `Bearer ${superToken()}`);

        expect(res.status).toBe(200);
        expect(res.body.summary.suspectCount).toBe(1);
        expect(res.body.suspects).toHaveLength(1);
        expect(res.body.suspects[0].id).toBe('suspect-1');

        expect(res.body.summary.sharedGroupCount).toBe(1);
        expect(res.body.sharedIpdbGroups).toHaveLength(1);
        const group = res.body.sharedIpdbGroups[0];
        expect(group.ipdbId).toBe('4000');
        expect(group.rows.map((r: any) => r.id).sort()).toEqual(['real-a', 'real-b']);
        expect(group.suggestedAction).toBe('merge');
    });

    it('(f) STRIP: moves a suspect\'s ipdb_url to based_on_ipdb_url; idempotent on re-run; skips non-suspects', async () => {
        const app = await createApp();
        const db = await getDatabase();

        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, status, ipdb_url)
             VALUES ('suspect-1', 'Deadpool', 'pinball', 'Zen Studios', 2014, 'approved', 'https://www.ipdb.org/machine.cgi?id=3000')`
        );
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, status, ipdb_url)
             VALUES ('real-a', 'Cavaleiro Negro', 'pinball', 'Taito do Brasil', 1982, 'approved', 'https://www.ipdb.org/machine.cgi?id=4000')`
        );

        const token = superToken();

        // First strip: the suspect id is actually a suspect -> stripped.
        const res1 = await request(app)
            .post('/api/admin/catalogue/dedup-audit/strip')
            .set('Authorization', `Bearer ${token}`)
            .send({ ids: ['suspect-1'] });
        expect(res1.status).toBe(200);
        expect(res1.body.stripped).toBe(1);
        expect(res1.body.skipped).toBe(0);
        expect(res1.body.results).toEqual([{ id: 'suspect-1', action: 'stripped' }]);

        const row = await db.get(`SELECT ipdb_url, based_on_ipdb_url FROM global_games WHERE id = ?`, 'suspect-1');
        expect(row!.ipdb_url).toBeNull();
        expect(row!.based_on_ipdb_url).toBe('https://www.ipdb.org/machine.cgi?id=3000');

        // Second strip on the same id: no longer a suspect (ipdb_url already
        // null) -> idempotent skip, not a re-strip.
        const res2 = await request(app)
            .post('/api/admin/catalogue/dedup-audit/strip')
            .set('Authorization', `Bearer ${token}`)
            .send({ ids: ['suspect-1'] });
        expect(res2.status).toBe(200);
        expect(res2.body.stripped).toBe(0);
        expect(res2.body.skipped).toBe(1);
        expect(res2.body.results).toEqual([{ id: 'suspect-1', action: 'skipped' }]);

        // A real-manufacturer row is never a suspect -> skipped, untouched.
        const res3 = await request(app)
            .post('/api/admin/catalogue/dedup-audit/strip')
            .set('Authorization', `Bearer ${token}`)
            .send({ ids: ['real-a'] });
        expect(res3.status).toBe(200);
        expect(res3.body.stripped).toBe(0);
        expect(res3.body.skipped).toBe(1);
        expect(res3.body.results).toEqual([{ id: 'real-a', action: 'skipped' }]);

        const realRow = await db.get(`SELECT ipdb_url, based_on_ipdb_url FROM global_games WHERE id = ?`, 'real-a');
        expect(realRow!.ipdb_url).toBe('https://www.ipdb.org/machine.cgi?id=4000');
        expect(realRow!.based_on_ipdb_url).toBeNull();
    });

    it('(g) JUNK: unparseable "Not Available" placeholders never flag as suspects; strip clears them without preserving', async () => {
        const app = await createApp();
        const db = await getDatabase();

        // VPS placeholder junk on a virtual row (the 95-false-suspect case
        // from the first prod audit run, 2026-07-13).
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, status, ipdb_url)
             VALUES ('junk-1', 'Some Fan Table', 'pinball', 'Original', 2020, 'approved', 'Not Available')`
        );
        // A REAL parseable suspect alongside, to prove the filter is selective.
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, status, ipdb_url)
             VALUES ('suspect-1', 'Deadpool', 'pinball', 'Zen Studios', 2014, 'approved', 'https://www.ipdb.org/machine.cgi?id=3000')`
        );

        const token = superToken();

        const audit = await request(app)
            .get('/api/admin/catalogue/dedup-audit')
            .set('Authorization', `Bearer ${token}`);
        expect(audit.status).toBe(200);
        expect(audit.body.summary.suspectCount).toBe(1);
        expect(audit.body.suspects[0].id).toBe('suspect-1');

        // Strip on the junk row clears the garbage outright — it must NOT be
        // preserved into based_on_ipdb_url.
        const res = await request(app)
            .post('/api/admin/catalogue/dedup-audit/strip')
            .set('Authorization', `Bearer ${token}`)
            .send({ ids: ['junk-1'] });
        expect(res.status).toBe(200);
        expect(res.body.stripped).toBe(1);
        const junkRow = await db.get(`SELECT ipdb_url, based_on_ipdb_url FROM global_games WHERE id = ?`, 'junk-1');
        expect(junkRow!.ipdb_url).toBeNull();
        expect(junkRow!.based_on_ipdb_url).toBeNull();
    });

    it('(h) JUNK at the upsert door: unparseable ipdb_url is dropped, not stored or routed', async () => {
        await setupTestDb();
        const db = await getDatabase();

        const result = await GlobalGameService.upsert({
            name: 'Junk Link Table', type: 'pinball', manufacturer: 'Original',
            year: 2021, status: 'approved', ipdb_url: 'Not Available',
        });
        const row = await db.get(
            `SELECT ipdb_url, based_on_ipdb_url FROM global_games WHERE id = ?`, result.id
        );
        expect(row!.ipdb_url).toBeNull();
        expect(row!.based_on_ipdb_url).toBeNull();
    });

    it('(i) MIGRATION 110 shape: the junk-clear UPDATE nulls placeholders in both columns, keeps real links', async () => {
        await setupTestDb();
        const db = await getDatabase();

        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, status, ipdb_url, based_on_ipdb_url)
             VALUES ('m1', 'Junk Both', 'pinball', 'Original', 'approved', 'Not Available', 'n/a')`
        );
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, status, ipdb_url, based_on_ipdb_url)
             VALUES ('m2', 'Real Link', 'pinball', 'Stern', 'approved', 'https://www.ipdb.org/machine.cgi?id=5000', NULL)`
        );

        // Same statements migration 110 runs (setupTestDb already applied the
        // migration to a then-empty table, so re-run them here against the
        // seeded rows — the migration is a plain idempotent UPDATE pair).
        await db.run(`UPDATE global_games SET ipdb_url = NULL WHERE ipdb_url IS NOT NULL AND LOWER(ipdb_url) NOT LIKE '%machine.cgi?id=%'`);
        await db.run(`UPDATE global_games SET based_on_ipdb_url = NULL WHERE based_on_ipdb_url IS NOT NULL AND LOWER(based_on_ipdb_url) NOT LIKE '%machine.cgi?id=%'`);

        const m1 = await db.get(`SELECT ipdb_url, based_on_ipdb_url FROM global_games WHERE id = 'm1'`);
        expect(m1!.ipdb_url).toBeNull();
        expect(m1!.based_on_ipdb_url).toBeNull();
        const m2 = await db.get(`SELECT ipdb_url, based_on_ipdb_url FROM global_games WHERE id = 'm2'`);
        expect(m2!.ipdb_url).toBe('https://www.ipdb.org/machine.cgi?id=5000');
    });
});

describe('catalogue-dedup-hardening: safe bulk-merge alias table + JP relaxation (v2.21.3)', () => {
    async function seedPair(mfrA: string, mfrB: string, nameA = 'Pistol Poker', nameB = 'Pistol Poker') {
        await setupTestDb();
        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, status, ipdb_url, opdb_id)
             VALUES ('row-a', ?, 'pinball', ?, 1993, 'approved', 'https://www.ipdb.org/machine.cgi?id=1805', 'OP-1')`,
            nameA, mfrA
        );
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, status, ipdb_url)
             VALUES ('row-b', ?, 'pinball', ?, 1993, 'approved', 'https://www.ipdb.org/machine.cgi?id=1805')`,
            nameB, mfrB
        );
        return db;
    }

    it('(j) corporate aliases merge: Alvin G. vs Alvin G. & Co (dry run)', async () => {
        await seedPair('Alvin G.', 'Alvin G. & Co');
        const res = await GlobalGameService.mergeIpdbDuplicates({ dryRun: true });
        expect(res.merged).toBe(1);
        expect(res.skipped).toBe(0);
        expect(res.log[0]!.targetId).toBe('row-a'); // richest (has opdb_id)
    });

    it('(j2) trade-name aliases merge: Sonic vs Segasa; group aliases: Cirsa vs Unidesa', async () => {
        await seedPair('Sonic', 'Segasa', 'Prospector', 'Prospector');
        const res1 = await GlobalGameService.mergeIpdbDuplicates({ dryRun: true });
        expect(res1.merged).toBe(1);

        await seedPair('Cirsa', 'Unidesa', 'Mephisto', 'Mephisto');
        const res2 = await GlobalGameService.mergeIpdbDuplicates({ dryRun: true });
        expect(res2.merged).toBe(1);
    });

    it('(k) JP-prefixed row with a REAL manufacturer merges (faithful recreation)', async () => {
        await seedPair('Stern', 'Stern', 'The Lord of the Rings', "JP's The Lord of the Rings");
        const res = await GlobalGameService.mergeIpdbDuplicates({ dryRun: true });
        expect(res.merged).toBe(1);
        expect(res.skipped).toBe(0);
    });

    it('(k2) JP-prefixed row with Original manufacturer still skipped (fan table)', async () => {
        await seedPair('Stern', 'Original', 'Cyclone', "JP's Cyclone");
        const res = await GlobalGameService.mergeIpdbDuplicates({ dryRun: true });
        expect(res.merged).toBe(0);
        expect(res.skipped).toBe(1);
        expect(res.log[0]!.reason).toBe('community-or-digital');
    });

    it('(l) genuinely different manufacturers still skipped: Stern vs Allied Leisure', async () => {
        await seedPair('Stern', 'Allied Leisure', 'Cosmic Princess', 'Cosmic Princess');
        const res = await GlobalGameService.mergeIpdbDuplicates({ dryRun: true });
        expect(res.merged).toBe(0);
        expect(res.log[0]!.reason).toBe('manufacturer-incompatible');
    });
});
