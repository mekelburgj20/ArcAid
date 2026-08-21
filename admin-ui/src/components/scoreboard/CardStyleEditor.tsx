import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Image, Search, Upload } from 'lucide-react';
import NeonButton from '../NeonButton';
import StyleUploadForm from '../StyleUploadForm';
import { api } from '../../lib/api';
import { BG_ZOOM_MAX, BG_ZOOM_MIN, DEFAULT_BG_POS, DEFAULT_BG_ZOOM } from '../../lib/bgFraming';

/**
 * v2.119.0 (C2) — the card art editor, hosted in the admin Leaderboard page's
 * display rail (desktop) or bottom sheet (phone).
 *
 * It replaces `StylePicker`'s modal for the two Leaderboard call sites. The
 * difference that matters is not the layout: it is that THE CARD ITSELF IS THE
 * PREVIEW. The modal previewed a background inside a 128px-tall strip that
 * shared neither the card's aspect ratio nor its style, theme or fill setting,
 * so "background framing doesn't look like the card sizing" was structurally
 * unavoidable. Here every control writes a draft overlay that the host merges
 * into the real leaderboard row before the real `ScoreboardSurface` renders it,
 * and the framing drag happens ON that card.
 *
 * The component is deliberately CONTROLLED — it owns the art-pack list and
 * nothing else. Framing in particular has two editors (this zoom slider and
 * the drag overlay on the card, which lives on the page), so its state has to
 * sit above both.
 */

export interface ArtPackStyle {
  id: string;
  name: string;
  author: string;
  has_background: number;
  has_header: number;
  source: string;
}

/** Unchanged from `StylePicker` — the same three endpoint families hang off it. */
export type ImageApplyType = 'both' | 'logo' | 'background';

export interface CardFraming {
  zoom: number;
  posX: number;
  posY: number;
}

export interface CardStyleEditorProps {
  /** Ranking-group cards have one background slot and no framing, per
   *  `AssignRankingGroupStyleSchema` ({ styleId } and nothing else). */
  mode: 'game' | 'ranking';
  cardName: string;
  /** The style id currently in effect for the card, draft included. */
  selectedStyleId: string | null;
  onPickStyle: (style: ArtPackStyle) => void;
  applyAs: ImageApplyType;
  onApplyAs: (t: ImageApplyType) => void;
  headerDisabled: boolean;
  onHeaderDisabled: (v: boolean) => void;
  framing: CardFraming;
  onFraming: (f: CardFraming) => void;
  /**
   * v2.122.1 — the zoom at which the WHOLE background fits inside this card,
   * for the "Fit whole image" button. It depends on the card's live geometry
   * and the art's aspect, so the host measures it (`useCoverFraming` publishes
   * both); null means the image has not reported its size yet and the button
   * is offered as disabled rather than hidden — a control that vanishes for a
   * second reads as a bug.
   */
  fitZoom?: number | null;
  /** The floor stopped the fit short: the art still overflows at `fitZoom`. */
  fitClamped?: boolean;
  /** `SCOREBOARD_CARD_BG_FILL` — framing renders only on the fill layer, so
   *  with fill off the controls are honest about doing nothing visible. */
  fillOn: boolean;
  onEnableFill: () => void;
  showDefaultOption: boolean;
  libraryHasDefault: boolean;
  setAsDefault: boolean;
  onSetAsDefault: (v: boolean) => void;
  uploadPath?: string;
  gameName?: string;
  dirty: boolean;
  applying: boolean;
  onApply: () => void;
  onCancel: () => void;
  onClear: () => void;
}

const PAGE_SIZE = 24;

/** Every interactive control in here clears the 44px touch target: the phone
 *  sheet is a first-class host, not a fallback. */
const TOUCH = 'min-h-11';

export default function CardStyleEditor({
  mode,
  cardName,
  selectedStyleId,
  onPickStyle,
  applyAs,
  onApplyAs,
  headerDisabled,
  onHeaderDisabled,
  framing,
  onFraming,
  fitZoom = null,
  fitClamped = false,
  fillOn,
  onEnableFill,
  showDefaultOption,
  libraryHasDefault,
  setAsDefault,
  onSetAsDefault,
  uploadPath,
  gameName,
  dirty,
  applying,
  onApply,
  onCancel,
  onClear,
}: CardStyleEditorProps) {
  const [styles, setStyles] = useState<ArtPackStyle[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);

  const fetchStyles = useCallback(async (q: string, off: number) => {
    setLoading(true);
    try {
      const data = await api.get<{ styles: ArtPackStyle[]; total: number }>(
        `/styles?q=${encodeURIComponent(q)}&limit=${PAGE_SIZE}&offset=${off}`,
      );
      setStyles(data.styles);
      setTotal(data.total);
    } catch {
      // Silent — the host owns toasts.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStyles(query, offset); }, [query, offset, fetchStyles]);

  useEffect(() => {
    const timer = setTimeout(() => { setOffset(0); setQuery(searchInput); }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const isGame = mode === 'game';
  // Framing acts on a background, so it is pointless while the picked art is
  // being applied as the identifier only.
  const framingVisible = isGame && applyAs !== 'logo';
  /** The zoom is exactly the whole-image fit — worth saying, since the number
   *  itself (16%) looks arbitrary otherwise. */
  const atFit = fitZoom !== null && framing.zoom === fitZoom;

  if (showUpload && uploadPath) {
    return (
      <div data-testid="card-style-editor">
        <SectionTitle>Upload art pack</SectionTitle>
        <StyleUploadForm
          uploadPath={uploadPath}
          gameName={gameName}
          onUploaded={(newStyleId) => {
            setShowUpload(false);
            fetchStyles(query, offset);
            // Select it straight away: the reason to upload art here is to put
            // it on THIS card, and the card previews it immediately.
            onPickStyle({ id: newStyleId, name: gameName || newStyleId, author: '', has_background: 1, has_header: 1, source: 'custom' });
          }}
          onCancel={() => setShowUpload(false)}
        />
      </div>
    );
  }

  return (
    <div data-testid="card-style-editor" className="pt-3">
      <p className="text-[11px] text-faint mb-3">
        Editing <span className="text-primary">{cardName}</span>. Every change previews on the card itself — nothing is
        saved until you press Apply.
      </p>

      {/* ── Art pack ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <SectionTitle>Art pack</SectionTitle>
        {uploadPath && (
          <button
            type="button"
            onClick={() => setShowUpload(true)}
            className={`${TOUCH} inline-flex items-center gap-1.5 px-2 text-xs text-neon-cyan hover:text-neon-cyan/80 bg-transparent border-0 cursor-pointer`}
          >
            <Upload size={14} /> Upload
          </button>
        )}
      </div>

      <div className="relative mb-2">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input
          type="text"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          placeholder="Search art packs..."
          aria-label="Search art packs"
          className={`${TOUCH} w-full pl-9 pr-3 py-2 bg-raised border border-border rounded text-sm text-primary placeholder:text-faint focus:outline-none focus:border-neon-cyan/50`}
        />
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-20 bg-raised border border-border rounded animate-pulse" />
          ))}
        </div>
      ) : styles.length === 0 ? (
        <div className="text-center text-muted text-sm py-6">No art packs found.</div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {styles.map(style => {
            const isSelected = style.id === selectedStyleId;
            const bgUrl = style.has_background ? `/api/styles/images/backgrounds/${style.id}.png` : null;
            const headerUrl = style.has_header ? `/api/styles/images/headers/${style.id}.png` : null;
            return (
              <button
                key={style.id}
                type="button"
                onClick={() => onPickStyle(style)}
                aria-pressed={isSelected}
                className={`text-left rounded overflow-hidden cursor-pointer border-2 bg-transparent p-0 transition-colors ${
                  isSelected ? 'border-neon-cyan' : 'border-transparent hover:border-border'
                }`}
              >
                <div
                  className="h-16 bg-raised bg-cover bg-center relative"
                  style={bgUrl ? { backgroundImage: `url(${bgUrl})` } : undefined}
                >
                  {headerUrl && <img src={headerUrl} alt="" className="absolute inset-0 w-full h-full object-contain" />}
                  {!bgUrl && !headerUrl && (
                    <div className="flex items-center justify-center h-full text-faint"><Image size={16} /></div>
                  )}
                  <div className="absolute bottom-1 left-1 flex gap-0.5">
                    {style.has_background ? <span className="px-1 py-0.5 text-[8px] font-bold rounded bg-black/60 text-neon-green">BG</span> : null}
                    {style.has_header ? <span className="px-1 py-0.5 text-[8px] font-bold rounded bg-black/60 text-neon-amber">HDR</span> : null}
                  </div>
                </div>
                <div className="bg-surface p-1.5">
                  <div className="text-[11px] text-primary truncate">{style.name}</div>
                  <div className="text-[10px] text-faint truncate">{style.author}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-2">
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            aria-label="Previous page"
            className={`${TOUCH} min-w-11 inline-flex items-center justify-center text-muted hover:text-primary disabled:opacity-30 bg-transparent border-0 cursor-pointer disabled:cursor-not-allowed`}
          >
            <ChevronLeft size={16} />
          </button>
          <span className="text-xs text-muted">{currentPage} / {totalPages}</span>
          <button
            type="button"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
            aria-label="Next page"
            className={`${TOUCH} min-w-11 inline-flex items-center justify-center text-muted hover:text-primary disabled:opacity-30 bg-transparent border-0 cursor-pointer disabled:cursor-not-allowed`}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}

      {isGame && (
        <>
          {/* ── Apply as ─────────────────────────────────────────────────── */}
          <div className="mt-4">
            <SectionTitle>Apply as</SectionTitle>
            <div className="inline-flex rounded border border-border overflow-hidden mt-1.5">
              {(['both', 'background', 'logo'] as const).map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => onApplyAs(t)}
                  aria-pressed={applyAs === t}
                  className={`${TOUCH} px-3 text-xs border-0 cursor-pointer transition-colors ${
                    applyAs === t ? 'bg-neon-cyan/20 text-neon-cyan' : 'bg-surface text-muted hover:text-primary'
                  }`}
                >
                  {t === 'both' ? 'Both' : t === 'background' ? 'Background' : 'Identifier'}
                </button>
              ))}
            </div>
          </div>

          {/* ── Hide game identifier ─────────────────────────────────────────
              v1 hid this behind `!showImageTypeSelector`, which the Leaderboard
              call site always set — so on the one page where cards have
              identifiers it was unreachable. It is a first-class toggle now and
              live-previews through `styleHeaderDisabled`. */}
          <ToggleRow
            label="Hide game identifier"
            hint="Show the background only; the card falls back to its text title."
            checked={headerDisabled}
            onChange={onHeaderDisabled}
          />

          {/* ── Background framing ───────────────────────────────────────── */}
          {framingVisible && (
            <div className="mt-4" data-testid="card-framing-controls">
              <div className="flex items-center justify-between gap-2">
                <SectionTitle>Background framing</SectionTitle>
                <button
                  type="button"
                  onClick={() => onFraming({ zoom: DEFAULT_BG_ZOOM, posX: DEFAULT_BG_POS, posY: DEFAULT_BG_POS })}
                  className={`${TOUCH} px-2 text-xs text-muted hover:text-neon-cyan bg-transparent border-0 cursor-pointer`}
                >
                  Reset framing
                </button>
              </div>

              {!fillOn && (
                <div className="mt-1.5 rounded border border-neon-amber/30 bg-neon-amber/10 px-3 py-2">
                  <p className="text-[11px] text-neon-amber">
                    Framing has no effect while Card Background Fill is off — the card draws its art in a separate
                    panel instead of behind the scores.
                  </p>
                  <button
                    type="button"
                    onClick={onEnableFill}
                    className={`${TOUCH} mt-1 px-0 text-[11px] text-neon-cyan underline bg-transparent border-0 cursor-pointer`}
                  >
                    Turn Card Background Fill on
                  </button>
                </div>
              )}

              <div className="flex items-center gap-2 mt-2">
                <span className="text-xs text-muted shrink-0">Zoom</span>
                {/* v2.122.1 — step 1, not 5. The floor moved to 10, and the
                    values that matter down there are single digits apart (a
                    3:1 strip fits a 1:2 card at 16%, not 15 or 20), so a
                    5-point grid could not express the fit it now offers. */}
                <input
                  type="range"
                  aria-label="Background zoom"
                  min={BG_ZOOM_MIN}
                  max={BG_ZOOM_MAX}
                  step={1}
                  value={framing.zoom}
                  onChange={e => onFraming({ ...framing, zoom: clampZoom(Number(e.target.value)) })}
                  className="flex-1 accent-neon-cyan cursor-pointer h-11"
                />
                <span data-testid="card-framing-zoom-value" className="text-xs text-neon-cyan font-mono shrink-0 text-right">
                  {framing.zoom}%{atFit ? (fitClamped ? ' · closest' : ' · fits') : ''}
                </span>
              </div>
              <button
                type="button"
                data-testid="card-framing-fit"
                onClick={() => { if (fitZoom !== null) onFraming({ zoom: fitZoom, posX: DEFAULT_BG_POS, posY: DEFAULT_BG_POS }); }}
                disabled={fitZoom === null}
                title={fitZoom === null
                  ? 'Available once the background image has loaded'
                  : `Zoom to ${fitZoom}% and centre, so the whole picture is inside the card`}
                className={`${TOUCH} mt-1 inline-flex items-center px-2 text-[11px] rounded border bg-transparent cursor-pointer transition-colors ${
                  fitZoom === null
                    ? 'text-faint border-border cursor-not-allowed'
                    : 'text-neon-cyan border-neon-cyan/40 hover:bg-neon-cyan/10'
                }`}
              >
                Fit whole image
              </button>
              <p className="text-[11px] text-faint mt-1">
                Drag the highlighted card to reposition the art. Below 100% the whole picture is zoomed out to fit,
                so the card shows through as bars on the short side.
              </p>
            </div>
          )}

          {/* ── Library default ──────────────────────────────────────────── */}
          {showDefaultOption && (
            <ToggleRow
              label={libraryHasDefault ? 'Update this game’s room default' : 'Set as this game’s room default'}
              hint="Applies the same art the next time this game is activated in any tournament in this room."
              checked={setAsDefault}
              onChange={onSetAsDefault}
            />
          )}
        </>
      )}

      {/* ── Actions ─────────────────────────────────────────────────────────
          v2.122.1 — the "pick an art pack before applying" note is GONE with
          the rule it explained: framing has its own endpoint now, so zoom and
          position save onto any card, art pack or plain catalogue art. The
          fill-off note above stays — that one is still true. */}
      <div className="flex flex-wrap justify-between gap-2 mt-5 pt-3 border-t border-border/40">
        <NeonButton variant="ghost" className="text-xs" onClick={onClear} disabled={applying}>
          Clear style
        </NeonButton>
        <div className="flex gap-2">
          <NeonButton variant="ghost" className="text-xs" onClick={onCancel} disabled={applying}>Cancel</NeonButton>
          <NeonButton className="text-xs" onClick={onApply} disabled={applying || !dirty}>
            {applying ? 'Applying...' : 'Apply'}
          </NeonButton>
        </div>
      </div>
    </div>
  );
}

function clampZoom(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_BG_ZOOM;
  return Math.min(BG_ZOOM_MAX, Math.max(BG_ZOOM_MIN, n));
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-display uppercase tracking-wider text-neon-cyan/70 pl-2 border-l-2 border-neon-cyan/30">{children}</h3>;
}

/** A 44px-tall switch row — the checkbox idiom the rail's other toggles use. */
function ToggleRow({ label, hint, checked, onChange }: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="mt-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm text-primary">{label}</div>
        {hint && <div className="text-[11px] text-faint">{hint}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`${TOUCH} min-w-11 shrink-0 inline-flex items-center justify-center rounded border px-2 text-[11px] cursor-pointer transition-colors ${
          checked
            ? 'bg-neon-cyan/20 text-neon-cyan border-neon-cyan/40'
            : 'bg-surface text-muted border-border hover:text-primary'
        }`}
      >
        {checked ? 'On' : 'Off'}
      </button>
    </div>
  );
}
