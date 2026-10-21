import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, ShieldAlert, ShieldCheck } from 'lucide-react';
import NeonButton from './NeonButton';
import { api } from '../lib/api';
import { INTEGRITY_MODE_LABEL, normalizeIntegrityMode, type IntegrityMode } from '../lib/integrityForm';
import type { Tournament } from '../lib/tournamentFormPayload';
import { formatScore, parseServerDate, relativeTimeFrom } from '../lib/format';

/**
 * Integrity panel (v2.166.0, ADR 0027; Castcade ADR 0005) — the runner's view
 * of one tournament's conditions: which catalogue table each game requires,
 * and what the Castcade companion measured for every witness score it posted.
 *
 * Uses `api.*` deliberately: this is a ROOM-ADMIN surface reached from
 * /:slug/admin/tournaments (the evidence read and the requirements PATCH both
 * need the admin token). The tournament's MODE and RULES are edited on the
 * tournament form; this panel is where the per-game table is named, because a
 * tournament's games are not known when its form is filled in.
 *
 * Nothing here filters or re-ranks a board. A flagged row in the evidence
 * table is a measurement for a human to look at; in Sanctioned play the
 * ingest already held it out (`outcome: not_sanctioned`), in Open play it is
 * on the board with a chip.
 */

type IntegrityGame = {
    gameId: string;
    name: string;
    status: string;
    requiredVpsTableId: string | null;
    requiredRom: string | null;
    requiredFingerprint: string | null;
    /** null = this game is not linked to the catalogue, so no table list exists for it. */
    globalGameId?: string | null;
};

type IntegrityResponse = {
    tournamentId: string;
    mode: string;
    rules: Record<string, unknown>;
    games: IntegrityGame[];
    verdicts: Record<string, { verdict: 'pass' | 'flagged'; reasons: string[] }>;
};

type CatalogueTable = {
    vpsTableId: string;
    name: string | null;
    authors: string[];
    version: string | null;
    tableFormat: string | null;
    features: string[];
    updatedAt: string | null;
};

type RuleCheck = { rule: string; status: 'pass' | 'fail' | 'skipped'; detail?: string };

type Binary = { sha256: string | null; version: string | null; known: string | null; family: string } | null;

/** One row of `GET .../evidence` (`EvidenceRow` in `WitnessEvidenceService.ts`). */
export type EvidenceRow = {
    id: number;
    deviceId: string;
    canonicalUserId: string;
    outcome: string;
    gameId: string | null;
    gameName: string | null;
    scoreHistoryId: number | null;
    globalScoreId: string | null;
    integrityMode: string | null;
    verdict: 'pass' | 'flagged' | null;
    reasons: string[];
    checks: RuleCheck[];
    tableName: string;
    rom: string | null;
    score: number;
    playedAt: string;
    evidence: {
        vpsGame: string | null;
        vpsTable: string | null;
        tableSha256: string | null;
        tableSaveRev?: number | null;
        fingerprint?: string | null;
        ini: Record<string, unknown> | null;
        adjustments: { total?: number; non_factory?: string[] } | null;
        build: { vpx: Binary; vpinmame: Binary; cheat: boolean | null } | null;
    } | null;
    createdAt: string;
};

const RULE_LABEL: Record<string, string> = {
    evidence: 'Evidence',
    named_table: 'Named table',
    rom: 'ROM',
    fingerprint: 'Playfield fingerprint',
    stock_physics: 'Stock physics',
    factory_adjustments: 'Factory adjustments',
    known_build: 'Known build',
    cheat: 'VPinMAME cheat',
    tilt_sensitivity: 'Tilt sensitivity',
    accel_gain: 'Accelerometer gain',
    nudge_filter: 'Nudge filter',
};

/** Plain-English outcome of the ingest, as a runner reads it. */
const OUTCOME_LABEL: Record<string, string> = {
    ingested: 'on the board',
    duplicate: 'already had it',
    global: 'Global only',
    global_duplicate: 'Global, already had it',
    no_match: 'no game matched',
    invalid: 'invalid',
    suppressed: 'suppressed',
    not_sanctioned: 'held out (Sanctioned)',
};

const CHECK_TONE: Record<RuleCheck['status'], string> = {
    pass: 'text-emerald-400',
    fail: 'text-amber-400',
    skipped: 'text-faint',
};

function tableLabel(t: CatalogueTable): string {
    if (t.name) return t.name;
    const authors = t.authors.length > 0 ? t.authors.join(', ') : 'unknown authors';
    return `${authors}${t.version ? ` v${t.version}` : ''}${t.tableFormat ? ` ${t.tableFormat}` : ''}`;
}

function formatWhen(iso: string): string {
    const d = parseServerDate(iso);
    if (!d) return iso;
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function VerdictChip({ verdict }: { verdict: EvidenceRow['verdict'] }) {
    if (!verdict) return <span className="text-xs text-faint">not evaluated</span>;
    const pass = verdict === 'pass';
    const Icon = pass ? ShieldCheck : ShieldAlert;
    return (
        <span className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded font-display tracking-wide whitespace-nowrap ${
            pass ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'
        }`} data-testid={`evidence-verdict-${verdict}`}>
            <Icon size={10} aria-hidden="true" /> {pass ? 'Pass' : 'Flagged'}
        </span>
    );
}

function Measurement({ label, value }: { label: string; value: string | number | null | undefined }) {
    if (value == null || value === '') return null;
    return (
        <div className="flex gap-2 text-xs">
            <span className="text-faint w-32 shrink-0">{label}</span>
            <span className="text-primary font-mono break-all">{String(value)}</span>
        </div>
    );
}

function describeBinary(b: Binary): string | null {
    if (!b) return null;
    return `${b.version ?? 'version unknown'} (${b.family})`;
}

function EvidenceDetails({ row }: { row: EvidenceRow }) {
    const ev = row.evidence;
    const ini = ev?.ini ?? null;
    const n = (k: string): number | null => (ini && typeof ini[k] === 'number' ? ini[k] as number : null);
    const b = (k: string): boolean | null => (ini && typeof ini[k] === 'boolean' ? ini[k] as boolean : null);
    const gains = [n('accel_gain_x'), n('accel_gain_y')].filter((g): g is number => g != null);
    const stock = b('stock');
    const accel = b('accel');
    return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-3 rounded border border-border/60 bg-raised/40">
            <div>
                <p className="text-xs font-display uppercase tracking-wider text-muted mb-1.5">Rule checks</p>
                {row.checks.length === 0 ? (
                    <p className="text-xs text-faint">No rules were evaluated for this score.</p>
                ) : (
                    <ul className="space-y-0.5">
                        {row.checks.map(c => (
                            <li key={c.rule} className="text-xs flex gap-2">
                                <span className={`w-14 shrink-0 font-display uppercase tracking-wide ${CHECK_TONE[c.status] ?? 'text-faint'}`}>{c.status}</span>
                                <span className="text-primary">{RULE_LABEL[c.rule] ?? c.rule}</span>
                                {c.detail && <span className="text-muted">— {c.detail}</span>}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
            <div>
                <p className="text-xs font-display uppercase tracking-wider text-muted mb-1.5">Measured</p>
                {!ev ? (
                    <p className="text-xs text-faint">No evidence came with this score (a cabinet Witness, or an older Castcade).</p>
                ) : (
                    <div className="space-y-0.5">
                        <Measurement label="VPS table" value={ev.vpsTable} />
                        <Measurement label="VPS game" value={ev.vpsGame} />
                        <Measurement label="Table SHA-256" value={ev.tableSha256 ? `${ev.tableSha256.slice(0, 16)}…` : null} />
                        <Measurement label="Stock physics" value={stock == null ? null : stock ? 'yes' : 'no'} />
                        <Measurement label="Accelerometer" value={accel === false ? 'off' : accel === true ? 'on' : (ini ? 'on (default)' : null)} />
                        <Measurement label="Tilt sensitivity" value={n('tilt_sens')} />
                        <Measurement label="Accel gain X/Y" value={gains.length > 0 ? `${gains.join(' / ')}%` : null} />
                        <Measurement label="Nudge filter" value={b('nudge_filter') == null ? null : b('nudge_filter') ? 'on' : 'off'} />
                        <Measurement label="Non-factory adj." value={ev.adjustments ? (ev.adjustments.non_factory?.length ? ev.adjustments.non_factory.join(', ') : 'none') : null} />
                        <Measurement label="VPX build" value={describeBinary(ev.build?.vpx ?? null)} />
                        <Measurement label="VPinMAME build" value={describeBinary(ev.build?.vpinmame ?? null)} />
                        <Measurement label="VPinMAME cheat" value={ev.build?.cheat == null ? null : ev.build.cheat ? 'ON' : 'off'} />
                    </div>
                )}
            </div>
        </div>
    );
}

interface IntegrityPanelProps {
    roomId: string;
    tournament: Tournament;
    onClose: () => void;
    toast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

export default function IntegrityPanel({ roomId, tournament, onClose, toast }: IntegrityPanelProps) {
    const [mode, setMode] = useState<IntegrityMode>(normalizeIntegrityMode(tournament.integrity_mode));
    const [games, setGames] = useState<IntegrityGame[]>([]);
    const [tables, setTables] = useState<Record<string, CatalogueTable[] | null>>({});
    const [evidence, setEvidence] = useState<EvidenceRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [savingGame, setSavingGame] = useState<string | null>(null);
    const [romDrafts, setRomDrafts] = useState<Record<string, string>>({});
    const [expanded, setExpanded] = useState<number | null>(null);

    const base = `/rooms/${roomId}/tournaments/${tournament.id}`;

    // One load per tournament. `loading` starts true, so nothing is set before
    // the first await; a close mid-flight is ignored via `cancelled`.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [integrity, ev] = await Promise.all([
                    api.get<IntegrityResponse>(`${base}/integrity`),
                    api.get<{ evidence: EvidenceRow[] }>(`${base}/evidence?limit=50`).catch(() => ({ evidence: [] as EvidenceRow[] })),
                ]);
                if (cancelled) return;
                setMode(normalizeIntegrityMode(integrity.mode));
                setGames(integrity.games);
                setRomDrafts(Object.fromEntries(integrity.games.map(g => [g.gameId, g.requiredRom ?? ''])));
                setEvidence(ev.evidence ?? []);
                // One table list per catalogue game, shared by games that resolve
                // to the same one. null = fetched and nothing / failed.
                const ids = [...new Set(integrity.games.map(g => g.globalGameId).filter((id): id is string => !!id))];
                const lists = await Promise.all(ids.map(id =>
                    api.get<{ tables: CatalogueTable[] }>(`/global/games/${id}/tables`)
                        .then(r => [id, r.tables ?? []] as const)
                        .catch(() => [id, null] as const)));
                if (cancelled) return;
                setTables(Object.fromEntries(lists));
            } catch (err) {
                if (!cancelled) setError((err as Error)?.message || 'Could not load integrity settings');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [base]);

    const patchGame = async (gameId: string, body: Record<string, string | null>, done: string) => {
        setSavingGame(gameId);
        try {
            const res = await api.patch<{ success: boolean; game: IntegrityGame | null }>(`${base}/games/${gameId}/requirements`, body);
            if (res.game) {
                const updated = res.game;
                setGames(prev => prev.map(g => g.gameId === gameId ? { ...g, ...updated } : g));
                setRomDrafts(prev => ({ ...prev, [gameId]: updated.requiredRom ?? '' }));
            }
            toast(done, 'success');
        } catch (err) {
            toast((err as Error)?.message || 'Could not save', 'error');
        } finally {
            setSavingGame(null);
        }
    };

    const selectClass = 'w-full px-2 py-1.5 bg-raised border border-border rounded text-primary text-xs focus:outline-none focus:border-neon-cyan transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';
    const inputClass = 'w-full px-2 py-1.5 bg-raised border border-border rounded text-primary placeholder-faint text-xs font-mono focus:outline-none focus:border-neon-cyan transition-colors disabled:opacity-50';

    return (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
            <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-4xl max-h-[90vh] overflow-y-auto">
                <div className="flex items-start justify-between mb-4 gap-4">
                    <div>
                        <h2 className="font-display text-lg font-bold">{tournament.name} — Integrity</h2>
                        <p className="text-xs text-muted mt-0.5">
                            <span className={`font-display uppercase tracking-wider ${mode === 'sanctioned' ? 'text-neon-amber' : 'text-neon-cyan'}`} data-testid="integrity-mode">
                                {INTEGRITY_MODE_LABEL[mode]}
                            </span>
                            {' — '}
                            {mode === 'sanctioned'
                                ? 'a Castcade score that fails a rule is held out of this tournament and lands on the player\'s Global Scoreboard. Change the mode and rules on Edit.'
                                : 'every score lands on the board; what Castcade measured is shown as a badge. Change the mode and rules on Edit.'}
                        </p>
                    </div>
                    <NeonButton variant="ghost" onClick={onClose} className="text-xs px-3 py-1">Close</NeonButton>
                </div>

                {error && <p className="text-xs text-neon-magenta mb-3" role="alert">{error}</p>}
                {loading ? (
                    <p className="text-sm text-muted">Loading…</p>
                ) : (
                    <>
                        {/* Section A — required tables */}
                        <section className="mb-6">
                            <h3 className="text-xs font-display uppercase tracking-wider text-muted mb-2">Required tables</h3>
                            <p className="text-xs text-faint mb-3">
                                The one catalogue table each game must be played on in Sanctioned play. In Open play the choice is recorded and shown, never enforced.
                                A required ROM is optional and only matters for a game whose tables ship with more than one.
                            </p>
                            {games.length === 0 ? (
                                <p className="text-xs text-faint">This tournament has no games yet.</p>
                            ) : (
                                <div className="space-y-2">
                                    {games.map(g => {
                                        const list = g.globalGameId ? tables[g.globalGameId] : undefined;
                                        const linked = !!g.globalGameId;
                                        const known = (list ?? []).some(t => t.vpsTableId === g.requiredVpsTableId);
                                        return (
                                            <div key={g.gameId} className="grid grid-cols-1 md:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)_minmax(0,0.8fr)] gap-2 items-center p-2 rounded border border-border/60" data-testid={`integrity-game-${g.gameId}`}>
                                                <div className="min-w-0">
                                                    <div className="text-sm text-primary truncate">{g.name}</div>
                                                    <div className="text-[10px] text-faint font-display uppercase tracking-wide">{g.status}</div>
                                                </div>
                                                <div>
                                                    <select
                                                        aria-label={`Required table for ${g.name}`}
                                                        className={selectClass}
                                                        value={g.requiredVpsTableId ?? ''}
                                                        disabled={!linked || savingGame === g.gameId}
                                                        onChange={e => void patchGame(g.gameId, { required_vps_table_id: e.target.value || null },
                                                            e.target.value ? 'Required table saved' : 'Any table of this game')}
                                                    >
                                                        <option value="">{linked ? 'Any table of this game' : 'Not linked to the catalogue'}</option>
                                                        {(list ?? []).map(t => (
                                                            <option key={t.vpsTableId} value={t.vpsTableId}>{tableLabel(t)}</option>
                                                        ))}
                                                        {g.requiredVpsTableId && !known && (
                                                            <option value={g.requiredVpsTableId}>{g.requiredVpsTableId} (not in the catalogue list)</option>
                                                        )}
                                                    </select>
                                                    {linked && list === null && <p className="text-[10px] text-faint mt-0.5">Catalogue tables could not be loaded.</p>}
                                                    {linked && list && list.length === 0 && <p className="text-[10px] text-faint mt-0.5">No tables imported for this game yet.</p>}
                                                </div>
                                                <input
                                                    type="text"
                                                    aria-label={`Required ROM for ${g.name}`}
                                                    placeholder="ROM (optional)"
                                                    className={inputClass}
                                                    value={romDrafts[g.gameId] ?? ''}
                                                    disabled={savingGame === g.gameId}
                                                    onChange={e => setRomDrafts(prev => ({ ...prev, [g.gameId]: e.target.value }))}
                                                    onBlur={e => {
                                                        const next = e.target.value.trim();
                                                        if (next === (g.requiredRom ?? '')) return;
                                                        void patchGame(g.gameId, { required_rom: next || null }, next ? 'Required ROM saved' : 'Required ROM cleared');
                                                    }}
                                                />
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </section>

                        {/* Section B — evidence */}
                        <section>
                            <h3 className="text-xs font-display uppercase tracking-wider text-muted mb-2">Evidence</h3>
                            <p className="text-xs text-faint mb-3">
                                The latest {evidence.length} Castcade-witnessed scores for this tournament, newest first, with what the rules said. Expand a row for the per-rule result and the measurements.
                            </p>
                            {evidence.length === 0 ? (
                                <p className="text-xs text-faint">No witness scores with evidence yet.</p>
                            ) : (
                                <div className="overflow-x-auto">
                                    <table className="w-full text-xs">
                                        <thead>
                                            <tr className="text-left text-faint font-display uppercase tracking-wider">
                                                <th className="py-1 pr-2">When</th>
                                                <th className="py-1 pr-2">Player</th>
                                                <th className="py-1 pr-2">Table</th>
                                                <th className="py-1 pr-2 text-right">Score</th>
                                                <th className="py-1 pr-2">Verdict</th>
                                                <th className="py-1 pr-2">Outcome</th>
                                                <th className="py-1"></th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {evidence.map(row => {
                                                const open = expanded === row.id;
                                                return [
                                                    <tr key={row.id} className="border-t border-border/60 align-top" data-testid={`evidence-row-${row.id}`}>
                                                        <td className="py-1.5 pr-2 whitespace-nowrap text-muted" title={row.playedAt}>
                                                            {formatWhen(row.playedAt)}
                                                            <span className="block text-[10px] text-faint">{relativeTimeFrom(row.playedAt)}</span>
                                                        </td>
                                                        <td className="py-1.5 pr-2 font-mono text-muted truncate max-w-[10rem]" title={row.canonicalUserId}>{row.canonicalUserId}</td>
                                                        <td className="py-1.5 pr-2 text-primary">
                                                            {row.tableName}
                                                            {row.rom && <span className="block text-[10px] text-faint font-mono">{row.rom}</span>}
                                                        </td>
                                                        <td className="py-1.5 pr-2 text-right font-display text-primary whitespace-nowrap">{formatScore(row.score)}</td>
                                                        <td className="py-1.5 pr-2">
                                                            <VerdictChip verdict={row.verdict} />
                                                            {row.reasons.length > 0 && (
                                                                <ul className="mt-1 space-y-0.5 text-[11px] text-amber-400/90">
                                                                    {row.reasons.map(r => <li key={r}>{r}</li>)}
                                                                </ul>
                                                            )}
                                                        </td>
                                                        <td className="py-1.5 pr-2 text-muted whitespace-nowrap">{OUTCOME_LABEL[row.outcome] ?? row.outcome}</td>
                                                        <td className="py-1.5 text-right">
                                                            <button type="button" onClick={() => setExpanded(open ? null : row.id)}
                                                                aria-label={open ? 'Hide details' : 'Show details'} aria-expanded={open}
                                                                className="p-1 rounded text-muted hover:text-neon-cyan cursor-pointer">
                                                                {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                                            </button>
                                                        </td>
                                                    </tr>,
                                                    open ? (
                                                        <tr key={`${row.id}-details`}>
                                                            <td colSpan={7} className="pb-3"><EvidenceDetails row={row} /></td>
                                                        </tr>
                                                    ) : null,
                                                ];
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </section>
                    </>
                )}
            </div>
        </div>
    );
}
