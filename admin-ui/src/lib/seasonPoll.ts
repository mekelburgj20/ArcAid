/**
 * Pure helpers + types for the public Season poll card (components/SeasonPollCard.tsx).
 * Kept out of the component module so react-refresh's only-export-components holds.
 */

export interface SeasonPollCandidate {
    position: number;
    game_name: string;
    global_game_id: string | null;
    votes: number;
}

export interface SeasonOpenPoll {
    id: string;
    slot_no: number;
    question: string;
    opens_at: string | null;
    closes_at: string | null;
    posted_at: string | null;
    discord_url: string | null;
    candidates: SeasonPollCandidate[];
    total_votes: number;
    my_vote: number | null;
}

export interface SeasonSummary {
    tournament_id: string;
    name: string;
    open_poll: SeasonOpenPoll | null;
    [key: string]: unknown;
}

/** "2 days 4 hr" / "3 hr 12 min" / "5 min". Null once the time has passed. */
export function closesInLabel(closesAt: string | null, now: number): string | null {
    if (!closesAt) return null;
    const ms = Date.parse(closesAt) - now;
    if (!Number.isFinite(ms)) return null;
    if (ms <= 0) return 'Closing now';
    const totalMin = Math.floor(ms / 60000);
    const days = Math.floor(totalMin / (24 * 60));
    const hours = Math.floor((totalMin % (24 * 60)) / 60);
    const mins = totalMin % 60;
    let span: string;
    if (days > 0) span = hours > 0 ? `${days} day${days === 1 ? '' : 's'} ${hours} hr` : `${days} day${days === 1 ? '' : 's'}`;
    else if (hours > 0) span = mins > 0 ? `${hours} hr ${mins} min` : `${hours} hr`;
    else span = `${Math.max(1, mins)} min`;
    return `Closes in ${span}`;
}

/** Move the viewer's vote from `poll.my_vote` to `next` (null = withdraw), adjusting the tally. */
export function applyVote(poll: SeasonOpenPoll, next: number | null): SeasonOpenPoll {
    const prev = poll.my_vote;
    if (prev === next) return poll;
    const candidates = poll.candidates.map(c => {
        let votes = c.votes;
        if (prev !== null && c.position === prev) votes = Math.max(0, votes - 1);
        if (next !== null && c.position === next) votes += 1;
        return votes === c.votes ? c : { ...c, votes };
    });
    const total = poll.total_votes + (prev === null ? 0 : -1) + (next === null ? 0 : 1);
    return { ...poll, candidates, total_votes: Math.max(0, total), my_vote: next };
}

