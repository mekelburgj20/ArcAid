import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { InfoTip } from './Tooltip';
import { TIMEZONES } from './ScheduleBuilder';
import { api } from '../lib/api';
import { zoneLabel } from '../lib/timezone';
import {
    addMinutes,
    durationMinutes,
    validateRoundDrafts,
    type EventFormState,
    type RoundDraft,
} from '../lib/eventTime';

export type { EventFormState };

/**
 * Live Event settings (v2.135.0, ADR 0017) — the fields that replace the
 * rotation controls when an admin flips the format switch.
 *
 * A rotation tournament answers "how do games rotate forever". An event answers
 * "when exactly does each round open and close, and who is allowed in". Almost
 * nothing carries over, which is why this is a separate component rather than
 * conditional fields sprinkled through `TournamentFormFields`.
 *
 * Rounds are edited as a labelled **Start + End** pair of date-time pickers
 * (v2.167.2). They were start + a minutes box until the owner configured the
 * first multi-day event (2026-10-22): "unlabelled boxes and a box at the end
 * that is the duration". The two ways to get a window wrong — an end before
 * its start, and a round that runs into the next — are caught while typing by
 * `validateRoundDrafts`; the duration is shown as a caption, never typed.
 */

const inputClass = 'w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors';
const selectClass = `${inputClass} cursor-pointer`;

const fieldLabelClass = 'block text-[10px] font-display uppercase tracking-wider text-faint mb-1';

/** "18 h", "1 h 30 min", "25 min" — the read-only duration caption under a round. Null when the window is incomplete or not positive. */
function formatLasts(minutes: number | null): string | null {
    if (minutes == null || minutes <= 0) return null;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h === 0) return `${m} min`;
    return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
const MINUTE_STEPS = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'));

/**
 * Date + hour + minute, replacing the native `datetime-local` control.
 *
 * v2.140.0, owner field report: Chrome's datetime-local time WHEEL skips
 * values when scrolled (10..14 then 17..) and only the arrow keys worked. A
 * date input's calendar is fine — it is only the time half that is broken —
 * so the time becomes two plain selects. Minutes step by 5 (a round starting
 * at :07 is nobody's plan), but a stored off-step value renders as itself
 * rather than snapping — editing an existing event must not silently move a
 * round.
 *
 * Picking a date before a time gets 20:00 — an evening default the host was
 * about to change anyway beats emitting a half-formed value the validators
 * would bounce.
 */
export function DateTimeField({ value, onChange, disabled, invalid, label }: {
    value: string;
    onChange: (v: string) => void;
    disabled?: boolean;
    invalid?: boolean;
    /** Names the date input for assistive tech ("Round 1 start date"); the hour/minute selects keep their own labels. */
    label?: string;
}) {
    const [datePart, timePart] = value ? value.split('T') : ['', ''];
    const [hh, mm] = timePart ? timePart.split(':') : ['', ''];
    const minuteOptions = mm && !MINUTE_STEPS.includes(mm) ? [...MINUTE_STEPS, mm].sort() : MINUTE_STEPS;
    const cls = `${inputClass} ${disabled ? 'opacity-60' : ''} ${invalid ? 'border-neon-magenta/60' : ''}`;

    const emit = (d: string, h: string, m: string) => {
        if (!d) { onChange(''); return; }
        onChange(`${d}T${h || '20'}:${m || '00'}`);
    };

    return (
        <div className="flex gap-1 items-center">
            <input
                type="date" value={datePart} disabled={disabled}
                onChange={e => emit(e.target.value, hh, mm)}
                className={`${cls} min-w-0 flex-[1.6]`}
                aria-label={label ? `${label} date` : undefined}
            />
            <select
                value={hh} disabled={disabled || !datePart}
                onChange={e => emit(datePart, e.target.value, mm)}
                className={`${cls} cursor-pointer flex-1`}
                aria-label="Hour"
            >
                {!hh && <option value="">--</option>}
                {HOURS.map(h => <option key={h} value={h}>{h}</option>)}
            </select>
            <span className="text-faint text-sm">:</span>
            <select
                value={mm} disabled={disabled || !datePart}
                onChange={e => emit(datePart, hh, e.target.value)}
                className={`${cls} cursor-pointer flex-1`}
                aria-label="Minute"
            >
                {!mm && <option value="">--</option>}
                {minuteOptions.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
        </div>
    );
}

/**
 * Game name with a suggestion list from the room's library.
 *
 * A free-text input with a `<datalist>`, not a picker modal: an event round is
 * one of up to twelve fields on a form the admin is already filling in, and
 * making each one a modal round-trip would be miserable. The name is validated
 * server-side against the catalogue at activation time anyway.
 */
function GameNameInput({ roomId, value, onChange, invalid }: {
    roomId: string | undefined;
    value: string;
    onChange: (v: string) => void;
    invalid?: boolean;
}) {
    const listId = useId();
    const [suggestions, setSuggestions] = useState<string[]>([]);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    useEffect(() => {
        if (!roomId || value.trim().length < 2) { setSuggestions([]); return; }
        clearTimeout(timer.current);
        timer.current = setTimeout(async () => {
            try {
                const rows = await api.get<Array<{ name: string }>>(
                    `/rooms/${roomId}/game_library/search?q=${encodeURIComponent(value.trim())}`,
                );
                setSuggestions(rows.map(r => r.name).slice(0, 20));
            } catch {
                // A failed lookup costs the admin autocomplete, nothing more —
                // the field is free text and the server validates the name.
                setSuggestions([]);
            }
        }, 250);
        return () => clearTimeout(timer.current);
    }, [roomId, value]);

    return (
        <>
            <input
                type="text" list={listId} placeholder="Game name" value={value}
                onChange={e => onChange(e.target.value)}
                className={`${inputClass} ${invalid ? 'border-neon-magenta' : ''}`}
            />
            <datalist id={listId}>
                {suggestions.map(name => <option key={name} value={name} />)}
            </datalist>
        </>
    );
}

interface EventSettingsFieldsProps {
    state: EventFormState;
    onChange: (next: EventFormState) => void;
    roomId?: string;
    /**
     * Round numbers that are already ACTIVE or COMPLETED. They are rendered
     * read-only: the server refuses to change them (`ROUND_LOCKED`), because
     * rewriting a live round's window would retroactively invalidate scores the
     * submission gate has already accepted.
     */
    lockedRounds?: number[];
}

export default function EventSettingsFields({ state, onChange, roomId, lockedRounds = [] }: EventSettingsFieldsProps) {
    const set = <K extends keyof EventFormState>(field: K, value: EventFormState[K]) =>
        onChange({ ...state, [field]: value });

    const errors = useMemo(
        () => validateRoundDrafts(state.rounds, state.checkinOpensLocal),
        [state.rounds, state.checkinOpensLocal],
    );

    /**
     * A brand-new form must not open shouting. Every round starts empty, so
     * validating on mount painted three red "Pick a game for this round" boxes
     * before the admin had typed anything — which reads as "you did something
     * wrong" at the exact moment they have not.
     *
     * A round's error is therefore shown once that round has been EDITED. The
     * validation itself is unchanged and still complete; this only governs when
     * it is surfaced. The save button gates on the real result either way, so a
     * never-touched empty round still cannot be saved.
     */
    const [touched, setTouched] = useState<Set<number>>(new Set());
    const markTouched = (roundNo: number) =>
        setTouched(prev => (prev.has(roundNo) ? prev : new Set(prev).add(roundNo)));
    const errorFor = (roundNo: number) => (touched.has(roundNo) ? errors[roundNo] : undefined);

    const isLocked = (roundNo: number) => lockedRounds.includes(roundNo);

    const updateRound = (roundNo: number, patch: Partial<RoundDraft>) => {
        markTouched(roundNo);
        onChange({
            ...state,
            rounds: state.rounds.map(r => {
                if (r.roundNo !== roundNo) {
                    // "Same game for all rounds" is applied on write rather than
                    // on read, so unticking it leaves every round with the name
                    // it already had instead of silently reverting them.
                    return state.sameGameForAllRounds && patch.gameName !== undefined && !isLocked(r.roundNo)
                        ? { ...r, gameName: patch.gameName }
                        : r;
                }
                return { ...r, ...patch };
            }),
        });
    };

    const addRound = () => {
        const last = state.rounds[state.rounds.length - 1];
        const nextNo = state.rounds.reduce((max, r) => Math.max(max, r.roundNo), 0) + 1;
        // Default the new round to start where the previous one ends, with a
        // 5-minute changeover, and to last as long as the previous one — the
        // shape almost every multi-round night takes.
        const lastMinutes = last ? (durationMinutes(last.startLocal, last.endLocal) ?? 30) : 30;
        const start = last ? addMinutes(last.endLocal, 5) : '';
        const end = start ? addMinutes(start, Math.max(1, lastMinutes)) : '';
        onChange({
            ...state,
            rounds: [...state.rounds, {
                roundNo: nextNo,
                gameName: state.sameGameForAllRounds ? (last?.gameName ?? '') : '',
                startLocal: start,
                endLocal: end,
            }],
        });
    };

    const removeRound = (roundNo: number) => {
        onChange({ ...state, rounds: state.rounds.filter(r => r.roundNo !== roundNo) });
    };

    return (
        <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                <div>
                    <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
                        Timezone <InfoTip text="Round times below are entered in this timezone. Stored as UTC, so a schedule stays correct across daylight-saving changes." />
                    </label>
                    <select value={state.timezone} onChange={e => set('timezone', e.target.value)} className={selectClass}>
                        {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>)}
                    </select>
                </div>
                <div>
                    <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
                        Check-in opens ({zoneLabel(state.timezone)}) <InfoTip text="Leave blank to open check-in as soon as the event is saved. Check-in always CLOSES when round 1 starts — after that only an admin can add a player." />
                    </label>
                    <DateTimeField
                        value={state.checkinOpensLocal}
                        onChange={v => set('checkinOpensLocal', v)}
                    />
                </div>
                <div>
                    <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
                        Ranking <InfoTip text="How a player's round scores combine. Best = their single best round. Sum = all rounds added (a missed round counts 0). Average = the mean, but only for players who scored in EVERY round; the rest are listed separately." />
                    </label>
                    <select
                        value={state.aggregateMethod}
                        onChange={e => set('aggregateMethod', e.target.value as EventFormState['aggregateMethod'])}
                        className={selectClass}
                    >
                        <option value="best">Best single round</option>
                        <option value="sum">Sum of all rounds</option>
                        <option value="average">Average (all rounds played)</option>
                    </select>
                </div>
            </div>

            <div className="mb-4 space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                    <input
                        type="checkbox" checked={state.checkinRequired}
                        onChange={e => set('checkinRequired', e.target.checked)}
                        className="accent-neon-cyan"
                    />
                    <span className="text-sm text-muted">Require check-in before round 1</span>
                    <InfoTip text="When on, only players who checked in before round 1 started can post a score — everyone else is refused with a clear message, and an admin can add them by hand. When off, anyone in the room can play." />
                </label>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div>
                    <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
                        Late-submit grace (seconds) <InfoTip text="How long after a round's end a score is still accepted. AtGames cabinets only upload a score when the player fully exits the table, so hosts running 'exit at the buzzer' rules want 120–180. A phone-submit frenzy can keep 60." />
                    </label>
                    <input
                        type="number" min={0} max={600} value={state.endGraceSec}
                        onChange={e => set('endGraceSec', Math.max(0, Math.min(600, Number(e.target.value) || 0)))}
                        className={inputClass}
                    />
                </div>
                <div>
                    <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
                        Flag scores faster than (seconds) <InfoTip text="0 = off. Scores posted sooner than this after a round opens get a 'fast' badge on the board, so you can eyeball the impossible ones. It is a HINT for you, never an automatic rejection — Arcaid sees submission time, not play time." />
                    </label>
                    <input
                        type="number" min={0} max={86400} value={state.minElapsedSec}
                        onChange={e => set('minElapsedSec', Math.max(0, Number(e.target.value) || 0))}
                        className={inputClass}
                    />
                </div>
            </div>

            <div className="mb-4">
                <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                    <label className="block text-xs font-display uppercase tracking-wider text-muted">
                        Rounds · times in {zoneLabel(state.timezone)} <InfoTip text="Each round is its own game and its own window, from its start to its end. Scores only count inside that window, on the server's clock." />
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                        <input
                            type="checkbox" checked={state.sameGameForAllRounds}
                            onChange={e => {
                                const on = e.target.checked;
                                const first = state.rounds[0]?.gameName ?? '';
                                onChange({
                                    ...state,
                                    sameGameForAllRounds: on,
                                    rounds: on
                                        ? state.rounds.map(r => (isLocked(r.roundNo) ? r : { ...r, gameName: first }))
                                        : state.rounds,
                                });
                            }}
                            className="accent-neon-cyan"
                        />
                        <span className="text-xs text-muted">Same game for all rounds</span>
                    </label>
                </div>

                <div className="space-y-2">
                    {state.rounds.map(round => {
                        const locked = isLocked(round.roundNo);
                        const error = errorFor(round.roundNo);
                        const lasts = formatLasts(durationMinutes(round.startLocal, round.endLocal));
                        return (
                            <div
                                key={round.roundNo}
                                className={`p-3 rounded border ${error ? 'border-neon-magenta/60' : 'border-border'} bg-surface`}
                            >
                                <div className="grid grid-cols-1 md:grid-cols-[3rem_1fr_1.3fr_1.3fr_2.5rem] gap-2 items-end">
                                    <div className="text-xs font-display uppercase tracking-wider text-muted pb-2">
                                        R{round.roundNo}
                                    </div>
                                    <div>
                                        <div className={fieldLabelClass}>Game</div>
                                        {locked ? (
                                            <div className={`${inputClass} opacity-60`}>{round.gameName}</div>
                                        ) : (
                                            <GameNameInput
                                                roomId={roomId} value={round.gameName}
                                                onChange={v => updateRound(round.roundNo, { gameName: v })}
                                                invalid={!!error}
                                            />
                                        )}
                                    </div>
                                    <div>
                                        <div className={fieldLabelClass}>Starts ({zoneLabel(state.timezone)})</div>
                                        <DateTimeField
                                            value={round.startLocal} disabled={locked}
                                            onChange={v => updateRound(round.roundNo, { startLocal: v })}
                                            invalid={!!error}
                                            label={`Round ${round.roundNo} start`}
                                        />
                                    </div>
                                    <div>
                                        <div className={fieldLabelClass}>Ends ({zoneLabel(state.timezone)})</div>
                                        <DateTimeField
                                            value={round.endLocal} disabled={locked}
                                            onChange={v => updateRound(round.roundNo, { endLocal: v })}
                                            invalid={!!error}
                                            label={`Round ${round.roundNo} end`}
                                        />
                                    </div>
                                    <div>
                                        {!locked && state.rounds.length > 1 && (
                                            <button
                                                type="button" onClick={() => removeRound(round.roundNo)}
                                                title={`Remove round ${round.roundNo}`}
                                                className="px-2 py-2 rounded border border-border text-muted hover:text-neon-magenta hover:border-neon-magenta transition-colors text-sm"
                                            >×</button>
                                        )}
                                    </div>
                                </div>
                                <div className="mt-1.5 flex items-center gap-3 flex-wrap">
                                    {lasts && (
                                        <span className="text-xs text-faint">Lasts {lasts}</span>
                                    )}
                                    {locked && (
                                        <span className="text-xs text-neon-amber">
                                            This round has already started — its window is fixed.
                                        </span>
                                    )}
                                    {error && <span className="text-xs text-neon-magenta">{error}</span>}
                                </div>
                            </div>
                        );
                    })}
                </div>

                {state.rounds.length < 12 && (
                    <button
                        type="button" onClick={addRound}
                        className="mt-2 px-3 py-1.5 rounded border border-border text-muted hover:text-neon-cyan hover:border-neon-cyan transition-colors text-xs"
                    >+ Add round</button>
                )}
            </div>
        </>
    );
}
