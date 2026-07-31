import { useEffect, useRef, useState } from 'react';
import { X, ExternalLink } from 'lucide-react';
import { api } from '../lib/api';
import LoadingState from './LoadingState';
import { getLegacyPlatformLabel } from '../lib/scoreProvenance';

interface GlobalGame {
  id: string;
  name: string;
  display_name: string | null;
  manufacturer: string | null;
  year: number | null;
  type: string;
  subtype: string | null;
  platforms: string[];
  themes: string[];
  designers: string[];
  table_authors: string[];
  features: string[];
  players: number | null;
  image_url: string | null;
  local_image_path: string | null;
  wheel_image_path: string | null;
  opdb_id: string | null;
  vps_id: string | null;
  igdb_id: number | null;
  ipdb_url: string | null;
  external_url: string | null;
  description: string | null;
}

function toCatalogueUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  // DB stores filesystem paths like "data/catalogue-images/opdb/foo.jpg".
  // The server mounts the catalogue-images directory at /api/catalogue-images/.
  const m = path.match(/^\/?data\/catalogue-images\/(.+)$/);
  if (m) return `/api/catalogue-images/${m[1]}`;
  return path.startsWith('/') ? path : `/${path}`;
}

function resolveImage(g: GlobalGame): string | null {
  if (g.local_image_path) return toCatalogueUrl(g.local_image_path);
  if (g.image_url) return g.image_url;
  return null;
}

interface Props {
  gameId: string;
  /** Seed values shown in the header before the fetch resolves so the modal
   *  isn't blank while loading. The Game Library row already has these. */
  seedName?: string;
  seedManufacturer?: string | null;
  seedYear?: number | null;
  onClose: () => void;
}

/**
 * Lightweight catalogue-detail popup for verifying which game a row points at.
 * Fetches `/api/global/games/:id` on mount; renders metadata + optional image.
 * No business actions; the row's own buttons (Activate, Pin, Tag) are the
 * write surface. Out-of-modal links use target="_blank" so the admin's
 * filtered/scrolled list state is preserved on return.
 */
export default function GameInfoModal({ gameId, seedName, seedManufacturer, seedYear, onClose }: Props) {
  const [game, setGame] = useState<GlobalGame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const backdropMouseDown = useRef(false);

  useEffect(() => {
    api.get<GlobalGame>(`/global/games/${gameId}`)
      .then(setGame)
      .catch(err => setError(err?.message || 'Failed to load game'));
  }, [gameId]);

  // Esc closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const headerName = game?.display_name || game?.name || seedName || 'Loading…';
  const headerSub = game
    ? [game.manufacturer, game.year].filter(Boolean).join(' · ')
    : [seedManufacturer, seedYear].filter(Boolean).join(' · ');
  const imageUrl = game ? resolveImage(game) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm p-4"
      onMouseDown={e => { backdropMouseDown.current = e.target === e.currentTarget; }}
      onClick={e => { if (e.target === e.currentTarget && backdropMouseDown.current) onClose(); }}
    >
      <div
        className="bg-surface border border-border rounded-lg shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-5 border-b border-border sticky top-0 bg-surface z-10">
          <div className="min-w-0 mr-3">
            <h2 className="font-display text-xl font-bold text-primary truncate">{headerName}</h2>
            {headerSub && <p className="text-sm text-muted mt-1">{headerSub}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:text-primary bg-transparent border-0 cursor-pointer p-1 -mr-1 -mt-1 flex-shrink-0"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-5">
          {error ? (
            <p className="text-neon-magenta text-sm">{error}</p>
          ) : !game ? (
            <LoadingState message="Loading game details..." />
          ) : (
            <>
              <div className="flex gap-5 flex-col sm:flex-row">
                {imageUrl && (
                  <img
                    src={imageUrl}
                    alt={game.name}
                    className="w-full sm:w-48 h-auto rounded border border-border object-cover flex-shrink-0"
                    onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                  />
                )}
                <div className="flex-1 min-w-0 space-y-3">
                  <Field label="Type">
                    <span className="text-sm">{game.type}{game.subtype ? ` · ${game.subtype}` : ''}</span>
                  </Field>

                  {game.platforms.length > 0 && (
                    /* v2.58.0 (ADR 0016): "Engines" — a game is authored FOR an
                       engine; which device runs it is a property of the score,
                       not the game. Labels folded + deduped accordingly. */
                    <Field label="Engines">
                      <div className="flex flex-wrap gap-1">
                        {[...new Set(game.platforms.map(p => getLegacyPlatformLabel(p, false)))].map(label => (
                          <span key={label} className="text-xs px-1.5 py-0.5 rounded bg-neon-cyan/10 text-neon-cyan border border-neon-cyan/30">
                            {label}
                          </span>
                        ))}
                      </div>
                    </Field>
                  )}

                  {game.themes.length > 0 && (
                    <Field label="Themes"><span className="text-sm">{game.themes.join(', ')}</span></Field>
                  )}
                  {game.designers.length > 0 && (
                    <Field label="Designers"><span className="text-sm">{game.designers.join(', ')}</span></Field>
                  )}
                  {game.table_authors.length > 0 && (
                    <Field label="Table Authors"><span className="text-sm">{game.table_authors.join(', ')}</span></Field>
                  )}
                  {typeof game.players === 'number' && (
                    <Field label="Players"><span className="text-sm">{game.players}</span></Field>
                  )}
                </div>
              </div>

              {game.description && (
                <div className="mt-5 pt-5 border-t border-border">
                  <span className="text-xs text-faint uppercase tracking-wider font-display block mb-1">Description</span>
                  <p className="text-sm text-muted whitespace-pre-wrap">{game.description}</p>
                </div>
              )}

              <div className="mt-5 pt-5 border-t border-border flex flex-wrap gap-2 items-center">
                {game.ipdb_url && (
                  <a href={game.ipdb_url} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-border text-muted hover:text-primary hover:border-neon-cyan/40 no-underline">
                    IPDB <ExternalLink size={12} />
                  </a>
                )}
                {game.external_url && (
                  <a href={game.external_url} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-border text-muted hover:text-primary hover:border-neon-cyan/40 no-underline">
                    External <ExternalLink size={12} />
                  </a>
                )}
                <a href={`/games/${game.id}`} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-neon-cyan/40 text-neon-cyan hover:bg-neon-cyan/10 no-underline ml-auto">
                  View full page <ExternalLink size={12} />
                </a>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="text-xs text-faint uppercase tracking-wider font-display block mb-0.5">{label}</span>
      {children}
    </div>
  );
}
