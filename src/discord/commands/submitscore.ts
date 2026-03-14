import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { getTerminology } from '../../utils/terminology.js';
import { logInfo, logError } from '../../utils/logger.js';
import { IScoredClient } from '../../engine/IScoredClient.js';
import { LeaderboardService } from '../../services/LeaderboardService.js';
import { checkCooldown } from '../../utils/cooldown.js';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export const submitscore: Command = {
    data: new SlashCommandBuilder()
        .setName('submit-score')
        .setDescription(`Submit a score for an active ${getTerminology().game}.`)
        .addStringOption(option =>
            option.setName('game')
                .setDescription(`The active ${getTerminology().game} to submit for`)
                .setRequired(true)
                .setAutocomplete(true)
        )
        .addIntegerOption(option =>
            option.setName('score')
                .setDescription('Your score')
                .setRequired(true)
        )
        .addAttachmentOption(option =>
            option.setName('photo')
                .setDescription('A photo of your score')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('username')
                .setDescription('Your iScored username (if different from mapping)')
                .setRequired(false)
        ) as SlashCommandBuilder,

    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);
        const db = await getDatabase();

        if (focusedOption.name === 'game') {
            // Only suggest ACTIVE games with a tournament for score submission
            const rows = await db.all(`
                SELECT g.name, t.name as tournament_name
                FROM games g
                JOIN tournaments t ON g.tournament_id = t.id
                WHERE g.status = 'ACTIVE'
                ORDER BY t.display_order ASC, g.name ASC
            `);

            const filtered = rows
                .filter((r: any) => r.name.toLowerCase().includes(focusedOption.value.toLowerCase()))
                .slice(0, 25);

            await interaction.respond(
                filtered.map((r: any) => ({
                    name: r.tournament_name ? `${r.name} (${r.tournament_name})` : r.name,
                    value: r.name,
                }))
            );
        }
    },
        
    async execute(interaction: ChatInputCommandInteraction) {
        // Check cooldown (30 seconds)
        const remaining = checkCooldown(interaction.user.id, 'submit-score', 30);
        if (remaining > 0) {
            await interaction.reply({ content: `Please wait ${remaining}s before submitting another score.`, ephemeral: true });
            return;
        }

        await interaction.deferReply();

        const term = getTerminology();
        const gameName = interaction.options.getString('game', true);
        const score = interaction.options.getInteger('score', true);
        const photo = interaction.options.getAttachment('photo', true);
        let username = interaction.options.getString('username');

        // Validate score is a positive integer
        if (score <= 0) {
            await interaction.editReply('Score must be a positive number.');
            return;
        }

        const db = await getDatabase();

        try {
            // Find the game ID
            const game = await db.get("SELECT id, iscored_id FROM games WHERE name = ? COLLATE NOCASE AND status = 'ACTIVE'", gameName);

            if (!game || !game.iscored_id) {
                await interaction.editReply(`Could not find an active ${term.game} named '${gameName}' linked to iScored.`);
                return;
            }

            // Resolve username: explicit param > saved mapping > auto-map from Discord display name
            if (!username) {
                const mapping = await db.get('SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?', interaction.user.id);
                if (mapping) {
                    username = mapping.iscored_username;
                } else {
                    // Auto-map using Discord display name as iScored username
                    const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
                    username = member?.displayName || interaction.user.displayName;
                    await db.run(
                        `INSERT INTO user_mappings (discord_user_id, iscored_username)
                         VALUES (?, ?)
                         ON CONFLICT(discord_user_id) DO UPDATE SET iscored_username = excluded.iscored_username`,
                        interaction.user.id, username
                    );
                    logInfo(`Auto-mapped user: ${username} -> ${interaction.user.tag}`);
                }
            }

            // Download Photo
            const photoRes = await fetch(photo.url);
            const arrayBuffer = await photoRes.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const ext = path.extname(photo.name) || '.jpg';
            const tempPhotoPath = path.join(process.cwd(), 'data', `${uuidv4()}${ext}`);
            
            await fs.writeFile(tempPhotoPath, buffer);

            try {
                // Submit to iScored
                const client = new IScoredClient();
                await client.connect();
                try {
                    await client.submitScore(game.iscored_id, username!, score, tempPhotoPath);
                } finally {
                    await client.disconnect();
                }

                // Record internally (use sync-compatible ID so sync won't create a duplicate)
                await db.run(
                    `INSERT INTO submissions (id, game_id, discord_user_id, iscored_username, score, photo_url, timestamp)
                     VALUES (?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET score = MAX(score, excluded.score), discord_user_id = excluded.discord_user_id, photo_url = excluded.photo_url`,
                    `${game.id}-${username!.toLowerCase()}`, game.id, interaction.user.id, username, score, photo.url, new Date().toISOString()
                );

                // Invalidate leaderboard cache
                await LeaderboardService.invalidate(game.id);

                // Invalidate ranking group caches (scores changed)
                const { RankingService } = await import('../../services/RankingService.js');
                await RankingService.invalidateAll();

                logInfo(`Score submitted: ${username} scored ${score} on ${gameName}`);
                await interaction.editReply(`Successfully submitted your score of **${score.toLocaleString()}** to **${gameName}**!`);
            } finally {
                // Always cleanup temp photo, even on error
                await fs.unlink(tempPhotoPath).catch(() => {});
            }

        } catch (error) {
            logError('Error in /submit-score:', error);
            await interaction.editReply('An error occurred while submitting your score.');
        }
    },
};
