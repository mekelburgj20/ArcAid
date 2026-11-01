import { getDatabase } from '../database/database.js';
import { logInfo } from '../utils/logger.js';
import { normalizeEntryMode, normalizeEntryMethods, type EntryMode, type EntryMethods } from '../utils/tournamentEntry.js';
import { IdentityLinkService } from './IdentityLinkService.js';

/**
 * Tournament entry — `Entry: Room members` (default) / `Invited players`
 * (W39, ADR 0033 §6).
 *
 * An invite-only tournament takes scores only from players on its ROSTER
 * (`tournament_roster`). That list is deliberately separate from
 * `tournament_participants`, the event check-in list (owner ruling 2026-10-26):
 * the roster says who MAY play; an event that requires check-in still needs
 * them to check in on the night.
 *
 * Three ways onto a roster, the host choosing which self-serve ones are on:
 *   - the host adds a player by name (always available);
 *   - an invite link/code (`entry_methods.link`) — accepting joins the room
 *     too, or files a room join request when the room needs approval;
 *   - the player requests and the host approves (`entry_methods.request`).
 *
 * Every id is the CANONICAL identity, like attempts and check-ins, so a Google
 * login and a Discord login of one person are one roster entry.
 *
 * The decision itself lives in `entryAllowed` (`utils/tournamentEntry.ts`);
 * this service only stores the facts and runs the typed-score gate.
 */

export type RosterSource = 'host' | 'invite' | 'request';

export interface EntryConfig {
    tournamentId: string;
    name: string;
    format: 'rotation' | 'event';
    gameRoomId: string | null;
    mode: EntryMode;
    methods: EntryMethods;
    inviteCode: string | null;
}

export interface RosterEntry {
    userId: string;
    label: string;
    source: RosterSource;
    addedBy: string | null;
    addedAt: string;
}

export interface EntryRequest {
    id: number;
    userId: string;
    label: string;
    requestedAt: string;
}

/** The one message a typed score from someone not on the roster gets. */
export const NOT_ON_ROSTER_MESSAGE = 'This tournament is invite-only and you are not on its roster.';

export class TournamentEntryError extends Error {
    constructor(public code: 'NOT_FOUND' | 'NOT_INVITE_ONLY' | 'METHOD_OFF' | 'CLOSED', public httpStatus: 404 | 409, message: string) {
        super(message);
        this.name = 'TournamentEntryError';
    }
}

async function canonical(userId: string): Promise<string> {
    return IdentityLinkService.resolveCanonical(userId);
}

export class TournamentEntryService {
    static async getConfig(tournamentId: string): Promise<EntryConfig | null> {
        const db = await getDatabase();
        const t = await db.get<{
            id: string; name: string; format: string | null; game_room_id: string | null;
            entry_mode: string | null; entry_methods: string | null; invite_code: string | null;
        }>(
            `SELECT id, name, format, game_room_id, entry_mode, entry_methods, invite_code
               FROM tournaments WHERE id = ?`,
            tournamentId,
        );
        if (!t) return null;
        return {
            tournamentId: t.id,
            name: t.name,
            format: t.format === 'event' ? 'event' : 'rotation',
            gameRoomId: t.game_room_id,
            mode: normalizeEntryMode(t.entry_mode),
            methods: normalizeEntryMethods(t.entry_methods),
            inviteCode: t.invite_code,
        };
    }

    /** Save the host's entry setting. A switched-on link gets a code; the code is kept when it goes off. */
    static async setConfig(tournamentId: string, mode: EntryMode, methods: EntryMethods): Promise<void> {
        const db = await getDatabase();
        await db.run(
            'UPDATE tournaments SET entry_mode = ?, entry_methods = ? WHERE id = ?',
            mode, JSON.stringify(methods), tournamentId,
        );
        if (mode === 'invited' && methods.link) await TournamentEntryService.ensureInviteCode(tournamentId);
    }

    static async isOnRoster(tournamentId: string, userId: string): Promise<boolean> {
        const db = await getDatabase();
        const row = await db.get(
            'SELECT 1 FROM tournament_roster WHERE tournament_id = ? AND user_id = ?',
            tournamentId, await canonical(userId),
        );
        return !!row;
    }

    /**
     * Idempotent. The first source is kept (an invited player the host later
     * re-adds stays `invite`). A pending request for the same player is marked
     * approved, so the host's queue never shows someone already in.
     */
    static async addToRoster(tournamentId: string, userId: string, source: RosterSource, addedBy: string | null): Promise<string> {
        const db = await getDatabase();
        const id = await canonical(userId);
        await db.run(
            `INSERT OR IGNORE INTO tournament_roster (tournament_id, user_id, source, added_by) VALUES (?, ?, ?, ?)`,
            tournamentId, id, source, addedBy,
        );
        await db.run(
            `UPDATE tournament_entry_requests SET status = 'approved', resolved_by = ?, resolved_at = datetime('now')
              WHERE tournament_id = ? AND user_id = ? AND status = 'pending'`,
            addedBy ?? source, tournamentId, id,
        );
        return id;
    }

    static async removeFromRoster(tournamentId: string, userId: string): Promise<boolean> {
        const db = await getDatabase();
        const res = await db.run(
            'DELETE FROM tournament_roster WHERE tournament_id = ? AND user_id = ?',
            tournamentId, await canonical(userId),
        ) as { changes?: number };
        return !!res.changes;
    }

    /** The host's view, names resolved (never a raw id), oldest first. */
    static async listRoster(tournamentId: string): Promise<RosterEntry[]> {
        const db = await getDatabase();
        const rows = await db.all<Array<{ user_id: string; source: RosterSource; added_by: string | null; added_at: string }>>(
            `SELECT user_id, source, added_by, added_at FROM tournament_roster
              WHERE tournament_id = ? ORDER BY added_at ASC, user_id ASC`,
            tournamentId,
        );
        const { resolveUserLabels } = await import('./PlayerProfileResolver.js');
        const labels = await resolveUserLabels(rows.map(r => r.user_id));
        return rows.map(r => ({
            userId: r.user_id, label: labels[r.user_id] ?? r.user_id,
            source: r.source, addedBy: r.added_by, addedAt: r.added_at,
        }));
    }

    // --- invite link ---------------------------------------------------------

    static async ensureInviteCode(tournamentId: string): Promise<string> {
        const db = await getDatabase();
        const row = await db.get<{ invite_code: string | null }>('SELECT invite_code FROM tournaments WHERE id = ?', tournamentId);
        if (row?.invite_code) return row.invite_code;
        return TournamentEntryService.resetInviteCode(tournamentId);
    }

    /** A fresh code; the old link stops working at once. */
    static async resetInviteCode(tournamentId: string): Promise<string> {
        const db = await getDatabase();
        const { randomCode } = await import('./ThrowdownService.js');
        for (let i = 0; i < 10; i++) {
            const code = randomCode();
            try {
                await db.run('UPDATE tournaments SET invite_code = ? WHERE id = ?', code, tournamentId);
                return code;
            } catch {
                // The unique index refused a collision; draw again.
            }
        }
        throw new Error('Could not allocate an invite code');
    }

    /**
     * What an invite link points at, or null when it does not (unknown code, the
     * tournament is no longer invite-only, the host switched the link off, or it
     * has finished). Public: it names the tournament and room and nothing else.
     */
    static async findInvite(code: string): Promise<{
        tournamentId: string; tournamentName: string; format: 'rotation' | 'event';
        roomId: string; roomSlug: string; roomName: string;
    } | null> {
        const clean = (code || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{4,16}$/.test(clean)) return null;
        const db = await getDatabase();
        const { tournamentFinishedSql } = await import('../utils/openCard.js');
        const row = await db.get<{
            id: string; name: string; format: string | null; entry_mode: string | null; entry_methods: string | null;
            room_id: string; slug: string; room_name: string; finished: number;
        }>(
            `SELECT t.id, t.name, t.format, t.entry_mode, t.entry_methods,
                    r.id AS room_id, r.slug, r.name AS room_name,
                    ${tournamentFinishedSql('t')} AS finished
               FROM tournaments t JOIN game_rooms r ON r.id = t.game_room_id
              WHERE t.invite_code = ?`,
            clean,
        );
        if (!row || row.finished === 1) return null;
        if (normalizeEntryMode(row.entry_mode) !== 'invited' || !normalizeEntryMethods(row.entry_methods).link) return null;
        return {
            tournamentId: row.id, tournamentName: row.name, format: row.format === 'event' ? 'event' : 'rotation',
            roomId: row.room_id, roomSlug: row.slug, roomName: row.room_name,
        };
    }

    /**
     * Accept an invite (owner ruling 2026-10-26: it joins the room AND enters the
     * tournament). An approval-only room gets a join request instead of a
     * membership — the roster entry alone already lets the player's scores count.
     */
    static async acceptInvite(code: string, userId: string): Promise<{
        tournamentId: string; tournamentName: string; roomId: string; roomSlug: string; room: 'member' | 'pending';
    }> {
        const invite = await TournamentEntryService.findInvite(code);
        if (!invite) throw new TournamentEntryError('NOT_FOUND', 404, 'This invite link is not valid any more');
        const { RoomMembershipService } = await import('./RoomMembershipService.js');
        const { GameRoomSettingsService } = await import('./GameRoomSettingsService.js');
        let room: 'member' | 'pending' = 'member';
        if (!await RoomMembershipService.isMember(userId, invite.roomId)) {
            const policy = await GameRoomSettingsService.get(invite.roomId, 'JOIN_POLICY');
            if (policy === 'approval') {
                const { JoinRequestService } = await import('./JoinRequestService.js');
                room = await JoinRequestService.request(invite.roomId, userId);
            } else if (policy === 'discord_role') {
                // v2.213.0 - a role holder joins; anyone else the host invited
                // (no role, no Discord link, role unknown) waits in the manual
                // join queue rather than being refused - the invite is the
                // host's own act, so an admin decides.
                const { JoinRequestService } = await import('./JoinRequestService.js');
                const outcome = await JoinRequestService.joinByDiscordRole(invite.roomId, userId);
                if (outcome.status === 'member') {
                    room = 'member';
                } else {
                    room = await JoinRequestService.request(invite.roomId, userId);
                }
            } else {
                await RoomMembershipService.addMember(userId, invite.roomId, 'admin_invite');
            }
        }
        const id = await TournamentEntryService.addToRoster(invite.tournamentId, userId, 'invite', `invite:${code.trim().toUpperCase()}`);
        logInfo(`Tournament entry: ${id} accepted the invite to "${invite.tournamentName}" (${invite.tournamentId})`);
        return {
            tournamentId: invite.tournamentId, tournamentName: invite.tournamentName,
            roomId: invite.roomId, roomSlug: invite.roomSlug, room,
        };
    }

    // --- request + approve ---------------------------------------------------

    /** The player asks to be let in. Idempotent; a player already on the roster gets `on_roster`. */
    static async requestEntry(tournamentId: string, userId: string): Promise<'on_roster' | 'pending'> {
        const config = await TournamentEntryService.getConfig(tournamentId);
        if (!config) throw new TournamentEntryError('NOT_FOUND', 404, 'Tournament not found');
        if (config.mode !== 'invited') throw new TournamentEntryError('NOT_INVITE_ONLY', 409, 'This tournament is open to every room member');
        if (!config.methods.request) throw new TournamentEntryError('METHOD_OFF', 409, 'This tournament does not take requests to join');
        if (await TournamentEntryService.isOnRoster(tournamentId, userId)) return 'on_roster';
        const db = await getDatabase();
        await db.run(
            `INSERT OR IGNORE INTO tournament_entry_requests (tournament_id, user_id, status) VALUES (?, ?, 'pending')`,
            tournamentId, await canonical(userId),
        );
        return 'pending';
    }

    static async listPendingRequests(tournamentId: string): Promise<EntryRequest[]> {
        const db = await getDatabase();
        const rows = await db.all<Array<{ id: number; user_id: string; requested_at: string }>>(
            `SELECT id, user_id, requested_at FROM tournament_entry_requests
              WHERE tournament_id = ? AND status = 'pending' ORDER BY requested_at ASC, id ASC`,
            tournamentId,
        );
        const { resolveUserLabels } = await import('./PlayerProfileResolver.js');
        const labels = await resolveUserLabels(rows.map(r => r.user_id));
        return rows.map(r => ({ id: r.id, userId: r.user_id, label: labels[r.user_id] ?? r.user_id, requestedAt: r.requested_at }));
    }

    /** Approve (puts them on the roster) or deny. False when no such pending request. */
    static async resolveRequest(tournamentId: string, requestId: number, approve: boolean, actor: string): Promise<boolean> {
        const db = await getDatabase();
        const row = await db.get<{ user_id: string }>(
            `SELECT user_id FROM tournament_entry_requests WHERE id = ? AND tournament_id = ? AND status = 'pending'`,
            requestId, tournamentId,
        );
        if (!row) return false;
        if (approve) {
            await TournamentEntryService.addToRoster(tournamentId, row.user_id, 'request', actor);
        } else {
            await db.run(
                `UPDATE tournament_entry_requests SET status = 'denied', resolved_by = ?, resolved_at = datetime('now') WHERE id = ?`,
                actor, requestId,
            );
        }
        return true;
    }

    /** The player's own view: what this tournament's entry is and where they stand. */
    static async myEntry(tournamentId: string, userId: string): Promise<{
        mode: EntryMode; onRoster: boolean; request: 'pending' | 'denied' | null; canRequest: boolean;
    } | null> {
        const config = await TournamentEntryService.getConfig(tournamentId);
        if (!config) return null;
        if (config.mode !== 'invited') return { mode: 'members', onRoster: false, request: null, canRequest: false };
        const id = await canonical(userId);
        const db = await getDatabase();
        const [onRoster, latest] = await Promise.all([
            TournamentEntryService.isOnRoster(tournamentId, id),
            db.get<{ status: 'pending' | 'approved' | 'denied' }>(
                `SELECT status FROM tournament_entry_requests WHERE tournament_id = ? AND user_id = ?
                  ORDER BY id DESC LIMIT 1`,
                tournamentId, id,
            ),
        ]);
        const request = latest?.status === 'pending' || latest?.status === 'denied' ? latest.status : null;
        return { mode: 'invited', onRoster, request: onRoster ? null : request, canRequest: config.methods.request && !onRoster };
    }

    // --- the typed-score gate ------------------------------------------------

    /**
     * W39 — a typed score (web, OAuth draft, Discord) on an invite-only
     * tournament needs its player on the roster: the same rule the device path
     * applies through `entryAllowed` (owner ruling 2026-10-26). Called beside
     * `checkAttemptLimitSubmission` at every manual submit path; a new submit
     * path is one more call to copy. `tournamentId` null (a pinned or freeplay
     * board) passes.
     */
    static async checkRosterSubmission(
        tournamentId: string | null | undefined, userId: string | null | undefined,
    ): Promise<{ ok: true } | { ok: false; code: 'NOT_ON_ROSTER'; message: string }> {
        if (!tournamentId) return { ok: true };
        const config = await TournamentEntryService.getConfig(tournamentId);
        if (!config || config.mode !== 'invited') return { ok: true };
        if (userId && await TournamentEntryService.isOnRoster(tournamentId, userId)) return { ok: true };
        return { ok: false, code: 'NOT_ON_ROSTER', message: NOT_ON_ROSTER_MESSAGE };
    }

    /**
     * Resolve the host's "add a player" text to a user id — the rules the event
     * participant add has used since v2.141.0, now shared:
     *   - a snowflake-shaped value is always a raw id;
     *   - '@name' DEMANDS name resolution (global display name, profile username,
     *     then this room's claimed names) and errors when it can't;
     *   - a bare string resolves only on exactly one match, otherwise passes
     *     through as a raw id (test fixtures and google:* ids arrive that way).
     * Several distinct matches is a 409, never a guess.
     */
    static async resolvePlayerRef(roomId: string, raw: string): Promise<
        { ok: true; userId: string } | { ok: false; httpStatus: 400 | 404 | 409; error: string }
    > {
        const value = (raw || '').trim();
        if (!value) return { ok: false, httpStatus: 400, error: 'userId is required' };
        if (/^\d{15,21}$/.test(value)) return { ok: true, userId: value };
        const explicit = value.startsWith('@');
        const name = value.replace(/^@/, '').trim();
        if (!name) return { ok: false, httpStatus: 400, error: 'userId is required' };
        const db = await getDatabase();
        const candidates = await db.all<Array<{ discord_user_id: string }>>(
            `SELECT discord_user_id FROM user_profiles
              WHERE display_name = ? COLLATE NOCASE OR username = ? COLLATE NOCASE
             UNION
             SELECT user_id AS discord_user_id FROM room_members
              WHERE room_id = ? AND display_name = ? COLLATE NOCASE`,
            name, name, roomId, name,
        );
        const distinct = [...new Set(candidates.map(c => c.discord_user_id))];
        if (distinct.length === 1) return { ok: true, userId: distinct[0]! };
        if (distinct.length > 1) {
            return { ok: false, httpStatus: 409, error: `"${name}" matches more than one player — paste their Discord user ID instead` };
        }
        if (explicit) {
            return { ok: false, httpStatus: 404, error: `No player named "${name}" — check the spelling, or paste their Discord user ID` };
        }
        return { ok: true, userId: value };
    }
}
