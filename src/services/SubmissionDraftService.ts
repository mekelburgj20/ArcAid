import fs from 'fs';
import path from 'path';
import { getDatabase } from '../database/database.js';
import { logError } from '../utils/logger.js';
import { UNKNOWN } from '../utils/scoreProvenance.js';

/**
 * Server-side draft storage for cross-device OAuth handoff (plan §15, Sprint 10).
 *
 * When an anonymous submitter clicks "Log in" in the collision prompt we stash
 * the pending submission here keyed on the OAuth `state` param, then restore it
 * on the callback leg. Client-side `sessionStorage` is the primary path (fast,
 * no round-trip); this table is the fallback when OAuth returns on a different
 * device or the browser flushes storage mid-flow.
 *
 * TTL is 5 minutes. Expired rows are filtered on read and cleaned by the
 * Scheduler.
 */

const DRAFT_TTL_MS = 5 * 60 * 1000;

export type SubmissionDraftTarget =
    | {
          kind: 'tournament'; roomId: string; gameName: string; gameStatus?: string; requirePhoto?: boolean;
          /**
           * v2.155.2 — mirrors `SubmissionTarget.gameId` (SubmissionSheet.tsx):
           * the games row this card actually renders, when the staging caller
           * has it. Threaded through commit so the OAuth-handoff path resolves
           * the SAME game a direct submit would (see the ambiguous-active-games
           * fix, v2.155.1/v2.155.2) instead of re-deriving by name alone.
           */
          gameId?: string;
      }
    | { kind: 'freeplay'; roomId: string; globalGameId: string; gameName: string; gameId?: string }
    | { kind: 'global'; globalGameId: string; gameName: string; presetDisplayName?: string };

export interface SubmissionDraft {
    stateParam: string;
    target: SubmissionDraftTarget;
    playerName: string | null;
    score: number | null;
    photoPath: string | null;
    excludeFromGlobal: boolean;
    /** v2.5.0: per-score platform replayed on commit. NULL on legacy drafts. */
    platform: string | null;
    /**
     * v2.53.0 (ADR 0016): split provenance replayed on commit. `'unknown'` for
     * legacy drafts staged before this release — never NULL going forward. Both
     * commit paths re-validate the pair before writing (pre-v2.53.0 neither
     * commit path validated anything).
     */
    engine: string;
    device: string;
    createdAt: string;
    expiresAt: string;
}

function photoDir(): string {
    const dir = path.join(process.cwd(), 'data', 'submission-drafts');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export class SubmissionDraftService {
    /** Persist a draft. Overwrites existing row with same state_param. */
    static async create(
        stateParam: string,
        target: SubmissionDraftTarget,
        fields: {
            playerName?: string | null;
            score?: number | null;
            photoBuffer?: Buffer | null;
            photoExt?: string;
            excludeFromGlobal?: boolean;
            platform?: string | null;
            engine?: string | null;
            device?: string | null;
        },
    ): Promise<void> {
        const db = await getDatabase();
        const expiresAt = new Date(Date.now() + DRAFT_TTL_MS).toISOString();

        let photoPath: string | null = null;
        if (fields.photoBuffer && fields.photoBuffer.length > 0) {
            const ext = fields.photoExt || 'jpg';
            const filename = `${stateParam.replace(/[^a-zA-Z0-9_-]/g, '_')}.${ext}`;
            const full = path.join(photoDir(), filename);
            fs.writeFileSync(full, fields.photoBuffer);
            photoPath = full;
        }

        await db.run(
            `INSERT OR REPLACE INTO submission_drafts
                (state_param, target_json, player_name, score, photo_path, exclude_from_global, platform, engine, device, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
            stateParam,
            JSON.stringify(target),
            fields.playerName ?? null,
            fields.score ?? null,
            photoPath,
            fields.excludeFromGlobal ? 1 : 0,
            fields.platform ?? null,
            fields.engine || UNKNOWN,
            fields.device || UNKNOWN,
            expiresAt,
        );
    }

    /** Retrieve a draft if still alive. Returns null when expired or missing. */
    static async get(stateParam: string): Promise<SubmissionDraft | null> {
        const db = await getDatabase();
        const row = await db.get(
            `SELECT state_param, target_json, player_name, score, photo_path, exclude_from_global, platform, engine, device, created_at, expires_at
             FROM submission_drafts
             WHERE state_param = ? AND expires_at > datetime('now')`,
            stateParam,
        );
        if (!row) return null;
        let target: SubmissionDraftTarget;
        try {
            target = JSON.parse(row.target_json);
        } catch (err) {
            logError('SubmissionDraftService.get: invalid target_json', err);
            return null;
        }
        return {
            stateParam: row.state_param,
            target,
            playerName: row.player_name,
            score: row.score,
            photoPath: row.photo_path,
            excludeFromGlobal: !!row.exclude_from_global,
            platform: row.platform ?? null,
            engine: row.engine || UNKNOWN,
            device: row.device || UNKNOWN,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
        };
    }

    /** Consume (delete) a draft. Removes the backing photo file too. */
    static async consume(stateParam: string): Promise<void> {
        const db = await getDatabase();
        const row = await db.get('SELECT photo_path FROM submission_drafts WHERE state_param = ?', stateParam);
        await db.run('DELETE FROM submission_drafts WHERE state_param = ?', stateParam);
        if (row?.photo_path) {
            try { fs.unlinkSync(row.photo_path); } catch { /* best effort */ }
        }
    }

    /** Delete expired rows + their photo files. Safe to call periodically. */
    static async cleanup(): Promise<number> {
        const db = await getDatabase();
        const expired = await db.all<{ photo_path: string | null }[]>(
            `SELECT photo_path FROM submission_drafts WHERE expires_at <= datetime('now')`,
        );
        const result = await db.run(`DELETE FROM submission_drafts WHERE expires_at <= datetime('now')`);
        for (const row of expired) {
            if (row.photo_path) {
                try { fs.unlinkSync(row.photo_path); } catch { /* best effort */ }
            }
        }
        return result.changes ?? 0;
    }
}

export { DRAFT_TTL_MS };
