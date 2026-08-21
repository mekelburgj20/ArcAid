import { CalloutAction, CalloutEntry } from './callouts.js';

/**
 * The default entry for every built-in live answer (v2.125.0).
 *
 * WHY THIS EXISTS: an `action` is useless until some entry's triggers point at
 * it, and the only list most deployments have is the legacy `data/callouts.json`
 * seed — which predates all ten actions. Without a seeder, shipping a new live
 * answer would ship a feature nobody could reach: the super admin would have to
 * hand-add a row per action per deployment before anyone saw a difference.
 *
 * `CalloutService.ensureBuiltinHelpEntries` inserts one row per action that has
 * NO row at all (enabled or disabled). It never updates, never re-adds, and
 * never reorders — so an admin who rewrites the triggers, moves the entry, or
 * switches it off keeps that decision through every restart. The
 * enabled-or-disabled test is the load-bearing half: matching on enabled rows
 * only would resurrect an entry the admin deliberately silenced.
 *
 * Triggers are phrased as things people actually type in a Discord channel,
 * with the contraction and its expansion both listed — the matcher folds curly
 * apostrophes but does not expand "who's" to "who is".
 */
export const BUILTIN_HELP_TRIGGERS: Record<CalloutAction, string[]> = {
    active_games: [
        "what's active", 'what is active', "what's the table", 'what is the table',
        "what's on", 'current game', 'active games',
    ],
    picks_link: ['pick a game', 'how do i pick', 'where do i pick', 'picks page'],
    scores_link: ['scoreboard', 'leaderboard link', 'where are the scores', 'standings'],
    how_to_submit: [
        'how do i submit', 'how to submit', 'submit a score', 'submit my score',
    ],
    time_left: [
        'how long left', 'time left', 'when does it end', 'when does the round end',
        'next rotation', 'when is the rotation', 'rotation time',
    ],
    leaders: [
        "who's winning", 'who is winning', 'top score', 'current leader', 'high score',
    ],
    my_rank: ['my rank', 'where am i', 'my score', 'my position'],
    pick_status: [
        'whose pick', 'who picks next', "who's picking", 'pick status', 'queue status',
    ],
    tournament_rules: [
        'rules', 'cooldown', "what's eligible", 'what is eligible', 'can i pick',
        'platform rules',
    ],
    how_to_claim: [
        'claim my name', 'link my name', 'how do i claim', 'how do i link',
        'not getting picks',
    ],
};

/**
 * The seed rows, in the order they are appended. Every one is `help`: these
 * answer a question, so they must survive in a room that has turned the fun
 * off, and they are the category the per-channel cooldown deliberately skips.
 */
export const BUILTIN_HELP_ENTRIES: CalloutEntry[] = (
    Object.entries(BUILTIN_HELP_TRIGGERS) as Array<[CalloutAction, string[]]>
).map(([action, triggers]) => ({ triggers, action, category: 'help' as const }));
