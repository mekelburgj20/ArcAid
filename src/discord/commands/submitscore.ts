import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { getTerminology } from '../../utils/terminology.js';
import { logInfo, logError } from '../../utils/logger.js';
import { IScoredClient } from '../../engine/IScoredClient.js';
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
        
    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();
        
        const term = getTerminology();
        const gameName = interaction.options.getString('game', true);
        const score = interaction.options.getInteger('score', true);
        const photo = interaction.options.getAttachment('photo', true);
        let username = interaction.options.getString('username');

        const db = await getDatabase();

        try {
            // Find the game ID
            const game = await db.get("SELECT id, iscored_id FROM games WHERE name = ? COLLATE NOCASE AND status = 'ACTIVE'", gameName);

            if (!game || !game.iscored_id) {
                await interaction.editReply(`❌ Could not find an active ${term.game} named '${gameName}' linked to iScored.`);
                return;
            }

            // Resolve username
            if (!username) {
                const mapping = await db.get('SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?', interaction.user.id);
                if (mapping) {
                    username = mapping.iscored_username;
                } else {
                    await interaction.editReply('❌ You have not mapped your iScored username. Use `/map-user` or provide the `username` option.');
                    return;
                }
            }

            // Download Photo
            const photoRes = await fetch(photo.url);
            const arrayBuffer = await photoRes.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const ext = path.extname(photo.name) || '.jpg';
            const tempPhotoPath = path.join(process.cwd(), 'data', `${uuidv4()}${ext}`);
            
            await fs.writeFile(tempPhotoPath, buffer);

            // Submit to iScored
            const client = new IScoredClient();
            await client.connect();
            await client.submitScore(game.iscored_id, username!, score, tempPhotoPath);
            await client.disconnect();

            // Record internally
            await db.run(
                'INSERT INTO submissions (id, game_id, discord_user_id, iscored_username, score, photo_url, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
                uuidv4(), game.id, interaction.user.id, username, score, photo.url, new Date().toISOString()
            );

            // Cleanup temp photo
            await fs.unlink(tempPhotoPath).catch(() => {});

            logInfo(`Score submitted: ${username} scored ${score} on ${gameName}`);
            await interaction.editReply(`✅ Successfully submitted your score of **${score.toLocaleString()}** to **${gameName}**!`);

        } catch (error) {
            logError('Error in /submit-score:', error);
            await interaction.editReply('❌ An error occurred while submitting your score.');
        }
    },
};
