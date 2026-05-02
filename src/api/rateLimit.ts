import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

/**
 * Rate limiters for API endpoints.
 * Protects against brute-force login, spam submissions, and general DoS.
 */

/** Auth endpoints: 5 requests per minute per IP */
export const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Please try again in a minute.' },
});

/** Score submission / write endpoints: 30 requests per minute per IP */
export const writeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please slow down.' },
});

/** Pick/queue game: 5 requests per minute per IP */
export const pickLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many pick attempts. Please wait a moment.' },
});

/** General API: 100 requests per minute per IP */
export const generalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.' },
});

/**
 * Direct global score submission: 10 per hour per Discord user.
 *
 * Keys on `req.user.discordId` so legitimate cross-room writes from the same
 * IP (e.g. a kiosk used by multiple players) aren't lumped together. Falls
 * back to IP if requireDiscordUser hasn't run yet — this limiter must be
 * mounted AFTER requireDiscordUser to take effect per-user.
 *
 * IP fallback runs through `ipKeyGenerator` so IPv6 addresses are normalized
 * to a subnet prefix (matching the library's built-in keyGenerator). Without
 * it, each IPv6 address looked unique and could bypass the limit;
 * express-rate-limit v8+ logs ERR_ERL_KEY_GEN_IPV6 at boot when a custom
 * keyGenerator references `req.ip` directly.
 */
export const globalSubmitLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: any) => req.user?.discordId || ipKeyGenerator(req.ip),
    message: { error: 'Global submission limit reached (10 per hour). Please try again later.' },
});
