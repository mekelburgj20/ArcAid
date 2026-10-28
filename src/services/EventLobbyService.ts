import { getDatabase } from '../database/database.js';
import { logInfo } from '../utils/logger.js';
import { EventService, type EventTournamentRow, type EventRoundRow } from './EventService.js';
import { resolveProfiles, resolveUserLabels } from './PlayerProfileResolver.js';
import { tournamentFinishedSql } from '../utils/openCard.js';
import { deviceRoutesTo } from '../utils/witnessRouting.js';

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
 *   - `not_routed`  — W26 (v2.174.0): the player has a paired device, but none
 *                     of them sends its scores to THIS event (pointed at
 *                     another room, pinned to another tournament, or set to
 *                     "Global Scoreboard only" — ADR 0032). Same rule as
 *                     ingest (`utils/witnessRouting.ts`), so the light cannot
 *                     be green for a device whose scores go elsewhere.
 *   - `no_cabinet`  — no paired, unrevoked Witness device (cabinet OR desktop).
 *                     Scores will post unverified. Neutral, not a fault: most
 *                     players have no device. The enum value keeps its
 *                     original name because the UI keys on it; the copy the
 *                     UI shows for it is device-neutral (v2.163.0).
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
 * ## Desktop devices (v2.163.0)
 *
 * The Castcade companion pairs a Windows VPX rig as a witness device with
 * `witness_devices.device_type = 'desktop'`. The roster grades it by exactly
 * the rules above — check-in, open session, heartbeat — and never reads
 * `device_type`: a desktop that has heartbeated and gone quiet for
 * HEARTBEAT_STALE_SEC is `offline` like a cabinet would be. One rule, one
 * copy, both kinds of machine.
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

export type LobbyStatus = 'ready' | 'table_open' | 'no_checkin' | 'offline' | 'not_routed' | 'no_cabinet';

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
    /**
     * v2.186.0 (W19): the type of the device that produced the BEST `status`
     * (the lobby copy differs: a cabinet opens a tile, a desktop closes VPX).
     * Null for `no_cabinet` and for `not_routed` (no device routes here).
     */
    deviceType: LobbyDeviceType | null;
    /** One per device of this player that routes to this event, best-first. */
    devices: LobbyDevice[];
}

export type LobbyDeviceType = 'atgames' | 'desktop';

export interface LobbyDevice {
    deviceType: LobbyDeviceType;
    status: LobbyStatus;
    openTable: string | null;
    witnessCheckinAt: string | null;
}

/** Observation rows launched before this many seconds ago are stale, not open. */
const OPEN_SESSION_MAX_AGE_SEC = 4 * 3600;

const STATUS_RANK: Record<LobbyStatus, number> = { ready: 5, table_open: 4, no_checkin: 3, offline: 2, not_routed: 1, no_cabinet: 0 };

export function toEpoch(iso: string | null | undefined): number | null {
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
     * v2.187.0 (W5) — the device-state reads behind BOTH the player-facing
     * lobby (`roster`) and the room admin's live device view
     * (`WitnessAdminViewService.roomDevices`), in one place so the two cannot
     * drift on what "checked in" or "table open" means.
     *
     * - `checkinByDevice`: the latest Witness check-in per device at or after
     *   `checkinFloorEpoch` (server clock, epoch seconds; 0 = any time).
     * - `openByDevice`: the newest OPEN session (kind `session`, no exit) per
     *   device, launched within OPEN_SESSION_MAX_AGE_SEC of `nowEpoch`, so a
     *   missed exit from yesterday cannot read as "open now".
     */
    static async loadDeviceState(
        deviceIds: string[], opts: { checkinFloorEpoch: number; nowEpoch: number },
    ): Promise<{
        checkinByDevice: Map<string, number>;
        openByDevice: Map<string, { atgames_unique_id: string; table_name: string; launch_ts: number }>;
    }> {
        if (deviceIds.length === 0) return { checkinByDevice: new Map(), openByDevice: new Map() };
        const db = await getDatabase();
        const devicePlaceholders = deviceIds.map(() => '?').join(', ');

        // Latest check-in per device inside the window. Server clock, always.
        const checkins = await db.all<Array<{ atgames_unique_id: string; ts: number }>>(
            `SELECT atgames_unique_id, MAX(CAST(strftime('%s', server_ts) AS INTEGER)) AS ts
               FROM witness_checkins
              WHERE atgames_unique_id IN (${devicePlaceholders})
                AND CAST(strftime('%s', server_ts) AS INTEGER) >= ?
              GROUP BY atgames_unique_id`,
            ...deviceIds, opts.checkinFloorEpoch,
        );
        const checkinByDevice = new Map(checkins.map(c => [c.atgames_unique_id, c.ts]));

        // The newest OPEN session per device (launched, not yet exited), bounded
        // so a missed exit from yesterday cannot read as "open now".
        const open = await db.all<Array<{ atgames_unique_id: string; table_name: string; launch_ts: number }>>(
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
            opts.nowEpoch - OPEN_SESSION_MAX_AGE_SEC, ...deviceIds,
        );
        const openByDevice = new Map(open.map(o => [o.atgames_unique_id, o]));
        return { checkinByDevice, openByDevice };
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

        // W26: each device's EFFECTIVE target rides along (a pinned tournament
        // that has finished reads as absent, as in getDeviceTarget), so only
        // devices whose scores would land on THIS event are graded.
        const devices = await db.all<Array<{
            atgames_unique_id: string; canonical_user_id: string; last_seen_at: string | null; heartbeat_at: string | null;
            target_room_id: string | null; target_tournament_id: string | null; global_only: number; device_type: string | null;
        }>>(
            `SELECT d.atgames_unique_id, d.canonical_user_id, d.last_seen_at, d.heartbeat_at, d.target_room_id, d.global_only, d.device_type,
                    CASE WHEN ${tournamentFinishedSql('t')} THEN NULL ELSE d.target_tournament_id END AS target_tournament_id
               FROM witness_devices d
               LEFT JOIN tournaments t ON t.id = d.target_tournament_id
              WHERE d.revoked_at IS NULL AND d.canonical_user_id IN (${placeholders})`,
            ...ids,
        );
        const deviceIds = devices.map(d => d.atgames_unique_id);

        // Latest check-in per device inside the window + the newest open session
        // per device (v2.187.0, W5: loaded by the helper the runner's view shares).
        const { checkinByDevice, openByDevice } = await EventLobbyService.loadDeviceState(deviceIds, {
            checkinFloorEpoch: windowOpen, nowEpoch,
        });

        const profiles = await resolveProfiles(
            participants.map(p => ({ submitted_by_user_id: p.user_id, discord_user_id: p.user_id })),
        );
        // v2.162.2 — id-keyed label rule (display_name → username → alias).
        const labels = await resolveUserLabels(participants.map(p => p.user_id));

        return participants.map((p, i) => {
            const mine = devices.filter(d => d.canonical_user_id === p.user_id);
            let best: { status: LobbyStatus; checkinTs: number | null; openTable: string | null; deviceType: LobbyDeviceType | null } =
                { status: mine.length > 0 ? 'not_routed' : 'no_cabinet', checkinTs: null, openTable: null, deviceType: null };
            const graded: LobbyDevice[] = [];
            for (const d of mine) {
                // A device that sends elsewhere says nothing about this event.
                const routesHere = deviceRoutesTo(
                    { roomId: d.target_room_id, tournamentId: d.target_tournament_id, globalOnly: d.global_only === 1 },
                    { roomId: event.game_room_id, tournamentId: event.id, isRound: true, isParticipant: true },
                );
                if (!routesHere) continue;
                const checkinTs = checkinByDevice.get(d.atgames_unique_id) ?? null;
                const session = openByDevice.get(d.atgames_unique_id) ?? null;
                const heartbeat = toEpoch(d.heartbeat_at);
                let status: LobbyStatus;
                if (heartbeat != null && nowEpoch - heartbeat > HEARTBEAT_STALE_SEC) status = 'offline';
                else if (checkinTs == null) status = 'no_checkin';
                else if (session && session.launch_ts > checkinTs) status = 'table_open';
                else status = 'ready';
                // W19: a missing/unknown type is a cabinet (the column default).
                const deviceType: LobbyDeviceType = d.device_type === 'desktop' ? 'desktop' : 'atgames';
                const candidate = {
                    status,
                    checkinTs,
                    openTable: status === 'table_open' ? session!.table_name : null,
                    deviceType,
                };
                graded.push({
                    deviceType, status, openTable: candidate.openTable,
                    witnessCheckinAt: checkinTs != null ? new Date(checkinTs * 1000).toISOString() : null,
                });
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
                displayName: labels[p.user_id] ?? null,
                avatarHash: profile?.avatar_hash ?? null,
                avatarUrl: profile?.avatar_url ?? null,
                checkedInAt: p.checked_in_at,
                source: p.source,
                status: best.status,
                witnessCheckinAt: best.checkinTs != null ? new Date(best.checkinTs * 1000).toISOString() : null,
                openTable: best.openTable,
                lastSeenAt: lastSeen,
                deviceType: best.deviceType,
                devices: graded.sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status]),
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
        return EventLobbyService.lobbyForDevice(deviceId, canonicalUserId, now, true);
    }

    /**
     * W28 (v2.173.0): the same answer for a HEARTBEAT, with NO check-in.
     *
     * The heartbeat runs in the cabinet's background while tables are played,
     * so it must never write a participant row — a check-in is the proof that
     * no table was open. A player who has not checked in gets null (no suffix);
     * one who has gets their live lobby status, so the cabinet's line can say
     * "EXIT TABLE" mid-session as truthfully as the check-in says "READY".
     */
    static async lobbyFromHeartbeat(
        deviceId: string, canonicalUserId: string, now: Date = new Date(),
    ): Promise<{ tournamentId: string; eventName: string; alreadyCheckedIn: boolean; status: LobbyStatus } | null> {
        return EventLobbyService.lobbyForDevice(deviceId, canonicalUserId, now, false);
    }

    private static async lobbyForDevice(
        deviceId: string, canonicalUserId: string, now: Date, checkIn: boolean,
    ): Promise<{ tournamentId: string; eventName: string; alreadyCheckedIn: boolean; status: LobbyStatus } | null> {
        const { WitnessService } = await import('./WitnessService.js');
        const target = await WitnessService.getDeviceTarget(deviceId);

        // v2.175.0 (W37): which events this device can check in to. Pinned →
        // that event. Un-pinned → every live event in the rooms the device
        // sends to: its one room, or (All my rooms, the default since
        // migration 191) every room the player is a member of. Global only →
        // none. Pre-v2.175.0 only a device pinned to the event checked in, and
        // migration 191 un-pinned every device, so without this the tile would
        // have stopped being the check-in at all.
        const db = await getDatabase();
        const eventIds: string[] = target.tournamentId
            ? [target.tournamentId]
            : target.roomId
                ? (await db.all<Array<{ id: string }>>(
                    `SELECT id FROM tournaments
                      WHERE format = 'event' AND is_active = 1 AND event_finished_at IS NULL AND game_room_id = ?
                      ORDER BY start_date`, target.roomId,
                )).map(r => r.id)
                : target.globalOnly
                    ? []
                    : (await db.all<Array<{ id: string }>>(
                        `SELECT t.id FROM tournaments t
                           JOIN room_members rm ON rm.room_id = t.game_room_id AND rm.user_id = ?
                          WHERE t.format = 'event' AND t.is_active = 1 AND t.event_finished_at IS NULL
                          ORDER BY t.start_date`, canonicalUserId,
                    )).map(r => r.id);

        let first: { tournamentId: string; eventName: string; alreadyCheckedIn: boolean; status: LobbyStatus } | null = null;
        for (const eventId of eventIds) {
            const result = await EventLobbyService.lobbyForEvent(eventId, deviceId, canonicalUserId, now, checkIn);
            first ??= result;
        }
        return first;
    }

    /** One event's check-in-window answer for a device (the pre-v2.175.0 body). */
    private static async lobbyForEvent(
        eventId: string, deviceId: string, canonicalUserId: string, now: Date, checkIn: boolean,
    ): Promise<{ tournamentId: string; eventName: string; alreadyCheckedIn: boolean; status: LobbyStatus } | null> {
        const event = await EventService.getEvent(eventId);
        if (!event || event.event_finished_at || event.is_active === 0) return null;
        const rounds = await EventService.getRounds(event.id);
        const state = EventService.deriveState(event, rounds, now);
        const windowOpen = state === 'checkin' || (state === 'upcoming' && !event.checkin_opens_at);
        if (!windowOpen) return null;

        const existing = await EventService.isParticipant(event.id, canonicalUserId);
        if (!existing && !checkIn) return null;
        if (!existing) {
            // W39 — an invite-only event: the tile cannot check in someone who
            // is not on its roster (it would only throw), so it says nothing.
            const { TournamentEntryService } = await import('./TournamentEntryService.js');
            const entry = await TournamentEntryService.getConfig(event.id);
            if (entry?.mode === 'invited' && !await TournamentEntryService.isOnRoster(event.id, canonicalUserId)) return null;
            await EventService.checkIn(event.id, canonicalUserId, 'checkin');
            logInfo(`Witness: ${canonicalUserId} checked in to event "${event.name}" from device ${deviceId}`);
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
