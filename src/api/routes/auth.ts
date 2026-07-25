import { Router } from 'express';
import { hashPassword, verifyPassword, signToken, getAdminPasswordHash, setAdminPasswordHash, generateRefreshToken, createSession, refreshAccessToken } from '../auth.js';
import { requireAuth } from '../middleware.js';
import { logInfo, logError } from '../../utils/logger.js';
import { GameRoomService } from '../../services/GameRoomService.js';
import { AdminService } from '../../services/AdminService.js';
import { LeaderboardService } from '../../services/LeaderboardService.js';
import { getDatabase } from '../../database/database.js';

const router = Router();

// Super-admin password login
router.post('/login', async (req, res) => {
    try {
        const { password } = req.body;
        if (!password || typeof password !== 'string') {
            return res.status(400).json({ error: 'Password required' });
        }

        const hash = await getAdminPasswordHash();

        if (!hash) {
            const newHash = await hashPassword(password);
            await setAdminPasswordHash(newHash);
            const token = signToken({ role: 'super_admin', gameRoomIds: [] });
            return res.json({ token });
        }

        const valid = await verifyPassword(password, hash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid password' });
        }

        const token = signToken({ role: 'super_admin', gameRoomIds: [] });
        res.json({ token });
    } catch (error) {
        logError('API Error (POST /api/auth/login):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Room local admin login
router.post('/login/:roomSlug', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }

        const room = await GameRoomService.getBySlug(req.params.roomSlug as string);
        if (!room) {
            return res.status(404).json({ error: 'Game room not found' });
        }

        const admin = await AdminService.getLocalAdminByUsername(room.id, username);
        if (!admin) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const valid = await AdminService.verifyLocalAdminPassword(admin, password);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = signToken({
            role: 'room_admin',
            gameRoomIds: [room.id],
            localAdminId: admin.id,
            username: admin.display_name || admin.username,
        });

        // Log activity event
        const { RoomEventService } = await import('../../services/RoomEventService.js');
        RoomEventService.log(room.id, 'admin_login', { username }).catch(() => {});

        res.json({ token, roomId: room.id, roomSlug: room.slug });
    } catch (error) {
        logError('API Error (POST /api/auth/login/:roomSlug):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Discord OAuth config
router.get('/discord', async (req, res) => {
    try {
        const clientId = process.env.DISCORD_CLIENT_ID;
        const clientSecret = process.env.DISCORD_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
            return res.status(400).json({ error: 'Discord OAuth not configured. Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET.' });
        }
        res.json({ clientId });
    } catch (error) {
        logError('API Error (GET /api/auth/discord):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Discord OAuth callback
router.post('/discord/callback', async (req, res) => {
    try {
        const { code, redirectUri } = req.body;
        if (!code || !redirectUri) {
            return res.status(400).json({ error: 'Authorization code and redirectUri required' });
        }

        const clientId = process.env.DISCORD_CLIENT_ID;
        const clientSecret = process.env.DISCORD_CLIENT_SECRET;

        if (!clientId || !clientSecret) {
            return res.status(400).json({ error: 'Discord OAuth not configured' });
        }

        // Exchange code for access token
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri,
            }),
        });

        if (!tokenRes.ok) {
            const err = await tokenRes.text();
            logError('Discord OAuth token exchange failed:', err);
            return res.status(401).json({ error: 'Failed to exchange authorization code' });
        }

        const tokenData = await tokenRes.json() as { access_token: string; token_type: string };

        // Get user info
        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        if (!userRes.ok) {
            return res.status(401).json({ error: 'Failed to fetch Discord user info' });
        }
        const user = await userRes.json() as { id: string; username: string; global_name?: string; avatar?: string };

        const displayName = user.global_name || user.username;
        const avatarUrl = user.avatar
            ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
            : null;

        // Cache avatar hash in user_profiles. Upsert so a row exists for every
        // user who has logged in (display_name stays NULL until they pick one).
        if (user.avatar) {
            const db = await getDatabase();
            const existing = await db.get(
                'SELECT avatar_hash FROM user_profiles WHERE discord_user_id = ?', user.id
            );
            const changed = !existing || existing.avatar_hash !== user.avatar;
            await db.run(
                `INSERT INTO user_profiles (discord_user_id, avatar_hash, avatar_fetched_at)
                 VALUES (?, ?, datetime('now'))
                 ON CONFLICT(discord_user_id) DO UPDATE SET
                    avatar_hash = excluded.avatar_hash,
                    avatar_fetched_at = excluded.avatar_fetched_at,
                    updated_at = datetime('now')`,
                user.id, user.avatar
            );
            if (changed) {
                await LeaderboardService.invalidateAll();
            }
        } else {
            // Even without an avatar, ensure the user_profiles row exists so
            // display_name can be set later.
            const db = await getDatabase();
            await db.run(
                `INSERT OR IGNORE INTO user_profiles (discord_user_id) VALUES (?)`,
                user.id
            );
        }

        // 1. Check super_admins table
        const isSuperAdmin = await AdminService.isSuperAdmin(user.id);
        if (isSuperAdmin) {
            const token = signToken({
                role: 'super_admin',
                gameRoomIds: [],
                discordId: user.id,
                username: displayName,
                avatar: avatarUrl || undefined,
                provider: 'discord',
            });
            const refreshToken = generateRefreshToken();
            await createSession(user.id, refreshToken, token);
            logInfo(`Discord OAuth login (super_admin): ${displayName} (${user.id})`);
            return res.json({ token, refreshToken, user: { discordId: user.id, username: displayName, avatar: avatarUrl } });
        }

        // 2. Check game_room_admins table
        const roomIds = await AdminService.getRoomsForDiscordUser(user.id);
        if (roomIds.length > 0) {
            const token = signToken({
                role: 'room_admin',
                gameRoomIds: roomIds,
                discordId: user.id,
                username: displayName,
                avatar: avatarUrl || undefined,
                provider: 'discord',
            });
            const refreshToken = generateRefreshToken();
            await createSession(user.id, refreshToken, token);
            logInfo(`Discord OAuth login (room_admin): ${displayName} (${user.id}) for rooms: ${roomIds.join(', ')}`);
            return res.json({ token, refreshToken, user: { discordId: user.id, username: displayName, avatar: avatarUrl } });
        }

        // 3. Not an admin — issue a player token (for public features like game picking)
        const token = signToken({
            role: 'player',
            gameRoomIds: [],
            discordId: user.id,
            username: displayName,
            avatar: avatarUrl || undefined,
            provider: 'discord',
        });
        const refreshToken = generateRefreshToken();
        await createSession(user.id, refreshToken, token);
        logInfo(`Discord OAuth login (player): ${displayName} (${user.id})`);
        return res.json({ token, refreshToken, user: { discordId: user.id, username: displayName, avatar: avatarUrl } });
    } catch (error) {
        logError('API Error (POST /api/auth/discord/callback):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Google OAuth config
router.get('/google', async (req, res) => {
    try {
        const clientId = process.env.GOOGLE_CLIENT_ID;
        if (!clientId) {
            return res.status(400).json({ error: 'Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.' });
        }
        res.json({ clientId });
    } catch (error) {
        logError('API Error (GET /api/auth/google):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Google OAuth callback
router.post('/google/callback', async (req, res) => {
    try {
        const { code, redirectUri } = req.body;
        if (!code || !redirectUri) {
            return res.status(400).json({ error: 'Authorization code and redirectUri required' });
        }

        const clientId = process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

        if (!clientId || !clientSecret) {
            return res.status(400).json({ error: 'Google OAuth not configured' });
        }

        // Exchange code for access token. Plain fetch — no id_token JWT
        // verification library; the userinfo endpoint call below IS the
        // verification (Google only returns profile data for a token it
        // minted for this client).
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code',
            }),
        });

        if (!tokenRes.ok) {
            const err = await tokenRes.text();
            logError('Google OAuth token exchange failed:', err);
            return res.status(401).json({ error: 'Failed to exchange authorization code' });
        }

        const tokenData = await tokenRes.json() as { access_token: string; token_type: string };

        // Get user info
        const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        if (!userRes.ok) {
            return res.status(401).json({ error: 'Failed to fetch Google user info' });
        }
        const profile = await userRes.json() as { sub: string; name?: string; email?: string; picture?: string };

        const userId = `google:${profile.sub}`;
        const displayName = profile.name || profile.email?.split('@')[0] || 'Player';
        const pictureUrl = profile.picture || null;

        // Upsert user_profiles with avatar_url (mirrors the Discord upsert
        // above, but writes the new avatar_url column instead of
        // avatar_hash — Google avatars are already full URLs, not CDN
        // template hashes). display_name is NEVER touched here — it stays
        // user-chosen (set via AccountSettings), same doctrine as Discord.
        if (pictureUrl) {
            const db = await getDatabase();
            const existing = await db.get(
                'SELECT avatar_url FROM user_profiles WHERE discord_user_id = ?', userId
            );
            const changed = !existing || existing.avatar_url !== pictureUrl;
            await db.run(
                `INSERT INTO user_profiles (discord_user_id, avatar_url, avatar_fetched_at)
                 VALUES (?, ?, datetime('now'))
                 ON CONFLICT(discord_user_id) DO UPDATE SET
                    avatar_url = excluded.avatar_url,
                    avatar_fetched_at = excluded.avatar_fetched_at,
                    updated_at = datetime('now')`,
                userId, pictureUrl
            );
            if (changed) {
                await LeaderboardService.invalidateAll();
            }
        } else {
            const db = await getDatabase();
            await db.run(
                `INSERT OR IGNORE INTO user_profiles (discord_user_id) VALUES (?)`,
                userId
            );
        }

        // Same role branch as Discord — role derivation is table-based and
        // provider-agnostic (a Google user pasted into super_admins /
        // game_room_admins by ID is a legitimate admin).
        const isSuperAdmin = await AdminService.isSuperAdmin(userId);
        if (isSuperAdmin) {
            const token = signToken({
                role: 'super_admin',
                gameRoomIds: [],
                discordId: userId,
                username: displayName,
                avatar: pictureUrl || undefined,
                provider: 'google',
            });
            const refreshToken = generateRefreshToken();
            await createSession(userId, refreshToken, token);
            logInfo(`Google OAuth login (super_admin): ${displayName} (${userId})`);
            return res.json({ token, refreshToken, user: { discordId: userId, username: displayName, avatar: pictureUrl } });
        }

        const roomIds = await AdminService.getRoomsForDiscordUser(userId);
        if (roomIds.length > 0) {
            const token = signToken({
                role: 'room_admin',
                gameRoomIds: roomIds,
                discordId: userId,
                username: displayName,
                avatar: pictureUrl || undefined,
                provider: 'google',
            });
            const refreshToken = generateRefreshToken();
            await createSession(userId, refreshToken, token);
            logInfo(`Google OAuth login (room_admin): ${displayName} (${userId}) for rooms: ${roomIds.join(', ')}`);
            return res.json({ token, refreshToken, user: { discordId: userId, username: displayName, avatar: pictureUrl } });
        }

        const token = signToken({
            role: 'player',
            gameRoomIds: [],
            discordId: userId,
            username: displayName,
            avatar: pictureUrl || undefined,
            provider: 'google',
        });
        const refreshToken = generateRefreshToken();
        await createSession(userId, refreshToken, token);
        logInfo(`Google OAuth login (player): ${displayName} (${userId})`);
        return res.json({ token, refreshToken, user: { discordId: userId, username: displayName, avatar: pictureUrl } });
    } catch (error) {
        logError('API Error (POST /api/auth/google/callback):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Refresh access token
router.post('/refresh', async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken || typeof refreshToken !== 'string') {
            return res.status(400).json({ error: 'refreshToken required' });
        }

        const result = await refreshAccessToken(refreshToken);
        if (!result) {
            return res.status(401).json({ error: 'Invalid or expired refresh token' });
        }

        res.json({ token: result.token, refreshToken: result.refreshToken });
    } catch (error) {
        logError('API Error (POST /api/auth/refresh):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Change password
router.post('/change-password', requireAuth, async (req, res) => {
    try {
        const { newPassword } = req.body;
        if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters' });
        }

        if (req.user!.localAdminId) {
            await AdminService.resetLocalAdminPassword(req.user!.localAdminId, newPassword);
        } else {
            const hash = await hashPassword(newPassword);
            await setAdminPasswordHash(hash);
        }
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST /api/auth/change-password):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Current user info
router.get('/me', requireAuth, (req, res) => {
    const user = req.user!;
    res.json({
        role: user.role,
        gameRoomIds: user.gameRoomIds,
        discordId: user.discordId || null,
        localAdminId: user.localAdminId || null,
        username: user.username || 'Admin',
        avatar: user.avatar || null,
    });
});

export default router;
