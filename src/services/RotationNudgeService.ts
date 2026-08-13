import { getDatabase } from '../database/database.js';
import { getNextRunTime } from '../utils/cronUtils.js';
import { PickAwardGate } from './PickAwardGate.js';
import { PickDispositionService } from './PickDispositionService.js';
import { resolveTopSubmissionPlayers } from '../utils/submissionAttribution.js';
import { NotificationService } from './NotificationService.js';
import { logError } from '../utils/logger.js';

/**
 * RotationNudgeService — the "get your pick ready" nudge (ROADMAP "Next-win
 * disposition + dynasty option + rotation-readiness nudge", locked
 * 2026-08-09).
 *
 * Two triggers, sharing one dedupe mechanism:
 *   (a) `evaluateTournament` — a T-1h sweep (Scheduler, every 15 min): for
 *       each active, pick-award-enabled tournament, the current top 3 on each
 *       ACTIVE slot who lack BOTH a queued game AND a stored disposition get
 *       nudged.
 *   (b) `evaluateSubmitter` — event-driven, called from the same fan-out
 *       point as `LobbyFeedGenerator.onScoreSubmitted`: if this submission
 *       lands the submitter in 1st on the active slot AND the rotation is
 *       within the hour, nudge them (same has-queue-or-disposition check).
 *
 * Dedupe: one row in `rotation_nudges` per (tournament, player, rotation
 * boundary) — `rotation_key` is the ISO instant of the next cron fire, so a
 * fresh boundary (the NEXT rotation) naturally allows a fresh nudge with no
 * TTL bookkeeping. The INSERT's UNIQUE constraint IS the dedupe check — no
 * separate SELECT-then-INSERT race.
 *
 * Known acceptable gap (per the design): someone entering 2nd/3rd inside the
 * final hour isn't nudged by trigger (b) — only a NEW #1 fires it. Trigger
 * (a)'s sweep still covers them on its next 15-minute pass.
 */
const WINDOW_MS = 60 * 60_000;
const TOP_N = 3;

interface CadenceLike {
    cron?: string;
    timezone?: string;
}

function nextRotationWithinWindow(cadenceJson: string | null | undefined): Date | null {
    let cadence: CadenceLike;
    try { cadence = JSON.parse(cadenceJson || '{}'); } catch { return null; }
    if (!cadence.cron) return null;
    const tz = cadence.timezone || process.env.BOT_TIMEZONE || 'America/Chicago';
    const nextRun = getNextRunTime(cadence.cron, tz);
    if (!nextRun) return null;
    const msUntil = nextRun.getTime() - Date.now();
    if (msUntil <= 0 || msUntil > WINDOW_MS) return null;
    return nextRun;
}

export class RotationNudgeService {
    /**
     * T-1h sweep for one tournament row (`id`, `name`, `cadence`,
     * `game_room_id` — the caller's own `SELECT` shape from Scheduler).
     */
    static async evaluateTournament(tournamentRow: {
        id: string;
        name: string;
        cadence: string | null;
        game_room_id: string | null;
    }): Promise<void> {
        try {
            // The nudge deep-links to a room's Picks page — a legacy
            // no-room tournament has nowhere to send the player.
            if (!tournamentRow.game_room_id) return;
            if (!(await PickAwardGate.isEnabled(tournamentRow.game_room_id, tournamentRow.id))) return;

            const nextRun = nextRotationWithinWindow(tournamentRow.cadence);
            if (!nextRun) return;

            const db = await getDatabase();
            const activeGames = await db.all(
                `SELECT id FROM games WHERE tournament_id = ? AND status = 'ACTIVE'`,
                tournamentRow.id,
            );
            if (activeGames.length === 0) return;

            const rotationKey = nextRun.toISOString();
            const seen = new Set<string>();
            for (const g of activeGames) {
                const top = await resolveTopSubmissionPlayers(db, g.id, TOP_N);
                for (const entry of top) {
                    if (seen.has(entry.playerId)) continue; // one nudge per player even with multiple slots
                    seen.add(entry.playerId);
                    await this.maybeNudge(tournamentRow.id, tournamentRow.game_room_id, tournamentRow.name, entry.playerId, rotationKey);
                }
            }
        } catch (error) {
            logError('RotationNudgeService.evaluateTournament error:', error);
        }
    }

    /**
     * Event-driven check — called (fire-and-forget) right after a score
     * lands. Only nudges when THIS submit put the submitter in 1st.
     */
    static async evaluateSubmitter(gameRoomId: string, gameName: string, submitterId: string | null | undefined): Promise<void> {
        try {
            if (!submitterId) return;

            const db = await getDatabase();
            const activeGame = await db.get(
                `SELECT g.id AS game_id, t.id AS tournament_id, t.name AS tournament_name, t.cadence
                 FROM games g JOIN tournaments t ON t.id = g.tournament_id
                 WHERE t.game_room_id = ? AND LOWER(g.name) = LOWER(?) AND g.status = 'ACTIVE' AND t.is_active = 1
                 LIMIT 1`,
                gameRoomId, gameName,
            );
            if (!activeGame) return;
            if (!(await PickAwardGate.isEnabled(gameRoomId, activeGame.tournament_id))) return;

            const nextRun = nextRotationWithinWindow(activeGame.cadence);
            if (!nextRun) return;

            const top1 = await resolveTopSubmissionPlayers(db, activeGame.game_id, 1);
            if (top1[0]?.playerId !== submitterId) return;

            await this.maybeNudge(activeGame.tournament_id, gameRoomId, activeGame.tournament_name, submitterId, nextRun.toISOString());
        } catch (error) {
            logError('RotationNudgeService.evaluateSubmitter error:', error);
        }
    }

    /** Shared has-queue-or-disposition check + dedupe-INSERT + notify. */
    private static async maybeNudge(
        tournamentId: string,
        gameRoomId: string,
        tournamentName: string,
        playerId: string,
        rotationKey: string,
    ): Promise<void> {
        if (await PickDispositionService.hasQueueOrDisposition(tournamentId, playerId)) return;

        const db = await getDatabase();
        try {
            await db.run(
                `INSERT INTO rotation_nudges (tournament_id, discord_user_id, rotation_key) VALUES (?, ?, ?)`,
                tournamentId, playerId, rotationKey,
            );
        } catch {
            // UNIQUE(tournament_id, discord_user_id, rotation_key) — already
            // nudged for this rotation boundary. The constraint IS the dedupe.
            return;
        }

        const room = await db.get('SELECT slug FROM game_rooms WHERE id = ?', gameRoomId);
        const link = room?.slug ? NotificationService.buildLink(room.slug, '/picks') : '';
        await NotificationService.notify({
            userId: playerId,
            type: 'rotationReady',
            message: `\u{23F0} Rotation soon for **${tournamentName}** — you're in the running! Queue your next pick or set your disposition (\`/pick-game\`) before the slot rotates.${link ? `\n${link}` : ''}`,
            pushBody: `Rotation soon in ${tournamentName} — get your pick ready.`,
            roomId: gameRoomId,
            tournamentId,
            pushUrl: link || undefined,
        }).catch(() => {});
    }
}
