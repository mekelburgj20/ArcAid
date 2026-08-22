import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { logError } from '../../utils/logger.js';
import { roomPicksUrl } from '../../utils/publicLinks.js';
import { queueOrderSql, cooldownDaysRemaining } from '../../services/PickQueueService.js';
import {
    resolveGuildReadScope,
    buildGuildScopedRoomSqlFilter,
    DISCORD_GUILD_NOT_LINKED_MESSAGE,
    type GuildReadScope,
} from '../../utils/discordRoomFilter.js';

/**
 * `/view-queue` — replaces `/view-selection` (v2.121.0, owner ask 2026-08-20).
 *
 * The old command listed EVERY player's queued games in the guild's rooms and
 * then a "Available to Pick (Sample)" dump of the first 10 catalogue titles,
 * which was neither the caller's queue nor a usable browse. This shows only
 * the invoker's own rows — queues are per-player (`games.picker_discord_id`
 * is the queue owner, owner spec 2026-08-17) — and points at the room's Picks
 * page for the full pick list instead of sampling the catalogue.
 *
 * `[Pending Pick]` placeholders are excluded: they are unfilled pick slots,
 * not queued games.
 */

interface QueueRow {
    game_name: string;
    queue_order: number | null;
    queue_held_at: string | null;
    tournament_id: string;
    tournament_name: string;
    tournament_type: string | null;
}

/**
 * One "Visit your Arcaid game room here: …" line per room in scope. The room
 * name is prefixed only when the guild links to more than one room, so the
 * single-room case (nearly every guild) reads as the plain sentence.
 */
async function buildRoomLinks(scope: GuildReadScope): Promise<string[]> {
    if (scope.roomIds.length === 0) return [];
    const db = await getDatabase();
    const placeholders = scope.roomIds.map(() => '?').join(', ');
    const rooms = await db.all(
        `SELECT slug, name FROM game_rooms WHERE id IN (${placeholders}) ORDER BY name COLLATE NOCASE ASC`,
        ...scope.roomIds,
    ) as Array<{ slug: string; name: string }>;

    return rooms.map(r => {
        const sentence = `Visit your Arcaid game room here: ${roomPicksUrl(r.slug)} to view all of the pick options for this tournament.`;
        return rooms.length > 1 ? `**${r.name}** — ${sentence}` : sentence;
    });
}

export const viewqueue: Command = {
    data: new SlashCommandBuilder()
        .setName('view-queue')
        .setDescription('Shows the games you have queued up for your next pick.'),
    async execute(interaction: ChatInputCommandInteraction) {
        // Guild-scoped read (v2.120.1 contract). Resolved BEFORE deferring so
        // the not-linked notice can be ephemeral. `null` = this guild maps to
        // no Arcaid room (or it's a DM, which carries no room context).
        const scope = await resolveGuildReadScope(interaction.guildId);
        if (!scope) {
            await interaction.reply({ content: DISCORD_GUILD_NOT_LINKED_MESSAGE, ephemeral: true });
            return;
        }

        await interaction.deferReply({ ephemeral: true });
        const db = await getDatabase();

        try {
            const { sql: scopeFilter, params } = buildGuildScopedRoomSqlFilter('t.game_room_id', scope);

            // `queueOrderSql` IS the engine's ordering (held picks first,
            // then `queue_order ASC` — NULLs first in SQLite, which is how a
            // repurposed `[Pending Pick]` row keeps its place at the front).
            // Shared with `TournamentEngine.nextEligibleQueuedFor` so this
            // listing can never disagree with what actually activates; the
            // tournament grouping sits in front of it.
            const rows = await db.all(`
                SELECT g.name AS game_name, g.queue_order, g.queue_held_at, t.id AS tournament_id,
                       t.name AS tournament_name, t.type AS tournament_type
                FROM games g
                JOIN tournaments t ON g.tournament_id = t.id
                WHERE g.status = 'QUEUED' AND g.name != '[Pending Pick]'
                  AND g.picker_discord_id = ? ${scopeFilter}
                ORDER BY t.name COLLATE NOCASE ASC, ${queueOrderSql('g')}
            `, interaction.user.id, ...params) as QueueRow[];

            const links = await buildRoomLinks(scope);

            if (rows.length === 0) {
                await interaction.editReply(['Your queue is empty.', ...links].join('\n\n'));
                return;
            }

            const sections: string[] = ['**Your Queue**'];
            let currentTournament: string | null = null;
            let position = 0;
            const lines: string[] = [];

            for (const row of rows) {
                if (row.tournament_id !== currentTournament) {
                    currentTournament = row.tournament_id;
                    position = 0;
                    const tag = row.tournament_type ? ` \`${row.tournament_type}\`` : '';
                    lines.push(`${lines.length > 0 ? '\n' : ''}**${row.tournament_name}**${tag}`);
                }
                position += 1;
                // A held pick is not broken and not going anywhere — say so,
                // with the wait, so nobody deletes it thinking it is stuck.
                let suffix = '';
                if (row.queue_held_at) {
                    const days = await cooldownDaysRemaining(row.tournament_id, row.game_name, { minDays: 1 });
                    suffix = ` — on hold (cooldown, ${days}d left)`;
                }
                lines.push(`${position}. ${row.game_name}${suffix}`);
            }

            sections.push(lines.join('\n'));
            await interaction.editReply([...sections, ...links].join('\n\n'));
        } catch (error) {
            logError('Error in view-queue command:', error);
            await interaction.editReply('An error occurred while fetching your queue.');
        }
    },
};
