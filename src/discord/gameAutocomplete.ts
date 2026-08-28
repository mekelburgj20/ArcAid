import { getDatabase } from '../database/database.js';
import { TournamentEngine } from '../engine/TournamentEngine.js';
import {
    parseTournamentRules, emptyTournamentRules, firstQualifyingVariant, parsePlatformsList,
    type TournamentRules, type QualificationVariant,
} from '../utils/platformRules.js';
import { rankName } from '../utils/searchRank.js';

/**
 * The `game` autocomplete shared by `/pick-game` and `/nominate-picker queue`
 * (v2.121.0).
 *
 * Lifted verbatim out of `pickgame.ts` when the admin queue-on-behalf
 * subcommand needed the same list: both must offer exactly the games that
 * tournament will accept, or an admin ends up picking something the shared
 * eligibility pipeline then rejects. GUILD SCOPING IS THE CALLER'S JOB — this
 * helper takes an already-resolved tournament row, and every caller resolves
 * it through `resolveGuildReadScope` first.
 */

/** The tournament fields the filter needs. `null` = no tournament chosen yet. */
export interface AutocompleteTournament {
    id: string;
    mode: string | null;
    game_room_id: string | null;
    /** Raw `tournaments.platform_rules` blob — read via `parseTournamentRules`. */
    platform_rules?: string | null;
}

/**
 * Up to 25 Discord choices for the catalogue, filtered by the tournament's
 * mode + platform rules (∪ the room's game tags) and ranked
 * nearest-exact-match first. Cooldown-blocked games stay in the list but are
 * labelled `(recently played)` — same as the pre-extraction behaviour.
 */
export async function buildGameAutocompleteChoices(
    tournament: AutocompleteTournament | null,
    query: string,
): Promise<Array<{ name: string; value: string }>> {
    const db = await getDatabase();

    const tournamentId = tournament?.id ?? null;
    const tournamentMode = tournament?.mode ?? null;
    const tournamentRoomId = tournament?.game_room_id ?? null;
    const platformRules: TournamentRules = tournament ? parseTournamentRules(tournament) : emptyTournamentRules();

    // Fetch the catalogue for autocomplete — one row per catalogue VARIANT
    // (not per name). v2.144.1: a prior `GROUP BY LOWER(name)` +
    // `MIN()`-per-column here could pair one variant's `platforms` with a
    // DIFFERENT variant's `features` (the Walking Dead miss); qualification
    // must judge each variant's platforms + features together, never mixed.
    const rows = await db.all(`
        SELECT name, type AS mode, platforms, features
        FROM global_games WHERE status = 'approved'
    `);

    // Group by name (case-insensitive) into per-name variant lists.
    const grouped = new Map<string, { name: string; variants: QualificationVariant[] }>();
    for (const r of rows) {
        const key = r.name.toLowerCase();
        const entry = grouped.get(key) ?? { name: r.name, variants: [] as QualificationVariant[] };
        entry.variants.push({
            mode: r.mode,
            platforms: parsePlatformsList(r.platforms || '[]'),
            features: parsePlatformsList(r.features || '[]'),
        });
        grouped.set(key, entry);
    }

    // Pre-load this room's tag map (name → tags) so the platform-rule filter
    // unions room tags into each game's effective platforms. Single query —
    // much cheaper than per-game lookup at autocomplete latencies.
    let tagMap: Map<string, string[]> = new Map();
    if (tournamentRoomId) {
        const { RoomGameTagsService } = await import('../services/RoomGameTagsService.js');
        tagMap = await RoomGameTagsService.getTagMapByGameNameForRoom(tournamentRoomId);
    }

    // Filter by tournament mode + platform rules + the v2.102.2
    // no-submittable-platform hide (mirrors game-availability's JS gate
    // exactly: a game whose EVERY platform the rules exclude can be picked
    // but never scored, so it stays out of the list; a game merely CARRYING
    // an excluded platform — e.g. a real machine with a VPXS port in a VPXS
    // tournament — stays IN, per ADR 0009's excluded-is-not-eligibility). A
    // name qualifies iff ANY ONE of its catalogue variants qualifies on its
    // own — never a MIN-mixed pair (v2.144.1).
    const choices = [...grouped.values()].filter(g => {
        const tags = tagMap.get(g.name.toLowerCase()) || [];
        return !!firstQualifyingVariant(g.variants, tournamentMode, platformRules, tags, { requireSubmittable: true });
    });

    // Filter by what the user is currently typing, ranked nearest-exact-match
    // first (search-relevance work package, 2026-08-13) before slicing to
    // Discord's 25-choice cap.
    const filtered = choices
        .filter(r => r.name.toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => {
            const diff = rankName(a.name, query) - rankName(b.name, query);
            return diff !== 0 ? diff : a.name.localeCompare(b.name);
        })
        .slice(0, 25);

    // Check eligibility for display labels
    const engine = TournamentEngine.getInstance();
    const results = await Promise.all(filtered.map(async (r) => {
        if (!tournamentId) return { name: r.name, label: r.name };
        const eligible = await engine.isGameEligible(tournamentId, r.name);
        const label = eligible ? r.name : `${r.name} (recently played)`;
        return { name: r.name, label };
    }));

    return results.map(r => ({ name: r.label, value: r.name }));
}
