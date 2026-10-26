import { useEffect, useState } from 'react';
import NeonButton from './NeonButton';
import { api } from '../lib/api';
import type { Tournament } from '../lib/tournamentFormPayload';

/**
 * Tournament entry roster (v2.179.0, W39, ADR 0033 §6) — the host's side of an
 * invite-only tournament: who is on the roster, add a player by name, the
 * invite link (copy / reset) and the queue of requests to join.
 *
 * The entry setting itself (Room members / Invited players, and which
 * self-serve ways are on) is saved on Edit; this panel manages the list.
 */

interface RosterEntry {
  userId: string;
  label: string;
  source: 'host' | 'invite' | 'request';
  addedAt: string;
}

interface EntryRequest {
  id: number;
  userId: string;
  label: string;
  requestedAt: string;
}

interface RosterResponse {
  mode: 'members' | 'invited';
  methods: { link: boolean; request: boolean };
  inviteCode: string | null;
  roster: RosterEntry[];
  requests: EntryRequest[];
}

const SOURCE_LABEL: Record<RosterEntry['source'], string> = {
  host: 'Added by host',
  invite: 'Invite link',
  request: 'Request approved',
};

/** The shareable invite URL for a code (the landing page is `/tournament-invite/:code`). */
function inviteUrl(code: string): string {
  return `${window.location.origin}/tournament-invite/${code}`;
}

export default function RosterPanel({ roomId, tournament, onClose, toast }: {
  roomId: string;
  tournament: Tournament;
  onClose: () => void;
  toast: (message: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const [data, setData] = useState<RosterResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const base = `/rooms/${roomId}/admin/tournaments/${tournament.id}`;

  const load = () => api.get<RosterResponse>(`${base}/roster`)
    .then(r => { setData(r); setFailed(false); })
    .catch(() => setFailed(true));

  useEffect(() => {
    let cancelled = false;
    api.get<RosterResponse>(`${base}/roster`)
      .then(r => { if (!cancelled) setData(r); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [base]);

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast(ok, 'success');
      await load();
    } catch (err) {
      toast((err as Error)?.message || 'Something went wrong', 'error');
    } finally {
      setBusy(null);
    }
  };

  const add = () => {
    const value = draft.trim();
    if (!value) return;
    void run('add', () => api.post(`${base}/roster`, { userId: value }), `${value} added to the roster`)
      .then(() => setDraft(''));
  };

  const copyLink = async (code: string) => {
    try {
      await navigator.clipboard.writeText(inviteUrl(code));
      toast('Invite link copied', 'success');
    } catch {
      toast(inviteUrl(code), 'info');
    }
  };

  const invited = data?.mode === 'invited';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="roster-panel">
        <div className="flex items-start justify-between mb-4 gap-4">
          <div>
            <h2 className="font-display text-lg font-bold">{tournament.name} — Roster</h2>
            <p className="text-xs text-muted mt-0.5">
              {invited
                ? 'Invite-only: only players on this list can score here. Everyone else\'s plays go to their Global Scoreboard.'
                : 'Open to every room member. Switch Entry to "Invited players" on Edit to use a roster.'}
            </p>
          </div>
          <NeonButton variant="ghost" onClick={onClose} className="text-xs px-3 py-1">Close</NeonButton>
        </div>

        {failed && <p className="text-xs text-neon-magenta mb-3" role="alert">Could not load the roster.</p>}
        {!data && !failed && <p className="text-sm text-muted">Loading…</p>}

        {data && (
          <>
            {invited && data.methods.link && data.inviteCode && (
              <section className="mb-5">
                <h3 className="text-xs font-display uppercase tracking-wider text-muted mb-2">Invite link</h3>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="text-xs bg-raised border border-border rounded px-2 py-1 break-all" data-testid="invite-url">{inviteUrl(data.inviteCode)}</code>
                  <NeonButton variant="ghost" onClick={() => copyLink(data.inviteCode!)} className="text-xs px-2 py-1">Copy</NeonButton>
                  <NeonButton
                    variant="ghost"
                    disabled={busy === 'reset'}
                    onClick={() => run('reset', () => api.post(`${base}/invite-code/reset`, {}), 'New invite link made — the old one no longer works')}
                    className="text-xs px-2 py-1"
                  >
                    New link
                  </NeonButton>
                </div>
                <p className="text-xs text-faint mt-1">Anyone who opens it joins the room and goes on the roster. Make a new link to stop the old one working.</p>
              </section>
            )}

            {invited && data.methods.request && (
              <section className="mb-5">
                <h3 className="text-xs font-display uppercase tracking-wider text-muted mb-2">Requests to join ({data.requests.length})</h3>
                {data.requests.length === 0 ? (
                  <p className="text-xs text-faint">No one is waiting.</p>
                ) : (
                  <ul className="divide-y divide-border/40">
                    {data.requests.map(r => (
                      <li key={r.id} className="flex items-center justify-between py-1.5 gap-2">
                        <span className="text-sm text-primary">{r.label}</span>
                        <span className="flex gap-2">
                          <NeonButton variant="ghost" disabled={busy === `req-${r.id}`} className="text-xs px-2 py-1"
                            onClick={() => run(`req-${r.id}`, () => api.post(`${base}/entry-requests/${r.id}/approve`, {}), `${r.label} is on the roster`)}>
                            Approve
                          </NeonButton>
                          <NeonButton variant="danger" disabled={busy === `req-${r.id}`} className="text-xs px-2 py-1"
                            onClick={() => run(`req-${r.id}`, () => api.post(`${base}/entry-requests/${r.id}/deny`, {}), `Request from ${r.label} declined`)}>
                            Decline
                          </NeonButton>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            <section>
              <h3 className="text-xs font-display uppercase tracking-wider text-muted mb-2">On the roster ({data.roster.length})</h3>
              <div className="flex gap-2 mb-3">
                <input
                  type="text"
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') add(); }}
                  placeholder="@name or Discord user ID"
                  aria-label="Add a player to the roster"
                  className="flex-1 px-2 py-1.5 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan"
                />
                <NeonButton onClick={add} disabled={busy === 'add' || !draft.trim()} className="text-xs px-3 py-1">Add</NeonButton>
              </div>
              {data.roster.length === 0 ? (
                <p className="text-xs text-faint">Nobody yet.</p>
              ) : (
                <ul className="divide-y divide-border/40">
                  {data.roster.map(p => (
                    <li key={p.userId} className="flex items-center justify-between py-1.5 gap-2">
                      <span className="text-sm text-primary">
                        {p.label}
                        <span className="text-xs text-faint ml-2">{SOURCE_LABEL[p.source]}</span>
                      </span>
                      <NeonButton variant="danger" disabled={busy === `rm-${p.userId}`} className="text-xs px-2 py-1"
                        onClick={() => run(`rm-${p.userId}`, () => api.delete(`${base}/roster/${encodeURIComponent(p.userId)}`), `${p.label} removed`)}>
                        Remove
                      </NeonButton>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
