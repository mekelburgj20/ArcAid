import { getDatabase } from '../database/database.js';

export interface LobbyFeedEvent {
    id: number;
    game_room_id: string;
    type: string;
    source: 'system' | 'admin';
    icon: string | null;
    title: string;
    subtitle: string | null;
    player_id: string | null;
    game_name: string | null;
    tournament_id: string | null;
    target_user_id: string | null;
    metadata: Record<string, any>;
    created_at: string;
    expires_at: string | null;
}

export interface LobbyFeedEmitParams {
    gameRoomId: string;
    type: string;
    source?: 'system' | 'admin';
    icon?: string;
    title: string;
    subtitle?: string;
    playerId?: string;
    gameName?: string;
    tournamentId?: string;
    targetUserId?: string;
    metadata?: Record<string, any>;
    expiresAt?: string;
}

export interface LobbyFeedQueryOptions {
    limit?: number;
    before?: string;
    types?: string[];
    viewerUserId?: string;
}

export class LobbyFeedService {
    /**
     * Insert a feed event. Also emits via WebSocket if available.
     */
    static async emit(params: LobbyFeedEmitParams): Promise<number> {
        const db = await getDatabase();
        const result = await db.run(
            `INSERT INTO lobby_feed_events
                (game_room_id, type, source, icon, title, subtitle, player_id, game_name, tournament_id, target_user_id, metadata, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params.gameRoomId,
            params.type,
            params.source || 'system',
            params.icon || null,
            params.title,
            params.subtitle || null,
            params.playerId || null,
            params.gameName || null,
            params.tournamentId || null,
            params.targetUserId || null,
            JSON.stringify(params.metadata || {}),
            params.expiresAt || null,
        );

        const insertedId = result.lastID!;

        // Fire-and-forget WebSocket emit
        try {
            const { emitLobbyEvent } = await import('../api/websocket.js');
            emitLobbyEvent(params.gameRoomId, {
                id: insertedId,
                game_room_id: params.gameRoomId,
                type: params.type,
                source: (params.source || 'system') as 'system' | 'admin',
                icon: params.icon || null,
                title: params.title,
                subtitle: params.subtitle || null,
                player_id: params.playerId || null,
                game_name: params.gameName || null,
                tournament_id: params.tournamentId || null,
                target_user_id: params.targetUserId || null,
                metadata: params.metadata || {},
                created_at: new Date().toISOString(),
                expires_at: params.expiresAt || null,
            });
        } catch {
            // WebSocket not initialized yet — safe to ignore
        }

        return insertedId;
    }

    /**
     * Get paginated feed for a game room.
     * Cursor-based pagination using created_at. Filters out targeted events
     * unless they match the viewer. Respects room feed settings.
     */
    static async getFeed(gameRoomId: string, options: LobbyFeedQueryOptions = {}): Promise<LobbyFeedEvent[]> {
        const db = await getDatabase();
        const limit = options.limit || 20;
        const params: any[] = [gameRoomId];
        const conditions: string[] = ['game_room_id = ?'];

        // Cursor-based pagination
        if (options.before) {
            conditions.push('created_at < ?');
            params.push(options.before);
        }

        // Filter by event types
        if (options.types && options.types.length > 0) {
            const placeholders = options.types.map(() => '?').join(',');
            conditions.push(`type IN (${placeholders})`);
            params.push(...options.types);
        }

        // Target user filter: show events with no target, or targeted at the viewer
        if (options.viewerUserId) {
            conditions.push('(target_user_id IS NULL OR target_user_id = ?)');
            params.push(options.viewerUserId);
        } else {
            conditions.push('target_user_id IS NULL');
        }

        // Exclude expired events
        conditions.push("(expires_at IS NULL OR expires_at > datetime('now'))");

        params.push(limit);

        const rows = await db.all(
            `SELECT * FROM lobby_feed_events
             WHERE ${conditions.join(' AND ')}
             ORDER BY created_at DESC
             LIMIT ?`,
            ...params
        );

        return rows.map((r: any) => ({
            ...r,
            metadata: JSON.parse(r.metadata || '{}'),
        }));
    }

    /**
     * Check room feed settings for enabled event types.
     * Returns null if all types are enabled (no filtering).
     */
    static async getEnabledTypes(gameRoomId: string): Promise<string[] | null> {
        try {
            const { GameRoomSettingsService } = await import('./GameRoomSettingsService.js');
            const raw = await GameRoomSettingsService.get(gameRoomId, 'LOBBY_FEED_SETTINGS');
            if (!raw) return null;
            const settings = JSON.parse(raw);
            if (settings.enabledTypes && Array.isArray(settings.enabledTypes) && settings.enabledTypes.length > 0) {
                return settings.enabledTypes;
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * Delete old feed events and expired events.
     */
    static async cleanup(retentionDays: number = 90): Promise<number> {
        const db = await getDatabase();
        const result = await db.run(
            `DELETE FROM lobby_feed_events
             WHERE created_at < datetime('now', ?)
                OR (expires_at IS NOT NULL AND expires_at < datetime('now'))`,
            `-${retentionDays} days`
        );
        return result.changes || 0;
    }

    /**
     * Delete all feed events for a game room.
     */
    static async deleteByRoom(gameRoomId: string): Promise<void> {
        const db = await getDatabase();
        await db.run('DELETE FROM lobby_feed_events WHERE game_room_id = ?', gameRoomId);
    }
}
