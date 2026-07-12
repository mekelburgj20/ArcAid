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
});
