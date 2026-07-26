import { ChatInputCommandInteraction, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { Command } from './index.js';
import { logError, logInfo } from '../../utils/logger.js';
import { TournamentEngine } from '../../engine/TournamentEngine.js';
import { getDatabase } from '../../database/database.js';
import { CleanupRule } from '../../types/index.js';

export const runcleanup: Command = {
    data: new SlashCommandBuilder()
        .setName('run-cleanup')
        .setDescription('(Admin) Run cleanup for all tournaments per their cleanup rules.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ ephemeral: true });

        try {
            logInfo('Manually triggering cleanup per tournament cleanup rules...');
            const db = await getDatabase();
            const engine = TournamentEngine.getInstance();

            const tournaments = await db.all('SELECT id, name, cleanup_rule, game_room_id FROM tournaments WHERE is_active = 1');

            let totalDeleted = 0;
            const results: string[] = [];
            const { RoomAccessService } = await import('../../services/RoomAccessService.js');

            for (const t of tournaments) {
                // S22 Phase 2 (v2.44.0, M1 fix) — this command is unscoped by
                // design (runs cleanup for EVERY active tournament regardless
                // of the invoking guild), so it must check EACH tournament's
                // own room rather than relying on the guild-level gate.
                if (t.game_room_id && await RoomAccessService.isSuspended(t.game_room_id)) {
                    results.push(`**${t.name}**: Skipped (room suspended)`);
                    continue;
                }

                let rule: CleanupRule = { mode: 'retain', count: 0 };
                try { rule = JSON.parse(t.cleanup_rule || '{}'); } catch {}

                if (rule.mode === 'scheduled') {
                    results.push(`**${t.name}**: Skipped (scheduled cleanup — use cron or force)`);
                    continue;
                }

                try {
                    const before = await db.get(
                        `SELECT COUNT(*) as count FROM games WHERE tournament_id = ? AND status = 'COMPLETED'`,
                        t.id
                    );
                    await engine.runCleanup(t.id, rule);
                    const after = await db.get(
                        `SELECT COUNT(*) as count FROM games WHERE tournament_id = ? AND status = 'COMPLETED'`,
                        t.id
                    );
                    const deleted = (before?.count || 0) - (after?.count || 0);
                    totalDeleted += deleted;
                    results.push(`**${t.name}** (${rule.mode}): ${deleted} game(s) cleaned up`);
                } catch (err) {
                    logError(`Cleanup failed for ${t.name}:`, err);
                    results.push(`**${t.name}**: Error — check logs`);
                }
            }

            await interaction.editReply(
                `**Cleanup Complete!**\n\n${results.join('\n')}\n\nTotal: ${totalDeleted} game(s) removed from iScored.`
            );
        } catch (error) {
            logError('Error in run-cleanup command:', error);
            await interaction.editReply('An error occurred while running the cleanup routine. Check the logs.');
        }
    },
};
