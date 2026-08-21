import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import ConfirmModal from '../ConfirmModal';
import CardStyleEditor from './CardStyleEditor';
import CardFramingDragOverlay, { useFramingGeometry } from './CardFramingDragOverlay';
import SyntheticCardPreview, { type SyntheticCardSource } from './SyntheticCardPreview';
import { applyCardEdits, type CardApplyTarget } from './cardEditApply';
import {
  buildGameCardOverlay, isCardEditDirty, isFramingOnlyEdit, newGameCardSession,
  type CardEditSession,
} from './cardEditSession';
import { fitWholeImageZoom } from '../../lib/bgFraming';
import useIsWideViewport from '../../lib/useIsWideViewport';
import { CARD_EDIT_OVERLAY_Z_INDEX } from './cardStacking';

/**
 * v2.124.0 (C3) — the host that retires `StylePicker`.
 *
 * GameLibrary and Tournaments used to open a modal titled "Select Art Pack": a
 * grid of thumbnails, a 128px framing strip, and no idea what the room's cards
 * actually look like. This opens the SAME `CardStyleEditor` the admin
 * Leaderboard rail hosts, beside a synthetic card rendered from the room's real
 * scoreboard config — so the two remaining call sites get the C2 contract
 * (every edit previews on a card; nothing reaches the server until Apply)
 * without needing a board to stand on.
 *
 * Desktop is a dialog with the card on the left and the controls on the right.
 * At ≤1024px it is a full-screen sheet with the card ABOVE the controls and its
 * own contained scroll — the same first-class-mobile call C1 made for the rail
 * (a mod in the game room with only a phone).
 */

export type CardEditTarget = CardApplyTarget;

export interface CardStyleEditorSheetProps {
  roomId: string;
  /** `{ kind:'library', gameName }` edits the room default;
   *  `{ kind:'game', gameId, gameName }` edits one activated game. */
  target: CardEditTarget;
  /** The row's current art + framing, and the metadata the card renders. */
  source: SyntheticCardSource;
  /** Game targets only: offer "Set as this game's room default". */
  showDefaultOption?: boolean;
  libraryHasDefault?: boolean;
  roomName?: string;
  slug?: string;
  /** Test seam / host cache — skips the scoreboard-config fetch. */
  config?: Record<string, string> | null;
  toast?: (message: string, type?: 'success' | 'error' | 'info') => void;
  /** Applied successfully — the host refetches its own list. */
  onApplied: () => void;
  onClose: () => void;
}

export default function CardStyleEditorSheet({
  roomId,
  target,
  source,
  showDefaultOption = false,
  libraryHasDefault = false,
  roomName,
  slug,
  config: configProp,
  toast,
  onApplied,
  onClose,
}: CardStyleEditorSheetProps) {
  const [session, setSession] = useState<CardEditSession>(() => newGameCardSession({
    id: target.kind === 'game' ? target.gameId : target.gameName,
    name: source.displayName || source.gameName,
    headerDisabled: !!source.styleHeaderDisabled,
    framing: { bgZoom: source.bgZoom, bgPosX: source.bgPosX, bgPosY: source.bgPosY },
    libraryHasDefault,
    // A library target IS the default; offering to copy it to itself would be
    // nonsense, so the toggle is off and hidden.
    setAsDefault: showDefaultOption ? !libraryHasDefault : false,
  }));
  const [applying, setApplying] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [roomConfig, setRoomConfig] = useState<Record<string, string>>(configProp ?? {});
  const isWide = useIsWideViewport();
  const previewRef = useRef<HTMLDivElement>(null);

  const patch = (p: Partial<CardEditSession>) => setSession(prev => ({ ...prev, ...p, touched: true }));

  const dirty = isCardEditDirty(session);
  const framingOnly = isFramingOnlyEdit(session);
  const overlay = buildGameCardOverlay(session);

  /**
   * The style id Apply will send when a STYLE is what changed. Neither style
   * schema accepts a null id, so a card with no art pack falls back to whatever
   * the row already carries — and when there is nothing at all, the `/framing`
   * family is what saves a pure zoom/drag edit.
   */
  const effectiveStyleId: string | null = session.pick !== undefined
    ? (session.pick ? session.pick.id : null)
    : session.applyAs === 'background'
      ? (source.bgStyleId ?? source.catalogueStyleId ?? null)
      : session.applyAs === 'logo'
        ? (source.logoStyleId ?? source.catalogueStyleId ?? null)
        : (source.catalogueStyleId ?? null);

  const geom = useFramingGeometry(`${target.kind}:${session.id}`, previewRef);
  const fitWhole = geom ? fitWholeImageZoom(geom.cardW, geom.cardH, geom.dispW, geom.dispH) : null;

  const attemptClose = () => {
    if (session.touched && dirty) { setConfirmClose(true); return; }
    onClose();
  };

  // Escape closes, through the same unsaved-changes guard as the backdrop.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') attemptClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const handleApply = async () => {
    setApplying(true);
    try {
      const { outcome, libraryError } = await applyCardEdits({
        roomId, target, session,
        styleId: effectiveStyleId,
        framingOnly,
        alsoSetLibraryDefault: showDefaultOption && session.setAsDefault,
      });
      toast?.(
        outcome === 'framing' ? 'Framing applied'
          : outcome === 'cleared' ? (target.kind === 'library' ? 'Default style cleared' : 'Style removed')
            : (target.kind === 'library' ? 'Default style set' : 'Style applied'),
        'success',
      );
      if (libraryError) toast?.('Failed to update library default', 'error');
      onApplied();
      onClose();
    } catch (err) {
      toast?.(err instanceof Error ? err.message : 'Failed to apply card style', 'error');
    } finally {
      setApplying(false);
    }
  };

  const editor = (
    <CardStyleEditor
      mode="game"
      cardName={session.name}
      selectedStyleId={effectiveStyleId}
      onPickStyle={style => patch({ pick: style })}
      applyAs={session.applyAs}
      onApplyAs={t => patch({ applyAs: t })}
      headerDisabled={session.headerDisabled}
      onHeaderDisabled={v => patch({ headerDisabled: v })}
      framing={session.framing}
      onFraming={f => patch({ framing: f })}
      fitZoom={fitWhole ? fitWhole.zoom : null}
      fitClamped={!!fitWhole?.clamped}
      /* Framing renders only on the fill layer, so with fill off the panel says
         so. There is no room draft to flip from here (that lives on the
         Leaderboard page's rail), hence no one-click enable — see
         `CardStyleEditor`'s fallback copy. */
      fillOn={roomConfig.SCOREBOARD_CARD_BG_FILL !== 'false'}
      showDefaultOption={showDefaultOption}
      libraryHasDefault={libraryHasDefault}
      setAsDefault={session.setAsDefault}
      onSetAsDefault={v => patch({ setAsDefault: v })}
      uploadPath={`/rooms/${roomId}/admin/styles/upload`}
      gameName={source.gameName}
      dirty={dirty}
      applying={applying}
      onApply={handleApply}
      onCancel={attemptClose}
      onClear={() => patch({ pick: null })}
    />
  );

  const preview = (
    <div ref={previewRef}>
      <SyntheticCardPreview
        roomId={roomId}
        source={source}
        overlay={overlay}
        config={configProp}
        roomName={roomName}
        slug={slug}
        onConfig={setRoomConfig}
      >
        <CardFramingDragOverlay
          framing={session.framing}
          onFramingPos={(posX, posY) => setSession(prev => ({
            ...prev, touched: true, framing: { ...prev.framing, posX, posY },
          }))}
          cardLabel={session.name}
          style={{ zIndex: CARD_EDIT_OVERLAY_Z_INDEX }}
        />
      </SyntheticCardPreview>
    </div>
  );

  const header = (
    <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 shrink-0">
      <div className="min-w-0">
        <h2 className="font-display text-sm font-bold text-primary truncate">Edit card art</h2>
        <p className="text-[11px] text-faint truncate">
          {target.kind === 'library' ? 'Room default for ' : ''}{session.name}
        </p>
      </div>
      <button
        type="button"
        onClick={attemptClose}
        aria-label="Close"
        className="min-h-11 min-w-11 inline-flex items-center justify-center text-muted hover:text-primary bg-transparent border-0 cursor-pointer"
      >
        <X size={18} />
      </button>
    </div>
  );

  return (
    <>
      <div
        data-testid="card-style-editor-sheet"
        className="fixed inset-0 z-50 bg-black/70 flex items-stretch lg:items-center justify-center lg:p-4"
        onMouseDown={e => { if (e.target === e.currentTarget) attemptClose(); }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Edit card art"
          onMouseDown={e => e.stopPropagation()}
          className={
            isWide
              ? 'bg-surface border border-border rounded-lg w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden'
              : 'bg-surface w-full h-full flex flex-col overflow-hidden'
          }
        >
          {header}
          {isWide ? (
            <div className="flex-1 min-h-0 flex">
              {/* Card on the left, controls on the right. The card column
                  scrolls independently so a tall Showcase card never pushes
                  Apply off the bottom of the dialog. */}
              <div className="flex-1 min-w-0 overflow-y-auto overscroll-contain p-4 flex items-start justify-center bg-deep/30">
                {preview}
              </div>
              <div className="w-[380px] shrink-0 border-l border-border overflow-y-auto overscroll-contain px-4 pb-4">
                {editor}
              </div>
            </div>
          ) : (
            /* Phone/tablet: one contained scroll, card first. `overscroll-contain`
               is what keeps a flick at the end of the list from scrolling the
               page behind the sheet. */
            <div data-testid="card-editor-sheet-scroll" className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
              <div className="p-3 bg-deep/30 flex justify-center">{preview}</div>
              <div className="px-4 pb-6">{editor}</div>
            </div>
          )}
        </div>
      </div>

      {confirmClose && (
        <ConfirmModal
          title="Discard card changes"
          message="You have unsaved art changes for this card. Close without applying?"
          confirmLabel="Discard"
          onConfirm={() => { setConfirmClose(false); onClose(); }}
          onCancel={() => setConfirmClose(false)}
        />
      )}
    </>
  );
}
