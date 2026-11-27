import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from './GameRoomSettingsService.js';
import { RunRecapService } from './RunRecapService.js';
import { resolveAnnouncementChannelId, sendChannelMessage, type ChannelSendResult } from '../utils/discord.js';
import { DISCORD_RUN_RECAPS_ENABLED_KEY, parseRunRecapsEnabled } from '../utils/discordRunRecaps.js';
import { buildRunRecapText, splitRecapForBot, DISCORD_COPY_MAX, DISCORD_BOT_MAX } from '../utils/runRecapText.js';
import { tournamentRunRecapUrl } from '../utils/publicLinks.js';
import { logInfo, logError } from '../utils/logger.js';

/**
 * Posts a run's Arcaid Recap to Discord once the run has ended (B31.5).
 *
 * A per-minute SWEEP (Scheduler.startRunRecapPostSweep), not a hook in the five
 * places a run can close: it is after COMMIT by construction, covers every close
 * path, and waits `RECAP_POST_SETTLE_MS` for late Witness reports.
 * `run_recap_posts` (migration 224) is the idempotency ledger: a run is claimed
 * with INSERT OR IGNORE and acted on only when `changes === 1`, so two ticks or
 * two processes post once. A failed send is recorded `failed` and never retried
 * (`sendChannelMessage` already logged it and wrote the bot-failure activity row).
 * A room whose switch is off gets no ledger row, so turning it on later still
 * posts runs that ended inside the max-age window.
 */

export const RECAP_POST_SETTLE_MS = 10 * 60_000;
export const RECAP_POST_MAX_AGE_MS = 6 * 3_600_000;

interface Candidate {
    game_id: string;
    game_name: string;
    game_room_id: string;
    tournament_id: string;
    tournament_channel_id: string | null;
    tournament_announce_routes: string | null;
    slug: string | null;
}

async function finish(gameId: string, status: 'posted' | 'skipped' | 'failed', extra: {
    reason?: string; channelId?: string; messageIds?: Array<string | null>;
} = {}): Promise<void> {
    const db = await getDatabase();
    await db.run(
        `UPDATE run_recap_posts SET status = ?, reason = ?, channel_id = ?, message_ids = ?, finished_at = ? WHERE game_id = ?`,
        status, extra.reason ?? null, extra.channelId ?? null,
        extra.messageIds ? JSON.stringify(extra.messageIds) : null, new Date().toISOString(), gameId,
    );
}

export class RunRecapPostService {
    static async sweep(now: Date = new Date()): Promise<{ posted: number; skipped: number; failed: number }> {
        const out = { posted: 0, skipped: 0, failed: 0 };
        const db = await getDatabase();
        const newest = new Date(now.getTime() - RECAP_POST_SETTLE_MS).toISOString();
        const oldest = new Date(now.getTime() - RECAP_POST_MAX_AGE_MS).toISOString();
        const candidates = await db.all<Candidate[]>(
            `SELECT g.id AS game_id, g.name AS game_name, t.game_room_id AS game_room_id, t.id AS tournament_id,
                    t.discord_channel_id AS tournament_channel_id, t.discord_announce_routes AS tournament_announce_routes,
                    r.slug AS slug
               FROM games g
               JOIN tournaments t ON t.id = g.tournament_id
               LEFT JOIN game_rooms r ON r.id = t.game_room_id
              WHERE g.status IN ('COMPLETED', 'ARCHIVED')
                AND t.game_room_id IS NOT NULL
                AND g.end_date IS NOT NULL
                AND julianday(g.end_date) BETWEEN julianday(?) AND julianday(?)
                AND NOT EXISTS (SELECT 1 FROM run_recap_posts p WHERE p.game_id = g.id)
              ORDER BY g.end_date`,
            oldest, newest,
        );
        if (candidates.length === 0) return out;

        const roomIds = [...new Set(candidates.map(c => c.game_room_id))];
        const settings = await GameRoomSettingsService.getManyForRooms(roomIds, [DISCORD_RUN_RECAPS_ENABLED_KEY]);

        for (const c of candidates) {
            if (!parseRunRecapsEnabled(settings.get(c.game_room_id)?.[DISCORD_RUN_RECAPS_ENABLED_KEY])) continue;
            try {
                const claim = await db.run(
                    `INSERT OR IGNORE INTO run_recap_posts (game_id, game_room_id, status, claimed_at) VALUES (?, ?, 'claimed', ?)`,
                    c.game_id, c.game_room_id, now.toISOString(),
                );
                if (claim.changes !== 1) continue;
                try {
                    out[await RunRecapPostService.postOne(c)]++;
                } catch (err) {
                    logError(`RunRecapPostService: recap for game ${c.game_id} failed:`, err);
                    out.failed++;
                    await finish(c.game_id, 'failed', { reason: 'exception' }).catch(() => { /* best effort */ });
                }
            } catch (err) {
                logError(`RunRecapPostService: claim for game ${c.game_id} failed:`, err);
            }
        }
        if (out.posted || out.skipped || out.failed) {
            logInfo(`Run recap posts: ${out.posted} posted, ${out.skipped} skipped, ${out.failed} failed.`);
        }
        return out;
    }

    private static async postOne(c: Candidate): Promise<'posted' | 'skipped' | 'failed'> {
        const channelId = await resolveAnnouncementChannelId(
            c.game_room_id, c.tournament_channel_id, 'recaps', c.tournament_announce_routes,
        );
        if (!channelId) { await finish(c.game_id, 'skipped', { reason: 'no_channel' }); return 'skipped'; }

        const recap = await RunRecapService.getRunRecap(c.game_room_id, c.game_id);
        if (!recap || recap.players.length === 0) {
            await finish(c.game_id, 'skipped', { reason: 'no_scores', channelId });
            return 'skipped';
        }

        const link = c.slug ? tournamentRunRecapUrl(c.slug, c.tournament_id, c.game_id) : undefined;
        const chunks = splitRecapForBot(buildRunRecapText(recap, { maxChars: DISCORD_COPY_MAX, link }), DISCORD_BOT_MAX);
        const [head, ...rest] = chunks;
        if (head === undefined) { await finish(c.game_id, 'skipped', { reason: 'no_scores', channelId }); return 'skipped'; }

        const ids: Array<string | null> = [];
        const first: ChannelSendResult | void = await sendChannelMessage(channelId, head, {
            threadName: `${c.game_name} · Arcaid Recap`, noMentions: true,
        });
        if (!first) { await finish(c.game_id, 'failed', { reason: 'send_failed', channelId }); return 'failed'; }
        ids.push(first.messageId);
        const target = first.threadId ?? channelId;
        for (const chunk of rest) {
            const sent = await sendChannelMessage(target, chunk, { noMentions: true });
            if (!sent) { await finish(c.game_id, 'failed', { reason: 'send_failed', channelId, messageIds: ids }); return 'failed'; }
            ids.push(sent.messageId);
        }
        await finish(c.game_id, 'posted', { channelId, messageIds: ids });
        return 'posted';
    }
}
