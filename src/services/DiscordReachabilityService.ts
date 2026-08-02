import { getDatabase } from '../database/database.js';
import { isDiscordUserId } from '../utils/identityProvider.js';
import { logWarn } from '../utils/logger.js';
import { SettingsService } from './SettingsService.js';

/**
 * Discord DM deliverability (Discord HQ arc, v2.72.0).
 *
 * Discord's hard rule: a bot may DM a user only while they share at least one
 * guild with that bot. Rooms with their own Discord integration give their
 * players that shared guild for free; players in Discord-less ("standalone")
 * rooms have no shared guild at all, so every DM the notification system tries
 * to send them fails — silently, from the player's point of view.
 *
 * The global Arcaid community server ("Arcaid HQ") closes that gap: one guild
 * every player can join, purely so the DM channel exists. This service answers
 * the one question the rest of the arc is built on — *can we DM this user?* —
 * without sending anything.
 *
 * SHIPS INERT. With `GLOBAL_DISCORD_GUILD_ID` unset there is no global guild to
 * check, `isConfigured()` is false, and every caller that could change behavior
 * on a reachability verdict is gated on it (see `NotificationService.notify`'s
 * known-unreachable short-circuit). `canDm` still answers honestly from the
 * room guilds alone, because the settings page's status line is a read-only
 * claim and is allowed to be useful before the owner configures HQ.
 *
 * Neither of the two global settings is a secret (a guild id is public in every
 * invite link; the invite URL is meant to be handed out), so neither belongs in
 * `ENCRYPTED_SETTING_KEYS` — see ADR 0003 on that allowlist being deliberate.
 */

/** Global setting: the Arcaid HQ guild id. Unset → the whole arc is inert. */
export const GLOBAL_DISCORD_GUILD_ID = 'GLOBAL_DISCORD_GUILD_ID';

/** Global setting: optional manual invite link shown as a fallback join path. */
export const GLOBAL_DISCORD_INVITE_URL = 'GLOBAL_DISCORD_INVITE_URL';

export type ReachabilityVia = 'global' | 'room_guild' | null;

export interface Reachability {
    /** True when the user shares a guild with the bot (so a DM can be routed). */
    reachable: boolean;
    /** Which guild class produced the verdict. Null when not reachable. */
    via: ReachabilityVia;
    /**
     * Room name behind a `room_guild` verdict, for the settings page's
     * "you share <room's server>" copy. Null otherwise (and when the guild maps
     * to a room row we could not name).
     */
    viaRoomName: string | null;
    /**
     * Whether the gateway was up when this verdict was computed. A false
     * verdict with `gatewayReady: false` means "we could not tell", NOT "not
     * reachable" — DMs ride REST and keep working while the gateway is down, so
     * no caller may suppress a send on that combination.
     */
    gatewayReady: boolean;
}

interface CacheEntry {
    value: Reachability;
    expiresAt: number;
}

// Positive verdicts are stable (guild membership rarely churns) and expensive
// to recompute; negative ones must expire fast so the connect flow's "✅" flip
// feels immediate. Gateway-down verdicts are never cached at all.
const POSITIVE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;

const cache = new Map<string, CacheEntry>();

const UNREACHABLE: Reachability = { reachable: false, via: null, viaRoomName: null, gatewayReady: false };

export class DiscordReachabilityService {
    /**
     * Whether the global-guild feature is configured at all. Every behavior
     * change in the arc (the connect button, the notify() short-circuit) is
     * gated on this so an unconfigured server behaves exactly as it did before.
     */
    static async isConfigured(): Promise<boolean> {
        return !!(await this.getGlobalGuildId());
    }

    /** The configured HQ guild id, or null. Trimmed; empty string reads as unset. */
    static async getGlobalGuildId(): Promise<string | null> {
        try {
            const raw = await SettingsService.get(GLOBAL_DISCORD_GUILD_ID);
            const trimmed = raw?.trim();
            return trimmed ? trimmed : null;
        } catch {
            return null;
        }
    }

    /** The optional manual invite URL, or null. Only `https://` links are served. */
    static async getInviteUrl(): Promise<string | null> {
        try {
            const raw = (await SettingsService.get(GLOBAL_DISCORD_INVITE_URL))?.trim();
            if (!raw) return null;
            if (!/^https:\/\//i.test(raw)) {
                logWarn(`DiscordReachabilityService: ${GLOBAL_DISCORD_INVITE_URL} is not an https:// URL — ignoring.`);
                return null;
            }
            return raw;
        } catch {
            return null;
        }
    }

    /**
     * Can the bot DM this user?
     *
     * Checks the HQ guild first (cheapest, and the answer we most want to be
     * true), then every distinct Discord-enabled room guild. Positive results
     * cache for 10 minutes, negative for 1; gateway-down results are not cached.
     *
     * Caveat worth stating plainly, because the product copy depends on it: a
     * true verdict means a DM *can be routed*, not that it will land. A user who
     * has turned off "Allow direct messages from server members" for the shared
     * guild still rejects the message with Discord error 50007. That is what the
     * Section-4 nudge exists to catch. Never promise delivery on this verdict.
     */
    static async canDm(discordUserId: string | null | undefined): Promise<Reachability> {
        // A `google:<sub>` identity has no Discord account, so no DM channel can
        // ever exist for it — answer without touching the gateway.
        if (!discordUserId || !isDiscordUserId(discordUserId)) return { ...UNREACHABLE };

        const cached = cache.get(discordUserId);
        if (cached && cached.expiresAt > Date.now()) return { ...cached.value };

        const { getDiscordClient } = await import('../discord/DiscordClient.js');
        const client = getDiscordClient();
        if (!client || !client.isReady()) {
            // Not cached: "we could not tell" must be re-asked, not remembered.
            return { ...UNREACHABLE };
        }

        let verdict: Reachability = { reachable: false, via: null, viaRoomName: null, gatewayReady: true };

        const globalGuildId = await this.getGlobalGuildId();
        if (globalGuildId && (await client.isMemberOfGuild(globalGuildId, discordUserId))) {
            verdict = { reachable: true, via: 'global', viaRoomName: null, gatewayReady: true };
        } else {
            for (const room of await this.getRoomGuilds()) {
                if (await client.isMemberOfGuild(room.guildId, discordUserId)) {
                    verdict = { reachable: true, via: 'room_guild', viaRoomName: room.roomName, gatewayReady: true };
                    break;
                }
            }
        }

        cache.set(discordUserId, {
            value: verdict,
            expiresAt: Date.now() + (verdict.reachable ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
        });
        return { ...verdict };
    }

    /**
     * Distinct guild ids from rooms with Discord integration ON, each with a
     * room name for the status-line copy. A room with `DISCORD_ENABLED=false`
     * is excluded: its players are exactly the population this arc serves, and
     * claiming reachability through a guild whose room has Discord switched off
     * would be a promise the notification path deliberately does not keep
     * (`NotificationService.notify` step 0a suppresses those DMs).
     */
    private static async getRoomGuilds(): Promise<Array<{ guildId: string; roomName: string | null }>> {
        try {
            const db = await getDatabase();
            const rows = await db.all(
                `SELECT s.value AS guild_id, r.name AS room_name
                   FROM game_room_settings s
                   LEFT JOIN game_rooms r ON r.id = s.game_room_id
                  WHERE s.key = 'DISCORD_GUILD_ID'
                    AND s.value IS NOT NULL AND s.value != ''
                    AND COALESCE(
                          (SELECT e.value FROM game_room_settings e
                            WHERE e.game_room_id = s.game_room_id AND e.key = 'DISCORD_ENABLED'),
                          'true') != 'false'`,
            ) as Array<{ guild_id: string; room_name: string | null }>;

            const seen = new Set<string>();
            const out: Array<{ guildId: string; roomName: string | null }> = [];
            for (const row of rows) {
                const guildId = row.guild_id?.trim();
                if (!guildId || seen.has(guildId)) continue;
                seen.add(guildId);
                out.push({ guildId, roomName: row.room_name ?? null });
            }
            return out;
        } catch {
            return [];
        }
    }

    /**
     * Drop a user's cached verdict. Called right after the connect flow adds
     * them to HQ so the settings page's status line flips on the next read
     * instead of waiting out the negative TTL.
     */
    static invalidate(discordUserId: string): void {
        cache.delete(discordUserId);
    }

    /** Test-only: clear every cached verdict between cases. */
    static _resetForTesting(): void {
        cache.clear();
    }
}
