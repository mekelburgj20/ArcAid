import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { frontendStaticOptions } from '../api/server.js';

// S19 — asserts the Cache-Control contract for the built admin-ui frontend:
// sw.js/index.html must always revalidate (no-cache) so an installed PWA
// discovers a new BUILD_ID on the next load, while Vite's content-hashed
// /assets/* output is safe to cache forever (immutable).
//
// The real dist/ directory isn't available to this test harness (it's a
// build artifact, not checked in, and existing backend tests never boot the
// full server — see helpers.ts / api-auth.test.ts precedent), so this mounts
// the exact same `frontendStaticOptions` used by src/api/server.ts against a
// small fixture directory instead of re-implementing the header logic.
describe('S19 — frontend static cache headers', () => {
    let fixtureDir: string;
    let app: express.Express;

    beforeAll(() => {
        fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arcaid-static-fixture-'));
        fs.mkdirSync(path.join(fixtureDir, 'assets'));
        fs.writeFileSync(path.join(fixtureDir, 'index.html'), '<html><body>fixture shell</body></html>');
        fs.writeFileSync(path.join(fixtureDir, 'sw.js'), '// fixture service worker');
        fs.writeFileSync(path.join(fixtureDir, 'assets', 'app-deadbeef123.js'), 'console.log(1);');
        fs.writeFileSync(path.join(fixtureDir, 'manifest.json'), '{}');

        app = express();
        app.use(express.static(fixtureDir, frontendStaticOptions(fixtureDir)));
    });

    afterAll(() => {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    });

    it('GET /sw.js carries Cache-Control: no-cache', async () => {
        const res = await request(app).get('/sw.js');
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-cache');
    });

    it('GET / (serves index.html) carries Cache-Control: no-cache', async () => {
        const res = await request(app).get('/');
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-cache');
    });

    it('GET /index.html carries Cache-Control: no-cache', async () => {
        const res = await request(app).get('/index.html');
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-cache');
    });

    it('GET /assets/<built file> carries a long immutable Cache-Control', async () => {
        const res = await request(app).get('/assets/app-deadbeef123.js');
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    });

    it('GET /manifest.json (not sw.js/index.html/assets) gets no explicit override', async () => {
        const res = await request(app).get('/manifest.json');
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).not.toBe('no-cache');
        expect(res.headers['cache-control']).not.toBe('public, max-age=31536000, immutable');
    });
});

// m2 (S19 review) — the SPA catch-all (server.ts's `app.get(/^(?!\/api).*/, ...)`)
// sets its own Cache-Control rather than relying on frontendStaticOptions,
// since it builds the response itself via res.sendFile/res.send instead of
// going through express.static. That header-setting pair (res.setHeader +
// sendFile's `{ cacheControl: false }`, which stops `send` from overriding
// it) was previously untested — only the static mount was covered above.
//
// The real catch-all also calls maybeBuildOgShell(req, frontendPath) before
// falling through to sendFile, which needs a live DB/SettingsService and
// isn't something existing backend tests boot (see helpers.ts / api-auth.test.ts
// precedent: minimal apps only). For a plain deep-link GET from a non-bot UA,
// maybeBuildOgShell always returns null and execution falls through to the
// exact sendFile call under test here — so this fixture reproduces the code
// path server.ts actually runs for the common case, header-setting lines
// copied verbatim.
describe('S19 — SPA catch-all no-cache header (m2)', () => {
    let fixtureDir: string;
    let app: express.Express;

    beforeAll(() => {
        fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arcaid-catchall-fixture-'));
        fs.writeFileSync(path.join(fixtureDir, 'index.html'), '<html><body>fixture shell</body></html>');

        app = express();
        app.get(/^(?!\/api).*/, (req, res) => {
            // Verbatim copy of the header-setting lines from src/api/server.ts's
            // catch-all (see the comment above `res.setHeader` there).
            res.setHeader('Cache-Control', 'no-cache');
            res.sendFile(path.join(fixtureDir, 'index.html'), { cacheControl: false });
        });
    });

    afterAll(() => {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    });

    it('GET /:slug/players/:id (a deep-link SPA route) carries Cache-Control: no-cache', async () => {
        const res = await request(app).get('/rtx_pinball/players/mekelburgj');
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-cache');
    });

    it('GET / (root deep link) carries Cache-Control: no-cache', async () => {
        const res = await request(app).get('/');
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-cache');
    });
});
