import crypto from 'crypto';
import { getDatabase } from '../database/database.js';
import { createTestRoom } from './helpers.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { TournamentService } from '../services/TournamentService.js';
import { SeasonPollService, type SeasonTournamentRow } from '../services/SeasonPollService.js';

/** Shared fixtures for the season-*.test.ts files. */

export const SEASON_CHANNEL = '900000000000000001';
/** Friday 00:00 America/New_York — GamerDad89's league cadence. */
export const FRIDAY_CRON = '0 0 * * 5';

let counter = 0;

export async function createSeason(opts: {
    tableCount?: number;
    tieRule?: 'admin' | 'random' | 'first_nominated';
    tieFallback?: 'random' | 'first_nominated';
    channelId?: string | null;
    platformRules?: unknown;
} = {}): Promise<{ roomId: string; tournamentId: string; season: SeasonTournamentRow }> {
    const n = ++counter;
    const roomId = await createTestRoom(`season-${n}-${crypto.randomUUID().slice(0, 6)}`, `Season Room ${n}`);
    await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
    const tournamentId = crypto.randomUUID();
    await TournamentService.create({
        id: tournamentId,
        name: `Mox Season ${n}`,
        type: 'WG-VPXS',
        cadence: { cron: FRIDAY_CRON, timezone: 'America/New_York' },
        platform_rules: opts.platformRules,
        discord_channel_id: opts.channelId === null ? undefined : (opts.channelId ?? SEASON_CHANNEL),
        is_active: true,
        game_room_id: roomId,
        season_table_count: opts.tableCount ?? 12,
        season_tie_rule: opts.tieRule ?? 'admin',
        season_tie_fallback: opts.tieFallback ?? 'random',
    });
    const season = (await SeasonPollService.getSeasonTournament(tournamentId))!;
    return { roomId, tournamentId, season };
}

export async function addCatalogueGame(name: string, opts: { platforms?: string[]; status?: string } = {}): Promise<string> {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_games (id, name, type, platforms, features, status) VALUES (?, ?, 'pinball', ?, '[]', ?)`,
        id, name, JSON.stringify(opts.platforms ?? ['vpx']), opts.status ?? 'approved',
    );
    return id;
}

export async function refreshSeason(tournamentId: string): Promise<SeasonTournamentRow> {
    return (await SeasonPollService.getSeasonTournament(tournamentId))!;
}

/** Put a draft straight into the `open` state with Discord ids, bypassing the scheduler. */
export async function openPollDirect(pollId: string, opts: { closesAt: string; messageId?: string | null; channelId?: string }): Promise<void> {
    const db = await getDatabase();
    await db.run(
        `UPDATE season_polls SET status = 'open', posted_at = ?, opens_at = ?, closes_at = ?, discord_channel_id = ?, discord_message_id = ? WHERE id = ?`,
        new Date(Date.parse(opts.closesAt) - 48 * 3_600_000).toISOString(),
        new Date(Date.parse(opts.closesAt) - 48 * 3_600_000).toISOString(),
        opts.closesAt,
        opts.messageId === null ? null : (opts.channelId ?? SEASON_CHANNEL),
        opts.messageId === null ? null : (opts.messageId ?? 'msg-1'),
        pollId,
    );
    if (opts.messageId !== null) {
        await db.run('UPDATE season_poll_candidates SET discord_answer_id = position WHERE poll_id = ?', pollId);
    }
}
