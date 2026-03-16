import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

declare global {
    namespace Express {
        interface Request {
            correlationId?: string;
        }
    }
}

/**
 * Middleware that assigns a unique correlation ID to each request.
 * The ID is available as req.correlationId and returned in the X-Correlation-ID response header.
 */
export function correlationId(req: Request, res: Response, next: NextFunction): void {
    const id = (req.headers['x-correlation-id'] as string) || crypto.randomUUID();
    req.correlationId = id;
    res.setHeader('X-Correlation-ID', id);
    next();
}
