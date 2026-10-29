import { Router } from 'express';
import { getDatabase } from '../../database/database.js';
import { logError } from '../../utils/logger.js';
import { requireAuth, requireRoomAccess, requireDiscordUser } from '../middleware.js';
import { validate } from '../validate.js';
import { GameRequirementsSchema } from '../schemas.js';
import { WitnessEvidenceService } from '../../services/WitnessEvidenceService.js';

/**
 * Integrity mode — Open play / Sanctioned play (v2.165.0, ADR 0027).
 *
 * The runner's side of the Castcade evidence: what a tournament requires, what
 * each witness score measured, and what the rules said. Mounted at `/api`
 * beside `globalRouter`; the tournament's mode and rules themselves are saved
 * through the ordinary tournament PUT (`integrity_mode`, `sanctioned_rules`).
 *
 * Nothing here filters or re-ranks a board. The public `integrity` read ships
 * a verdict MAP so a board can draw a badge next to a score; it is the same
 * data the runner sees, minus the measurements.
 */
const router = Router();

async function tournamentInRoom(roomId: string, tournamentId: string): Promise<boolean> {
    const db = await getDatabase();
    const row = await db.get<{ id: string }>(
        'SELECT id FROM tournaments WHERE id = ? AND game_room_id = ?', tournamentId, roomId,
    );
    return !!row;
}

// Public: a tournament's mode, its (normalised) Sanctioned rules, each game's
// required table, and `score_history.id` → verdict for its witness scores.
router.get('/rooms/:roomId/tournaments/:id/integrity', async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const tournamentId = req.params.id as string;
        if (!await tournamentInRoom(roomId, tournamentId)) return res.status(404).json({ error: 'Tournament not found' });
        const integrity = await WitnessEvidenceService.getIntegrity(tournamentId);
        if (!integrity) return res.status(404).json({ error: 'Tournament not found' });
        const verdicts = await WitnessEvidenceService.verdictMap(tournamentId);
        const quits = await WitnessEvidenceService.quitMap(tournamentId);
        res.json({ ...integrity, verdicts, quits });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/tournaments/:id/integrity):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Player: W38 (ADR 0033 §4) — when I pressed "Start attempts" on each of this
// tournament's tables: `{ starts: { [gameId]: epochSeconds } }` (absent = not
// pressed). Keyed on the viewer's canonical identity, like the attempts.
router.get('/rooms/:roomId/tournaments/:id/attempt-starts/me', requireDiscordUser, async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const tournamentId = req.params.id as string;
        if (!await tournamentInRoom(roomId, tournamentId)) return res.status(404).json({ error: 'Tournament not found' });
        const db = await getDatabase();
        const games = await db.all<Array<{ id: string }>>('SELECT id FROM games WHERE tournament_id = ?', tournamentId);
        const { IdentityLinkService } = await import('../../services/IdentityLinkService.js');
        const { AttemptService } = await import('../../services/AttemptService.js');
        const canonical = await IdentityLinkService.resolveCanonical(req.user!.discordId as string);
        const starts = await AttemptService.startsFor(canonical, games.map(g => g.id));
        res.json({ starts });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/tournaments/:id/attempt-starts/me):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Player: W56 — the room's top-level "Start attempts" list: every open game in
// this room whose tournament limits attempts AND requires the press, that the
// viewer is allowed in, with whether they pressed it. One read for the whole
// room scoreboard and the "Your scores go to" strip.
// `{ games: [{ gameId, gameName, tournamentId, tournamentName, roundNo, started, startedTs }] }`
router.get('/rooms/:roomId/attempt-starts/me', requireDiscordUser, async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const db = await getDatabase();
        const room = await db.get<{ id: string }>('SELECT id FROM game_rooms WHERE id = ?', roomId);
        if (!room) return res.status(404).json({ error: 'Room not found' });
        const { AttemptService } = await import('../../services/AttemptService.js');
        const games = await AttemptService.roomStartsFor({ roomId, userId: req.user!.discordId as string });
        res.json({ games });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/attempt-starts/me):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Player: W38 — press "Start attempts" on one table. From now on the player's
// plays on it count (and use attempts); before it they went to Global. A second
// press keeps the first time.
router.post('/rooms/:roomId/tournaments/:id/games/:gameId/attempt-start', requireDiscordUser, async (req, res) => {
    try {
        const { AttemptService } = await import('../../services/AttemptService.js');
        const result = await AttemptService.startForPlayer({
            roomId: req.params.roomId as string,
            tournamentId: req.params.id as string,
            gameId: req.params.gameId as string,
            userId: req.user!.discordId as string,
        });
        if (!result.ok) return res.status(result.httpStatus).json({ error: result.message, code: result.code });
        res.json({ startedTs: result.startedTs });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/tournaments/:id/games/:gameId/attempt-start):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Runner: the full evidence trail for one tournament (newest first), per score
// the measurements and the pass/fail per rule. `?gameId=` narrows to one game.
router.get('/rooms/:roomId/tournaments/:id/evidence', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const tournamentId = req.params.id as string;
        if (!await tournamentInRoom(roomId, tournamentId)) return res.status(404).json({ error: 'Tournament not found' });
        const gameId = typeof req.query.gameId === 'string' && req.query.gameId ? req.query.gameId : null;
        const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
        const rows = await WitnessEvidenceService.listForTournament(tournamentId, {
            gameId, limit: Number.isFinite(limit) ? limit : undefined,
        });
        res.json({ evidence: rows });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/tournaments/:id/evidence):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Runner: name the table (and optionally the ROM / blessed fingerprint) one
// tournament game requires in Sanctioned play. `null` clears a field; an
// omitted field is left alone.
router.patch('/rooms/:roomId/tournaments/:id/games/:gameId/requirements', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const tournamentId = req.params.id as string;
        const gameId = req.params.gameId as string;
        if (!await tournamentInRoom(roomId, tournamentId)) return res.status(404).json({ error: 'Tournament not found' });
        const validation = validate(GameRequirementsSchema, req.body ?? {});
        if ('error' in validation) return res.status(400).json({ error: validation.error });
        const body = validation.data;
        const patch: { requiredVpsTableId?: string | null; requiredRom?: string | null; requiredFingerprint?: string | null } = {};
        if ('required_vps_table_id' in body) patch.requiredVpsTableId = body.required_vps_table_id ?? null;
        if ('required_rom' in body) patch.requiredRom = body.required_rom ?? null;
        if ('required_fingerprint' in body) patch.requiredFingerprint = body.required_fingerprint ?? null;
        const ok = await WitnessEvidenceService.setGameRequirements(tournamentId, gameId, patch);
        if (!ok) return res.status(404).json({ error: 'Game not found in this tournament' });
        const integrity = await WitnessEvidenceService.getIntegrity(tournamentId);
        res.json({ success: true, game: integrity?.games.find(g => g.gameId === gameId) ?? null });
    } catch (error) {
        logError('API Error (PATCH rooms/:roomId/tournaments/:id/games/:gameId/requirements):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Runner: Limited attempts (v2.167.0, ADR 0029) — every recorded game start of
// one tournament, newest first, names resolved (never a raw id). `?gameId=`
// narrows to one game.
router.get('/rooms/:roomId/admin/tournaments/:id/attempts', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const tournamentId = req.params.id as string;
        if (!await tournamentInRoom(roomId, tournamentId)) return res.status(404).json({ error: 'Tournament not found' });
        const gameId = typeof req.query.gameId === 'string' && req.query.gameId ? req.query.gameId : null;
        const { AttemptService } = await import('../../services/AttemptService.js');
        const [attempts, maxAttempts] = await Promise.all([
            AttemptService.listForAdmin(tournamentId, gameId),
            AttemptService.limitFor(tournamentId),
        ]);
        res.json({ maxAttempts, attempts });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/admin/tournaments/:id/attempts):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Runner: give an attempt back (a crashed companion, an honest mistake). Only a
// counted / over_limit / unreported row; a scored row is a 409 — voiding never
// removes a score. Audited explicitly (the audit middleware is not mounted).
router.post('/rooms/:roomId/admin/tournaments/:id/attempts/:attemptId/void', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const tournamentId = req.params.id as string;
        const attemptId = Number(req.params.attemptId as string);
        if (!Number.isInteger(attemptId) || attemptId <= 0) return res.status(400).json({ error: 'Invalid attempt id' });
        if (!await tournamentInRoom(roomId, tournamentId)) return res.status(404).json({ error: 'Tournament not found' });
        const { AttemptService, AttemptVoidError } = await import('../../services/AttemptService.js');
        const actor = req.user!.discordId || req.user!.username || req.user!.localAdminId || 'admin';
        try {
            await AttemptService.void(attemptId, String(actor), tournamentId);
        } catch (err) {
            if (err instanceof AttemptVoidError) {
                return res.status(err.httpStatus).json({ error: err.message, code: err.code });
            }
            throw err;
        }
        const { AuditService } = await import('../../services/AuditService.js');
        await AuditService.log({
            actor: String(actor),
            action: 'attempt.void',
            target_type: 'tournament',
            target_id: tournamentId,
            details: JSON.stringify({ roomId, attemptId }),
            ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
            correlation_id: req.correlationId || '',
        }).catch(() => { /* the void stands; an audit failure is logged by the service */ });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/admin/tournaments/:id/attempts/:attemptId/void):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Player: their own most recent evidence row — "bless the one I just played".
// `?vps_game=` narrows to the game the runner is configuring.
router.get('/me/witness/evidence/latest', requireDiscordUser, async (req, res) => {
    try {
        const vpsGame = typeof req.query.vps_game === 'string' && req.query.vps_game ? req.query.vps_game : null;
        const row = await WitnessEvidenceService.latestForUser(req.user!.discordId!, { vpsGame });
        res.json({ evidence: row });
    } catch (error) {
        logError('API Error (GET /api/me/witness/evidence/latest):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Catalogue: the tables of one game, by name — what the runner's required-table
// picker lists. Filled by the VPS import (`global_game_tables`).
router.get('/global/games/:id/tables', async (req, res) => {
    try {
        const db = await getDatabase();
        const game = await db.get<{ id: string; vps_id: string | null }>(
            'SELECT id, vps_id FROM global_games WHERE id = ?', req.params.id as string,
        );
        if (!game) return res.status(404).json({ error: 'Game not found' });
        const rows = await db.all<Array<{
            vps_table_id: string; name: string | null; authors: string; version: string | null;
            table_format: string | null; features: string; updated_at: string | null;
        }>>(
            `SELECT vps_table_id, name, authors, version, table_format, features, updated_at
               FROM global_game_tables WHERE global_game_id = ?
              ORDER BY updated_at DESC, name ASC`,
            game.id,
        );
        const parse = (s: string): string[] => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };
        res.json({
            gameId: game.id,
            vpsGameId: game.vps_id,
            tables: rows.map(r => ({
                vpsTableId: r.vps_table_id, name: r.name, authors: parse(r.authors), version: r.version,
                tableFormat: r.table_format, features: parse(r.features), updatedAt: r.updated_at,
            })),
        });
    } catch (error) {
        logError('API Error (GET /api/global/games/:id/tables):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

export default router;
