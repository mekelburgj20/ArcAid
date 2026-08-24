import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { InfoTip } from './Tooltip';
import { TIMEZONES } from './ScheduleBuilder';
import { api } from '../lib/api';
import {
    addMinutes,
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
 * Rounds are edited as **start + duration**, never start + end. Hosts think in
 * durations ("three 25-minute rounds"), and it makes the two ways to get a
 * window wrong — an end before its start, and a round that runs into the next —
 * structurally harder to type.
 */

const inputClass = 'w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors';
const selectClass = `${inputClass} cursor-pointer`;

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
        // 5-minute changeover — the shape almost every multi-round night takes.
        const start = last ? addMinutes(last.startLocal, last.durationMin + 5) : '';
        onChange({
            ...state,
            rounds: [...state.rounds, {
                roundNo: nextNo,
                gameName: state.sameGameForAllRounds ? (last?.gameName ?? '') : '',
                startLocal: start,
                durationMin: last?.durationMin ?? 30,
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
                        Check-in opens <InfoTip text="Leave blank to open check-in as soon as the event is saved. Check-in always CLOSES when round 1 starts — after that only an admin can add a player." />
                    </label>
                    <input
                        type="datetime-local" value={state.checkinOpensLocal}
                        onChange={e => set('checkinOpensLocal', e.target.value)}
                        className={inputClass}
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
                        Rounds <InfoTip text="Each round is its own game and its own window. Scores only count inside that window, on the server's clock." />
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
                        return (
                            <div
                                key={round.roundNo}
                                className={`p-3 rounded border ${error ? 'border-neon-magenta/60' : 'border-border'} bg-surface`}
                            >
                                <div className="grid grid-cols-1 md:grid-cols-[3rem_1fr_1fr_7rem_2.5rem] gap-2 items-end">
                                    <div className="text-xs font-display uppercase tracking-wider text-muted pb-2">
                                        R{round.roundNo}
                                    </div>
                                    <div>
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
                                        <input
                                            type="datetime-local" value={round.startLocal} disabled={locked}
                                            onChange={e => updateRound(round.roundNo, { startLocal: e.target.value })}
                                            className={`${inputClass} ${locked ? 'opacity-60' : ''}`}
                                        />
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <input
                                            type="number" min={1} value={round.durationMin} disabled={locked}
                                            onChange={e => updateRound(round.roundNo, { durationMin: Math.max(1, Number(e.target.value) || 1) })}
                                            className={`${inputClass} ${locked ? 'opacity-60' : ''}`}
                                        />
                                        <span className="text-xs text-faint whitespace-nowrap">min</span>
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
                                    {round.startLocal && round.durationMin > 0 && (
                                        <span className="text-xs text-faint">
                                            Ends {addMinutes(round.startLocal, round.durationMin).replace('T', ' ')}
                                        </span>
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
