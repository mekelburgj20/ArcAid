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
 * Emit a score:new event to the specific game room only.
 * Clients must join the game room via 'join:game' to receive these events.
 */
export function emitScoreNew(data: { gameId: string; gameName: string; playerName: string; score: number }) {
    if (!io) return;
    io.to(`game:${data.gameId}`).emit('score:new', data);
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
 * Emit a leaderboard:updated event to the specific game room only.
 */
export function emitLeaderboardUpdated(data: { gameId: string }) {
    if (!io) return;
    io.to(`game:${data.gameId}`).emit('leaderboard:updated', data);
}

/**
 * Emit a bot:status event.
 */
export function emitBotStatus(data: { online: boolean }) {
    if (!io) return;
    io.emit('bot:status', data);
}
