import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { getDatabase } from '../database/database.js';

function getJwtSecret(): string {
    const secret = process.env.JWT_SECRET;
    if (secret) return secret;

    if (process.env.NODE_ENV === 'production') {
        throw new Error('JWT_SECRET environment variable is required in production. Set it before starting the server.');
    }

    return 'arcaid-dev-secret-change-in-production';
}

const JWT_SECRET = getJwtSecret();
const JWT_EXPIRY = '24h';

export interface TokenPayload {
    role: 'room_admin' | 'super_admin' | 'player';
    gameRoomIds: string[];
    // Identity — exactly one of these is set:
    discordId?: string;
    localAdminId?: string;
    // Display
    username?: string;
    avatar?: string;
}

export async function hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
}

export function signToken(payload: TokenPayload): string {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

export function verifyToken(token: string): TokenPayload | null {
    try {
        return jwt.verify(token, JWT_SECRET) as TokenPayload;
    } catch {
        return null;
    }
}

export function generateRefreshToken(): string {
    return crypto.randomUUID();
}

export async function createSession(
    discordUserId: string,
    refreshToken: string,
    accessToken: string,
): Promise<void> {
    const db = await getDatabase();
    const accessTokenHash = crypto.createHash('sha256').update(accessToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
    await db.run(
        `INSERT INTO sessions (id, discord_user_id, refresh_token, access_token_hash, expires_at, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        crypto.randomUUID(), discordUserId, refreshToken, accessTokenHash, expiresAt,
    );
}

export async function refreshAccessToken(
    refreshToken: string,
): Promise<{ token: string; refreshToken: string } | null> {
    const db = await getDatabase();
    const session = await db.get(
        `SELECT * FROM sessions WHERE refresh_token = ? AND expires_at > datetime('now')`,
        refreshToken,
    );
    if (!session) return null;

    const discordId: string = session.discord_user_id;
    const { AdminService } = await import('../services/AdminService.js');

    const mapping = await db.get(
        'SELECT iscored_username, avatar_hash FROM user_mappings WHERE discord_user_id = ?',
        discordId,
    );
    const username = mapping?.iscored_username || discordId;
    const avatar = mapping?.avatar_hash
        ? `https://cdn.discordapp.com/avatars/${discordId}/${mapping.avatar_hash}.png`
        : undefined;

    let payload: TokenPayload;
    const isSuperAdmin = await AdminService.isSuperAdmin(discordId);
    if (isSuperAdmin) {
        payload = { role: 'super_admin', gameRoomIds: [], discordId, username, avatar };
    } else {
        const roomIds = await AdminService.getRoomsForDiscordUser(discordId);
        if (roomIds.length > 0) {
            payload = { role: 'room_admin', gameRoomIds: roomIds, discordId, username, avatar };
        } else {
            payload = { role: 'player', gameRoomIds: [], discordId, username, avatar };
        }
    }

    const token = signToken(payload);
    const newRefresh = crypto.randomUUID();
    const accessTokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const newExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await db.run(
        `UPDATE sessions SET refresh_token = ?, access_token_hash = ?, expires_at = ?, last_used_at = datetime('now') WHERE id = ?`,
        newRefresh, accessTokenHash, newExpiry, session.id,
    );

    return { token, refreshToken: newRefresh };
}

export async function cleanExpiredSessions(): Promise<number> {
    const db = await getDatabase();
    const result = await db.run(`DELETE FROM sessions WHERE expires_at < datetime('now')`);
    return result.changes ?? 0;
}

export async function getAdminPasswordHash(): Promise<string | null> {
    const db = await getDatabase();
    const row = await db.get("SELECT value FROM settings WHERE key = 'ADMIN_PASSWORD_HASH'");
    return row?.value ?? null;
}

export async function setAdminPasswordHash(hash: string): Promise<void> {
    const db = await getDatabase();
    await db.run(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('ADMIN_PASSWORD_HASH', ?)",
        hash
    );
}
