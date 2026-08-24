import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../database/database.js';
import { EventService, type EventTournamentRow } from './EventService.js';
import { IdentityLinkService } from './IdentityLinkService.js';
import { logInfo } from '../utils/logger.js';

/**
 * Throwdowns — player-created, room-less challenges (v2.136.0, ADR 0018).
 *
 * "Let's see who can beat me on Medieval Madness." Two questions (game,
 * duration), a shareable link, no game room anywhere.
 *
 * ## It is the SAME object as a Tournament Event
 *
 * A Throwdown is a `format='event'` tournament with `game_room_id IS NULL`,
 * `checkin_required = 0` and exactly one round. That is deliberate and it is
 * the whole design: the round clock, the submission gate, the boards, the
 * standings, the frozen result and the public page are all reused unchanged.
 * There is no parallel board code and no `private_tournaments` table.
 *
 * The earlier "one personal room per player" idea was rejected — see ADR 0018.
 * Going genuinely room-less cost exactly one column (migration 164).
 *
 * ## Where it differs from a hosted event
 *
 * - **No check-in.** Participants are whoever opens the link and scores. A
 *   roster would be friction on a thing whose whole point is two clicks.
 * - **Starts immediately.** A Throwdown is "from now, for N minutes"; there is
 *   no scheduling UI and no check-in window to sit before it.
 * - **Addressed by a short code**, not a room slug — the link is the product.
 */

/**
 * Code alphabet: no `0`/`O`/`1`/`I`/`l`. These codes get read aloud on streams
 * and retyped from phone screens, and an ambiguous glyph turns into a dead link
 * with no way for the player to tell what went wrong.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/** Ceiling on how long a Throwdown may run. A week is already generous. */
export const MAX_THROWDOWN_MINUTES = 7 * 24 * 60;
export const MIN_THROWDOWN_MINUTES = 5;

export type ThrowdownErrorCode =
    | 'INVALID_GAME'
    | 'INVALID_DURATION'
    | 'CODE_GENERATION_FAILED'
    | 'REMATCH_EXISTS'
    | 'NOT_A_THROWDOWN';

export class ThrowdownError extends Error {
    constructor(public code: ThrowdownErrorCode, message: string, public existingCode?: string) {
        super(message);
        this.name = 'ThrowdownError';
    }
}

export interface CreateThrowdownInput {
    gameName: string;
    durationMinutes: number;
    /** Provenance for the creator's own scores; the round carries no rules. */
    engine?: string | null;
    device?: string | null;
    /** Set when this is a rematch of a finished Throwdown (first-click-wins). */
    rematchOf?: string | null;
}

export interface ThrowdownSummary {
    tournamentId: string;
    code: string;
    name: string;
    gameName: string;
    startsAt: string;
    endsAt: string;
}

function randomCode(): string {
    const bytes = crypto.randomBytes(CODE_LENGTH);
    let out = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
        out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
    }
    return out;
}

export class ThrowdownService {
    /**
     * Allocate a code that is free right now.
     *
     * The UNIQUE index on `throwdown_code` is the real guarantee — this loop
     * only avoids the common case of an INSERT failing. With a 31-character
     * alphabet over 8 places, a collision needs astronomically many rows before
     * ten attempts is not enough.
     */
    static async allocateCode(): Promise<string> {
        const db = await getDatabase();
        for (let attempt = 0; attempt < 10; attempt++) {
            const code = randomCode();
            const clash = await db.get('SELECT id FROM tournaments WHERE throwdown_code = ?', code);
            if (!clash) return code;
        }
        throw new ThrowdownError('CODE_GENERATION_FAILED', 'Could not allocate a Throwdown code. Try again.');
    }

    /**
     * Create a Throwdown and return its link handle.
     *
     * Starts NOW: the creator is expected to play immediately and send the link,
     * so there is no "starts at" to choose. Everything downstream — the tick
     * that closes it, the gate that bounds submissions, the standings — is the
     * ordinary event machinery.
     */
    static async create(creatorUserId: string, input: CreateThrowdownInput): Promise<ThrowdownSummary> {
        const gameName = (input.gameName ?? '').trim();
        if (!gameName) throw new ThrowdownError('INVALID_GAME', 'Pick a game to throw down on.');

        const minutes = Math.round(input.durationMinutes);
        if (!Number.isFinite(minutes) || minutes < MIN_THROWDOWN_MINUTES || minutes > MAX_THROWDOWN_MINUTES) {
            throw new ThrowdownError(
                'INVALID_DURATION',
                `A Throwdown runs between ${MIN_THROWDOWN_MINUTES} minutes and 7 days.`,
            );
        }

        const db = await getDatabase();
        const canonical = await IdentityLinkService.resolveCanonical(creatorUserId);

        // First-click-wins rematch. The UNIQUE index is the authority; this
        // pre-flight exists so the second clicker gets the FIRST one's link
        // instead of an error — that is the product behaviour, not a nicety.
        if (input.rematchOf) {
            const existing = await db.get<{ throwdown_code: string }>(
                'SELECT throwdown_code FROM tournaments WHERE rematch_of_tournament_id = ?',
                input.rematchOf,
            );
            if (existing?.throwdown_code) {
                throw new ThrowdownError(
                    'REMATCH_EXISTS',
                    'Someone already started the rematch — this is their link.',
                    existing.throwdown_code,
                );
            }
        }

        const id = uuidv4();
        const code = await ThrowdownService.allocateCode();
        const startsAt = new Date();
        const endsAt = new Date(startsAt.getTime() + minutes * 60_000);

        // `cadence` carries a timezone only — NO cron, exactly as a hosted event
        // does, which is what keeps runMaintenance away from the round.
        await db.run(
            `INSERT INTO tournaments (
                id, name, type, mode, cadence, is_active, game_room_id, format,
                throwdown_code, rematch_of_tournament_id, created_by_user_id
             ) VALUES (?, ?, 'TD', 'pinball', '{"timezone":"UTC"}', 1, NULL, 'event', ?, ?, ?)`,
            id, gameName, code, input.rematchOf ?? null, canonical,
        );

        await EventService.createOrUpdateEvent(id, {
            rounds: [{
                roundNo: 1,
                gameName,
                scheduledStartAt: startsAt.toISOString(),
                scheduledEndAt: endsAt.toISOString(),
            }],
            // No roster: whoever opens the link and scores is in.
            checkinRequired: false,
            aggregateMethod: 'best',
        });

        // The round starts now, so open it immediately rather than making the
        // creator wait up to a minute for the tick.
        await db.run(
            `UPDATE games SET status = 'ACTIVE' WHERE tournament_id = ? AND round_no = 1 AND status = 'SCHEDULED'`,
            id,
        );

        logInfo(`Throwdown created: "${gameName}" (${code}) by ${canonical}, ${minutes} min.`);
        return {
            tournamentId: id, code, name: gameName, gameName,
            startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(),
        };
    }

    /** Resolve a Throwdown by its public code. Null when the code is unknown. */
    static async getByCode(code: string): Promise<EventTournamentRow | null> {
        if (!code?.trim()) return null;
        const db = await getDatabase();
        const row = await db.get<EventTournamentRow>(
            `SELECT * FROM tournaments WHERE throwdown_code = ? AND format = 'event'`,
            code.trim().toUpperCase(),
        );
        return row ?? null;
    }

    /** Throwdowns this user created, newest first. Powers the profile tab. */
    static async listForCreator(userId: string, limit = 50): Promise<Array<EventTournamentRow>> {
        const db = await getDatabase();
        const canonical = await IdentityLinkService.resolveCanonical(userId);
        return db.all<EventTournamentRow[]>(
            `SELECT * FROM tournaments
              WHERE created_by_user_id = ? AND throwdown_code IS NOT NULL
              ORDER BY start_date DESC LIMIT ?`,
            canonical, limit,
        );
    }
}
