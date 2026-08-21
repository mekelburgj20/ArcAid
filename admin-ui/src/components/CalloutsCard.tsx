import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from './Toast';
import NeonCard from './NeonCard';
import NeonButton from './NeonButton';
import ConfirmModal from './ConfirmModal';
import {
  parseCalloutsJson,
  triggersToText,
  textToTriggers,
  responsesToText,
  textToResponses,
  CALLOUT_ACTIONS,
  CALLOUT_ACTION_LABELS,
  CALLOUT_CATEGORIES,
  CALLOUT_CATEGORY_LABELS,
  type CalloutAction,
  type CalloutCategory,
  type CalloutCounts,
  type CalloutEntry,
  type CalloutParseResult,
  type CalloutRow,
} from '../lib/callouts';

const inputClass =
  'w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors';

/**
 * Super-admin Arcaid Chat Responses manager (v2.123.0, renamed v2.125.0).
 *
 * The list used to be a git-tracked `data/callouts.json`, so every new table
 * catchphrase was a code change + redeploy. It now lives in the DB and this
 * card is how it is maintained. UPLOAD IS THE PRIMARY PATH — export, edit the
 * file, upload it back; the inline table is for one-off tweaks (toggle an
 * entry off, fix a typo) without a round-trip through a text editor.
 *
 * Every entry carries a CATEGORY (v2.125.0), because rooms enable the kinds of
 * reply they want individually. The filter and the per-category counts exist so
 * an admin can answer "how much banter is even in here?" before a room asks.
 *
 * Rooms opt in separately: Room Settings → Discord → "Arcaid Chat Responses".
 * Nothing here turns replies on for anybody.
 */
export default function CalloutsCard() {
  const { toast } = useToast();
  const [rows, setRows] = useState<CalloutRow[]>([]);
  const [counts, setCounts] = useState<CalloutCounts>({
    total: 0, enabled: 0, disabled: 0, responses: 0, actions: 0,
    byCategory: { help: 0, callouts: 0, banter: 0, easter_eggs: 0 },
  });
  // '' = show everything. Filtering is display-only: add/replace still operate
  // on the WHOLE list, so a filtered view can never silently drop entries.
  const [categoryFilter, setCategoryFilter] = useState<CalloutCategory | ''>('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Upload staging — a parsed file sits here until the admin confirms Replace.
  const [pending, setPending] = useState<{ name: string; result: CalloutParseResult } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Inline editor — one row at a time.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTriggers, setEditTriggers] = useState('');
  const [editResponses, setEditResponses] = useState('');
  const [editAction, setEditAction] = useState<CalloutAction | ''>('');
  const [editCategory, setEditCategory] = useState<CalloutCategory>('callouts');
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const load = async () => {
    try {
      const data = await api.get<{ entries: CalloutRow[]; counts: CalloutCounts }>('/admin/callouts');
      setRows(data.entries);
      setCounts(data.counts);
    } catch {
      toast('Failed to load chat responses', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  /** Current list in upload shape — the base for add/replace operations. */
  const toEntries = (list: CalloutRow[]): CalloutEntry[] => list.map(r => {
    const entry: CalloutEntry = { triggers: r.triggers };
    if (!r.action || r.responses.length > 0) entry.responses = r.responses;
    if (r.action) entry.action = r.action;
    entry.category = r.category;
    if (!r.enabled) entry.enabled = false;
    return entry;
  });

  const putEntries = async (entries: CalloutEntry[], successMessage: string) => {
    setBusy(true);
    try {
      await api.put('/admin/callouts', { entries });
      toast(successMessage, 'success');
      await load();
      return true;
    } catch (err) {
      toast((err as Error).message || 'Save failed', 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleFile = (file: File | null | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = parseCalloutsJson(String(reader.result ?? ''));
      setPending({ name: file.name, result });
    };
    reader.onerror = () => toast('Could not read that file', 'error');
    reader.readAsText(file);
  };

  const handleReplace = async () => {
    setConfirming(false);
    if (!pending || !pending.result.ok) return;
    const ok = await putEntries(pending.result.entries, `Replaced with ${pending.result.entries.length} chat responses`);
    if (ok) {
      setPending(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleToggle = async (row: CalloutRow) => {
    setBusy(true);
    try {
      await api.patch(`/admin/callouts/${row.id}`, { enabled: !row.enabled });
      await load();
    } catch (err) {
      toast((err as Error).message || 'Update failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (row: CalloutRow) => {
    setEditingId(row.id);
    setEditTriggers(triggersToText(row.triggers));
    setEditResponses(responsesToText(row.responses));
    setEditAction(row.action ?? '');
    setEditCategory(row.category);
  };

  const saveEdit = async (row: CalloutRow) => {
    setBusy(true);
    try {
      await api.patch(`/admin/callouts/${row.id}`, {
        triggers: textToTriggers(editTriggers),
        responses: textToResponses(editResponses),
        // null clears a live-data responder back to a plain static entry.
        action: editAction === '' ? null : editAction,
        category: editCategory,
      });
      setEditingId(null);
      await load();
      toast('Chat response updated', 'success');
    } catch (err) {
      toast((err as Error).message || 'Update failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: number) => {
    setDeletingId(null);
    setBusy(true);
    try {
      await api.delete(`/admin/callouts/${id}`);
      await load();
      toast('Chat response deleted', 'success');
    } catch (err) {
      toast((err as Error).message || 'Delete failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  // No POST endpoint by design — the list is replace-all plus per-row patches,
  // so "add" is a replace with one extra entry appended.
  const handleAdd = async () => {
    const added = await putEntries(
      [...toEntries(rows), { triggers: ['new trigger'], responses: ['New response'] }],
      'Entry added — edit it below',
    );
    if (added) setEditingId(null);
  };

  const handleDownload = async () => {
    try {
      await api.download('/admin/callouts/export', 'callouts.json');
    } catch (err) {
      toast((err as Error).message || 'Download failed', 'error');
    }
  };

  // Display-only. Every mutation still round-trips the FULL `rows` list, so a
  // Replace performed while a filter is active cannot drop the hidden entries.
  const visibleRows = categoryFilter === ''
    ? rows
    : rows.filter(r => r.category === categoryFilter);

  return (
    <NeonCard title="Arcaid Chat Responses" className="mb-4">
      <p className="text-muted text-sm mb-1">
        Automatic bot replies to ordinary chat. When someone in a participating room&rsquo;s Discord
        server says a trigger word (usually a table name), the bot answers with one of that
        entry&rsquo;s responses at random. An entry can instead answer with <strong>live data</strong>{' '}
        &mdash; what&rsquo;s active right now, how long the round has left, who&rsquo;s winning, whose
        pick it is &mdash; for questions a fixed reply can&rsquo;t answer.
      </p>
      <p className="text-muted text-sm mb-4">
        This list is global, and every entry has a <strong>category</strong>. Each room opts in on its
        own Settings page under <strong>Discord &rarr; Arcaid Chat Responses</strong> and chooses
        which categories it wants &mdash; nothing here makes the bot talk in anybody&rsquo;s server.
      </p>

      {loading ? (
        <p className="text-faint text-sm">Loading callouts&hellip;</p>
      ) : (
        <>
          <p className="text-sm text-primary mb-4" data-testid="callout-counts">
            <span className="font-mono">{counts.total}</span> entries
            {' · '}
            <span className="font-mono">{counts.enabled}</span> enabled
            {' · '}
            <span className="font-mono">{counts.disabled}</span> disabled
            {' · '}
            <span className="font-mono">{counts.responses}</span> responses
            {' · '}
            <span className="font-mono">{counts.actions}</span> live answers
          </p>

          {/* Per-category counts double as the filter: an admin asking "how
              much banter is in here?" and an admin wanting to SEE it are the
              same person one click apart. */}
          <div className="flex flex-wrap items-center gap-2 mb-4" data-testid="callout-category-filter">
            <button
              onClick={() => setCategoryFilter('')}
              aria-pressed={categoryFilter === ''}
              className={`px-2.5 py-1 rounded text-xs border cursor-pointer transition-colors ${
                categoryFilter === ''
                  ? 'border-neon-cyan text-neon-cyan bg-neon-cyan/10'
                  : 'border-border text-muted bg-transparent hover:text-primary'
              }`}
            >
              All <span className="font-mono">{counts.total}</span>
            </button>
            {CALLOUT_CATEGORIES.map(category => (
              <button
                key={category}
                onClick={() => setCategoryFilter(categoryFilter === category ? '' : category)}
                aria-pressed={categoryFilter === category}
                data-testid={`callout-category-count-${category}`}
                className={`px-2.5 py-1 rounded text-xs border cursor-pointer transition-colors ${
                  categoryFilter === category
                    ? 'border-neon-cyan text-neon-cyan bg-neon-cyan/10'
                    : 'border-border text-muted bg-transparent hover:text-primary'
                }`}
              >
                {CALLOUT_CATEGORY_LABELS[category]}{' '}
                <span className="font-mono">{counts.byCategory?.[category] ?? 0}</span>
              </button>
            ))}
          </div>

          {/* ── Upload (the primary path) ── */}
          <div className="border border-border rounded p-4 mb-4">
            <p className="text-xs font-display uppercase tracking-wider text-neon-cyan/70 mb-2">
              Upload a list
            </p>
            <p className="text-xs text-faint mb-3">
              A JSON array of <span className="font-mono">{'{ "triggers": [...], "responses": [...] }'}</span> entries
              &mdash; the same shape the download gives you. Uploading REPLACES the whole list.
              A trigger starting with <span className="font-mono">!</span> is an exclusion: it stops
              that entry firing even when another of its triggers matched. Add
              <span className="font-mono"> "action"</span> (one of {CALLOUT_ACTIONS.join(', ')}) to
              answer with live data instead &mdash; <span className="font-mono">responses</span> can
              then be omitted. Add <span className="font-mono">"category"</span> (one of
              {' '}{CALLOUT_CATEGORIES.join(', ')}) to choose which room toggle governs the entry;
              omit it and one is inferred. Responses may use
              <span className="font-mono"> {'{room_name}'} {'{room_url}'} {'{picks_url}'} {'{scores_url}'}</span>,
              filled in from the first room linked to the asking server.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                aria-label="Callouts JSON file"
                onChange={e => handleFile(e.target.files?.[0])}
                className="text-sm text-muted file:mr-3 file:px-3 file:py-1.5 file:rounded file:border file:border-border file:bg-raised file:text-muted file:text-sm file:cursor-pointer"
              />
              <NeonButton
                onClick={() => setConfirming(true)}
                disabled={busy || !pending || !pending.result.ok}
              >
                Replace list
              </NeonButton>
              <NeonButton variant="secondary" onClick={handleDownload} disabled={busy}>
                Download current JSON
              </NeonButton>
            </div>

            {pending && (
              <p
                className={`text-xs mt-3 ${pending.result.ok ? 'text-neon-green' : 'text-neon-magenta'}`}
                data-testid="callout-upload-preview"
              >
                {pending.result.ok
                  ? `${pending.name}: ${pending.result.entries.length} entries, ${pending.result.responseCount} responses`
                  : `${pending.name}: ${pending.result.error}`}
              </p>
            )}
          </div>

          {/* ── Inline editor ── */}
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-display uppercase tracking-wider text-neon-cyan/70">
              Current list
            </p>
            <NeonButton variant="ghost" className="text-xs px-2 py-1" onClick={handleAdd} disabled={busy}>
              + Add entry
            </NeonButton>
          </div>

          {rows.length === 0 ? (
            <p className="text-faint text-sm">No chat responses yet. Upload a list to get started.</p>
          ) : visibleRows.length === 0 ? (
            <p className="text-faint text-sm">
              Nothing in {CALLOUT_CATEGORY_LABELS[categoryFilter as CalloutCategory]}. Clear the
              filter to see the rest.
            </p>
          ) : (
            <div className="space-y-2">
              {visibleRows.map(row => (
                <div
                  key={row.id}
                  className={`border border-border rounded px-3 py-2 ${row.enabled ? '' : 'opacity-50'}`}
                  data-testid="callout-row"
                >
                  {editingId === row.id ? (
                    <div className="space-y-2">
                      <div>
                        <label className="text-xs text-faint block mb-1" htmlFor={`triggers-${row.id}`}>
                          Triggers (comma separated; prefix with ! to exclude)
                        </label>
                        <input
                          id={`triggers-${row.id}`}
                          className={inputClass}
                          value={editTriggers}
                          onChange={e => setEditTriggers(e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-faint block mb-1" htmlFor={`responses-${row.id}`}>
                          Responses (one per line)
                        </label>
                        <textarea
                          id={`responses-${row.id}`}
                          rows={3}
                          className={inputClass}
                          value={editResponses}
                          onChange={e => setEditResponses(e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-faint block mb-1" htmlFor={`action-${row.id}`}>
                          Live answer (overrides the responses above)
                        </label>
                        <select
                          id={`action-${row.id}`}
                          className={inputClass}
                          value={editAction}
                          onChange={e => setEditAction(e.target.value as CalloutAction | '')}
                        >
                          <option value="">None — reply with one of the responses</option>
                          {CALLOUT_ACTIONS.map(a => (
                            <option key={a} value={a}>{CALLOUT_ACTION_LABELS[a]}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-faint block mb-1" htmlFor={`category-${row.id}`}>
                          Category (rooms turn these on and off individually)
                        </label>
                        <select
                          id={`category-${row.id}`}
                          className={inputClass}
                          value={editCategory}
                          onChange={e => setEditCategory(e.target.value as CalloutCategory)}
                        >
                          {CALLOUT_CATEGORIES.map(c => (
                            <option key={c} value={c}>{CALLOUT_CATEGORY_LABELS[c]}</option>
                          ))}
                        </select>
                      </div>
                      <div className="flex gap-2">
                        <NeonButton className="text-xs px-2 py-1" onClick={() => saveEdit(row)} disabled={busy}>
                          Save
                        </NeonButton>
                        <NeonButton variant="ghost" className="text-xs px-2 py-1" onClick={() => setEditingId(null)}>
                          Cancel
                        </NeonButton>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap gap-1 mb-1">
                          {row.triggers.map(t => (
                            <span
                              key={t}
                              className={`px-2 py-0.5 rounded text-xs font-mono border ${
                                t.startsWith('!')
                                  ? 'border-neon-magenta/40 text-neon-magenta bg-neon-magenta/10'
                                  : 'border-neon-cyan/30 text-neon-cyan bg-neon-cyan/10'
                              }`}
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                        <p className="mb-1">
                          <span
                            className="px-2 py-0.5 rounded text-xs border border-border text-muted"
                            data-testid="callout-category-badge"
                          >
                            {CALLOUT_CATEGORY_LABELS[row.category]}
                          </span>
                        </p>
                        {row.action && (
                          <p className="mb-1">
                            <span
                              className="px-2 py-0.5 rounded text-xs border border-neon-amber/40 text-neon-amber bg-neon-amber/10"
                              title={CALLOUT_ACTION_LABELS[row.action]}
                              data-testid="callout-action-badge"
                            >
                              Live answer: {CALLOUT_ACTION_LABELS[row.action]}
                            </span>
                          </p>
                        )}
                        <p className="text-xs text-muted break-words">
                          {row.responses.length > 0
                            ? row.responses.join(' · ')
                            : <span className="text-faint">Rendered from live room data</span>}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => handleToggle(row)}
                          disabled={busy}
                          aria-label={row.enabled ? 'Disable chat response' : 'Enable chat response'}
                          className={`relative w-12 h-6 rounded-full transition-colors cursor-pointer border-none ${
                            row.enabled ? 'bg-neon-cyan' : 'bg-raised border border-border'
                          }`}
                        >
                          <span
                            className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-primary transition-transform ${
                              row.enabled ? 'translate-x-6' : ''
                            }`}
                          />
                        </button>
                        <NeonButton variant="ghost" className="text-xs px-2 py-1" onClick={() => startEdit(row)}>
                          Edit
                        </NeonButton>
                        <NeonButton
                          variant="ghost"
                          className="text-xs px-2 py-1 text-neon-magenta hover:text-neon-magenta"
                          onClick={() => setDeletingId(row.id)}
                        >
                          Delete
                        </NeonButton>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {confirming && pending?.result.ok && (
        <ConfirmModal
          title="Replace the chat response list?"
          message={`This deletes all ${counts.total} current entries and replaces them with the ${pending.result.entries.length} from ${pending.name}. Download the current list first if you want a backup.`}
          confirmLabel="Replace"
          onConfirm={handleReplace}
          onCancel={() => setConfirming(false)}
        />
      )}

      {deletingId !== null && (
        <ConfirmModal
          title="Delete this chat response?"
          message="The entry is removed from the list. Other entries are unaffected."
          confirmLabel="Delete"
          onConfirm={() => handleDelete(deletingId)}
          onCancel={() => setDeletingId(null)}
        />
      )}
    </NeonCard>
  );
}
