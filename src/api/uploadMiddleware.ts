/**
 * Wraps a multer middleware instance so upload rejections (bad mimetype from
 * `fileFilter`, oversize file hitting `limits.fileSize`) surface as JSON 400s
 * instead of falling through to Express's default plain-text 500 handler.
 *
 * Owner field report (2026-08-11): a mobile score submission with an attached
 * photo (iPhone camera default is `image/heic`, not in the PNG/APNG/JPEG/WebP
 * allowlist) failed with the bare generic "Submission failed" and ZERO server
 * log lines — multer's `fileFilter`/`LIMIT_FILE_SIZE` errors bypass the route
 * handler entirely and go straight to Express's default error handler, which
 * neither logs nor returns JSON the FE can parse. This wrapper intercepts the
 * error before Express's default handler sees it, logs one diagnosable line,
 * and returns a JSON body the FE's existing error-parsing path understands.
 *
 * Multer's `fileFilter` rejection doesn't populate `req.file`, so the mimetype
 * of the REJECTED file isn't otherwise recoverable here. Each multer instance's
 * `fileFilter` stashes `{ mimetype, originalname }` on `req._uploadRejectedFile`
 * before calling back with an error — read below to log it.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import multer from 'multer';
import { logWarn } from '../utils/logger.js';

declare global {
    namespace Express {
        interface Request {
            /**
             * Set by a multer `fileFilter` immediately before rejecting a file, so
             * `withUploadErrors` can log which mimetype was rejected (the rejected
             * file never reaches `req.file`).
             */
            _uploadRejectedFile?: { mimetype?: string; originalname?: string };
        }
    }
}

function describeUpload(req: Request): { mimetype: string; size: number | string } {
    const file = req.file as Express.Multer.File | undefined;
    const rejected = req._uploadRejectedFile;
    const mimetype = file?.mimetype ?? rejected?.mimetype ?? 'unknown';
    const size = file?.size ?? req.headers['content-length'] ?? 'unknown';
    return { mimetype, size };
}

/**
 * Wraps a multer middleware (e.g. `roomAssetUpload.single('photo')`) so any
 * upload error it produces is logged and returned as a JSON 400 rather than
 * propagating to Express's default (unlogged, non-JSON) error handler.
 */
export function withUploadErrors(mw: RequestHandler): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        mw(req, res, (err: unknown) => {
            if (!err) return next();

            const routePath = req.originalUrl || req.path;
            const { mimetype, size } = describeUpload(req);

            if (err instanceof multer.MulterError) {
                if (err.code === 'LIMIT_FILE_SIZE') {
                    logWarn(`Upload rejected (file too large) on ${routePath}`, { mimetype, size });
                    return res.status(400).json({ error: 'That image is too large — the limit is 30MB.' });
                }
                logWarn(`Upload rejected (${err.code}) on ${routePath}`, { mimetype, size });
                return res.status(400).json({ error: 'Upload failed — please try a different file.' });
            }

            // Plain Error thrown from fileFilter (unsupported mimetype, etc).
            const message = err instanceof Error ? err.message : 'Upload failed';
            logWarn(`Upload rejected on ${routePath}: ${message}`, { mimetype, size });
            return res.status(400).json({ error: message });
        });
    };
}
