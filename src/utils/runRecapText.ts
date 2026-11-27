import type { RecapLeadChange, RecapPlayerRow, RunRecap } from '../types/runRecap.js';

/**
 * The Discord text of a run recap (B31.1; docs/run-recap-plan.md "Discord text").
 *
 * Pure: the recap in, a string out. Self-contained on purpose (the compute module
 * imports `abbrevScore` / `wordsScore` from here, so this file imports nothing
 * but types). Names are `display_name ?? iscored_username`, never a key or an
 * id. No emoji.
 */

export const DISCORD_COPY_MAX = 4000;   // the owner pastes as a Nitro user
export const DISCORD_BOT_MAX = 2000;    // a bot message's content limit (Nitro does not apply to bots)

const NAME_MAX = 16;
const BAR_MAX = 20;

// ---- score formatting ----

const ABBREV = [
    { v: 1e12, s: 'T' },
    { v: 1e9, s: 'B' },
    { v: 1e6, s: 'M' },
    { v: 1e3, s: 'K' },
];

/** 950 / 31.4K / 116.2M / 8.6B / 1.2T: one decimal, a trailing .0 is kept ("92.0M"). */
export function abbrevScore(n: number): string {
    const abs = Math.abs(n);
    if (abs < 1000) return String(Math.round(n));
    let idx = ABBREV.findIndex(u => abs >= u.v);
    let scaled = (abs / ABBREV[idx]!.v);
    let fixed = scaled.toFixed(1);
    if (Number(fixed) >= 1000 && idx > 0) {
        idx -= 1;
        scaled = abs / ABBREV[idx]!.v;
        fixed = scaled.toFixed(1);
    }
    return `${n < 0 ? '-' : ''}${fixed}${ABBREV[idx]!.s}`;
}

const WORDS = [
    { v: 1e12, w: 'trillion' },
    { v: 1e9, w: 'billion' },
    { v: 1e6, w: 'million' },
];

/** "8.58 billion": three significant digits. Below a million: grouped digits. */
export function wordsScore(n: number): string {
    const abs = Math.abs(n);
    if (abs < 1e6) return Math.round(n).toLocaleString('en-US');
    let idx = WORDS.findIndex(u => abs >= u.v);
    let value = Number((abs / WORDS[idx]!.v).toPrecision(3));
    if (value >= 1000 && idx > 0) {
        idx -= 1;
        value = Number((abs / WORDS[idx]!.v).toPrecision(3));
    }
    return `${n < 0 ? '-' : ''}${value} ${WORDS[idx]!.w}`;
}

// ---- helpers ----

/**
 * `escapeMd` of DiscordScorePostService (module-private there), widened for text built
 * from player names: `[`, `]` and `<` are escaped (masked links, `<@id>` / `<@&role>`),
 * and a zero-width space follows every `@` so `@everyone` / `@here` cannot ping.
 */
function escapeMd(s: string): string {
    return s.replace(/([\\*_~|`[\]<])/g, '\\$1').replace(/@/g, '@\u200B');
}

const cpLen = (s: string) => Array.from(s).length;
const padEndCp = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - cpLen(s)));
const padStartCp = (s: string, w: number) => ' '.repeat(Math.max(0, w - cpLen(s))) + s;

function codeName(name: string): string {
    const clean = name.replace(/`/g, "'");
    const cps = Array.from(clean);
    return cps.length > NAME_MAX ? cps.slice(0, NAME_MAX - 1).join('') + '…' : clean;
}

function nameOf(p: Pick<RecapPlayerRow, 'display_name' | 'iscored_username'> | undefined): string {
    if (!p) return 'Unknown';
    return p.display_name || p.iscored_username || 'Unknown';
}

const formatters = new Map<string, Intl.DateTimeFormat>();
interface Local { day: string; weekday: string; weekdayLong: string; month: string; monthNum: number; dayNum: number; hour: number; minute: number }
function local(ms: number, tz: string): Local {
    let f = formatters.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', hourCycle: 'h23', minute: '2-digit',
        });
        formatters.set(tz, f);
    }
    const p: Record<string, string> = {};
    for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
    const monthNum = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(p.month!) + 1;
    const dayNum = parseInt(p.day!, 10);
    const longNames: Record<string, string> = { Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };
    return {
        day: `${p.year}-${String(monthNum).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`,
        weekday: p.weekday!, weekdayLong: longNames[p.weekday!] ?? p.weekday!, month: p.month!, monthNum, dayNum,
        hour: parseInt(p.hour!, 10) % 24, minute: parseInt(p.minute!, 10),
    };
}

function clock12(hour: number, minute: number, padHour: boolean): string {
    const h = hour % 12 || 12;
    const hs = padHour ? String(h).padStart(2, ' ') : String(h);
    return `${hs}:${String(minute).padStart(2, '0')}${hour < 12 ? 'am' : 'pm'}`;
}

function dayDiff(a: string, b: string): number {
    return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** < 60 min "N minutes", < 48 h "about N hours", else "N days". */
function duration(ms: number): string {
    const min = Math.max(0, Math.round(ms / 60_000));
    if (min < 60) return `${min} ${min === 1 ? 'minute' : 'minutes'}`;
    const hours = Math.round(min / 60);
    if (hours < 48) return `about ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
    return `${Math.round(hours / 24)} days`;
}

function city(tz: string): string {
    const last = tz.split('/').pop() ?? tz;
    return last.replace(/_/g, ' ');
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function nameList(names: string[]): string {
    if (names.length <= 1) return names.join('');
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// ---- builder ----

interface Limits {
    leaderboard: number;
    lead: number;
    awards: number;
    bullets: boolean;
    perDay: boolean;
    sections: number;   // 4 = all of lead / leaderboard / awards / per-day; lower drops from the bottom
}

function annotation(c: RecapLeadChange): string {
    const base = c.kind === 'first' ? 'first score' : c.kind === 'takes_first' ? 'takes first' : 'takes it back';
    return c.wins_it ? `${base}, wins it` : base;
}

function build(recap: Omit<RunRecap, 'discord_text'>, link: string | null | undefined, lim: Limits): string {
    const tz = recap.run.timezone;
    const byKey = new Map(recap.players.map(p => [p.key, p]));
    const name = (key: string) => nameOf(byKey.get(key));
    const lines: string[] = [];
    const active = recap.run.state === 'active';

    lines.push(`# ${escapeMd(recap.run.game_name)} ▸ by the numbers`);

    // subtitle
    const parts: string[] = [escapeMd(recap.run.tournament_name)];
    if (recap.run.round_no != null) parts.push(`Round ${recap.run.round_no}`);
    const firstAt = recap.lead_changes[0]?.at ?? recap.run.start_date;
    const nowMs = Date.parse(recap.generated_at) || Date.now();
    const endMs = active || !recap.run.end_date ? nowMs : Date.parse(recap.run.end_date);
    if (firstAt) {
        const a = local(Date.parse(firstAt), tz);
        const b = local(Number.isNaN(endMs) ? nowMs : endMs, tz);
        const fmt = (l: Local) => `${l.weekday} ${l.month} ${l.dayNum}`;
        parts.push(a.day === b.day || b.day < a.day ? fmt(a) : `${fmt(a)} – ${fmt(b)}`);
    }
    const t = recap.totals;
    if (t.witness_games > 0) {
        parts.push(`${plural(t.witness_games, 'game', 'games')} from ${plural(t.witness_players, 'player', 'players')} on Arcaid Witness`);
    } else {
        parts.push(plural(t.players, 'player', 'players'));
    }
    if (active) parts.push('so far');
    lines.push(`-# ${parts.join(' · ')}`);

    if (recap.players.length === 0) {
        lines.push('', 'No scores were posted in this run.');
        return lines.join('\n');
    }

    // hero
    const winner = recap.players[0]!;
    lines.push('', `## ▸ ${escapeMd(nameOf(winner))} ${active ? 'leads with' : 'wins with'} ${winner.best.toLocaleString('en-US')}`);
    const hero = recap.hero;
    if (hero.best_at) {
        const bestMs = Date.parse(hero.best_at);
        const rounded = Math.round(bestMs / 3_600_000) * 3_600_000;
        const lr = local(rounded, tz);
        const when = `${lr.weekdayLong} around ${lr.hour % 12 || 12} ${lr.hour < 12 ? 'am' : 'pm'}`;
        let lead: string;
        if (winner.best_source === 'other') lead = `The winning score was typed in, ${when}`;
        else if (winner.play_stats === 'shown' && hero.winning_game_no != null && hero.winner_games != null) {
            const last = hero.winning_game_no === hero.winner_games ? ' (the last)' : '';
            lead = `The winning score was game #${hero.winning_game_no} of ${hero.winner_games}${last}, ${when}`;
        } else lead = `The winning score came ${when}`;
        let tail = '.';
        if (active) tail = `, posted ${duration(nowMs - bestMs)} ago.`;
        else if (hero.ms_before_close != null) tail = `, ${duration(hero.ms_before_close)} before the close.`;
        lines.push(lead + tail);
    }
    if (lim.bullets && winner.play_stats === 'shown' && (winner.games ?? 0) >= 2) {
        const bullets: string[] = [];
        if (hero.winner_days && hero.winner_days.length > 0) {
            const days = hero.winner_days.slice(0, 7).map(d => `${d.games} ${d.label.split(' ')[0]}`);
            bullets.push(`Games by day: ${days.join(', ')}`);
        }
        if (hero.game_of_day != null && hero.best_at && hero.winner_days) {
            const day = local(Date.parse(hero.best_at), tz).day;
            const bucket = hero.winner_days.find(d => d.key === day);
            if (bucket && bucket.games >= 2) bullets.push(`Won it on game #${hero.game_of_day} of the day`);
        }
        if (winner.median != null) bullets.push(`Half of their games scored ${abbrevScore(winner.median)} or more`);
        for (const b of bullets.slice(0, 3)) lines.push(`- ${b}`);
    }

    // lead changes
    if (lim.sections >= 1 && recap.lead_changes.length > 0) {
        const changes = recap.lead_changes;
        const firstDay = local(Date.parse(changes[0]!.at), tz).day;
        const lastDay = local(Date.parse(changes[changes.length - 1]!.at), tz).day;
        const weekdays = dayDiff(firstDay, lastDay) <= 6;
        let shown: Array<RecapLeadChange | null> = changes;
        let more = 0;
        if (changes.length > lim.lead) {
            const tailN = lim.lead - 1;
            more = changes.length - 1 - tailN;
            shown = [changes[0]!, null, ...changes.slice(changes.length - tailN)];
        }
        const real = shown.filter((c): c is RecapLeadChange => c !== null);
        const timeLabels = new Map(real.map(c => {
            const l = local(Date.parse(c.at), tz);
            const label = weekdays ? `${l.weekday} ${clock12(l.hour, l.minute, true)}` : `${l.monthNum}/${l.dayNum} ${clock12(l.hour, l.minute, true)}`;
            return [c, label] as const;
        }));
        const timeW = Math.max(...[...timeLabels.values()].map(cpLen));
        const nameW = Math.max(...real.map(c => cpLen(codeName(name(c.player_key)))));
        const scoreW = Math.max(...real.map(c => cpLen(abbrevScore(c.score))));
        lines.push('', '## ▸ Lead changes', '```');
        for (const c of shown) {
            if (c === null) { lines.push(`${' '.repeat(12)}… ${more} more lead changes`); continue; }
            lines.push(`${padEndCp(timeLabels.get(c)!, timeW)}  ${padEndCp(codeName(name(c.player_key)), nameW)}  ${padStartCp(abbrevScore(c.score), scoreW)}  ← ${annotation(c)}`);
        }
        lines.push('```');
    }

    // leaderboard
    if (lim.sections >= 2) {
        const shown = recap.players.slice(0, lim.leaderboard);
        const nameW = Math.max(cpLen('Player'), ...shown.map(p => cpLen(codeName(nameOf(p))))) + 1;
        const num = (v: number | null, w: number) => padStartCp(v == null ? '—' : abbrevScore(v), w);
        lines.push('', '## ▸ Leaderboard', '```');
        lines.push(`${padEndCp('Player', nameW)}${padStartCp('Games', 5)} ${padStartCp('Avg', 6)} ${padStartCp('Median', 7)} ${padStartCp('Best', 6)}`);
        for (const p of shown) {
            const hide = p.play_stats !== 'shown';
            lines.push(`${padEndCp(codeName(nameOf(p)), nameW)}${padStartCp(hide || p.games == null ? '—' : String(p.games), 5)} ${num(hide ? null : p.average, 6)} ${num(hide ? null : p.median, 7)} ${num(p.best, 6)}`);
        }
        if (recap.players.length > shown.length) lines.push(`+ ${recap.players.length - shown.length} more players`);
        lines.push('```');
    }

    // awards
    if (lim.sections >= 3 && recap.awards.length > 0) {
        lines.push('', '## ▸ Awards');
        for (const a of recap.awards.slice(0, lim.awards)) {
            const names = nameList(a.player_keys.map(k => escapeMd(name(k))));
            lines.push(`- **${escapeMd(a.label)}:** ${names} — ${escapeMd(a.detail)}`);
        }
    }

    // games per day
    if (lim.sections >= 4 && lim.perDay && recap.per_day && recap.per_day.length > 0) {
        const buckets = recap.per_day;
        const max = Math.max(...buckets.map(b => b.games));
        const labelW = Math.max(...buckets.map(b => cpLen(b.label)));
        const countW = Math.max(...buckets.map(b => String(b.games).length));
        lines.push('', '## ▸ Games per day', '```');
        for (const b of buckets) {
            const bar = b.games > 0 && max > 0 ? '█'.repeat(Math.max(1, Math.round((b.games / max) * BAR_MAX))) : '';
            lines.push(`${padEndCp(b.label, labelW)}  ${padStartCp(String(b.games), countW)}${bar ? `  ${bar}` : ''}`);
        }
        lines.push('```');
    }

    // footnote
    let foot = 'Games, averages and medians count only games recorded by Arcaid Witness; scores typed in or synced count for the standings and the lead.';
    if (t.hidden_players > 0) foot += ` ${plural(t.hidden_players, 'player keeps', 'players keep')} their play stats private.`;
    foot += ` Times are ${city(tz)} time.`;
    lines.push(`-# ${foot}`);
    if (link) lines.push(`-# Full recap: <${link}>`);
    return lines.join('\n');
}

export function buildRunRecapText(
    recap: Omit<RunRecap, 'discord_text'>,
    opts: { maxChars: number; link?: string | null },
): string {
    const lim: Limits = { leaderboard: 10, lead: 10, awards: 9, bullets: true, perDay: true, sections: 4 };
    const steps: Array<(l: Limits) => void> = [
        l => { l.leaderboard = 7; },
        l => { l.lead = 6; },
        l => { l.awards = 4; },
        l => { l.bullets = false; },
        l => { l.perDay = false; },
        l => { l.leaderboard = 5; },
        l => { l.sections = 3; },
        l => { l.sections = 2; },
        l => { l.sections = 1; },
        l => { l.sections = 0; },
    ];
    let text = build(recap, opts.link, lim);
    for (const step of steps) {
        if (text.length <= opts.maxChars) break;
        step(lim);
        text = build(recap, opts.link, lim);
    }
    return text;
}

/** Split at section boundaries ('\n## ') into <= maxChars chunks, never inside a code block; at most 3 chunks. */
export function splitRecapForBot(text: string, maxChars: number = DISCORD_BOT_MAX): string[] {
    if (text.length <= maxChars) return [text];
    // Sections start at a '## ' line that is OUTSIDE a code fence (a player's name may begin with '## ').
    const sections: string[] = [];
    let open = false;
    let current: string[] = [];
    for (const line of text.split('\n')) {
        if (!open && line.startsWith('## ') && current.length > 0) {
            sections.push(current.join('\n'));
            current = [];
        }
        current.push(line);
        if (line.startsWith('```')) open = !open;
    }
    sections.push(current.join('\n'));
    // A section longer than the limit is cut at line breaks, closing and reopening a code fence.
    const pieces: string[] = [];
    for (const section of sections) {
        if (section.length <= maxChars) { pieces.push(section); continue; }
        let cur = '';
        let inCode = false;
        for (const line of section.split('\n')) {
            const fenceCost = inCode ? 4 : 0;
            if (cur && cur.length + 1 + line.length + fenceCost > maxChars) {
                pieces.push(inCode ? `${cur}\n\`\`\`` : cur);
                cur = inCode ? '```' : '';
            }
            cur = cur ? `${cur}\n${line}` : line;
            if (line.startsWith('```')) inCode = !inCode;
        }
        if (cur) pieces.push(cur);
    }
    const chunks: string[] = [];
    for (const piece of pieces) {
        const last = chunks[chunks.length - 1];
        if (last !== undefined && last.length + 1 + piece.length <= maxChars) chunks[chunks.length - 1] = `${last}\n${piece}`;
        else chunks.push(piece);
    }
    return chunks.slice(0, 3).map(c => c.trimEnd());
}
