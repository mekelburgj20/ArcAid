import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { logError } from '../../utils/logger.js';
import { BanService } from '../../services/BanService.js';
import { EventService } from '../../services/EventService.js';
import { resolveGuildReadScope, DISCORD_GUILD_NOT_LINKED_MESSAGE } from '../../utils/discordRoomFilter.js';

/**
 * `/check-in` — join a Live Event's roster from Discord (v2.135.0, ADR 0017).
 *
 * Check-in is the one thing a player MUST do before an event starts, and the
 * announcement that tells them about it lands in Discord. Making them leave for
 * the web page to press one button is exactly the friction the format exists to
 * remove, so the command mirrors `POST /events/:id/checkin` rule for rule.
 *
 * Scope: only events in rooms linked to the INVOKING guild are listed or
 * accepted (`resolveGuildReadScope`). A bare `FROM tournaments` here would be a
 * cross-room leak — see CLAUDE.md.
 */

interface OpenEventRow {
    id: string;
    name: string;
    game_room_id: string;
    checkin_opens_at: string | null;
    first_start: string | null;
}

/**
 * Events in scope that a player could still check into: not finished, and round
 * 1 has not started. Ordered soonest-first, because the one about to start is
 * almost always the one they mean.
 */
async function openEventsForScope(roomIds: string[]): Promise<OpenEventRow[]> {
    if (roomIds.length === 0) return [];
    const db = await getDatabase();
    const placeholders = roomIds.map(() => '?').join(',');
    return db.all<OpenEventRow[]>(
        `SELECT t.id, t.name, t.game_room_id, t.checkin_opens_at,
                (SELECT MIN(g.scheduled_start_at) FROM games g
                  WHERE g.tournament_id = t.id AND g.round_no IS NOT NULL) AS first_start
           FROM tournaments t
          WHERE t.game_room_id IN (${placeholders})
            AND t.format = 'event'
            AND t.is_active = 1
            AND t.event_finished_at IS NULL
          ORDER BY first_start ASC`,
        ...roomIds,
    );
}

const isOpenNow = (event: OpenEventRow, now: number) =>
    (!event.checkin_opens_at || now >= Date.parse(event.checkin_opens_at))
    && (!event.first_start || now < Date.parse(event.first_start));

export const checkin: Command = {
    data: new SlashCommandBuilder()
        .setName('check-in')
        .setDescription('Check in for a live event so your scores count.')
        .addStringOption(option =>
            option.setName('event')
                .setDescription('The event to check into')
                .setRequired(false)
                .setAutocomplete(true)),

    async autocomplete(interaction: AutocompleteInteraction) {
        try {
            const scope = await resolveGuildReadScope(interaction.guildId);
            if (!scope) return interaction.respond([]);
            const typed = interaction.options.getFocused().toLowerCase();
            const now = Date.now();
            const options = (await openEventsForScope(scope.roomIds))
                .filter(e => isOpenNow(e, now))
                .filter(e => e.name.toLowerCase().includes(typed))
                .slice(0, 25)
                .map(e => ({ name: e.name, value: e.id }));
            await interaction.respond(options);
        } catch {
            await interaction.respond([]);
        }
    },

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ ephemeral: true });
        try {
            const scope = await resolveGuildReadScope(interaction.guildId);
            if (!scope) {
                await interaction.editReply(DISCORD_GUILD_NOT_LINKED_MESSAGE);
                return;
            }

            const now = Date.now();
            const all = await openEventsForScope(scope.roomIds);
            const open = all.filter(e => isOpenNow(e, now));

            const requested = interaction.options.getString('event');
            let event: OpenEventRow | undefined;

            if (requested) {
                // Autocomplete supplies the id, but a player can type free text.
                event = all.find(e => e.id === requested)
                    ?? all.find(e => e.name.toLowerCase() === requested.toLowerCase());
                if (!event) {
                    await interaction.editReply(`No event called "${requested}" here.`);
                    return;
                }
            } else if (open.length === 1) {
                // The overwhelmingly common case: one event, about to start.
                event = open[0]!;
            } else if (open.length === 0) {
                await interaction.editReply(
                    all.length > 0
                        ? "Check-in isn't open for any event right now."
                        : 'There are no events running here at the moment.',
                );
                return;
            } else {
                await interaction.editReply(
                    `More than one event is open. Re-run \`/check-in\` with \`event:\` set to one of: ${open.map(e => e.name).join(', ')}.`,
                );
                return;
            }

            if (!event) {
                await interaction.editReply("Couldn't work out which event you meant.");
                return;
            }
            // Frozen after resolution so the rest of the handler reads against
            // one definite event rather than a maybe-undefined `let`.
            const target = event;

            // Room-aware ban check, once the event's room is known.
            const banned = await BanService.isIdentityBanned(interaction.user.id, target.game_room_id);
            if (banned.banned) {
                await interaction.editReply('This account is banned.');
                return;
            }

            // The same two gates the web route applies, in the same order, so
            // the two surfaces can never disagree about who got in.
            if (target.checkin_opens_at && now < Date.parse(target.checkin_opens_at)) {
                await interaction.editReply(
                    `Check-in for **${target.name}** hasn't opened yet — it opens <t:${Math.floor(Date.parse(target.checkin_opens_at) / 1000)}:R>.`,
                );
                return;
            }
            if (target.first_start && now >= Date.parse(target.first_start)) {
                await interaction.editReply(
                    `Check-in for **${target.name}** closed when round 1 started. Ask an admin to add you.`,
                );
                return;
            }

            const already = await EventService.isParticipant(target.id, interaction.user.id);
            await EventService.checkIn(target.id, interaction.user.id);
            const count = await EventService.participantCount(target.id);

            await interaction.editReply(
                already
                    ? `You're already checked in for **${target.name}** (${count} in).`
                    : `You're checked in for **${target.name}** — ${count} player${count === 1 ? '' : 's'} in. Good luck.`,
            );
        } catch (error) {
            logError('Discord /check-in failed:', error);
            await interaction.editReply('Something went wrong checking you in. Try the event page on the web.');
        }
    },
};
