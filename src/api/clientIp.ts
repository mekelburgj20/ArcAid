import { BlockList, isIP } from 'node:net';
import type { NextFunction, Request, Response } from 'express';

/**
 * The visitor's own address, behind Cloudflare (v2.265.1).
 *
 * Production is Cloudflare -> Caddy -> this app. Caddy does not trust
 * Cloudflare's forwarding header, so the `X-Forwarded-For` it writes holds the
 * CLOUDFLARE EDGE address, and with `trust proxy = 1` that is what `req.ip`
 * was. Every limiter keyed on `req.ip` therefore counted all visitors behind
 * one edge address as one, and one visitor's requests were spread over
 * several edge addresses: a busy minute on the site could refuse an
 * unrelated visitor's room page (the owner, 2026-11-23: the room was found,
 * every request after it came back refused, a refresh fixed it).
 *
 * Cloudflare names the visitor in `CF-Connecting-IP`. That header is only
 * believed when the request really came from Cloudflare (the peer is inside
 * the ranges Cloudflare publishes), so a client that reaches the origin
 * directly cannot pick its own address. Anything else keeps the peer address,
 * which is the behaviour from before this file.
 *
 * The ranges are https://www.cloudflare.com/ips-v4 and /ips-v6 as read on
 * 2026-11-23. They change rarely. A new range that is missing here is not
 * believed, so its visitors fall back to sharing the edge address (the old
 * behaviour), never to an address somebody typed.
 */
const CLOUDFLARE_V4 = [
    '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
    '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
    '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];
const CLOUDFLARE_V6 = [
    '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
    '2a06:98c0::/29', '2c0f:f248::/32',
];

const cloudflare = new BlockList();
for (const range of CLOUDFLARE_V4) {
    const [net, bits] = range.split('/');
    cloudflare.addSubnet(net!, Number(bits), 'ipv4');
}
for (const range of CLOUDFLARE_V6) {
    const [net, bits] = range.split('/');
    cloudflare.addSubnet(net!, Number(bits), 'ipv6');
}

/** An IPv4 address written the IPv6 way (`::ffff:1.2.3.4`) as plain IPv4. */
function plainAddress(ip: string): string {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    return mapped ? mapped[1]! : ip;
}

export function isCloudflareAddress(ip: string | undefined | null): boolean {
    if (!ip) return false;
    const address = plainAddress(ip.trim());
    const family = isIP(address);
    if (family === 0) return false;
    return cloudflare.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * The address to count a request against: Cloudflare's word for the visitor
 * when the peer is Cloudflare and the header is a real address, else the peer.
 */
export function resolveClientIp(
    peerIp: string | undefined | null,
    cfConnectingIp: string | string[] | undefined | null,
): string | undefined {
    const peer = peerIp || undefined;
    if (!isCloudflareAddress(peer)) return peer;
    const header = Array.isArray(cfConnectingIp) ? cfConnectingIp[0] : cfConnectingIp;
    const visitor = header?.trim();
    return visitor && isIP(plainAddress(visitor)) !== 0 ? plainAddress(visitor) : peer;
}

/**
 * Mounted first, before any limiter: from here on `req.ip` is the visitor, so
 * every limiter, audit line and log that reads it needs no change of its own.
 */
export function realClientIp(req: Request, _res: Response, next: NextFunction): void {
    const peer = req.ip;
    const visitor = resolveClientIp(peer, req.headers['cf-connecting-ip']);
    if (visitor && visitor !== peer) {
        Object.defineProperty(req, 'ip', { value: visitor, configurable: true, enumerable: true });
    }
    next();
}
