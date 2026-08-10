import { ChatInputCommandInteraction, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { Command } from './index.js';
import { TournamentEngine } from '../../engine/TournamentEngine.js';
import { getDatabase } from '../../database/database.js';
import { logError } from '../../utils/logger.js';

export const reorderlineup: Command = {
    data: new SlashCommandBuilder()
        .setName('reorder-lineup')
        .setDescription('(Admin) Reorder the iScored lineup based on tournament display positions.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ ephemeral: true });
        const engine = TournamentEngine.getInstance();

        try {
            // Drift-audit fix — this called `reorderIScoredLineup()` with no
            // roomId, which reorders EVERY room's iScored lineup regardless of
            // the invoking guild. Scope to the invoking guild's room(s):
            // rooms whose `DISCORD_GUILD_ID` setting matches this guild, plus
            // (legacy env-fallback allowance, same precedence as
            // discordWriteTarget.ts) rooms with NO per-room guild id at all,
            // when this guild is the env fallback guild.
            const db = await getDatabase();
            const guildId = interaction.guildId;

            const configuredRows = await db.all(
                `SELECT game_room_id, value AS guild_id FROM game_room_settings WHERE key = 'DISCORD_GUILD_ID'`,
            ) as Array<{ game_room_id: string; guild_id: string }>;
            const configuredRoomIds = new Set(configuredRows.map(r => r.game_room_id));

            let roomIds = configuredRows.filter(r => r.guild_id === guildId).map(r => r.game_room_id);

            if (guildId && guildId === process.env.DISCORD_GUILD_ID) {
                const allRoomRows = await db.all(`SELECT id FROM game_rooms`) as Array<{ id: string }>;
                const envFallbackRoomIds = allRoomRows.map(r => r.id).filter(id => !configuredRoomIds.has(id));
                roomIds = Array.from(new Set([...roomIds, ...envFallbackRoomIds]));
            }

            if (roomIds.length === 0) {
                await interaction.editReply('No Arcaid room is linked to this Discord server.');
                return;
            }

            for (const roomId of roomIds) {
                await engine.reorderIScoredLineup(roomId);
            }
            await interaction.editReply('iScored lineup has been reordered based on tournament positions.');
        } catch (error) {
            logError('Error in reorder-lineup command:', error);
            await interaction.editReply('An error occurred while reordering the lineup.');
        }
    },
};
