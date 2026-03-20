import { useState, useEffect, useCallback } from 'react';
import { Search, X, Image, ChevronLeft, ChevronRight } from 'lucide-react';
import NeonButton from './NeonButton';
import { api } from '../lib/api';

interface Style {
  id: string;
  name: string;
  author: string;
  has_background: number;
  has_header: number;
  source: string;
}

interface StylePickerProps {
  /** Currently assigned style ID, if any */
  currentStyleId?: string | null;
  /** Whether header is currently disabled */
  headerDisabled?: boolean;
  /** Called when a style is selected (or cleared) */
  onSelect: (styleId: string | null, headerDisabled: boolean, setAsDefault?: boolean) => void;
  onClose: () => void;
  /** Show "Set as default style for this game" checkbox */
  showDefaultOption?: boolean;
  /** Whether the library already has a default style for this game */
  libraryHasDefault?: boolean;
}

const PAGE_SIZE = 30;

export default function StylePicker({ currentStyleId, headerDisabled = false, onSelect, onClose, showDefaultOption = false, libraryHasDefault = false }: StylePickerProps) {
  const [styles, setStyles] = useState<Style[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(currentStyleId || null);
  const [disableHeader, setDisableHeader] = useState(headerDisabled);
  const [setAsDefault, setSetAsDefault] = useState(!libraryHasDefault);

  const fetchStyles = useCallback(async (q: string, off: number) => {
    setLoading(true);
    try {
      const data = await api.get<{ styles: Style[]; total: number }>(
        `/styles?q=${encodeURIComponent(q)}&limit=${PAGE_SIZE}&offset=${off}`
      );
      setStyles(data.styles);
      setTotal(data.total);
    } catch {
      // Silent fail — toast is handled by parent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStyles(query, offset);
  }, [query, offset, fetchStyles]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setOffset(0);
      setQuery(searchInput);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const selectedStyle = styles.find(s => s.id === selectedId);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-lg w-full max-w-3xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <h3 className="font-display text-sm font-bold text-primary">Select Style</h3>
          <button onClick={onClose} className="text-muted hover:text-primary bg-transparent border-0 cursor-pointer">
            <X size={18} />
          </button>
        </div>

        {/* Search */}
        <div className="p-4 border-b border-border shrink-0">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="text"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder="Search styles by name or author..."
              className="w-full pl-10 pr-4 py-2 bg-raised border border-border rounded text-sm text-primary placeholder:text-faint focus:outline-none focus:border-neon-cyan/50"
              autoFocus
            />
          </div>
        </div>

        {/* Grid */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
              {Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="h-28 bg-raised border border-border rounded animate-pulse" />
              ))}
            </div>
          ) : styles.length === 0 ? (
            <div className="text-center text-muted py-8">No styles found.</div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
              {styles.map(style => {
                const isSelected = style.id === selectedId;
                const bgUrl = style.has_background ? `/api/styles/images/backgrounds/${style.id}.png` : null;
                const headerUrl = style.has_header ? `/api/styles/images/headers/${style.id}.png` : null;

                return (
                  <div
                    key={style.id}
                    onClick={() => setSelectedId(style.id)}
                    className={`rounded overflow-hidden cursor-pointer border-2 transition-colors ${
                      isSelected ? 'border-neon-cyan' : 'border-transparent hover:border-border'
                    }`}
                  >
                    <div
                      className="h-20 bg-raised bg-cover bg-center relative"
                      style={bgUrl ? { backgroundImage: `url(${bgUrl})` } : undefined}
                    >
                      {headerUrl && (
                        <img src={headerUrl} alt="" className="absolute inset-0 w-full h-full object-contain" />
                      )}
                      {!bgUrl && !headerUrl && (
                        <div className="flex items-center justify-center h-full text-faint">
                          <Image size={16} />
                        </div>
                      )}
                    </div>
                    <div className="bg-surface p-1.5">
                      <div className="text-xs text-primary truncate">{style.name}</div>
                      <div className="text-xs text-faint truncate">{style.author}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 mt-4">
              <button
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                className="text-muted hover:text-primary disabled:opacity-30 bg-transparent border-0 cursor-pointer disabled:cursor-not-allowed"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-xs text-muted">{currentPage} / {totalPages}</span>
              <button
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
                className="text-muted hover:text-primary disabled:opacity-30 bg-transparent border-0 cursor-pointer disabled:cursor-not-allowed"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border p-4 shrink-0">
          {/* Header toggle */}
          {selectedId && selectedStyle?.has_header ? (
            <label className="flex items-center gap-2 mb-3 cursor-pointer">
              <input
                type="checkbox"
                checked={disableHeader}
                onChange={e => setDisableHeader(e.target.checked)}
                className="accent-neon-cyan"
              />
              <span className="text-sm text-muted">Hide header image (show background only)</span>
            </label>
          ) : null}

          {/* Set as default toggle */}
          {showDefaultOption && selectedId ? (
            <label className="flex items-center gap-2 mb-3 cursor-pointer">
              <input
                type="checkbox"
                checked={setAsDefault}
                onChange={e => setSetAsDefault(e.target.checked)}
                className="accent-neon-cyan"
              />
              <span className="text-sm text-muted">
                {libraryHasDefault
                  ? 'Update default style for this game in the library'
                  : 'Set as default style for this game in the library'}
              </span>
            </label>
          ) : null}

          <div className="flex justify-between gap-2">
            <NeonButton variant="ghost" onClick={() => onSelect(null, false, showDefaultOption ? setAsDefault : undefined)}>
              Clear Style
            </NeonButton>
            <div className="flex gap-2">
              <NeonButton variant="ghost" onClick={onClose}>Cancel</NeonButton>
              <NeonButton
                disabled={!selectedId}
                onClick={() => onSelect(selectedId, disableHeader, showDefaultOption ? setAsDefault : undefined)}
              >
                Apply Style
              </NeonButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
