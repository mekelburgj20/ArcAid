import { describe, it, expect } from 'vitest';
import fixture from './fixtures/run-recap-lis.json';
import { computeRunRecap, type RecapPrefs, type RecapScoreRow } from '../utils/runRecapCompute.js';
import { buildRunRecapText, splitRecapForBot, DISCORD_BOT_MAX, DISCORD_COPY_MAX } from '../utils/runRecapText.js';
import type { RecapPlayerRow, RunRecap } from '../types/runRecap.js';

const rows: RecapScoreRow[] = fixture.score_history.map(r => ({
    history_id: r.id, key: r.submitted_by_user_id, iscored_username: r.iscored_username, discord_user_id: r.submitted_by_user_id,
    submitted_by_user_id: r.submitted_by_user_id, score: r.score, source: r.source, created_at: r.created_at,
}));

function standings(list: RecapScoreRow[]) {
    const best = new Map<string, RecapScoreRow>();
    for (const r of [...list].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.history_id - b.history_id)) {
        const cur = best.get(r.key);
        if (!cur || r.score > cur.score) best.set(r.key, r);
    }
    return [...best.values()].sort((a, b) => b.score - a.score)
        .map((r, i) => ({ key: r.key, rank: i + 1, history_id: r.history_id, score: r.score, created_at: r.created_at }));
}

function recapOf(list: RecapScoreRow[], opts: {
    prefs?: Map<string, RecapPrefs>; state?: 'active' | 'completed'; nameOf?: (key: string, user: string) => string;
    tournament?: string; game?: string; round?: number | null;
} = {}): Omit<RunRecap, 'discord_text'> {
    const state = opts.state ?? 'completed';
    const c = computeRunRecap({
        rows: list, standings: standings(list), prefs: opts.prefs ?? new Map(), timezone: fixture.timezone, state,
        start_date: fixture.game.start_date, end_date: fixture.game.end_date, close_at: fixture.game.end_date,
        attemptsUsed: null, now: new Date('2026-11-27T12:00:00Z'),
    });
    const userOf = new Map(list.map(r => [r.key, r.iscored_username]));
    const players: RecapPlayerRow[] = c.players.map(p => ({
        ...p, iscored_username: userOf.get(p.key)!, display_name: opts.nameOf ? opts.nameOf(p.key, userOf.get(p.key)!) : null,
        discord_user_id: p.key, avatar_hash: null, avatar_url: null,
    }));
    return {
        version: 1,
        run: {
            game_id: 'g', game_name: opts.game ?? fixture.game.name, tournament_id: 't', tournament_name: opts.tournament ?? fixture.tournament.name,
            tournament_type: 'custom', format: 'rotation', round_no: opts.round ?? null, state,
            start_date: fixture.game.start_date, end_date: fixture.game.end_date, close_at: fixture.game.end_date,
            timezone: fixture.timezone, image_url: null, max_attempts: null,
        },
        totals: c.totals, hero: c.hero, players, lead_changes: c.lead_changes, lead_steps: c.lead_steps, awards: c.awards,
        per_day: c.per_day, facts: c.facts, generated_at: '2026-11-27T12:00:00.000Z',
    };
}

describe('run recap Discord text, reference run', () => {
    const recap = recapOf(rows);
    const text = buildRunRecapText(recap, { maxChars: DISCORD_COPY_MAX, link: 'https://example.test/r/t?run=g&recap=1' });

    it('has the section shape of the hand-built recap', () => {
        const lines = text.split('\n');
        expect(lines[0]).toBe('# Lost in Space ▸ by the numbers');
        expect(lines[1]).toBe('-# Test Season · Fri Nov 20 – Thu Nov 26 · 335 games from 11 players on Arcaid Witness');
        expect(text).toContain('## ▸ Lead changes');
        expect(text).toContain('## ▸ Leaderboard');
        expect(text).toContain('## ▸ Awards');
        expect(text).toContain('## ▸ Games per day');
        const heads = lines.filter(l => l.startsWith('## ')).map(l => l.replace('## ▸ ', ''));
        expect(heads.slice(1)).toEqual(['Lead changes', 'Leaderboard', 'Awards', 'Games per day']);
        expect(heads[0]).toMatch(/ wins with 492,315,750$/);
    });

    it('hero sentence and bullets', () => {
        expect(text).toContain('The winning score was game #22 of 22 (the last), Thursday around 4 pm, about 7 hours before the close.');
        expect(text).toContain('- Games by day: 16 Fri, 2 Sat, 4 Thu');
        expect(text).toContain('- Won it on game #4 of the day');
        expect(text).toContain('- Half of their games scored 84.6M or more');
    });

    it('lead list: weekday times, scores, annotations', () => {
        expect(text).toMatch(/Fri  8:04am {2}Player \w {2,}\s*31\.4M {2}← first score/);
        expect(text).toMatch(/← takes first\n/);
        expect(text).toMatch(/← takes first, wins it\n```/);
    });

    it('leaderboard rows in rank order with dashes for typed-only players', () => {
        const lb = text.split('## ▸ Leaderboard\n```\n')[1]!.split('\n```')[0]!.split('\n');
        expect(lb[0]).toMatch(/^Player\s+Games\s+Avg\s+Median\s+Best$/);
        expect(lb).toHaveLength(1 + 10 + 1);
        expect(lb[1]).toMatch(/\s22 116\.2M\s+84\.6M 492\.3M$/);
        expect(lb[lb.length - 1]).toBe('+ 11 more players');
    });

    it('games per day bars', () => {
        expect(text).toContain('Fri 11/20  79  ' + '█'.repeat(20));
        expect(text).toContain('Sat 11/21  43  ' + '█'.repeat(11));
        expect(text).toContain('Tue 11/24   9  ' + '█'.repeat(2));
    });

    it('footnote and link', () => {
        expect(text).toContain('-# Games, averages and medians count only games recorded by Arcaid Witness; scores typed in or synced count for the standings and the lead. Times are Chicago time.');
        expect(text.endsWith('-# Full recap: <https://example.test/r/t?run=g&recap=1>')).toBe(true);
    });

    it('fits the Nitro limit, has no emoji and no raw ids', () => {
        expect(text.length).toBeLessThanOrEqual(DISCORD_COPY_MAX);
        expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
        expect(/\d{15,}/.test(text)).toBe(false);
    });

    it('private players show a footnote count and dashes', () => {
        const key = rows.filter(r => r.source === 'vpx').find(r => r.iscored_username)!.key;
        const hidden = recapOf(rows, { prefs: new Map([[key, { playStats: false, timeOfDay: false }]]) });
        const t = buildRunRecapText(hidden, { maxChars: DISCORD_COPY_MAX });
        expect(t).toContain('1 player keeps their play stats private.');
    });
});

describe('run recap text edge cases', () => {
    it('no scores: title, subtitle and one line', () => {
        const t = buildRunRecapText(recapOf([]), { maxChars: DISCORD_COPY_MAX });
        expect(t.split('\n')).toHaveLength(4);
        expect(t).toContain('No scores were posted in this run.');
    });

    it('typed-only run: players subtitle, "typed in", no per-day', () => {
        const typed = rows.filter(r => r.source !== 'vpx');
        const t = buildRunRecapText(recapOf(typed), { maxChars: DISCORD_COPY_MAX });
        expect(t.split('\n')[1]).toMatch(/ · \d+ players?$/);
        expect(t).toContain('The winning score was typed in,');
        expect(t).not.toContain('Games per day');
    });

    it('an active run says "so far" and "leads with"', () => {
        const t = buildRunRecapText(recapOf(rows, { state: 'active' }), { maxChars: DISCORD_COPY_MAX });
        expect(t.split('\n')[1]).toMatch(/ · so far$/);
        expect(t).toMatch(/ leads with /);
        expect(t).toMatch(/posted .* ago\./);
    });

    it('markdown in names is escaped outside code and defanged inside', () => {
        const t = buildRunRecapText(recapOf(rows, { nameOf: (_k, u) => (u === 'Player L' ? 'a_b*c`d~' : null) as unknown as string }), { maxChars: DISCORD_COPY_MAX });
        expect(t).toContain('a\\_b\\*c\\`d\\~');
        expect(t).toContain("a_b*c'd~");
    });

    it('round recaps name the round; game titles are never cut but long player names are', () => {
        const longGame = 'A Table With A Really Quite Long Title Indeed';
        const t = buildRunRecapText(recapOf(rows, { game: longGame, round: 2, nameOf: (_k, u) => (u === 'Player L' ? 'Z'.repeat(30) : null) as unknown as string }), { maxChars: DISCORD_COPY_MAX });
        expect(t.split('\n')[0]).toContain(longGame);
        expect(t.split('\n')[1]).toContain('Round 2');
        // Inside the code blocks a long player name is cut to 16 code points; prose keeps the full name.
        const code = t.split('```').filter((_, i) => i % 2 === 1).join('\n');
        expect(code).toContain('Z'.repeat(15) + '…');
        expect(code).not.toContain('Z'.repeat(16));
    });

    it('a 60-player, 40-change, long-name run stays within the limit', () => {
        const big: RecapScoreRow[] = [];
        let id = 100000;
        for (let p = 0; p < 60; p++) {
            for (let g = 0; g < 4; g++) {
                big.push({
                    history_id: id++, key: `k${p}`, iscored_username: `A very long player name number ${p}`, discord_user_id: `k${p}`,
                    submitted_by_user_id: `k${p}`, score: (p * 4 + g + 1) * 1_000_003 + (g === 0 ? 0 : p), source: 'vpx',
                    created_at: new Date(Date.UTC(2026, 10, 20, 12, 0, 0) + (p * 4 + g) * 11 * 60_000).toISOString().replace('T', ' ').slice(0, 19),
                });
            }
        }
        const recap = recapOf(big, { tournament: 'T'.repeat(80), game: 'G'.repeat(60) });
        expect(recap.lead_changes.length).toBeGreaterThan(40);
        const t = buildRunRecapText(recap, { maxChars: DISCORD_COPY_MAX, link: 'https://example.test/x' });
        expect(t.length).toBeLessThanOrEqual(DISCORD_COPY_MAX);
        expect(t.split('\n')[0]).toContain('G'.repeat(60));
        expect(t).toContain('-# Full recap: <https://example.test/x>');
        // Tight budgets still keep the title, hero header and footnote.
        const tight = buildRunRecapText(recap, { maxChars: 900 });
        expect(tight.length).toBeLessThanOrEqual(1200);
        expect(tight).toContain('## ▸');
        expect(tight).toContain('-# Games, averages');
    });
});

describe('mentions and links in names', () => {
    const evil: Record<string, string> = {
        'Player G': '@everyone', 'Player L': '<@123456789012345678>', 'Player B': '[free](https://x.y)', 'Player R': '@here <@&99>',
    };
    const t = buildRunRecapText(
        recapOf(rows, { nameOf: (_k, u) => (evil[u] ?? null) as unknown as string }),
        { maxChars: DISCORD_COPY_MAX },
    );
    const prose = t.split('```').filter((_, i) => i % 2 === 0).join('\n');

    it('cannot ping: every @ is followed by a zero-width space', () => {
        expect(prose).not.toMatch(/@(?!\u200B)/);
        expect(prose).toContain('@\u200Beveryone');
        // Inside code blocks nothing pings, so only prose is checked; the winner and award names are prose.
        expect(t).toContain('@\u200Beveryone wins with');
    });

    it('cannot mention or link: <, [ and ] are escaped', () => {
        expect(prose).not.toMatch(/(?<!\\)</);
        expect(prose).toContain('\\<@\u200B123456789012345678>');
        expect(prose).toContain('\\[free\\](https://x.y)');
        expect(prose).not.toMatch(/(?<!\\)\[free/);
    });

    it('keeps the footer link in angle brackets', () => {
        const withLink = buildRunRecapText(recapOf(rows), { maxChars: DISCORD_COPY_MAX, link: 'https://example.test/x' });
        expect(withLink).toContain('-# Full recap: <https://example.test/x>');
    });
});

describe('splitRecapForBot fences', () => {
    it('does not split at a "## " line inside a code block', () => {
        const names = (_k: string, u: string) => (u === 'Player L' ? '## Evil' : null) as unknown as string;
        const text = buildRunRecapText(recapOf(rows, { nameOf: names }), { maxChars: DISCORD_COPY_MAX });
        expect(text).toContain('\n## Evil');
        const chunks = splitRecapForBot(text, 700);
        expect(chunks.length).toBeGreaterThan(1);
        for (const c of chunks) {
            expect((c.match(/^```/gm) ?? []).length % 2).toBe(0);
            expect(c.length).toBeLessThanOrEqual(700);
        }
        for (const c of chunks.slice(1)) expect(c.startsWith('## \u25B8')).toBe(true);
    });

    it('splits sections on a "## " line outside a fence only', () => {
        const text = `# t\n## \u25B8 A\n\`\`\`\n## inside\nrow\n\`\`\`\n## \u25B8 B\nbody`;
        expect(splitRecapForBot(text, 30)).toEqual([`# t`, `## \u25B8 A\n\`\`\`\n## inside\nrow\n\`\`\``, `## \u25B8 B\nbody`]);
    });
});

describe('splitRecapForBot', () => {
    const recap = recapOf(rows);
    const text = buildRunRecapText(recap, { maxChars: DISCORD_COPY_MAX });

    it('chunks at section boundaries within the bot limit, at most three', () => {
        // The reference text is under the bot limit whole; a smaller limit forces the split.
        expect(splitRecapForBot(text, DISCORD_BOT_MAX)).toEqual([text]);
        const chunks = splitRecapForBot(text, 1300);
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.length).toBeLessThanOrEqual(3);
        for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1300);
        expect(chunks.join('\n\n')).toBe(text);
        for (const c of chunks) expect((c.match(/```/g) ?? []).length % 2).toBe(0);
        for (const c of chunks.slice(1)) expect(c.startsWith('## ')).toBe(true);
    });

    it('returns short text whole', () => {
        expect(splitRecapForBot('hello')).toEqual(['hello']);
    });

    it('never splits inside a code block when one section is oversized', () => {
        const body = Array.from({ length: 80 }, (_, i) => `line ${String(i).padStart(3, '0')} xxxxxxxxxxxxxxxxxxxxxxxxxx`).join('\n');
        const chunks = splitRecapForBot(`# t\n## ▸ Big\n\`\`\`\n${body}\n\`\`\``, 500);
        expect(chunks.length).toBeGreaterThan(1);
        for (const c of chunks) {
            expect(c.length).toBeLessThanOrEqual(500);
            expect((c.match(/```/g) ?? []).length % 2).toBe(0);
        }
    });
});
