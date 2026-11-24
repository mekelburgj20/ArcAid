import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import rateLimit from 'express-rate-limit';
import { isCloudflareAddress, resolveClientIp, realClientIp } from '../api/clientIp.js';

/**
 * v2.265.1: behind Cloudflare, `req.ip` was a Cloudflare edge address, so every
 * limiter counted unrelated visitors together. `realClientIp` makes it the
 * visitor, and only believes Cloudflare's header when Cloudflare sent it.
 */

const EDGE_A = '104.23.113.13';   // seen in the proxy's log, inside 104.16.0.0/13
const EDGE_B = '104.23.243.160';
const VISITOR_1 = '203.0.113.7';
const VISITOR_2 = '198.51.100.44';

describe('isCloudflareAddress', () => {
    it('knows Cloudflare addresses, v4 and v6, and the v4-in-v6 spelling', () => {
        expect(isCloudflareAddress(EDGE_A)).toBe(true);
        expect(isCloudflareAddress('172.71.0.1')).toBe(true);
        expect(isCloudflareAddress('2606:4700::1')).toBe(true);
        expect(isCloudflareAddress(`::ffff:${EDGE_B}`)).toBe(true);
    });

    it('refuses everything else', () => {
        for (const ip of [VISITOR_1, '127.0.0.1', '172.18.0.2', '104.28.0.1', '2001:db8::1', 'not-an-address', '', undefined, null]) {
            expect(isCloudflareAddress(ip)).toBe(false);
        }
    });
});

describe('resolveClientIp', () => {
    it('takes the visitor from Cloudflare when the peer is Cloudflare', () => {
        expect(resolveClientIp(EDGE_A, VISITOR_1)).toBe(VISITOR_1);
        expect(resolveClientIp(EDGE_A, [VISITOR_2, VISITOR_1])).toBe(VISITOR_2);
        expect(resolveClientIp(EDGE_A, ' 2001:db8::9 ')).toBe('2001:db8::9');
    });

    it('never believes the header from a peer that is not Cloudflare', () => {
        expect(resolveClientIp(VISITOR_1, VISITOR_2)).toBe(VISITOR_1);
        expect(resolveClientIp('172.18.0.2', VISITOR_2)).toBe('172.18.0.2');
    });

    it('keeps the peer when the header is missing or is not an address', () => {
        expect(resolveClientIp(EDGE_A, undefined)).toBe(EDGE_A);
        expect(resolveClientIp(EDGE_A, 'unknown')).toBe(EDGE_A);
        expect(resolveClientIp(EDGE_A, '')).toBe(EDGE_A);
        expect(resolveClientIp(undefined, VISITOR_1)).toBeUndefined();
    });
});

/** The production shape: trust proxy = 1, the proxy's hop in X-Forwarded-For, then the limiter. */
function app(max: number) {
    const a = express();
    a.set('trust proxy', 1);
    a.use(realClientIp);
    a.use(rateLimit({ windowMs: 60_000, max, standardHeaders: true, legacyHeaders: false }));
    a.get('/ip', (req, res) => { res.json({ ip: req.ip }); });
    return a;
}

describe('realClientIp in front of a limiter', () => {
    it('makes req.ip the visitor behind a Cloudflare edge', async () => {
        const res = await request(app(100)).get('/ip').set('X-Forwarded-For', EDGE_A).set('CF-Connecting-IP', VISITOR_1);
        expect(res.body.ip).toBe(VISITOR_1);
    });

    it('one visitor is one counter, whichever edge carries the request', async () => {
        const a = app(2);
        const hit = (edge: string) => request(a).get('/ip').set('X-Forwarded-For', edge).set('CF-Connecting-IP', VISITOR_1);
        expect((await hit(EDGE_A)).status).toBe(200);
        expect((await hit(EDGE_B)).status).toBe(200);
        expect((await hit(EDGE_A)).status).toBe(429);
    });

    it('two visitors behind the same edge do not share a counter', async () => {
        const a = app(1);
        const hit = (visitor: string) => request(a).get('/ip').set('X-Forwarded-For', EDGE_A).set('CF-Connecting-IP', visitor);
        expect((await hit(VISITOR_1)).status).toBe(200);
        expect((await hit(VISITOR_2)).status).toBe(200);
        expect((await hit(VISITOR_1)).status).toBe(429);
    });

    it('a client that reaches the origin directly cannot pick its own address', async () => {
        const a = app(1);
        const hit = (claimed: string) => request(a).get('/ip').set('X-Forwarded-For', VISITOR_1).set('CF-Connecting-IP', claimed);
        const first = await hit('198.51.100.1');
        expect(first.body.ip).toBe(VISITOR_1);
        expect((await hit('198.51.100.2')).status).toBe(429);
    });
});
