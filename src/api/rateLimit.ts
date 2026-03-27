import rateLimit from 'express-rate-limit';

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
