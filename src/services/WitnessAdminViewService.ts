import { getDatabase } from '../database/database.js';
import { EventService } from './EventService.js';
import {
    EventLobbyService, HEARTBEAT_STALE_SEC, toEpoch, type LobbyEntry, type LobbyStatus,
} from './EventLobbyService.js';
import { WitnessService } from './WitnessService.js';
import { resolveUserLabels } from './PlayerProfileResolver.js';

/**
 * The runner's live device view (v2.189.0, W5) — what a room admin sees while
 * running a night: every paired Witness device belonging to a member of THEIR
 * room (or entered directly into one of the room's tournaments), whether it is
 * reporting in, when it last checked in, which table is open on it right now,
 * and where its scores go; plus, for each event in its check-in lobby, the
 * lobby counts the players see (ready / table open / not checked in / ...).
 *
 * Owner ask 2026-10-18 (castcade `docs/arcaid-side-changes.md` §10): the runner
 * needs to know when to start. The data was all there — this only aggregates.
 *
 * ## One copy of every rule
 *
 * - Check-in and open-table state load through
 *   `EventLobbyService.loadDeviceState`, the SAME reads `roster` grades the
 *   player-facing lobby with, so the two cannot disagree about "checked in" or
 *   "table open".
 * - Online-ness uses `HEARTBEAT_STALE_SEC` with the lobby's own rule: a device
 *   that has heartbeated and gone quiet that long is `offline`; one that has
 *   NEVER heartbeated (a pre-1.0.4 cabinet) is `unknown`, never offline.
 * - The routing entry is the matching row of `WitnessService.routingForRoom`
 *   — the answer behind the player's own "Your scores go to" line — so the
 *   runner is told exactly what the player is told.
 * - Player names resolve through `resolveUserLabels` (display_name → username →
 *   alias); a raw id is never shown.
 *
 * Privacy: the caller (the route) is a room admin of `roomId`; the device set
 * is bounded to that room's members and entrants; and every field is something
 * the device already reports to the server (table names, timestamps). Nothing
 * comes from the player's PC. Read-only; writes nothing.
 */

export type DeviceOnline = 'online' | 'offline' | 'unknown';

export interface AdminViewDevice {
    deviceId: string;
    deviceType: 'atgames' | 'desktop';
    /** No label column exists on `witness_devices` today; reserved. */
    label: string | null;
    userId: string;
    playerName: string;
    /** True when the player is a member of this room; false = entered directly into a tournament here. */
    member: boolean;
    online: DeviceOnline;
    heartbeatAt: string | null;
    lastSeenAt: string | null;
    lastCheckinAt: string | null;
    openTable: string | null;
    openSince: string | null;
    /** The W27.3 entry for this device and room (the words are the front end's `roomLines`). */
    routing: Awaited<ReturnType<typeof WitnessService.routingForRoom>>[number] | null;
    /** `WitnessService.describeTarget` — where the device is pointed. */
    target: string;
}

export interface AdminViewEvent {
    tournamentId: string;
    name: string;
    state: string;
    counts: Record<LobbyStatus, number>;
    roster: LobbyEntry[];
}

const iso = (epoch: number | null): string | null => (epoch == null ? null : new Date(epoch * 1000).toISOString());

export class WitnessAdminViewService {
    static async roomDevices(roomId: string, now: Date = new Date()): Promise<{ devices: AdminViewDevice[]; events: AdminViewEvent[] }> {
        const db = await getDatabase();
        const nowEpoch = Math.floor(now.getTime() / 1000);

        // Members of this room, plus direct entrants: participants / roster of
        // this room's tournaments that are still open (ADR 0033: a direct entry
        // is also "allowed in").
        const rows = await db.all<Array<{
            atgames_unique_id: string; canonical_user_id: string; device_type: string | null;
            last_seen_at: string | null; heartbeat_at: string | null; member: number;
        }>>(
            `SELECT d.atgames_unique_id, d.canonical_user_id, d.device_type, d.last_seen_at, d.heartbeat_at,
                    EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id = ? AND rm.user_id = d.canonical_user_id) AS member
               FROM witness_devices d
              WHERE d.revoked_at IS NULL
                AND (
                    EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id = ? AND rm.user_id = d.canonical_user_id)
                 OR EXISTS (SELECT 1 FROM tournaments t
                             WHERE t.game_room_id = ? AND t.is_active = 1 AND t.event_finished_at IS NULL
                               AND (EXISTS (SELECT 1 FROM tournament_participants tp WHERE tp.tournament_id = t.id AND tp.user_id = d.canonical_user_id)
                                 OR EXISTS (SELECT 1 FROM tournament_roster tr WHERE tr.tournament_id = t.id AND tr.user_id = d.canonical_user_id)))
                )`,
            roomId, roomId, roomId,
        );

        const deviceIds = rows.map(r => r.atgames_unique_id);
        const userIds = [...new Set(rows.map(r => r.canonical_user_id))];
        const { checkinByDevice, openByDevice } = await EventLobbyService.loadDeviceState(deviceIds, {
            checkinFloorEpoch: 0, nowEpoch,
        });
        const labels = await resolveUserLabels(userIds);

        // The player's own routing words, once per player (the rule runs on each
        // device's EFFECTIVE target inside routingForRoom).
        const routingByDevice = new Map<string, NonNullable<AdminViewDevice['routing']>>();
        for (const userId of userIds) {
            for (const r of await WitnessService.routingForRoom(userId, roomId)) routingByDevice.set(r.deviceId, r);
        }

        const devices: AdminViewDevice[] = [];
        for (const r of rows) {
            const heartbeat = toEpoch(r.heartbeat_at);
            const online: DeviceOnline = heartbeat == null ? 'unknown'
                : nowEpoch - heartbeat > HEARTBEAT_STALE_SEC ? 'offline' : 'online';
            const session = openByDevice.get(r.atgames_unique_id) ?? null;
            devices.push({
                deviceId: r.atgames_unique_id,
                deviceType: r.device_type === 'desktop' ? 'desktop' : 'atgames',
                label: null,
                userId: r.canonical_user_id,
                playerName: labels[r.canonical_user_id] ?? 'Unknown player',
                member: r.member === 1,
                online,
                heartbeatAt: r.heartbeat_at,
                lastSeenAt: r.last_seen_at,
                lastCheckinAt: iso(checkinByDevice.get(r.atgames_unique_id) ?? null),
                openTable: session?.table_name ?? null,
                openSince: iso(session?.launch_ts ?? null),
                routing: routingByDevice.get(r.atgames_unique_id) ?? null,
                target: await WitnessService.describeTarget(r.atgames_unique_id),
            });
        }
        // Open table first, then online, then by player name.
        const onlineRank: Record<DeviceOnline, number> = { online: 0, unknown: 1, offline: 2 };
        devices.sort((a, b) =>
            Number(!!b.openTable) - Number(!!a.openTable)
            || onlineRank[a.online] - onlineRank[b.online]
            || a.playerName.localeCompare(b.playerName)
            || a.deviceId.localeCompare(b.deviceId));

        // Each live event in its check-in lobby (upcoming / check-in) — the
        // lobby seen from the runner's side. Gone once round 1 has started.
        const eventRows = await db.all<Array<{ id: string }>>(
            `SELECT id FROM tournaments
              WHERE game_room_id = ? AND format = 'event' AND is_active = 1 AND event_finished_at IS NULL
              ORDER BY start_date, name`,
            roomId,
        );
        const events: AdminViewEvent[] = [];
        for (const { id } of eventRows) {
            const event = await EventService.getEvent(id);
            if (!event) continue;
            const rounds = await EventService.getRounds(id);
            if (!EventLobbyService.isLobbyOpen(event, rounds, now)) continue;
            const roster = await EventLobbyService.roster(event, rounds, now);
            const counts: Record<LobbyStatus, number> = {
                ready: 0, table_open: 0, no_checkin: 0, offline: 0, not_routed: 0, no_cabinet: 0,
            };
            for (const e of roster) counts[e.status] += 1;
            events.push({
                tournamentId: id, name: event.name, state: EventService.deriveState(event, rounds, now), counts, roster,
            });
        }

        return { devices, events };
    }
}
