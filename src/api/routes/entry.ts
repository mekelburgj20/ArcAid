import { Router, type Request } from 'express';
import { getDatabase } from '../../database/database.js';
import { logError } from '../../utils/logger.js';
import { requireAuth, requireRoomAccess, requireDiscordUser } from '../middleware.js';
import { TournamentEntryService, TournamentEntryError } from '../../services/TournamentEntryService.js';

/**
 * Tournament entry — `Entry: Room members` / `Invited players` (v2.179.0, W39,
 * ADR 0033 §6). Mounted at `/api` beside the integrity router.
 *
 * Host (room admin): the roster, add by name, remove, the invite link (and
 * resetting it), the request queue. Player: where they stand, asking to join,
 * and accepting an invite link. The entry setting itself is saved through the
 * ordinary tournament PUT (`entry_mode`, `entry_methods`).
 *
 * Admin writes are audited explicitly — the audit middleware is not mounted
 * on this router.
 */
const router = Router();

async function tournamentInRoom(roomId: string, tournamentId: string): Promise<boolean> {
    const db = await getDatabase();
    const row = await db.get('SELECT id FROM tournaments WHERE id = ? AND game_room_id = ?', tournamentId, roomId);
    return !!row;
}

function actorOf(req: Request): string {
    return String(req.user?.discordId || req.user?.username || req.user?.localAdminId || 'admin');
}

async function audit(req: Request, action: string, tournamentId: string, details: Record<string, unknown>): Promise<void> {
    const { AuditService } = await import('../../services/AuditService.js');
    await AuditService.log({
        actor: actorOf(req),
        action,
        target_type: 'tournament',
        target_id: tournamentId,
        details: JSON.stringify(details),
        ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
        correlation_id: req.correlationId || '',
    }).catch(() => { /* the change stands; an audit failure is logged by the service */ });
}

function sendEntryError(res: import('express').Response, error: unknown, label: string) {
    if (error instanceof TournamentEntryError) {
        return res.status(error.httpStatus).json({ error: error.message, code: error.code });
    }
    logError(`API Error (${label}):`, error);
    return res.status(500).json({ error: 'Internal Server Error' });
}

// --- host --------------------------------------------------------------------

// The host's whole entry picture for one tournament.
router.get('/rooms/:roomId/admin/tournaments/:id/roster', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const tournamentId = req.params.id as string;
        if (!await tournamentInRoom(roomId, tournamentId)) return res.status(404).json({ error: 'Tournament not found' });
        const config = await TournamentEntryService.getConfig(tournamentId);
        const [roster, requests] = await Promise.all([
            TournamentEntryService.listRoster(tournamentId),
            TournamentEntryService.listPendingRequests(tournamentId),
        ]);
        res.json({
            mode: config!.mode,
            methods: config!.methods,
            inviteCode: config!.mode === 'invited' && config!.methods.link ? config!.inviteCode : null,
            roster,
            requests,
        });
    } catch (error) {
        sendEntryError(res, error, 'GET rooms/:roomId/admin/tournaments/:id/roster');
    }
});

// Host: add a player by name (`@name`) or id.
router.post('/rooms/:roomId/admin/tournaments/:id/roster', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const tournamentId = req.params.id as string;
        if (!await tournamentInRoom(roomId, tournamentId)) return res.status(404).json({ error: 'Tournament not found' });
        const ref = await TournamentEntryService.resolvePlayerRef(roomId, typeof req.body?.userId === 'string' ? req.body.userId : '');
        if (!ref.ok) return res.status(ref.httpStatus).json({ error: ref.error });
        const userId = await TournamentEntryService.addToRoster(tournamentId, ref.userId, 'host', actorOf(req));
        await audit(req, 'roster.add', tournamentId, { roomId, userId });
        res.status(201).json({ success: true, userId });
    } catch (error) {
        sendEntryError(res, error, 'POST rooms/:roomId/admin/tournaments/:id/roster');
    }
});

router.delete('/rooms/:roomId/admin/tournaments/:id/roster/:userId', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const tournamentId = req.params.id as string;
        if (!await tournamentInRoom(roomId, tournamentId)) return res.status(404).json({ error: 'Tournament not found' });
        const userId = req.params.userId as string;
        const removed = await TournamentEntryService.removeFromRoster(tournamentId, userId);
        if (removed) await audit(req, 'roster.remove', tournamentId, { roomId, userId });
        res.json({ success: true, removed });
    } catch (error) {
        sendEntryError(res, error, 'DELETE rooms/:roomId/admin/tournaments/:id/roster/:userId');
    }
});

// Host: a fresh invite code — the old link stops working at once.
router.post('/rooms/:roomId/admin/tournaments/:id/invite-code/reset', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const tournamentId = req.params.id as string;
        if (!await tournamentInRoom(roomId, tournamentId)) return res.status(404).json({ error: 'Tournament not found' });
        const inviteCode = await TournamentEntryService.resetInviteCode(tournamentId);
        await audit(req, 'roster.invite_reset', tournamentId, { roomId });
        res.json({ inviteCode });
    } catch (error) {
        sendEntryError(res, error, 'POST rooms/:roomId/admin/tournaments/:id/invite-code/reset');
    }
});

// Host: approve or deny one pending request.
router.post('/rooms/:roomId/admin/tournaments/:id/entry-requests/:requestId/:action', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const tournamentId = req.params.id as string;
        const action = req.params.action as string;
        if (action !== 'approve' && action !== 'deny') return res.status(404).json({ error: 'Unknown action' });
        const requestId = Number(req.params.requestId as string);
        if (!Number.isInteger(requestId) || requestId <= 0) return res.status(400).json({ error: 'Invalid request id' });
        if (!await tournamentInRoom(roomId, tournamentId)) return res.status(404).json({ error: 'Tournament not found' });
        const done = await TournamentEntryService.resolveRequest(tournamentId, requestId, action === 'approve', actorOf(req));
        if (!done) return res.status(404).json({ error: 'No pending request with that id' });
        await audit(req, `roster.request_${action}`, tournamentId, { roomId, requestId });
        res.json({ success: true });
    } catch (error) {
        sendEntryError(res, error, 'POST rooms/:roomId/admin/tournaments/:id/entry-requests/:requestId/:action');
    }
});

// --- player ------------------------------------------------------------------

// Where I stand: `{ mode, onRoster, request, canRequest }`.
router.get('/rooms/:roomId/tournaments/:id/entry/me', requireDiscordUser, async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const tournamentId = req.params.id as string;
        if (!await tournamentInRoom(roomId, tournamentId)) return res.status(404).json({ error: 'Tournament not found' });
        const mine = await TournamentEntryService.myEntry(tournamentId, req.user!.discordId as string);
        res.json(mine);
    } catch (error) {
        sendEntryError(res, error, 'GET rooms/:roomId/tournaments/:id/entry/me');
    }
});

// Ask to be let in (only when the host takes requests).
router.post('/rooms/:roomId/tournaments/:id/entry/request', requireDiscordUser, async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const tournamentId = req.params.id as string;
        if (!await tournamentInRoom(roomId, tournamentId)) return res.status(404).json({ error: 'Tournament not found' });
        const { BanService } = await import('../../services/BanService.js');
        if ((await BanService.isIdentityBanned(req.user!.discordId as string, roomId)).banned) {
            return res.status(403).json({ error: 'You cannot join this tournament', code: 'BANNED' });
        }
        const status = await TournamentEntryService.requestEntry(tournamentId, req.user!.discordId as string);
        res.json({ status });
    } catch (error) {
        sendEntryError(res, error, 'POST rooms/:roomId/tournaments/:id/entry/request');
    }
});

// Public: what an invite link points at (names only), for its landing page.
router.get('/tournament-invites/:code', async (req, res) => {
    try {
        const invite = await TournamentEntryService.findInvite(req.params.code as string);
        if (!invite) return res.status(404).json({ error: 'This invite link is not valid any more' });
        res.json(invite);
    } catch (error) {
        sendEntryError(res, error, 'GET tournament-invites/:code');
    }
});

// Accept an invite: join the room (or file a request in an approval-only room)
// and go on the tournament's roster.
router.post('/tournament-invites/:code/accept', requireDiscordUser, async (req, res) => {
    try {
        const invite = await TournamentEntryService.findInvite(req.params.code as string);
        if (!invite) return res.status(404).json({ error: 'This invite link is not valid any more' });
        const { BanService } = await import('../../services/BanService.js');
        if ((await BanService.isIdentityBanned(req.user!.discordId as string, invite.roomId)).banned) {
            return res.status(403).json({ error: 'You cannot join this tournament', code: 'BANNED' });
        }
        const result = await TournamentEntryService.acceptInvite(req.params.code as string, req.user!.discordId as string);
        res.json(result);
    } catch (error) {
        sendEntryError(res, error, 'POST tournament-invites/:code/accept');
    }
});

export default router;
