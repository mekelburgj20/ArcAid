import { useCallback, useEffect, useState } from 'react';
import { Star, Save, Check, Trash2, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../lib/api';

/**
 * Style-system revamp P2 — Style Profiles.
 *
 * A named snapshot of a room's APPEARANCE, owned by the admin rather than by
 * any one room, so someone running several rooms can dress a new one in two
 * clicks instead of re-deriving forty settings.
 *
 * What a profile deliberately does NOT carry — and why this component can be
 * this blunt about applying one — is decided server-side in
 * `StyleProfileService.PORTABLE_STYLE_KEYS`: no room name, title text, logo,
 * background image, credentials or policy. Applying writes only the keys the
 * profile holds and leaves everything else in the room alone.
 */

export interface StyleProfile {
  id: string;
  name: string;
  settings: Record<string, string>;
  isDefault: boolean;
  updatedAt: string;
}

interface StyleProfilesProps {
  roomId: string;
  /** Fired after a profile is applied, so the page can reload the settings it
   *  is displaying — the server has just rewritten some of them. */
  onApplied: () => void;
  /** Unsaved changes make "save this room as a profile" capture the SAVED
   *  state, not what is on screen — so the control says so rather than
   *  silently snapshotting something the admin isn't looking at. */
  hasUnsavedChanges: boolean;
  toast: (msg: string, kind?: 'success' | 'error') => void;
}

export default function StyleProfiles({ roomId, onApplied, hasUnsavedChanges, toast }: StyleProfilesProps) {
  const [profiles, setProfiles] = useState<StyleProfile[]>([]);
  const [current, setCurrent] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const fetchProfiles = useCallback(
    () => api.get<{ profiles: StyleProfile[]; current: Record<string, string> }>(
      `/rooms/${roomId}/admin/style-profiles`,
    ),
    [roomId],
  );

  // Promise-chained with a cancel flag rather than `void load()` — the latter
  // reads to the React compiler as a synchronous setState inside an effect
  // body (react-hooks/set-state-in-effect). Same shape the other loaders in
  // this codebase use.
  useEffect(() => {
    let cancelled = false;
    fetchProfiles()
      .then(data => {
        if (cancelled) return;
        // Coerce defensively. A response missing these fields is a server or
        // proxy fault, and this component sits at the TOP of the settings card
        // — rendering `undefined.map` here would take the whole page down with
        // it rather than just hiding the profile list.
        setProfiles(Array.isArray(data?.profiles) ? data.profiles : []);
        setCurrent(data?.current ?? {});
        setLoaded(true);
      })
      .catch(() => {
        // A profile list that fails to load must not take the settings page
        // down with it — the rest of the card is unaffected.
        if (!cancelled) setLoaded(true);
      });
    return () => { cancelled = true; };
  }, [fetchProfiles]);

  /** Re-pull after a mutation. Failures leave the last-known list on screen. */
  const load = async () => {
    try {
      const data = await fetchProfiles();
      setProfiles(Array.isArray(data?.profiles) ? data.profiles : []);
      setCurrent(data?.current ?? {});
    } catch { /* keep what we have */ }
  };

  /** True when this room's saved appearance already equals the profile. Lets
   *  the UI mark "you are here" instead of inviting a pointless re-apply. */
  const matchesCurrent = (p: StyleProfile) => {
    const keys = Object.keys(p.settings);
    return keys.length > 0 && keys.every(k => current[k] === p.settings[k])
      && Object.keys(current).length === keys.length;
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  const handleApply = () => run(async () => {
    const profile = profiles.find(p => p.id === selectedId);
    if (!profile) return;
    try {
      const { applied } = await api.post<{ applied: string[] }>(
        `/rooms/${roomId}/admin/style-profiles/${profile.id}/apply`, {},
      );
      toast(`Applied "${profile.name}" — ${applied.length} setting${applied.length === 1 ? '' : 's'} updated`, 'success');
      await load();
      onApplied();
    } catch {
      toast('Failed to apply style profile', 'error');
    }
  });

  const handleSaveAs = () => run(async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const { profile } = await api.post<{ profile: StyleProfile }>(
        `/rooms/${roomId}/admin/style-profiles`, { name },
      );
      toast(`Saved "${profile.name}"`, 'success');
      setNewName('');
      setSelectedId(profile.id);
      await load();
    } catch (err) {
      const msg = err instanceof Error && /already exists/i.test(err.message)
        ? 'You already have a profile with that name'
        : 'Failed to save style profile';
      toast(msg, 'error');
    }
  });

  const handleRecapture = (p: StyleProfile) => run(async () => {
    try {
      await api.put(`/rooms/${roomId}/admin/style-profiles/${p.id}`, { recaptureFromRoom: true });
      toast(`Updated "${p.name}" from this room`, 'success');
      await load();
    } catch {
      toast('Failed to update style profile', 'error');
    }
  });

  const handleToggleDefault = (p: StyleProfile) => run(async () => {
    try {
      await api.put(`/rooms/${roomId}/admin/style-profiles/${p.id}/default`, { isDefault: !p.isDefault });
      await load();
    } catch {
      toast('Failed to change the default profile', 'error');
    }
  });

  const handleDelete = (p: StyleProfile) => run(async () => {
    if (!window.confirm(`Delete the style profile "${p.name}"? Rooms already using it keep their look.`)) return;
    try {
      await api.delete(`/rooms/${roomId}/admin/style-profiles/${p.id}`);
      if (selectedId === p.id) setSelectedId('');
      toast(`Deleted "${p.name}"`, 'success');
      await load();
    } catch {
      toast('Failed to delete style profile', 'error');
    }
  });

  if (!loaded) return null;

  return (
    <div className="pb-4 mb-4 border-b border-border/40">
      <p className="text-[13px] font-display uppercase tracking-[0.18em] text-primary mb-1">Style Profiles</p>
      <p className="text-xs text-muted mb-3">
        Save this room's look under a name and apply it to your other rooms. Profiles never carry the room's
        name, title, logo or background image — those stay with the room.
      </p>

      {/* Apply */}
      <div className="flex items-center gap-2 mb-2">
        <select
          value={selectedId}
          onChange={e => setSelectedId(e.target.value)}
          disabled={busy || profiles.length === 0}
          className="flex-1 min-w-0 px-3 py-1.5 bg-raised text-primary border border-border rounded text-sm disabled:opacity-50"
        >
          <option value="">{profiles.length === 0 ? 'No saved profiles yet' : 'Choose a profile…'}</option>
          {profiles.map(p => (
            <option key={p.id} value={p.id}>
              {p.name}{p.isDefault ? ' ★' : ''}{matchesCurrent(p) ? ' — in use here' : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleApply}
          disabled={busy || !selectedId}
          className="shrink-0 px-3 py-1.5 rounded border border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan text-sm cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Check size={14} className="inline mr-1" />Apply
        </button>
      </div>

      {/* Save as */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && newName.trim()) handleSaveAs(); }}
          placeholder="Name this look…"
          maxLength={60}
          className="flex-1 min-w-0 px-3 py-1.5 bg-raised text-primary border border-border rounded text-sm"
        />
        <button
          type="button"
          onClick={handleSaveAs}
          disabled={busy || !newName.trim()}
          className="shrink-0 px-3 py-1.5 rounded border border-border bg-raised text-primary text-sm cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Save size={14} className="inline mr-1" />Save this room
        </button>
      </div>
      {hasUnsavedChanges && (
        <p className="mt-1.5 text-[11px] text-neon-amber">
          You have unsaved changes. Saving a profile captures this room's <em>saved</em> settings — save the page first
          to include them.
        </p>
      )}

      {/* Manage */}
      {profiles.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setManageOpen(o => !o)}
            className="flex items-center gap-2 mt-3 text-sm text-muted hover:text-primary cursor-pointer bg-transparent border-none"
          >
            {manageOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className="font-display text-xs uppercase tracking-wider">Manage profiles</span>
          </button>

          {manageOpen && (
            <div className="mt-2 space-y-1.5">
              {profiles.map(p => (
                <div key={p.id} className="flex items-center gap-2 rounded border border-border/60 bg-raised px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-primary truncate">
                      {p.name}
                      {p.isDefault && <span className="ml-2 text-[10px] text-neon-amber uppercase tracking-wider">Default</span>}
                    </p>
                    <p className="text-[11px] text-faint">{Object.keys(p.settings).length} settings</p>
                  </div>
                  <button
                    type="button"
                    title={p.isDefault ? 'Remove as default for your rooms' : 'Make default for all my rooms'}
                    aria-label={p.isDefault ? `Remove ${p.name} as default` : `Make ${p.name} the default`}
                    onClick={() => handleToggleDefault(p)}
                    disabled={busy}
                    className={`shrink-0 p-1.5 rounded cursor-pointer border-none bg-transparent ${p.isDefault ? 'text-neon-amber' : 'text-faint hover:text-primary'}`}
                  >
                    <Star size={15} fill={p.isDefault ? 'currentColor' : 'none'} />
                  </button>
                  <button
                    type="button"
                    title="Update this profile from the current room"
                    aria-label={`Update ${p.name} from this room`}
                    onClick={() => handleRecapture(p)}
                    disabled={busy}
                    className="shrink-0 p-1.5 rounded cursor-pointer border-none bg-transparent text-faint hover:text-primary"
                  >
                    <RefreshCw size={15} />
                  </button>
                  <button
                    type="button"
                    title="Delete this profile"
                    aria-label={`Delete ${p.name}`}
                    onClick={() => handleDelete(p)}
                    disabled={busy}
                    className="shrink-0 p-1.5 rounded cursor-pointer border-none bg-transparent text-faint hover:text-neon-magenta"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
