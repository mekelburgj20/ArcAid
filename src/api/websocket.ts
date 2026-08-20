import { Server as HttpServer } from 'http';
import { Server as SocketServer, Socket } from 'socket.io';
import { logInfo, logError } from '../utils/logger.js';
import { verifyToken } from './auth.js';
import { RoomAccessService } from '../services/RoomAccessService.js';
import { getDatabase } from '../database/database.js';

let io: SocketServer | null = null;

/**
 * Approval-rooms (v2.39.0) leak closure. FE passes the player token via the
 * Socket.io `auth` handshake payload (see admin-ui/src/lib/websocket.ts).
 * 'open'-policy rooms: unchanged, zero added latency beyond the policy read
 * itself (mirrors the HTTP gate's short-circuit). 'approval'-policy rooms:
 * defers to the same RoomAccessService.canViewRoom check the HTTP gate uses.
 * A client without access silently doesn't join — no error channel, the
 * room's live-update channels are simply inert for them (matching "hard-gate
 * VIEWING", not just page-load reads).
 *
 * S22 Phase 2 (v2.44.0) — suspension check runs first (mirrors
 * `roomVisibilityGate`'s ordering): a suspended room's channels are inert for
 * everyone except super-admins, regardless of join policy.
 */
async function canJoinRoomChannel(socket: Socket, roomId: string): Promise<boolean> {
    if (!roomId) return false;
    try {
        const token = (socket.handshake.auth as { token?: string } | undefined)?.token;
        const payload = token ? verifyToken(token) : null;

        const suspended = await RoomAccessService.isSuspended(roomId);
        if (suspended && payload?.role !== 'super_admin') return false;

        const policy = await RoomAccessService.getJoinPolicy(roomId);
        if (policy !== 'approval') return true;
        return RoomAccessService.canViewRoom(payload, roomId);
    } catch {
        // Fail-open on infra failure (matches the HTTP gate).
        return true;
    }
}

/** `join:game` only knows a gameId — resolve its room via the denormalized
 * `games.game_room_id` column (cheap: indexed PK lookup, no join needed —
 * see CLAUDE.md's pin-to-scoreboard section) before applying the same gate. */
async function resolveGameRoomId(gameId: string): Promise<string | null> {
    try {
        const db = await getDatabase();
        const row = await db.get<{ game_room_id: string | null }>(
            'SELECT game_room_id FROM games WHERE id = ?', gameId,
        );
        return row?.game_room_id ?? null;
    } catch {
        return null;
    }
}

/**
 * Initialize Socket.io server on the existing HTTP server.
 */
export function initWebSocket(httpServer: HttpServer): SocketServer {
    const allowedOrigins = process.env.CORS_ORIGIN
        ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
        : '*';

    io = new SocketServer(httpServer, {
        cors: {
            origin: allowedOrigins,
            methods: ['GET', 'POST'],
        },
        path: '/socket.io',
    });

    io.on('connection', (socket) => {
        logInfo(`WebSocket client connected: ${socket.id}`);

        socket.on('disconnect', () => {
            logInfo(`WebSocket client disconnected: ${socket.id}`);
        });

        // Allow clients to join a specific game room for targeted updates
        socket.on('join:game', async (gameId: string) => {
            const roomId = await resolveGameRoomId(gameId);
            // No room attribution (manual/legacy game) — nothing to gate.
            if (roomId && !(await canJoinRoomChannel(socket, roomId))) return;
            socket.join(`game:${gameId}`);
        });

        socket.on('leave:game', (gameId: string) => {
            socket.leave(`game:${gameId}`);
        });

        // Lobby feed: room-scoped channel
        socket.on('join:lobby', async (roomId: string) => {
            if (!(await canJoinRoomChannel(socket, roomId))) return;
            socket.join(`lobby:${roomId}`);
        });

        socket.on('leave:lobby', (roomId: string) => {
            socket.leave(`lobby:${roomId}`);
        });

        // Room-scoped scoreboard channel (S4): score:new + leaderboard:updated
        // are emitted to room:<id> so a score in one room doesn't refresh
        // another's boards. Scoreboard / admin Leaderboard / Kiosk join on mount.
        socket.on('join:room', async (roomId: string) => {
            if (!(await canJoinRoomChannel(socket, roomId))) return;
            socket.join(`room:${roomId}`);
        });

        socket.on('leave:room', (roomId: string) => {
            socket.leave(`room:${roomId}`);
        });
    });

    logInfo('WebSocket server initialized');
    return io;
}

/**
 * Get the Socket.io server instance.
 */
export function getIO(): SocketServer | null {
    return io;
}

/**
 * Emit a score:new event to a room's scoreboard channel (S4). Clients join via
 * 'join:room'. Fired (fire-and-forget) from LobbyFeedGenerator.onScoreSubmitted
 * — the single chokepoint for all live submit paths (web / sync / Discord) — so
 * the poller's dedup prevents a web submit from double-toasting when it later
 * re-reads the same score off iScored.
 */
export function emitScoreNew(roomId: string, data: { gameName: string; playerName: string; score: number }) {
    if (!io) return;
    io.to(`room:${roomId}`).emit('score:new', data);
}

/**
 * Emit a score:new:global event to all clients watching the global scoreboard.
 * The global scoreboard page subscribes via `io.on('score:new:global', ...)` —
 * no room join needed, all connected clients receive it.
 */
export function emitScoreNewGlobal(data: {
    globalGameId: string;
    gameName: string;
    playerName: string;
    score: number;
    /**
     * v2.89.x — the score's canonical engine id, so the Global Scoreboard's
     * optimistic bump can target the ONE per-category card the score belongs
     * to (P4 split games into per-category boards; without this the client
     * bumped every card of the game). Optional: clients treat a missing
     * engine as "bump all cards" (pre-P4 behavior, self-heals on next fetch).
     */
    engine?: string | null;
    originRoomSlug?: string | null;
    originRoomName?: string | null;
}) {
    if (!io) return;
    io.emit('score:new:global', data);
}

/**
 * Emit a game:rotated event.
 */
export function emitGameRotated(data: { tournamentName: string; oldGame: string; newGame: string }) {
    if (!io) return;
    io.emit('game:rotated', data);
}

/**
 * Emit a picker:assigned event.
 */
export function emitPickerAssigned(data: { tournamentName: string; pickerName: string; deadline: string }) {
    if (!io) return;
    io.emit('picker:assigned', data);
}

/**
 * Emit a leaderboard:updated event to a room's scoreboard channel (S4).
 * Scoreboard, admin Leaderboard, and Kiosk subscribe after `join:room`.
 * Room-scoped so a moderator/self delete in one room doesn't repaint every
 * other room's boards.
 */
export function emitLeaderboardUpdated(roomId: string, data: { gameId: string }) {
    if (!io) return;
    io.to(`room:${roomId}`).emit('leaderboard:updated', data);
}

/**
 * Emit a settings:updated event to a room's scoreboard channel.
 *
 * The payload is deliberately EMPTY. Room settings include credentials and
 * policy keys; the only shape a public client is allowed to see is the
 * `GET /:roomId/scoreboard-config` allowlist, so clients refetch that endpoint
 * rather than trusting anything pushed over the socket. Emitted after any
 * write that changes stored settings (the settings POST, a style-profile
 * apply) so the kiosk on the wall and every open scoreboard re-dress
 * themselves within a second instead of waiting for a full page reload.
 */
export function emitSettingsUpdated(roomId: string) {
    if (!io) return;
    io.to(`room:${roomId}`).emit('settings:updated', {});
}

/**
 * Emit a lobby:event to clients watching a specific game room's lobby.
 */
export function emitLobbyEvent(roomId: string, event: Record<string, unknown>) {
    if (!io) return;
    io.to(`lobby:${roomId}`).emit('lobby:event', event);
}

/**
 * Emit a bot:status event.
 */
export function emitBotStatus(data: { online: boolean }) {
    if (!io) return;
    io.emit('bot:status', data);
}
