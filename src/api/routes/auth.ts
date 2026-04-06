import { Router } from 'express';
import { hashPassword, verifyPassword, signToken, getAdminPasswordHash, setAdminPasswordHash } from '../auth.js';
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

        // Store avatar hash in user_mappings if the user has a mapping
        if (user.avatar) {
            const db = await getDatabase();
            const existing = await db.get(
                'SELECT avatar_hash FROM user_mappings WHERE discord_user_id = ?', user.id
            );
            if (existing && existing.avatar_hash !== user.avatar) {
                await db.run(
                    'UPDATE user_mappings SET avatar_hash = ? WHERE discord_user_id = ?',
                    user.avatar, user.id
                );
                // Avatar changed — invalidate leaderboard cache so cards pick up new avatar
                await LeaderboardService.invalidateAll();
            } else if (existing && !existing.avatar_hash) {
                await db.run(
                    'UPDATE user_mappings SET avatar_hash = ? WHERE discord_user_id = ?',
                    user.avatar, user.id
                );
                await LeaderboardService.invalidateAll();
            }
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
            });
            logInfo(`Discord OAuth login (super_admin): ${displayName} (${user.id})`);
            return res.json({ token, user: { discordId: user.id, username: displayName, avatar: avatarUrl } });
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
            });
            logInfo(`Discord OAuth login (room_admin): ${displayName} (${user.id}) for rooms: ${roomIds.join(', ')}`);
            return res.json({ token, user: { discordId: user.id, username: displayName, avatar: avatarUrl } });
        }

        // 3. Not an admin — issue a player token (for public features like game picking)
        const token = signToken({
            role: 'player',
            gameRoomIds: [],
            discordId: user.id,
            username: displayName,
            avatar: avatarUrl || undefined,
        });
        logInfo(`Discord OAuth login (player): ${displayName} (${user.id})`);
        return res.json({ token, user: { discordId: user.id, username: displayName, avatar: avatarUrl } });
    } catch (error) {
        logError('API Error (POST /api/auth/discord/callback):', error);
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
