import { Router, Request } from 'express';
import { hashPassword, verifyPassword, signToken, verifyToken, getAdminPasswordHash, setAdminPasswordHash, generateRefreshToken, createSession, refreshAccessToken } from '../auth.js';
import { requireAuth, requireDiscordUser } from '../middleware.js';
import { logInfo, logError } from '../../utils/logger.js';
import { GameRoomService } from '../../services/GameRoomService.js';
import { AdminService } from '../../services/AdminService.js';
import { getDatabase } from '../../database/database.js';
import { IdentityLinkService } from '../../services/IdentityLinkService.js';
import { LinkNonceStore } from '../../services/LinkNonceStore.js';
import { isGoogleUserId, isDiscordUserId } from '../../utils/identityProvider.js';
import { sanitizeProviderUsername } from '../../utils/contentBlocklist.js';
import { BanService } from '../../services/BanService.js';
import { DiscordReachabilityService } from '../../services/DiscordReachabilityService.js';
import { DmNudgeService } from '../../services/DmNudgeService.js';

const router = Router();

// Fix 1b (adversarial review, mirror-link-fixes.md) — CSRF hardening for both
// link-completion callbacks. A link nonce alone proves only that SOME browser
// started a link flow, not that the browser completing it is the SAME one —
// an attacker can mint a nonce for their OWN account and trick a victim into
// completing it via a crafted authorize URL (`state=link:<attacker's nonce>`),
// merging the victim's identity onto the attacker's account. The initiator is
// by definition still logged in (they just clicked "Link X account" in
// Account Settings and the FE holds their token throughout the OAuth
// round-trip), so the callback requires that same bearer token and asserts
// its decoded identity matches the nonce's bound initiator. Reuses the same
// `verifyToken` helper every other authenticated route uses — no new JWT code.
function extractBearerToken(req: Request): string | null {
    const authHeader = req.headers['authorization'];
    return authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
}

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
        // v2.36.0 — `linkNonce` is present only when the FE ran this OAuth
        // redirect from the Google-account-linking flow (state=link:<nonce>,
        // decoded client-side and posted explicitly; the server never trusts
        // `state` itself for anything security-relevant).
        const { code, redirectUri, linkNonce } = req.body;
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

        // Login-time canonical resolution (v2.36.0), kept uniform across both
        // OAuth callbacks + refreshAccessToken via IdentityLinkService. A bare
        // Discord snowflake is never a `provider_user_id` key in v1, so this
        // is always a no-op for a Discord login — canonicalUserId === user.id.
        const canonicalUserId = await IdentityLinkService.resolveCanonical(user.id);

        // S22 Phase 2 (v2.44.0) — ban enforcement at token issuance. Checked
        // right after canonical resolution, before ANY writes (linkNonce
        // consumption, user_profiles upsert) so a banned login leaves no
        // trace — no profile row, no consumed link nonce, no session.
        const discordBanCheck = await BanService.isIdentityBanned(user.id);
        if (discordBanCheck.banned) {
            return res.status(403).json({ error: 'This account is banned.' });
        }

        // v2.36.0 — Google-account-link completion. Exchanges + user-info
        // fetch above are unconditional (needed either way); this branch only
        // decides whether we ALSO consume a pending link nonce before minting
        // the token. Invalid/expired/replayed nonce -> 400, no link, no token
        // change — bail out before any session/profile mutation.
        let linked = false;
        if (linkNonce) {
            const initiatorUserId = LinkNonceStore.consume(linkNonce);
            if (!initiatorUserId) {
                return res.status(400).json({ error: 'Invalid or expired link request. Please try linking again from Account Settings.' });
            }

            // v2.46.0 (mirror-link contract) — direction assert. The
            // LinkNonceStore is now shared by both link directions; a nonce
            // minted by `/link/google/start` (initiator = a Discord
            // snowflake) must never be replayable into THIS callback, whose
            // whole point is linking a google id onto a Discord canonical.
            if (!isGoogleUserId(initiatorUserId)) {
                return res.status(400).json({ error: 'Invalid or expired link request. Please try linking again from Account Settings.' });
            }
            const googleUserId = initiatorUserId;

            // Fix 1b (adversarial review) — server-side initiator assert. The
            // nonce is already consumed above (deliberately — a failed assert
            // here still burns it, closing the replay window even when the
            // request turns out to be a forgery). The FE sends the
            // initiator's own player token as a Bearer header throughout this
            // OAuth round-trip; require it and check its decoded identity
            // against the nonce's bound initiator (the google id, in this
            // direction). Missing, invalid, or mismatched token -> 401.
            const initiatorToken = extractBearerToken(req);
            const initiatorPayload = initiatorToken ? verifyToken(initiatorToken) : null;
            if (!initiatorPayload || initiatorPayload.discordId !== googleUserId) {
                return res.status(401).json({ error: 'This link request didn\'t start in this browser session. Please retry from Account Settings.' });
            }

            // M2 fix (S22 Phase 2 adversarial review) — the discordBanCheck
            // above only covers the Discord snowflake being linked TO; the
            // google id being linked FROM was never checked, so a banned
            // google:X identity holding a still-valid access token could link
            // a clean snowflake and mint a brand-new token+refresh pair
            // through this flow, repeatably. Check BEFORE createLink so a
            // banned google id writes no user_identity_links row and mints no
            // token — same "leaves no trace" contract as discordBanCheck.
            const googleBanCheck = await BanService.isIdentityBanned(googleUserId);
            if (googleBanCheck.banned) {
                return res.status(403).json({ error: 'This account is banned.' });
            }

            try {
                await IdentityLinkService.createLink(googleUserId, canonicalUserId);
            } catch (err) {
                // v2.46.0 — LINK_CONFLICT (the google id is already linked to
                // a DIFFERENT canonical) is a client error, not a server
                // fault; map it to 409 instead of falling into the generic
                // 500 below.
                if ((err as Error & { code?: string })?.code === 'LINK_CONFLICT') {
                    return res.status(409).json({ error: 'That Google account is already linked to a different Arcaid account.' });
                }
                logError('Identity link createLink failed:', err);
                return res.status(500).json({ error: 'Failed to link accounts. Please try again.' });
            }
            linked = true;
            logInfo(`Linked google identity ${googleUserId} -> discord ${canonicalUserId} (${user.global_name || user.username})`);
        }

        const displayName = user.global_name || user.username;
        const avatarUrl = user.avatar
            ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
            : null;

        // Cache avatar hash in user_profiles. Upsert so a row exists for every
        // user who has logged in (display_name stays NULL until they pick one).
        // v2.40.0 (D1): also persist `username` = displayName on every login
        // (last-write-wins) — a nullable, non-unique fallback consulted when
        // display_name is unset, distinct from the user-chosen unique
        // display_name which this code path never touches.
        // m2 (S22 Phase 1) — a blocked provider display name is never
        // rejected at login, but is stored as NULL (not the raw slur) so
        // every public render of this fallback (join-request queue,
        // leaderboards, etc.) falls back to the raw id instead.
        const storedUsername = sanitizeProviderUsername(displayName);
        if (user.avatar) {
            const db = await getDatabase();
            await db.run(
                `INSERT INTO user_profiles (discord_user_id, avatar_hash, avatar_fetched_at, username)
                 VALUES (?, ?, datetime('now'), ?)
                 ON CONFLICT(discord_user_id) DO UPDATE SET
                    avatar_hash = excluded.avatar_hash,
                    avatar_fetched_at = excluded.avatar_fetched_at,
                    username = excluded.username,
                    updated_at = datetime('now')`,
                canonicalUserId, user.avatar, storedUsername
            );
            // v2.74.0 (S24.1): no `LeaderboardService.invalidateAll()` here any
            // more, and the `changed` pre-read it gated is gone with it.
            // Avatars are joined from `user_profiles` at read time, so a new
            // hash is live on the next render. The old call was also only half
            // a fix — it never touched `global_leaderboard_cache`, so avatar
            // changes were PERMANENTLY stale on the Global Scoreboard.
        } else {
            // Even without an avatar, ensure the user_profiles row exists so
            // display_name can be set later, and keep username fresh.
            const db = await getDatabase();
            await db.run(
                `INSERT INTO user_profiles (discord_user_id, username) VALUES (?, ?)
                 ON CONFLICT(discord_user_id) DO UPDATE SET
                    username = excluded.username,
                    updated_at = datetime('now')`,
                canonicalUserId, storedUsername
            );
        }

        // 1. Check super_admins table
        const isSuperAdmin = await AdminService.isSuperAdmin(canonicalUserId);
        if (isSuperAdmin) {
            const token = signToken({
                role: 'super_admin',
                gameRoomIds: [],
                discordId: canonicalUserId,
                username: displayName,
                avatar: avatarUrl || undefined,
                provider: 'discord',
            });
            const refreshToken = generateRefreshToken();
            await createSession(canonicalUserId, refreshToken, token);
            logInfo(`Discord OAuth login (super_admin): ${displayName} (${canonicalUserId})`);
            return res.json({ token, refreshToken, user: { discordId: canonicalUserId, username: displayName, avatar: avatarUrl }, ...(linked && { linked: true }) });
        }

        // 2. Check game_room_admins table
        const roomIds = await AdminService.getRoomsForDiscordUser(canonicalUserId);
        if (roomIds.length > 0) {
            const token = signToken({
                role: 'room_admin',
                gameRoomIds: roomIds,
                discordId: canonicalUserId,
                username: displayName,
                avatar: avatarUrl || undefined,
                provider: 'discord',
            });
            const refreshToken = generateRefreshToken();
            await createSession(canonicalUserId, refreshToken, token);
            logInfo(`Discord OAuth login (room_admin): ${displayName} (${canonicalUserId}) for rooms: ${roomIds.join(', ')}`);
            return res.json({ token, refreshToken, user: { discordId: canonicalUserId, username: displayName, avatar: avatarUrl }, ...(linked && { linked: true }) });
        }

        // 3. Not an admin — issue a player token (for public features like game picking)
        const token = signToken({
            role: 'player',
            gameRoomIds: [],
            discordId: canonicalUserId,
            username: displayName,
            avatar: avatarUrl || undefined,
            provider: 'discord',
        });
        const refreshToken = generateRefreshToken();
        await createSession(canonicalUserId, refreshToken, token);
        logInfo(`Discord OAuth login (player): ${displayName} (${canonicalUserId})`);
        return res.json({ token, refreshToken, user: { discordId: canonicalUserId, username: displayName, avatar: avatarUrl }, ...(linked && { linked: true }) });
    } catch (error) {
        logError('API Error (POST /api/auth/discord/callback):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// v2.36.0 — start a Google->Discord account link. Caller must already be
// logged in as a google:* identity (400 "nothing to link" otherwise — this
// also naturally blocks a re-link attempt, since a session that has already
// been linked gets a canonical/snowflake JWT at login time, not a google:*
// one). Returns a short-lived nonce the FE embeds in the Discord OAuth
// `state` param; see LinkNonceStore for the storage trade-off.
router.post('/link/discord/start', requireDiscordUser, async (req, res) => {
    try {
        const userId = req.user!.discordId;
        if (!userId || !isGoogleUserId(userId)) {
            return res.status(400).json({ error: 'Only a Google-signed-in account can start a Discord link. Nothing to link.' });
        }
        // M2 fix (S22 Phase 2 adversarial review) — a banned identity must not
        // be able to mint a link nonce at all (the callback-side check above
        // covers the nonce's google id being consumed, but this closes the
        // door earlier — a banned caller can't even start the flow).
        const banCheck = await BanService.isIdentityBanned(userId);
        if (banCheck.banned) {
            return res.status(403).json({ error: 'This account is banned.' });
        }
        const nonce = LinkNonceStore.create(userId);
        res.json({ nonce });
    } catch (error) {
        logError('API Error (POST /api/auth/link/discord/start):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// v2.46.0 (mirror-link contract) — start a Discord->Google account link.
// Mirror of /link/discord/start above: caller must already be logged in as a
// Discord identity (400 "nothing to link" for a google:* caller — the inverse
// check). Returns a short-lived nonce the FE embeds in the Google OAuth
// `state` param; consumed by the linkNonce branch of /google/callback below.
router.post('/link/google/start', requireDiscordUser, async (req, res) => {
    try {
        // Fix 7 (adversarial review) — assert the caller id is actually a
        // Discord snowflake, not merely "not google". Enforces the doctrine
        // ("canonical is always a snowflake") instead of leaving it
        // conventional; also the nonce is bound to `req.user!.discordId` from
        // the verified JWT, never anything the request body could supply.
        const userId = req.user!.discordId;
        if (!userId || !isDiscordUserId(userId)) {
            return res.status(400).json({ error: 'Only a Discord-signed-in account can start a Google link. Nothing to link.' });
        }
        // Same ban-check-before-mint pattern as /link/discord/start above.
        const banCheck = await BanService.isIdentityBanned(userId);
        if (banCheck.banned) {
            return res.status(403).json({ error: 'This account is banned.' });
        }
        const nonce = LinkNonceStore.create(userId);
        res.json({ nonce });
    } catch (error) {
        logError('API Error (POST /api/auth/link/google/start):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// v2.36.0 — list google identities linked to the caller's canonical (self-only).
router.get('/link/discord', requireDiscordUser, async (req, res) => {
    try {
        const userId = req.user!.discordId;
        if (!userId) return res.status(400).json({ error: 'No identity on this token' });
        const links = await IdentityLinkService.getLinkForCanonical(userId);
        res.json({ links });
    } catch (error) {
        logError('API Error (GET /api/auth/link/discord):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// v2.36.0 — unlink (row delete only, no un-merge; see IdentityLinkService).
// Self-only: the target link must belong to the caller's own canonical id.
router.delete('/link/discord/:providerUserId', requireDiscordUser, async (req, res) => {
    try {
        const userId = req.user!.discordId;
        const providerUserId = req.params.providerUserId as string;
        if (!userId) return res.status(400).json({ error: 'No identity on this token' });
        const links = await IdentityLinkService.getLinkForCanonical(userId);
        const owns = links.some(l => l.provider_user_id === providerUserId);
        if (!owns) {
            return res.status(404).json({ error: 'Link not found' });
        }
        await IdentityLinkService.deleteLink(providerUserId);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE /api/auth/link/discord/:providerUserId):', error);
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
        // v2.46.0 (mirror-link contract) — `linkNonce` is present only when
        // the FE ran this OAuth redirect from the Discord-account-linking
        // flow (state=link:<nonce>), mirroring discord/callback's linkNonce
        // handling for the Google->Discord direction.
        const { code, redirectUri, linkNonce } = req.body;
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

        // v2.36.0 login-time canonical resolution — if this google identity
        // has been linked to a Discord snowflake, everything below (profile
        // upsert, role lookup, token, session) operates on the canonical id
        // instead. The JWT's `provider` claim stays 'google' regardless (see
        // signToken calls below) — it reflects the ACTUAL login method used;
        // only the id canonicalizes. `let` (not `const`) because the linkNonce
        // branch below reassigns it to the just-linked Discord snowflake —
        // resolveCanonical can't see that link yet since createLink hasn't
        // run at this point in the request.
        let canonicalUserId = await IdentityLinkService.resolveCanonical(userId);

        // S22 Phase 2 (v2.44.0) — same ban-at-login enforcement as the
        // Discord callback above, checked on the raw `google:<sub>` id before
        // any writes.
        const googleBanCheck = await BanService.isIdentityBanned(userId);
        if (googleBanCheck.banned) {
            return res.status(403).json({ error: 'This account is banned.' });
        }

        // v2.46.0 (mirror-link contract) — Discord-account-link completion.
        // Mirrors the discord/callback linkNonce branch: this only fires when
        // the FE ran this OAuth redirect from AccountSettings' "Link Google
        // account" flow (state=link:<nonce>). Placed here — after the
        // googleBanCheck above, before any writes — so both sides of the link
        // are ban-checked before anything is persisted, same ordering as the
        // M2 fix on the discord/callback side.
        let linked = false;
        if (linkNonce) {
            const initiatorUserId = LinkNonceStore.consume(linkNonce);
            if (!initiatorUserId) {
                return res.status(400).json({ error: 'Invalid or expired link request. Please try linking again from Account Settings.' });
            }

            // Direction assert (symmetric to the discord/callback side) — a
            // nonce minted by `/link/discord/start` (initiator = a google:*
            // id) must never be replayable into THIS callback, whose whole
            // point is linking a Discord snowflake onto a google canonical.
            if (isGoogleUserId(initiatorUserId)) {
                return res.status(400).json({ error: 'Invalid or expired link request. Please try linking again from Account Settings.' });
            }
            const discordUserIdBeingLinked = initiatorUserId;

            // Fix 1b (adversarial review) — server-side initiator assert,
            // symmetric to the discord/callback side. The nonce is already
            // consumed above; require the initiator's own bearer token
            // (their existing Discord player session, still held by the FE
            // throughout the Google OAuth round-trip) and check its decoded
            // identity against the nonce's bound initiator.
            const initiatorToken = extractBearerToken(req);
            const initiatorPayload = initiatorToken ? verifyToken(initiatorToken) : null;
            if (!initiatorPayload || initiatorPayload.discordId !== discordUserIdBeingLinked) {
                return res.status(401).json({ error: 'This link request didn\'t start in this browser session. Please retry from Account Settings.' });
            }

            // Ban-check the OTHER side (the Discord snowflake) before any
            // writes — the googleBanCheck above only covers the identity
            // logging in right now.
            const discordBanCheck = await BanService.isIdentityBanned(discordUserIdBeingLinked);
            if (discordBanCheck.banned) {
                return res.status(403).json({ error: 'This account is banned.' });
            }

            try {
                await IdentityLinkService.createLink(userId, discordUserIdBeingLinked);
            } catch (err) {
                if ((err as Error & { code?: string })?.code === 'LINK_CONFLICT') {
                    return res.status(409).json({ error: 'That Google account is already linked to a different Arcaid account.' });
                }
                logError('Identity link createLink failed:', err);
                return res.status(500).json({ error: 'Failed to link accounts. Please try again.' });
            }
            canonicalUserId = discordUserIdBeingLinked;
            linked = true;
            logInfo(`Linked google identity ${userId} -> discord ${discordUserIdBeingLinked} (${displayName})`);
        }

        // Upsert user_profiles with avatar_url (mirrors the Discord upsert
        // above, but writes the new avatar_url column instead of
        // avatar_hash — Google avatars are already full URLs, not CDN
        // template hashes). display_name is NEVER touched here — it stays
        // user-chosen (set via AccountSettings), same doctrine as Discord.
        // v2.40.0 (D1): username = displayName persists on every login here
        // too, same fallback doctrine as the Discord branch above.
        // m2 (S22 Phase 1) — same NULL-not-reject treatment as the Discord
        // branch: a blocked provider name never blocks login, only the
        // stored public fallback.
        //
        // Fix 6 (adversarial review) — SKIP this block entirely on the link
        // path (`linked === true`). On a plain google login, canonicalUserId
        // IS userId (the google identity's own row), so this upsert writes
        // an identity's own data onto its own profile — correct. On the link
        // path, canonicalUserId has been reassigned above to the SNOWFLAKE
        // (a different identity's row): unconditionally upserting
        // avatar_url/username here would overwrite the Discord profile
        // `IdentityLinkService.createLink` just COALESCE-merged (fill-NULLs-
        // only, snowflake wins) with Google's values, clobbering the
        // snowflake's existing avatar/username. The discord/callback link
        // path doesn't have this problem — canonicalUserId there is already
        // the caller's own snowflake, never reassigned — so this guard is
        // the google-side-specific fix that keeps both callbacks' post-link
        // behavior equivalent ("snowflake's own data wins").
        const storedUsername = sanitizeProviderUsername(displayName);
        if (!linked) {
            if (pictureUrl) {
                const db = await getDatabase();
                await db.run(
                    `INSERT INTO user_profiles (discord_user_id, avatar_url, avatar_fetched_at, username)
                     VALUES (?, ?, datetime('now'), ?)
                     ON CONFLICT(discord_user_id) DO UPDATE SET
                        avatar_url = excluded.avatar_url,
                        avatar_fetched_at = excluded.avatar_fetched_at,
                        username = excluded.username,
                        updated_at = datetime('now')`,
                    canonicalUserId, pictureUrl, storedUsername
                );
                // v2.74.0 (S24.1) — see the Discord branch above: avatars
                // resolve at read time now, so no invalidation is needed.
            } else {
                const db = await getDatabase();
                await db.run(
                    `INSERT INTO user_profiles (discord_user_id, username) VALUES (?, ?)
                     ON CONFLICT(discord_user_id) DO UPDATE SET
                        username = excluded.username,
                        updated_at = datetime('now')`,
                    canonicalUserId, storedUsername
                );
            }
        }

        // Same role branch as Discord — role derivation is table-based and
        // provider-agnostic (a Google user pasted into super_admins /
        // game_room_admins by ID is a legitimate admin).
        const isSuperAdmin = await AdminService.isSuperAdmin(canonicalUserId);
        if (isSuperAdmin) {
            const token = signToken({
                role: 'super_admin',
                gameRoomIds: [],
                discordId: canonicalUserId,
                username: displayName,
                avatar: pictureUrl || undefined,
                provider: 'google',
            });
            const refreshToken = generateRefreshToken();
            await createSession(canonicalUserId, refreshToken, token);
            logInfo(`Google OAuth login (super_admin): ${displayName} (${userId}${canonicalUserId !== userId ? ` -> canonical ${canonicalUserId}` : ''})`);
            return res.json({ token, refreshToken, user: { discordId: canonicalUserId, username: displayName, avatar: pictureUrl }, ...(linked && { linked: true }) });
        }

        const roomIds = await AdminService.getRoomsForDiscordUser(canonicalUserId);
        if (roomIds.length > 0) {
            const token = signToken({
                role: 'room_admin',
                gameRoomIds: roomIds,
                discordId: canonicalUserId,
                username: displayName,
                avatar: pictureUrl || undefined,
                provider: 'google',
            });
            const refreshToken = generateRefreshToken();
            await createSession(canonicalUserId, refreshToken, token);
            logInfo(`Google OAuth login (room_admin): ${displayName} (${userId}${canonicalUserId !== userId ? ` -> canonical ${canonicalUserId}` : ''}) for rooms: ${roomIds.join(', ')}`);
            return res.json({ token, refreshToken, user: { discordId: canonicalUserId, username: displayName, avatar: pictureUrl }, ...(linked && { linked: true }) });
        }

        const token = signToken({
            role: 'player',
            gameRoomIds: [],
            discordId: canonicalUserId,
            username: displayName,
            avatar: pictureUrl || undefined,
            provider: 'google',
        });
        const refreshToken = generateRefreshToken();
        await createSession(canonicalUserId, refreshToken, token);
        logInfo(`Google OAuth login (player): ${displayName} (${userId}${canonicalUserId !== userId ? ` -> canonical ${canonicalUserId}` : ''})`);
        return res.json({ token, refreshToken, user: { discordId: canonicalUserId, username: displayName, avatar: pictureUrl }, ...(linked && { linked: true }) });
    } catch (error) {
        logError('API Error (POST /api/auth/google/callback):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ---------------------------------------------------------------------------
// Discord "connect notifications" flow (Discord HQ arc, v2.72.0, Section 3)
//
// A SEPARATE OAuth flow from login, and it must stay separate. The login
// authorize is `identify`-only — hard-learned, adding scopes there broke it
// (see CLAUDE.md, "Discord OAuth state encoding"). This flow asks for
// `identify guilds.join`, which lets the bot add a consenting user to the
// Arcaid HQ guild server-side, giving them a shared guild with the bot and
// therefore a working DM channel. Nothing about the login scopes changes.
//
// State encoding extends the existing conventions in this file: login uses
// `__super__` / `player:<slug>` / bare slug, account linking uses
// `link:<nonce>`; this uses `connect:<nonce>`. As with `link:`, the server
// never trusts `state` itself — the FE decodes it client-side and posts the
// nonce back explicitly, and the callback additionally requires the caller's
// bearer token and asserts three identities agree (nonce initiator, token
// subject, and the Discord account that just authorized).
// ---------------------------------------------------------------------------

/** Prefix for this flow's OAuth `state`, alongside `link:` above. */
export const CONNECT_STATE_PREFIX = 'connect:';

const CONNECT_SCOPES = 'identify guilds.join';

/**
 * Start the flow: mint a nonce and hand back the authorize URL.
 *
 * 400s (rather than half-working) when there is no HQ guild configured or no
 * OAuth app — the FE hides the button in those cases, so reaching here means
 * something is out of sync and a silent no-op would be worse than an error.
 */
router.get('/discord/connect-notifications', requireDiscordUser, async (req, res) => {
    try {
        const userId = req.user!.discordId;
        // A `google:*` identity has no Discord account to add to a guild.
        // Joining HQ would not give THEM a DM channel, because the notification
        // path has no snowflake to DM in the first place.
        if (!userId || !isDiscordUserId(userId)) {
            return res.status(400).json({ error: 'Only a Discord-signed-in account can connect Discord notifications.' });
        }

        const clientId = process.env.DISCORD_CLIENT_ID;
        if (!clientId || !process.env.DISCORD_CLIENT_SECRET) {
            return res.status(400).json({ error: 'Discord OAuth is not configured on this server.' });
        }

        const guildId = await DiscordReachabilityService.getGlobalGuildId();
        if (!guildId) {
            return res.status(400).json({ error: 'The Arcaid community server is not configured on this server.' });
        }

        const redirectUri = typeof req.query.redirectUri === 'string' ? req.query.redirectUri : '';
        if (!redirectUri) {
            return res.status(400).json({ error: 'redirectUri required' });
        }
        // Open-redirect hygiene. Discord independently rejects any redirect_uri
        // that isn't registered on the app, so this is defence in depth rather
        // than the only guard — but it keeps a crafted link from bouncing a
        // user through our own endpoint toward someone else's origin. Skipped
        // when PUBLIC_URL is unset (dev/test), where there's no origin to
        // compare against.
        const publicUrl = process.env.PUBLIC_URL;
        if (publicUrl) {
            try {
                if (new URL(redirectUri).origin !== new URL(publicUrl).origin) {
                    return res.status(400).json({ error: 'redirectUri must be on this site.' });
                }
            } catch {
                return res.status(400).json({ error: 'redirectUri is not a valid URL.' });
            }
        }

        const nonce = LinkNonceStore.create(userId);
        const authorizeUrl = 'https://discord.com/api/oauth2/authorize?' + new URLSearchParams({
            client_id: clientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: CONNECT_SCOPES,
            state: `${CONNECT_STATE_PREFIX}${nonce}`,
        }).toString();

        res.json({ authorizeUrl, nonce });
    } catch (error) {
        logError('API Error (GET /api/auth/discord/connect-notifications):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * Complete the flow: exchange the code, verify identity three ways, then add
 * the user to the HQ guild.
 *
 * `PUT /guilds/{guild}/members/{user}` is authorized with the BOT token and
 * carries the user's OAuth access token in the body — that is what makes it a
 * consented server-side join rather than an invite. Discord answers 201 when
 * it adds the member and 204 when they were already in the guild; both are
 * success here, which makes the endpoint safely idempotent (a double-click, a
 * refreshed callback page, or a user who joined manually first all land well).
 */
router.post('/discord/connect-notifications/callback', requireDiscordUser, async (req, res) => {
    try {
        const { code, redirectUri, nonce } = req.body ?? {};
        if (!code || !redirectUri || !nonce) {
            return res.status(400).json({ error: 'code, redirectUri and nonce required' });
        }

        const userId = req.user!.discordId;
        if (!userId || !isDiscordUserId(userId)) {
            return res.status(400).json({ error: 'Only a Discord-signed-in account can connect Discord notifications.' });
        }

        // 1. Nonce — proves the browser completing this flow is the one that
        // started it. Consumed (single-use) before anything else happens.
        const initiator = LinkNonceStore.consume(String(nonce));
        if (!initiator) {
            return res.status(400).json({ error: 'This request expired. Please try connecting again.' });
        }
        // 2. Identity match #1 — the nonce's initiator vs. the bearer token.
        if (initiator !== userId) {
            logError('Connect-notifications identity mismatch: nonce initiator does not match caller', new Error(`nonce=${initiator} caller=${userId}`));
            return res.status(403).json({ error: 'This request was started by a different account.' });
        }

        const clientId = process.env.DISCORD_CLIENT_ID;
        const clientSecret = process.env.DISCORD_CLIENT_SECRET;
        const botToken = process.env.DISCORD_BOT_TOKEN;
        if (!clientId || !clientSecret) {
            return res.status(400).json({ error: 'Discord OAuth is not configured on this server.' });
        }
        if (!botToken) {
            return res.status(400).json({ error: 'The Discord bot is not configured on this server.' });
        }

        const guildId = await DiscordReachabilityService.getGlobalGuildId();
        if (!guildId) {
            return res.status(400).json({ error: 'The Arcaid community server is not configured on this server.' });
        }

        // 3. Exchange the code.
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
            logError('Connect-notifications token exchange failed:', err);
            return res.status(401).json({ error: 'Discord rejected the authorization. Please try again.' });
        }
        const tokenData = await tokenRes.json() as { access_token: string; scope?: string };

        // 4. Consent check. A user can untick `guilds.join` on Discord's consent
        // screen and still complete the flow; without that scope the PUT below
        // would fail with an opaque 403, so say plainly what happened instead.
        if (!(tokenData.scope ?? '').split(/\s+/).includes('guilds.join')) {
            return res.status(400).json({
                error: 'Arcaid needs permission to add you to the community server. Please try again and leave that permission enabled.',
                code: 'CONSENT_DECLINED',
            });
        }

        // 5. Identity match #2 — the Discord account that just authorized vs.
        // the caller. Without this, a user could authorize as someone else's
        // account and have THAT account joined under their session.
        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        if (!userRes.ok) {
            return res.status(401).json({ error: 'Failed to fetch Discord user info' });
        }
        const discordUser = await userRes.json() as { id: string };
        if (discordUser.id !== userId) {
            return res.status(403).json({
                error: 'That Discord account is not the one you are signed in with.',
                code: 'IDENTITY_MISMATCH',
            });
        }

        // 6. The join itself.
        const joinRes = await fetch(
            `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}`,
            {
                method: 'PUT',
                headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ access_token: tokenData.access_token }),
            },
        );

        if (joinRes.status !== 201 && joinRes.status !== 204) {
            // Surface Discord's own words (guild full, user banned, bot lacks
            // CREATE_INSTANT_INVITE) rather than a generic failure — the owner
            // needs the real reason, and the invite-link fallback stays visible
            // on the page either way.
            const detail = await joinRes.text().catch(() => '');
            logError(`Connect-notifications guild join failed (${joinRes.status}):`, detail);
            let message = 'Discord could not add you to the community server.';
            try {
                const parsed = JSON.parse(detail) as { message?: string };
                if (parsed?.message) message = `Discord said: ${parsed.message}`;
            } catch { /* non-JSON body — keep the generic message */ }
            return res.status(502).json({ error: message, code: 'JOIN_FAILED' });
        }

        // Flip the cached verdict immediately so the status line says ✅ on the
        // very next read instead of waiting out the negative TTL.
        DiscordReachabilityService.invalidate(userId);
        // Joining fixes the most common cause of the "we couldn't DM you"
        // banner, so retire it now rather than waiting for the next send.
        await DmNudgeService.clear(userId).catch(() => {});

        const alreadyMember = joinRes.status === 204;
        logInfo(`Connect-notifications: ${userId} ${alreadyMember ? 'already in' : 'joined'} guild ${guildId}`);
        res.json({ ok: true, alreadyMember });
    } catch (error) {
        logError('API Error (POST /api/auth/discord/connect-notifications/callback):', error);
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
        // S22 Phase 2 (v2.44.0) — banned-identity refresh. Distinct code (still
        // a 401, so api.ts's existing refresh-failure handling redirects to
        // login without any FE change needed) rather than the generic 500 path.
        const e = error as Error & { code?: string };
        if (e.code === 'ACCOUNT_BANNED') {
            return res.status(401).json({ error: 'This account is banned.', code: 'ACCOUNT_BANNED' });
        }
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
