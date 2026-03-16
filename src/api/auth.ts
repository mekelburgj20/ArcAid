import bcrypt from 'bcryptjs';
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
    role: 'room_admin' | 'super_admin';
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
