import { RoomAccessService } from '../services/RoomAccessService.js';
import { discordExcludedRoomIds } from './discordRoomFilter.js';

/**
 * Why the resolved reason is a room, not a text — see the exports below.
 */
export type DiscordWriteTargetDenial = 'suspended' | 'not_linked';

export interface DiscordWriteTargetResult {
    allowed: boolean;
    denial?: DiscordWriteTargetDenial;
}

/**
 * Cross-room write guard for Discord commands that resolve their target by
 * NAME (tournament/game/room lookups aren't guild-scoped). Same root cause as
 * the v2.44.0 M1 suspension-check fix in `activategame.ts`/`pickgame.ts`/
 * `submitscore.ts`/`forcemaintenance.ts`: the guild-level interaction gate
 * (`guildInteractionBlockReason` in `discord.ts`) only knows the INVOKING
 * guild has SOME enabled, non-suspended room — it never checks that the room
 * a write command is actually about to mutate is the same one. A user in
 * Guild A can name a tournament/game that belongs to Room B (linked to Guild
 * B) and, pre-this-fix, mutate it from Guild A.
 *
 * Rejects (returns `allowed: false`) when:
 *   (a) `denial: 'suspended'` — the room is suspended
 *       (`RoomAccessService.isSuspended`). Checked first, independent of
 *       everything else, matching `guildInteractionBlockReason`'s ordering.
 *   (b) `denial: 'not_linked'` — the room is Discord-disabled or
 *       approval-gated (`discordExcludedRoomIds` — the same exclusion set the
 *       READ commands filter out of their results via
 *       `buildEnabledRoomSqlFilter`; a write command reaching a room a read
 *       command would never have surfaced is the same leak in the other
 *       direction), OR
 *   (c) `denial: 'not_linked'` — the room's linked `DISCORD_GUILD_ID` does
 *       not match the invoking guild. Precedence is per-room setting → env
 *       fallback (`process.env.DISCORD_GUILD_ID`), the same precedence
 *       `getIScoredCredsForRoom` uses for iScored creds — a room with NO
 *       per-room guild id configured (legacy single-room deployments, before
 *       multi-room existed) is reachable ONLY when the env fallback guild is
 *       the one invoking.
 *
 * Returns `{ allowed: true }` when `roomId` is null/undefined (no room
 * attribution — e.g. a legacy manual/unmanaged game — nothing to validate
 * against) or when every check above passes.
 *
 * Callers own the user-facing text: `denial` is a code, not a message, so
 * each command can keep its own established suspended-room wording ("Game
 * activation is disabled." vs "Game picking is disabled." etc.) and only need
 * a new string for `'not_linked'` — recommended: "That game belongs to a
 * room this server isn't linked to."
 */
export async function validateDiscordWriteTarget(
    roomId: string | null | undefined,
    invokingGuildId: string | null | undefined,
): Promise<DiscordWriteTargetResult> {
    if (!roomId) return { allowed: true };

    if (await RoomAccessService.isSuspended(roomId)) {
        return { allowed: false, denial: 'suspended' };
    }

    const excluded = await discordExcludedRoomIds();
    if (excluded.includes(roomId)) {
        return { allowed: false, denial: 'not_linked' };
    }

    const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');
    const perRoomGuildId = await GameRoomSettingsService.get(roomId, 'DISCORD_GUILD_ID');
    const effectiveGuildId = perRoomGuildId || process.env.DISCORD_GUILD_ID || null;
    if (!effectiveGuildId || effectiveGuildId !== invokingGuildId) {
        return { allowed: false, denial: 'not_linked' };
    }

    return { allowed: true };
}
