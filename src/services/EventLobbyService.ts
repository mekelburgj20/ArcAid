import { getDatabase } from '../database/database.js';
import { logInfo } from '../utils/logger.js';
import { EventService, type EventTournamentRow, type EventRoundRow } from './EventService.js';
import { resolveProfiles } from './PlayerProfileResolver.js';

/**
 * The check-in LOBBY (v2.159.0) — who is checked in to an event, and whether
 * each of them is green-lit to play with a witnessed cabinet.
 *
 * Owner ask, 2026-10-01: "some mechanism during a tournament check-in that
 * shows each player who is in the check-in lobby and whether or not they are
 * 'green light' to go — Arcaid Witness is running and validated that a game
 * is either not currently active or, if so, happened during check-in."
 * Rulings the same day: the roster is PUBLIC, opening the Witness tile on a
 * cabinet designated to the event IS the event check-in, and the open-table
 * rule is STRICT (green only when no table is open).
 *
 * ## What the server already knows, and what it does not
 *
 * Every paired cabinet talks to the server through three things, all of
 * which are already stored: a CHECK-IN (the tile was opened — the cabinet runs
 * one thing at a time, so this proves no table was open at that instant, on
 * the SERVER's clock), a table LAUNCH (reported live, before the exit, as a
 * `witness_observations` row with a NULL `exit_ts`), and that table's EXIT
 * (which closes the row). There is NO heartbeat: a cabinet that is powered off
 * after checking in looks exactly like one that is idle. That is the one
 * honest gap, and the roster copy does not pretend otherwise.
 *
 * ## The status rule (strict)
 *
 *   - `no_cabinet`  — no paired, unrevoked cabinet. Scores will post unverified.
 *                     Neutral, not a fault: most players have no cabinet.
 *   - `no_checkin`  — a cabinet is paired, but it has not checked in since the
 *                     check-in window opened. "Open the Arcaid Witness tile."
 *   - `table_open`  — checked in, but a table has been launched on that
 *                     cabinet SINCE the check-in and has not exited. "Exit to
 *                     the menu, then open the tile again."
 *   - `ready`       — checked in, and no table launched since. Green light.
 *
 * "Since the check-in" is the load-bearing phrase: a check-in at T proves no
 * table was open at T, so an open-session row launched BEFORE T is a missed
 * exit (the detector drops those at a 4 h cap) and must not keep a player
 * amber. Only a launch AFTER the latest check-in means a table is open now.
 *
 * A player with several cabinets gets the BEST status across them — the
 * question is "can they play witnessed", and one ready cabinet answers it.
 *
 * ## Why no-ROM tables need the strict rule
 *
 * For a table with a ROM the cabinet sees every game's own start, so a table
 * opened during check-in would be fine — the game inside starts when Start is
 * pressed. For a no-ROM table the cabinet only ever learns when the TABLE was
 * opened, so a table open at round start can never be verified (v2.158.0,
 * exit samples). One rule for everyone is simpler to explain and costs the
 * player one trip to the menu.
 */

export type LobbyStatus = 'ready' | 'table_open' | 'no_checkin' | 'offline' | 'no_cabinet';

/**
 * v2.160.0 — a 1.0.4 cabinet heartbeats every 2 min while paired. One that
 * has sent a heartbeat before and has been silent this long is `offline`
 * ("not responding"), whatever its check-in said: the lobby's one honest gap
 * (a cabinet powered off after checking in read green) closes here. A cabinet
 * that has NEVER heartbeated (pre-1.0.4) is exempt — silence from it means
 * nothing, and reading it as offline would amber every older install.
 */
export const HEARTBEAT_STALE_SEC = 5 * 60;

export interface LobbyEntry {
    userId: string;
    displayName: string | null;
    avatarHash: string | null;
    avatarUrl: string | null;
    checkedInAt: string;
    source: 'checkin' | 'qualifier' | 'admin';
    status: LobbyStatus;
    /** ISO, server clock — the latest Witness check-in inside the window. */
    witnessCheckinAt: string | null;
    /** The table currently open on the cabinet, when `status === 'table_open'`. */
    openTable: string | null;
    /** ISO — last time ANY of the player's cabinets talked to the server. */
    lastSeenAt: string | null;
}

/** Observation rows launched before this many seconds ago are stale, not open. */
const OPEN_SESSION_MAX_AGE_SEC = 4 * 3600;

const STATUS_RANK: Record<LobbyStatus, number> = { ready: 4, table_open: 3, no_checkin: 2, offline: 1, no_cabinet: 0 };

function toEpoch(iso: string | null | undefined): number | null {
    if (!iso) return null;
    const ms = Date.parse(iso.includes('T') || iso.includes('Z') ? iso : `${iso.replace(' ', 'T')}Z`);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export class EventLobbyService {
    /** The lobby is only meaningful before round 1 starts. */
    static isLobbyOpen(event: EventTournamentRow, rounds: EventRoundRow[], now: Date): boolean {
        const state = EventService.deriveState(event, rounds, now);
        return state === 'checkin' || state === 'upcoming';
    }

    /**
     * When the check-in window opened, as epoch seconds. `checkin_opens_at`
     * when set; otherwise the event has been open to check-in since it was
     * created, and the earliest actual check-in is the honest floor (bounded
     * to the last 24 h so a stale row cannot pull in week-old attestations).
     */
    private static windowOpenEpoch(
        event: EventTournamentRow, participants: Array<{ checked_in_at: string }>, nowEpoch: number,
    ): number {
        const explicit = toEpoch(event.checkin_opens_at);
        if (explicit != null) return explicit;
        const earliest = participants
            .map(p => toEpoch(p.checked_in_at))
            .filter((t): t is number => t != null)
            .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
        const floor = nowEpoch - 24 * 3600;
        return Number.isFinite(earliest) ? Math.max(earliest, floor) : floor;
    }

    /**
     * One entry per checked-in player, in check-in order, with the witness
     * readiness computed as of `now`. Empty once round 1 has started — the
     * standings carry the per-score verdicts from there on.
     */
    static async roster(event: EventTournamentRow, rounds: EventRoundRow[], now: Date = new Date()): Promise<LobbyEntry[]> {
        if (!EventLobbyService.isLobbyOpen(event, rounds, now)) return [];
        const participants = await EventService.listParticipants(event.id);
        if (participants.length === 0) return [];

        const db = await getDatabase();
        const nowEpoch = Math.floor(now.getTime() / 1000);
        const windowOpen = EventLobbyService.windowOpenEpoch(event, participants, nowEpoch);
        const ids = participants.map(p => p.user_id);
        const placeholders = ids.map(() => '?').join(', ');

        const devices = await db.all<Array<{
            atgames_unique_id: string; canonical_user_id: string; last_seen_at: string | null; heartbeat_at: string | null;
        }>>(
            `SELECT atgames_unique_id, canonical_user_id, last_seen_at, heartbeat_at
               FROM witness_devices
              WHERE revoked_at IS NULL AND canonical_user_id IN (${placeholders})`,
            ...ids,
        );
        const deviceIds = devices.map(d => d.atgames_unique_id);
        const devicePlaceholders = deviceIds.map(() => '?').join(', ');

        // Latest check-in per device inside the window. Server clock, always.
        const checkins = deviceIds.length === 0 ? [] : await db.all<Array<{ atgames_unique_id: string; ts: number }>>(
            `SELECT atgames_unique_id, MAX(CAST(strftime('%s', server_ts) AS INTEGER)) AS ts
               FROM witness_checkins
              WHERE atgames_unique_id IN (${devicePlaceholders})
                AND CAST(strftime('%s', server_ts) AS INTEGER) >= ?
              GROUP BY atgames_unique_id`,
            ...deviceIds, windowOpen,
        );
        const checkinByDevice = new Map(checkins.map(c => [c.atgames_unique_id, c.ts]));

        // The newest OPEN session per device (launched, not yet exited), bounded
        // so a missed exit from yesterday cannot read as "open now".
        const open = deviceIds.length === 0 ? [] : await db.all<Array<{ atgames_unique_id: string; table_name: string; launch_ts: number }>>(
            `SELECT o.atgames_unique_id, o.table_name, o.launch_ts
               FROM witness_observations o
               JOIN (SELECT atgames_unique_id, MAX(launch_ts) AS launch_ts
                       FROM witness_observations
                      WHERE kind = 'session' AND exit_ts IS NULL
                        AND launch_ts >= ?
                        AND atgames_unique_id IN (${devicePlaceholders})
                      GROUP BY atgames_unique_id) m
                 ON m.atgames_unique_id = o.atgames_unique_id AND m.launch_ts = o.launch_ts
              WHERE o.kind = 'session' AND o.exit_ts IS NULL`,
            nowEpoch - OPEN_SESSION_MAX_AGE_SEC, ...deviceIds,
        );
        const openByDevice = new Map(open.map(o => [o.atgames_unique_id, o]));

        const profiles = await resolveProfiles(
            participants.map(p => ({ submitted_by_user_id: p.user_id, discord_user_id: p.user_id })),
        );

        return participants.map((p, i) => {
            const mine = devices.filter(d => d.canonical_user_id === p.user_id);
            let best: { status: LobbyStatus; checkinTs: number | null; openTable: string | null } =
                { status: 'no_cabinet', checkinTs: null, openTable: null };
            for (const d of mine) {
                const checkinTs = checkinByDevice.get(d.atgames_unique_id) ?? null;
                const session = openByDevice.get(d.atgames_unique_id) ?? null;
                const heartbeat = toEpoch(d.heartbeat_at);
                let status: LobbyStatus;
                if (heartbeat != null && nowEpoch - heartbeat > HEARTBEAT_STALE_SEC) status = 'offline';
                else if (checkinTs == null) status = 'no_checkin';
                else if (session && session.launch_ts > checkinTs) status = 'table_open';
                else status = 'ready';
                const candidate = {
                    status,
                    checkinTs,
                    openTable: status === 'table_open' ? session!.table_name : null,
                };
                if (STATUS_RANK[candidate.status] > STATUS_RANK[best.status]) best = candidate;
            }
            const lastSeen = mine
                .map(d => d.last_seen_at)
                .filter((s): s is string => !!s)
                .sort()
                .pop() ?? null;
            const profile = profiles[i];
            return {
                userId: p.user_id,
                displayName: profile?.display_name ?? null,
                avatarHash: profile?.avatar_hash ?? null,
                avatarUrl: profile?.avatar_url ?? null,
                checkedInAt: p.checked_in_at,
                source: p.source,
                status: best.status,
                witnessCheckinAt: best.checkinTs != null ? new Date(best.checkinTs * 1000).toISOString() : null,
                openTable: best.openTable,
                lastSeenAt: lastSeen,
            };
        });
    }

    /**
     * The Witness tile IS the event check-in (owner ruling 2026-10-01): when a
     * cabinet designated to an event checks in while that event's check-in
     * window is open, the cabinet's owner is checked in to the event. A player
     * with a cabinet never has to visit the event page.
     *
     * Returns what the cabinet should print, or null when the device is not
     * designated to an event in its check-in window — the common case for a
     * tile opened on an ordinary day, and deliberately silent then.
     *
     * Only the WINDOW is enforced, same as the web button: before
     * `checkin_opens_at` and after round 1 starts nothing is written (the
     * admin "add" remains the straggler path). `checkin_required` is NOT a
     * gate — an open event still benefits from a roster, and the row is
     * harmless there (everyone counts regardless).
     */
    static async checkinFromWitness(
        deviceId: string, canonicalUserId: string, now: Date = new Date(),
    ): Promise<{ tournamentId: string; eventName: string; alreadyCheckedIn: boolean; status: LobbyStatus } | null> {
        const { WitnessService } = await import('./WitnessService.js');
        const target = await WitnessService.getDeviceTarget(deviceId);
        if (!target.tournamentId) return null;

        const event = await EventService.getEvent(target.tournamentId);
        if (!event || event.event_finished_at || event.is_active === 0) return null;
        const rounds = await EventService.getRounds(event.id);
        const state = EventService.deriveState(event, rounds, now);
        const windowOpen = state === 'checkin' || (state === 'upcoming' && !event.checkin_opens_at);
        if (!windowOpen) return null;

        const existing = await EventService.isParticipant(event.id, canonicalUserId);
        if (!existing) {
            await EventService.checkIn(event.id, canonicalUserId, 'checkin');
            logInfo(`Witness: ${canonicalUserId} checked in to event "${event.name}" from cabinet ${deviceId}`);
        }

        const roster = await EventLobbyService.roster(event, rounds, now);
        const canonical = await EventService.canonicalId(canonicalUserId);
        const mine = roster.find(e => e.userId === canonical);
        return {
            tournamentId: event.id,
            eventName: event.name,
            alreadyCheckedIn: !!existing,
            // The tile being open is itself the proof no table is open, so
            // this is 'ready' in practice; computed rather than assumed so a
            // second paired cabinet with a table up is reported honestly.
            status: mine?.status ?? 'ready',
        };
    }

    /** The short line the cabinet prints after "SENDING TO …". */
    static cabinetLine(result: { status: LobbyStatus } | null): string {
        if (!result) return '';
        switch (result.status) {
            case 'ready': return ' · CHECKED IN · READY';
            case 'table_open': return ' · CHECKED IN · EXIT TABLE';
            default: return ' · CHECKED IN';
        }
    }
}
