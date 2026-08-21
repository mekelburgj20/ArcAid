import { useState, useEffect, useCallback, useRef } from 'react';
import { Search, X, Image, ChevronLeft, ChevronRight, Upload } from 'lucide-react';
import NeonButton from './NeonButton';
import StyleUploadForm from './StyleUploadForm';
import { api } from '../lib/api';
import {
  dragFramingPos, resolveFraming, BG_ZOOM_MIN, BG_ZOOM_MAX, DEFAULT_BG_ZOOM, DEFAULT_BG_POS,
  type BgFraming,
} from '../lib/bgFraming';
import { useCoverFraming } from './scoreboard/useCoverFraming';

interface Style {
  id: string;
  name: string;
  author: string;
  has_background: number;
  has_header: number;
  source: string;
}

export type ImageApplyType = 'both' | 'logo' | 'background';

interface StylePickerProps {
  /** Currently assigned style ID, if any */
  currentStyleId?: string | null;
  /** Whether header is currently disabled */
  headerDisabled?: boolean;
  /**
   * Called when a style is selected (or cleared).
   *
   * `framing` is present only when `showFraming` is on, and always carries the
   * picker's full current state — the write paths treat a missing axis as
   * "unframed", so a partial object would silently reset one.
   */
  onSelect: (styleId: string | null, headerDisabled: boolean, setAsDefault?: boolean, imageType?: ImageApplyType, framing?: BgFraming) => void;
  onClose: () => void;
  /**
   * v2.115.0 — show the background framing controls (zoom + drag). Off for
   * targets with no per-game background to frame, e.g. the ranking-group
   * style picker, whose endpoint takes a style id and nothing else.
   */
  showFraming?: boolean;
  /** Current framing of the target, if any. */
  bgZoom?: number | null;
  bgPosX?: number | null;
  bgPosY?: number | null;
  /** Background the card falls back to when the chosen style has none (the
   *  catalogue image). Used for the framing preview only. */
  fallbackBgUrl?: string | null;
  /** Show "Set as default style for this game" checkbox */
  showDefaultOption?: boolean;
  /** Whether the library already has a default style for this game */
  libraryHasDefault?: boolean;
  /** Show image type selector (logo/background/both) */
  showImageTypeSelector?: boolean;
  /** API path for uploading custom styles. When provided, shows Upload button. */
  uploadPath?: string;
  /** Game name to pre-fill the upload form name field */
  gameName?: string;
}

const PAGE_SIZE = 30;

export default function StylePicker({
  currentStyleId,
  headerDisabled = false,
  onSelect,
  onClose,
  showDefaultOption = false,
  libraryHasDefault = false,
  showImageTypeSelector = false,
  uploadPath,
  gameName,
  showFraming = false,
  bgZoom,
  bgPosX,
  bgPosY,
  fallbackBgUrl,
}: StylePickerProps) {
  const [styles, setStyles] = useState<Style[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(currentStyleId || null);
  const [disableHeader, setDisableHeader] = useState(headerDisabled);
  const [setAsDefault, setSetAsDefault] = useState(!libraryHasDefault);
  const [imageType, setImageType] = useState<ImageApplyType>('both');
  const [showUpload, setShowUpload] = useState(false);

  // ── Background framing (v2.115.0) ────────────────────────────────────────
  const initialFraming = resolveFraming({ bgZoom, bgPosX, bgPosY });
  const [zoom, setZoom] = useState(initialFraming.zoom);
  const [posX, setPosX] = useState(initialFraming.posX);
  const [posY, setPosY] = useState(initialFraming.posY);
  const previewRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ clientX: number; clientY: number; posX: number; posY: number } | null>(null);

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

  const backdropMouseDown = useRef(false);

  // The background the framing acts on: the chosen style's, else the game's
  // catalogue art (which is what the card falls back to). No image → nothing
  // to frame, so the section stays hidden.
  const framingBgUrl = (selectedId && selectedStyle?.has_background)
    ? `/api/styles/images/backgrounds/${selectedId}.png`
    : (fallbackBgUrl || null);
  const framingVisible = showFraming && !!framingBgUrl && imageType !== 'logo';

  /** The preview box is a card stand-in, so it frames by the SAME model the
   *  cards use — otherwise the numbers mean two different pictures. */
  const previewLayer = useCoverFraming(framingVisible ? framingBgUrl : null, { bgZoom: zoom, bgPosX: posX, bgPosY: posY });

  const beginDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    previewRef.current?.setPointerCapture?.(e.pointerId);
    dragStart.current = { clientX: e.clientX, clientY: e.clientY, posX, posY };
  };
  /**
   * v2.122.1 — the picture follows the pointer on BOTH axes, at whatever zoom.
   * v1 hard-coded the overflow sign (a subtraction), which ran backwards the
   * moment the image was smaller than the box. `dragFramingPos` divides by the
   * signed slack instead, so the sign is derived, not assumed — and the axis
   * where the image exactly fits is a no-op rather than a jump.
   */
  const onDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    const box = previewRef.current;
    if (!start || !box) return;
    const g = previewLayer.geometry;
    const cardW = g?.cardW || box.offsetWidth;
    const cardH = g?.cardH || box.offsetHeight;
    if (!cardW || !cardH) return;
    // Pre-measure fallback: assume the legacy overflowing-cover geometry, which
    // is what the layer is still drawing until the image reports its size.
    const dispW = g?.dispW ?? cardW * 2;
    const dispH = g?.dispH ?? cardH * 2;
    setPosX(dragFramingPos(start.posX, e.clientX - start.clientX, cardW, dispW));
    setPosY(dragFramingPos(start.posY, e.clientY - start.clientY, cardH, dispH));
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    dragStart.current = null;
    previewRef.current?.releasePointerCapture?.(e.pointerId);
  };

  /** The framing to emit — only when the section is actually in play. */
  const framingOut = (): BgFraming | undefined =>
    showFraming ? { bgZoom: zoom, bgPosX: posX, bgPosY: posY } : undefined;

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onMouseDown={e => { backdropMouseDown.current = e.target === e.currentTarget; }} onClick={e => { if (e.target === e.currentTarget && backdropMouseDown.current) onClose(); }}>
      <div className="bg-surface border border-border rounded-lg w-full max-w-3xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <h3 className="font-display text-sm font-bold text-primary">
            {showUpload ? 'Upload Art Pack' : 'Select Art Pack'}
          </h3>
          <div className="flex items-center gap-2">
            {uploadPath && (
              <button
                onClick={() => setShowUpload(!showUpload)}
                className="flex items-center gap-1.5 text-xs text-neon-cyan hover:text-neon-cyan/80 bg-transparent border-0 cursor-pointer"
              >
                {showUpload ? <Search size={14} /> : <Upload size={14} />}
                {showUpload ? 'Browse' : 'Upload'}
              </button>
            )}
            <button onClick={onClose} className="text-muted hover:text-primary bg-transparent border-0 cursor-pointer">
              <X size={18} />
            </button>
          </div>
        </div>

        {showUpload && uploadPath ? (
          <StyleUploadForm
            uploadPath={uploadPath}
            gameName={gameName}
            onUploaded={(newStyleId) => {
              setShowUpload(false);
              setSelectedId(newStyleId);
              fetchStyles(query, offset);
            }}
            onCancel={() => setShowUpload(false)}
          />
        ) : (
        <>
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
                      {/* Image type badges */}
                      <div className="absolute bottom-1 left-1 flex gap-0.5">
                        {style.has_background ? <span className="px-1 py-0.5 text-[8px] font-bold rounded bg-black/60 text-neon-green">BG</span> : null}
                        {style.has_header ? <span className="px-1 py-0.5 text-[8px] font-bold rounded bg-black/60 text-neon-amber">HDR</span> : null}
                      </div>
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
          {/* Image type selector */}
          {showImageTypeSelector && selectedId ? (
            <div className="flex items-center gap-2 mb-3">
              <span className="text-sm text-muted">Apply as:</span>
              <div className="inline-flex rounded border border-border overflow-hidden">
                {(['both', 'background', 'logo'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => setImageType(t)}
                    className={`px-3 py-1 text-xs border-0 cursor-pointer transition-colors ${
                      imageType === t ? 'bg-neon-cyan/20 text-neon-cyan' : 'bg-surface text-muted hover:text-primary'
                    }`}
                  >
                    {t === 'both' ? 'Both' : t === 'background' ? 'Background' : 'Identifier'}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* Hint when image type selector is not shown */}
          {!showImageTypeSelector && selectedId && selectedStyle?.has_header ? (
            <label className="flex items-center gap-2 mb-3 cursor-pointer">
              <input
                type="checkbox"
                checked={disableHeader}
                onChange={e => setDisableHeader(e.target.checked)}
                className="accent-neon-cyan"
              />
              <span className="text-sm text-muted">Hide game identifier (show background only)</span>
            </label>
          ) : null}

          {/* Background framing — zoom + drag, live against the real image.
              The preview box CLIPS, exactly like the card's background layer,
              so what an admin frames here is what the card renders. */}
          {framingVisible ? (
            <div className="mb-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-sm text-muted">Background framing</span>
                <button
                  onClick={() => { setZoom(DEFAULT_BG_ZOOM); setPosX(DEFAULT_BG_POS); setPosY(DEFAULT_BG_POS); }}
                  className="text-xs text-muted hover:text-neon-cyan bg-transparent border-0 cursor-pointer"
                >
                  Reset framing
                </button>
              </div>
              <div
                ref={previewRef}
                onPointerDown={beginDrag}
                onPointerMove={onDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                data-testid="framing-preview"
                className="relative w-full h-32 rounded overflow-hidden border border-border bg-raised cursor-move touch-none"
                title="Drag to reposition"
              >
                <div
                  className="absolute inset-0"
                  ref={previewLayer.ref}
                  {...previewLayer.data}
                  style={{ backgroundImage: `url(${framingBgUrl})`, ...previewLayer.style }}
                />
              </div>
              <div className="flex items-center gap-2 mt-2">
                <span className="text-xs text-muted shrink-0">Zoom</span>
                <input
                  type="range"
                  aria-label="Background zoom"
                  min={BG_ZOOM_MIN}
                  max={BG_ZOOM_MAX}
                  step={1}
                  value={zoom}
                  onChange={e => setZoom(Number(e.target.value))}
                  className="flex-1 accent-neon-cyan cursor-pointer"
                />
                <span className="text-xs text-neon-cyan font-mono w-12 text-right">{zoom}%</span>
              </div>
              <p className="text-[11px] text-faint mt-1">Drag the preview to move the image behind the card.</p>
            </div>
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
            {/* Clearing the style clears the framing with it — there is no
                background left for it to describe. */}
            <NeonButton variant="ghost" onClick={() => onSelect(null, false, showDefaultOption ? setAsDefault : undefined, showImageTypeSelector ? imageType : undefined)}>
              Clear Style
            </NeonButton>
            <div className="flex gap-2">
              <NeonButton variant="ghost" onClick={onClose}>Cancel</NeonButton>
              <NeonButton
                disabled={!selectedId}
                onClick={() => onSelect(selectedId, disableHeader, showDefaultOption ? setAsDefault : undefined, showImageTypeSelector ? imageType : undefined, framingOut())}
              >
                Apply Style
              </NeonButton>
            </div>
          </div>
        </div>
        </>
        )}
      </div>
    </div>
  );
}
