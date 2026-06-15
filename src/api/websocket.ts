import { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { logInfo, logError } from '../utils/logger.js';

let io: SocketServer | null = null;

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
        socket.on('join:game', (gameId: string) => {
            socket.join(`game:${gameId}`);
        });

        socket.on('leave:game', (gameId: string) => {
            socket.leave(`game:${gameId}`);
        });

        // Lobby feed: room-scoped channel
        socket.on('join:lobby', (roomId: string) => {
            socket.join(`lobby:${roomId}`);
        });

        socket.on('leave:lobby', (roomId: string) => {
            socket.leave(`lobby:${roomId}`);
        });

        // Room-scoped scoreboard channel (S4): score:new + leaderboard:updated
        // are emitted to room:<id> so a score in one room doesn't refresh
        // another's boards. Scoreboard / admin Leaderboard / Kiosk join on mount.
        socket.on('join:room', (roomId: string) => {
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
