import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { X } from 'lucide-react';
import { api } from '../lib/api';
import NeonButton from './NeonButton';

interface RenameCatalogueGameModalProps {
  game: { id: string; name: string; manufacturer: string | null; year: number | null };
  onClose: () => void;
  /** Called after the server accepted the new name. */
  onRenamed: () => void;
}

/**
 * Rename one catalogue game (Super Admin -> Global Catalogue).
 *
 * Name only, on purpose: it is the one field an import never writes back on an
 * existing row. Manufacturer and year are supplied by the sources, so an edit
 * to them here would be undone by the next sync.
 */
export default function RenameCatalogueGameModal({ game, onClose, onRenamed }: RenameCatalogueGameModalProps) {
  const [name, setName] = useState(game.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const trimmed = name.trim();
  const unchanged = trimmed === game.name;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!trimmed || unchanged || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.put(`/admin/catalogue/games/${game.id}`, { name: trimmed });
      onRenamed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed');
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label="Rename game"
        className="bg-surface border border-border rounded-lg shadow-2xl w-full max-w-lg"
        onSubmit={save}
      >
        <div className="flex items-start justify-between p-5 border-b border-border">
          <div>
            <h2 className="font-display text-xl font-bold text-primary">Rename game</h2>
            <p className="text-sm text-muted mt-1">
              <span className="text-primary">{game.name}</span>
              {game.manufacturer && <> ({game.manufacturer}{game.year ? `, ${game.year}` : ''})</>}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:text-primary bg-transparent border-0 cursor-pointer p-1 -mr-1 -mt-1"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label htmlFor="rename-catalogue-game" className="block text-xs text-muted uppercase tracking-wider mb-1">
              Name
            </label>
            <input
              id="rename-catalogue-game"
              ref={inputRef}
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={200}
              autoComplete="off"
              className="w-full bg-deep border border-border rounded px-3 py-2 text-primary focus:outline-none focus:border-neon-cyan"
            />
          </div>

          <ul className="text-xs text-muted bg-raised/40 border border-border rounded p-3 space-y-1 list-disc pl-6">
            <li>The next import keeps this name. The old name is remembered, so a source that still uses it updates this game.</li>
            <li>A cabinet score is matched to the catalogue by this name.</li>
            <li>Room games and past scores saved under the old name are not renamed. Move them in Game Names.</li>
          </ul>

          {error && (
            <p role="alert" className="text-sm text-neon-magenta">{error}</p>
          )}

          <div className="flex justify-end gap-3">
            <NeonButton type="button" variant="ghost" onClick={onClose}>Cancel</NeonButton>
            <NeonButton type="submit" variant="primary" disabled={!trimmed || unchanged || saving}>
              {saving ? 'Renaming…' : 'Rename'}
            </NeonButton>
          </div>
        </div>
      </form>
    </div>
  );
}
