import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { getTerminology } from '../../utils/terminology.js';
import { logError } from '../../utils/logger.js';
import { checkCooldown } from '../../utils/cooldown.js';
import { LeaderboardService } from '../../services/LeaderboardService.js';
import { getTournamentColor } from '../../utils/discord.js';
import {
    resolveGuildReadScope,
    buildGuildScopedRoomSqlFilter,
    DISCORD_GUILD_NOT_LINKED_MESSAGE,
    type GuildReadScope,
} from '../../utils/discordRoomFilter.js';

/**
 * Resolves the `tournament` option (id or typed name/tag) to a tournament row
 * within `scope`, or `null` if nothing matches. Tried as an id first (what
 * the autocomplete choices send as `value`), then as an exact case-insensitive
 * match on name or tag — so a player who types instead of picking a
 * suggestion still resolves. Both lookups are guild-scoped so a tournament id
 * from another guild's room never resolves here.
 */
async function resolveTournamentFilter(
    db: Awaited<ReturnType<typeof getDatabase>>,
    scope: GuildReadScope,
    input: string,
): Promise<{ id: string; name: string } | null> {
    const { sql: scopeFilter, params: scopeParams } = buildGuildScopedRoomSqlFilter('t.game_room_id', scope);

    const byId = await db.get(
        `SELECT t.id, t.name FROM tournaments t WHERE t.id = ? ${scopeFilter}`,
        input, ...scopeParams,
    );
    if (byId) return byId;

    const byNameOrTag = await db.get(
        `SELECT t.id, t.name FROM tournaments t
         WHERE (t.name = ? COLLATE NOCASE OR t.type = ? COLLATE NOCASE) ${scopeFilter}`,
        input, input, ...scopeParams,
    );
    return byNameOrTag || null;
}

const PAGE_SIZE = 10;

export const listscores: Command = {
    data: new SlashCommandBuilder()
        .setName('list-scores')
        .setDescription('Displays the leaderboard for active games.')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('Filter scores to a specific player')
                .setRequired(false)
        )
        .addIntegerOption(option =>
            option.setName('page')
                .setDescription('Page number (default: 1)')
                .setRequired(false)
                .setMinValue(1)
        )
        .addStringOption(option =>
            option.setName('tournament')
                .setDescription('Only show scores for this tournament')
                .setRequired(false)
                .setAutocomplete(true)
        ) as SlashCommandBuilder,

    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);
        if (focusedOption.name !== 'tournament') {
            await interaction.respond([]);
            return;
        }

        // Guild-scoped, same contract as /activate-game's tournament
        // autocomplete (v2.120.2) — `null` scope (unlinked guild / DM) shows
        // nothing rather than every room's tournaments.
        const scope = await resolveGuildReadScope(interaction.guildId);
        if (!scope) {
            await interaction.respond([]);
            return;
        }
        const { sql: scopeFilter, params: scopeParams } = buildGuildScopedRoomSqlFilter('t.game_room_id', scope);

        const db = await getDatabase();
        const rows = await db.all(
            `SELECT t.id, t.name, t.type FROM tournaments t WHERE t.is_active = 1 ${scopeFilter}`,
            ...scopeParams,
        ) as Array<{ id: string; name: string; type: string }>;

        const query = focusedOption.value.toLowerCase();
        const filtered = rows
            .filter(r => r.name.toLowerCase().includes(query) || r.type.toLowerCase().includes(query))
            .slice(0, 25);
        await interaction.respond(filtered.map(r => ({ name: `${r.name} (${r.type})`, value: r.id })));
    },

    async execute(interaction: ChatInputCommandInteraction) {
        // Check cooldown (5 seconds)
        const remaining = checkCooldown(interaction.user.id, 'list-scores', 5);
        if (remaining > 0) {
            await interaction.reply({ content: `Please wait ${remaining}s before listing scores again.`, ephemeral: true });
            return;
        }

        // v2.120.1 - guild-scoped read. Resolved BEFORE deferring so the
        // not-linked notice can be ephemeral. `null` = this guild maps to
        // no Arcaid room (or the interaction is a DM, which has no guild
        // context at all) - show nothing rather than every room's data.
        const scope = await resolveGuildReadScope(interaction.guildId);
        if (!scope) {
            await interaction.reply({ content: DISCORD_GUILD_NOT_LINKED_MESSAGE, ephemeral: true });
            return;
        }

        await interaction.deferReply();
        const term = getTerminology();
        const db = await getDatabase();
        const targetUser = interaction.options.getUser('user');
        const page = interaction.options.getInteger('page') ?? 1;
        const offset = (page - 1) * PAGE_SIZE;
        const tournamentInput = interaction.options.getString('tournament');

        try {
            let tournamentFilter: { id: string; name: string } | null = null;
            if (tournamentInput) {
                tournamentFilter = await resolveTournamentFilter(db, scope, tournamentInput);
                if (!tournamentFilter) {
                    await interaction.editReply(`No tournament named "${tournamentInput}" in this server's rooms.`);
                    return;
                }
            }

            const { sql: enabledFilter, params } = buildGuildScopedRoomSqlFilter('t.game_room_id', scope);
            const tournamentIdFilter = tournamentFilter ? 'AND t.id = ?' : '';
            const tournamentIdParams = tournamentFilter ? [tournamentFilter.id] : [];
            // INNER JOIN — orphan games have no room and aren't relevant to
            // any Discord guild's scoreboard.
            const activeGames = await db.all(`
                SELECT g.id, g.name as game_name, t.name as tournament_name, t.type as tournament_type, t.display_order
                FROM games g
                JOIN tournaments t ON g.tournament_id = t.id
                WHERE g.status = 'ACTIVE' ${enabledFilter} ${tournamentIdFilter}
                ORDER BY COALESCE(t.display_order, 999) ASC, g.start_date DESC
            `, ...params, ...tournamentIdParams);

            if (activeGames.length === 0) {
                await interaction.editReply(tournamentFilter
                    ? `${tournamentFilter.name} has no active games right now.`
                    : `There are no recent ${term.games.toLowerCase()} to show scores for.`);
                return;
            }

            const embeds = [];
            for (const game of activeGames) {
                let rankings = await LeaderboardService.getForGame(game.id);

                // Filter to a specific user if requested
                if (targetUser) {
                    const mapping = await db.get(
                        'SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?',
                        targetUser.id
                    );
                    if (mapping) {
                        rankings = rankings.filter(e =>
                            e.iscored_username.toLowerCase() === mapping.iscored_username.toLowerCase()
                        );
                    } else {
                        rankings = [];
                    }
                }

                const total = rankings.length;
                const paged = rankings.slice(offset, offset + PAGE_SIZE);
                const tName = game.tournament_name || 'Manual Game';
                const color = getTournamentColor(game.tournament_type);

                const embed = new EmbedBuilder()
                    .setTitle(`Standings: [${tName}] ${game.game_name}`)
                    .setColor(color)
                    .setTimestamp();

                if (targetUser) {
                    embed.setFooter({ text: `Filtered to ${targetUser.displayName}` });
                }

                if (paged.length === 0) {
                    embed.setDescription(targetUser
                        ? `No scores found for ${targetUser.displayName}.`
                        : `No ${term.submission.toLowerCase()}s submitted yet.`);
                } else {
                    let desc = '';
                    paged.forEach((entry) => {
                        const medal = `**${entry.rank}.**`;
                        desc += `${medal} **${entry.iscored_username}** — ${entry.score.toLocaleString()}\n`;
                    });
                    if (total > PAGE_SIZE) {
                        const totalPages = Math.ceil(total / PAGE_SIZE);
                        desc += `\n*Page ${page}/${totalPages} — use \`/list-scores page:${page + 1}\` for more*`;
                    }
                    embed.setDescription(desc);
                }
                embeds.push(embed);
            }

            await interaction.editReply({ embeds });
        } catch (error) {
            logError('Error in list-scores command:', error);
            await interaction.editReply('An error occurred while fetching the scores.');
        }
    },
};
