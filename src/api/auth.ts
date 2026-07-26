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
    // Identity provider for `discordId`. ABSENT = legacy token minted before
    // Google login existed = treat as discord (see identityProvider.ts).
    // localAdminId tokens never carry this — provider is a discordId-only concept.
    provider?: 'discord' | 'google';
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

function hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createSession(
    discordUserId: string,
    refreshToken: string,
    accessToken: string,
): Promise<void> {
    const db = await getDatabase();
    const refreshTokenHash = hashToken(refreshToken);
    const accessTokenHash = hashToken(accessToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
    await db.run(
        `INSERT INTO sessions (id, discord_user_id, refresh_token, access_token_hash, expires_at, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        crypto.randomUUID(), discordUserId, refreshTokenHash, accessTokenHash, expiresAt,
    );
}

export async function refreshAccessToken(
    refreshToken: string,
): Promise<{ token: string; refreshToken: string } | null> {
    const db = await getDatabase();
    const session = await db.get(
        `SELECT * FROM sessions WHERE refresh_token = ? AND expires_at > datetime('now')`,
        hashToken(refreshToken),
    );
    if (!session) return null;

    const { AdminService } = await import('../services/AdminService.js');
    const { providerOfUserId } = await import('../utils/identityProvider.js');
    const { IdentityLinkService } = await import('../services/IdentityLinkService.js');
    const { BanService } = await import('../services/BanService.js');

    // v2.36.0 — resolve to the canonical identity if this user has linked a
    // google:* identity to a Discord snowflake. In practice `createLink`
    // already rewrites `sessions.discord_user_id` inside its own transaction,
    // so this is usually a no-op by the time a refresh happens; kept anyway
    // per the shared-helper contract (defense-in-depth for sessions minted
    // in some future path that forgets the rewrite, and for uniformity with
    // the two OAuth callbacks).
    const discordId: string = await IdentityLinkService.resolveCanonical(session.discord_user_id);

    // S22 Phase 2 (v2.44.0) — ban enforcement at token issuance. Checked on
    // every refresh (not just at login) so a ban placed mid-session takes
    // effect the moment the current access token expires, and a lifted/expired
    // ban lets the SAME refresh token start working again (no session
    // revocation on ban — see BanService doc comment). Throws a coded error
    // (mirrors the DISPLAY_NAME_TAKEN convention) so the route layer can
    // surface a distinct 401 code instead of the generic "expired token" one.
    const banCheck = await BanService.isIdentityBanned(discordId);
    if (banCheck.banned) {
        const err = new Error('Account is banned') as Error & { code?: string };
        err.code = 'ACCOUNT_BANNED';
        throw err;
    }

    // Username/avatar come from user_profiles (display_name / avatar_hash /
    // avatar_url) — NOT user_mappings. user_mappings is the iScored-alias
    // table (many-to-one Discord->iScored aliases); using it here was a
    // doctrine drift that also meant a Google user's refreshed token showed
    // their raw `google:<sub>` string as username (no user_mappings row is
    // ever written for Google logins). user_profiles holds one row per
    // logged-in identity (Discord OR Google) with the user-chosen display
    // name and cached avatar — the correct read source for both providers.
    const profile = await db.get(
        'SELECT display_name, username, avatar_hash, avatar_url FROM user_profiles WHERE discord_user_id = ?',
        discordId,
    );
    // Fall back through the provider `username` (v2.40.0) before the raw id.
    // Pre-fix this degraded to `discordId` for any user without a chosen
    // display_name, which then poisoned user_profiles.username via the
    // join-request upsert (v2.40.1 regression fix).
    const username = profile?.display_name || profile?.username || discordId;
    const avatar = profile?.avatar_url
        ? profile.avatar_url
        : profile?.avatar_hash
            ? `https://cdn.discordapp.com/avatars/${discordId}/${profile.avatar_hash}.png`
            : undefined;
    const provider = providerOfUserId(discordId);

    let payload: TokenPayload;
    const isSuperAdmin = await AdminService.isSuperAdmin(discordId);
    if (isSuperAdmin) {
        payload = { role: 'super_admin', gameRoomIds: [], discordId, username, avatar, provider };
    } else {
        const roomIds = await AdminService.getRoomsForDiscordUser(discordId);
        if (roomIds.length > 0) {
            payload = { role: 'room_admin', gameRoomIds: roomIds, discordId, username, avatar, provider };
        } else {
            payload = { role: 'player', gameRoomIds: [], discordId, username, avatar, provider };
        }
    }

    const token = signToken(payload);
    const newRefresh = crypto.randomUUID();
    const newRefreshHash = hashToken(newRefresh);
    const accessTokenHash = hashToken(token);
    const newExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await db.run(
        `UPDATE sessions SET refresh_token = ?, access_token_hash = ?, expires_at = ?, last_used_at = datetime('now') WHERE id = ?`,
        newRefreshHash, accessTokenHash, newExpiry, session.id,
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
