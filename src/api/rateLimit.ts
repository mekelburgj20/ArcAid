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

/**
 * S16 — OG meta injection on the SPA catch-all: 60 requests per minute per IP.
 * The catch-all isn't under the /api generalLimiter, and a spoofed bot UA now
 * triggers DB lookups there; this caps that surface. Applied ONLY to requests
 * whose UA matches the preview-bot list — humans never hit it.
 */
export const ogPreviewLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many preview requests. Please try again later.',
});

/**
 * Public room creation: 3 per hour per Discord user.
 *
 * Cloned from globalSubmitLimiter's per-discordId pattern (see its comment
 * for the ipKeyGenerator/IPv6 rationale) — must be mounted AFTER
 * requireDiscordUser so `req.user.discordId` is populated; falls back to IP
 * only if that middleware hasn't run.
 */
export const roomCreateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: any) => req.user?.discordId || ipKeyGenerator(req.ip),
    message: { error: 'Room creation limit reached (3 per hour). Please try again later.' },
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

/**
 * RetroAchievements master-list search: 30 requests per minute per IP.
 *
 * The global twin of this endpoint is a PUBLIC read — it only exposes our
 * cached copy of RA's game lists, which RA publishes freely — so it needs no
 * auth. It does need a cap: it is an unauthenticated endpoint that runs a
 * double-LIKE over ~10-15k rows, and a search box fires it per keystroke, so
 * the limit is set above realistic typing (a debounced box makes a handful of
 * calls per query) and well below scripted abuse.
 */
export const raSearchLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: any) => ipKeyGenerator(req.ip),
    message: { error: 'Too many searches. Please slow down.' },
});

/**
 * Player-triggered RetroAchievements import: 5 per hour per Discord user.
 *
 * Keyed on `req.user.discordId` (same pattern and IPv6 rationale as
 * `globalSubmitLimiter`) so a shared IP does not lump distinct players
 * together — must be mounted AFTER requireDiscordUser to take effect per-user.
 *
 * An import is cheap for us (2-4 API calls, 2 image fetches) but it is not
 * free for RA, and it WRITES to the shared catalogue. Two different abuses are
 * capped by the one number: hammering RA's fair-use budget, and bulk-adding
 * junk games that a super-admin then has to review by hand. Five per hour is
 * far above a real player adding the game they want to post a score on.
 */
export const raImportLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: any) => req.user?.discordId || ipKeyGenerator(req.ip),
    message: { error: 'Import limit reached (5 per hour). Please try again later.' },
});

/**
 * Guest content (comments, ratings): 10 requests per minute per IP.
 *
 * Keys on the normalized IP via `ipKeyGenerator` (IPv6 addresses are
 * subnet-normalized — see globalSubmitLimiter for the ERR_ERL_KEY_GEN_IPV6
 * rationale). Deliberately NOT keyed on the `x-user-id` header: that value is
 * client-controlled, so a script rotating it per request would bypass the cap
 * entirely — and comment/rating spam is exactly what this guards against.
 */
export const guestContentLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: any) => ipKeyGenerator(req.ip),
    message: { error: 'Too many requests. Please slow down.' },
});
