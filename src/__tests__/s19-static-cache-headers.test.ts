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
