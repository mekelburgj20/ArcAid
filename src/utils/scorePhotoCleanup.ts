import fs from 'fs';
import path from 'path';
import { logError } from './logger.js';

/**
 * Traversal-safe deletion of on-disk score proof photos.
 *
 * Score photos live under `data/score-photos/` and are referenced from the four
 * score tables (`submissions`, `score_history`, `community_scores`,
 * `global_scores`) by a `photo_url` shaped like:
 *   - `/api/score-photos/{roomId}/{filename}`   (room-scoped)
 *   - `/api/score-photos/global/{filename}`     (global scoreboard)
 * They are served static by `server.ts`.
 *
 * This helper is distilled from the two existing ad-hoc delete sites
 * (`GlobalScoreService.hardDelete` and `TournamentEngine.runCleanup`) and hardens
 * them with an explicit path-traversal guard: the resolved absolute path must sit
 * inside SCORE_PHOTOS_ROOT, otherwise nothing is touched. Both URL shapes are
 * handled with no branching because the segment after the prefix
 * (`{roomId}/{file}` or `global/{file}`) resolves correctly under the root either
 * way.
 *
 * Contract: idempotent and NEVER throws. A missing file, a non-local URL, a
 * traversal attempt, or an unlink error all resolve to "no file removed" rather
 * than propagating — callers (primarily AccountDeletionService, which unlinks
 * best-effort AFTER its DB transaction commits) must never have a filesystem
 * hiccup roll back or abort their work.
 */
export const SCORE_PHOTOS_ROOT = path.join(process.cwd(), 'data', 'score-photos');

const PHOTO_URL_PREFIX = '/api/score-photos/';

/**
 * Delete the on-disk file backing a single `photo_url`.
 * @returns true iff a file was actually unlinked.
 */
export function deleteScorePhotoFile(photoUrl: string | null | undefined): boolean {
    if (typeof photoUrl !== 'string' || !photoUrl.startsWith(PHOTO_URL_PREFIX)) return false;

    const rel = photoUrl.slice(PHOTO_URL_PREFIX.length);
    if (!rel) return false;

    // Resolve, then confirm the result is the root or lives strictly beneath it.
    // path.resolve collapses any `..` segments, so a crafted URL escaping the
    // root fails this check and is ignored.
    const abs = path.resolve(SCORE_PHOTOS_ROOT, rel);
    if (abs !== SCORE_PHOTOS_ROOT && !abs.startsWith(SCORE_PHOTOS_ROOT + path.sep)) return false;

    try {
        if (fs.existsSync(abs)) {
            fs.unlinkSync(abs);
            return true;
        }
    } catch (err) {
        // Best-effort: an unreferenced orphan on disk is acceptable; a thrown
        // error here is not (it must never unwind a caller's post-commit cleanup).
        logError(`Failed to delete score photo file for ${photoUrl}:`, err);
    }
    return false;
}

/**
 * Delete the on-disk files for a batch of `photo_url`s (nulls/undefined skipped).
 * @returns the number of files actually unlinked.
 */
export function deleteScorePhotoFiles(photoUrls: Array<string | null | undefined>): number {
    let count = 0;
    for (const url of photoUrls) {
        if (deleteScorePhotoFile(url)) count++;
    }
    return count;
}
