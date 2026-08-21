import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Lock, Trash2, Pencil, StickyNote, ExternalLink, SlidersHorizontal, X, GripHorizontal, ListOrdered } from 'lucide-react';
import { api } from '../lib/api';
import { getPortal } from '../lib/portal';
import { useRoom } from '../contexts/RoomContext';
import { useToast } from '../components/Toast';
import { getSocket } from '../lib/websocket';
import LoadingState from '../components/LoadingState';
import ConfirmModal from '../components/ConfirmModal';
import NeonButton from '../components/NeonButton';
import GameQuickView from '../components/GameQuickView';
import DevicePreviewFrame from '../components/DevicePreviewFrame';
import ScoreboardSurface from '../components/scoreboard/ScoreboardSurface';
import DisplaySettingsPanel from '../components/scoreboard/DisplaySettingsPanel';
import CardStyleEditor, { type ArtPackStyle, type CardFraming, type ImageApplyType } from '../components/scoreboard/CardStyleEditor';
import FixedHScrollbar from '../components/scoreboard/FixedHScrollbar';
import { useCardReorder, type CardDragHandleProps } from '../components/scoreboard/useCardReorder';
import type { HScrollMetrics } from '../components/HorizontalScrollNav';
import { displaySettingChanged } from '../lib/displaySettings';
import { tournamentCardTitleLink, tournamentCardTitleClick } from '../components/scoreboard/tournamentCardTitle';
import { ADMIN_CARD_CHROME_Z_INDEX, CARD_EDIT_OVERLAY_Z_INDEX } from '../components/scoreboard/cardStacking';
import { resolveFraming, dragFramingPos, fitWholeImageZoom, DEFAULT_BG_ZOOM, DEFAULT_BG_POS } from '../lib/bgFraming';
import type { CoverFramingGeometry } from '../lib/bgFraming';
import { readLayerGeometry, BG_FRAMING_LAYER_ATTR } from '../components/scoreboard/useCoverFraming';
import { getTournamentBorderColor } from '../components/ScoreboardComponents';
import type { GameLeaderboard, RankingGroupData } from '../components/ScoreboardComponents';

interface Submission {
  id: string;
  iscored_username: string;
  score: number;
  timestamp: string;
  photo_url: string | null;
}

/** A deleted-score tombstone (deleted_score_suppressions, migration 096). While
 *  it exists, the ScoreSyncPoller refuses to re-import a same-or-lower iScored
 *  score for this game. Removing it lets the next poll cycle re-import. */
interface Suppression {
  gameId: string;
  /** lowercased iScored username (composite-PK component). */
  username: string;
  suppressedScore: number;
  deletedAt: string;
  deletedBy: string | null;
}

/** iPhone 14/15 logical width — the phone preview's viewport (same constant
 *  ScoreboardPreview uses), scaled to sit inside the 380px rail. */
const PHONE_PREVIEW_WIDTH = 390;
const PHONE_PREVIEW_SCALE = 0.85;

/**
 * Bottom-sheet snap points as a fraction of the viewport height: peek / half /
 * full. Half is the resting position — the point of the sheet is that the live
 * surface stays visible and editable ABOVE it while a mod tweaks the room from
 * a phone, which a full-height modal would defeat.
 */
const SHEET_SNAPS = [0.3, 0.55, 0.92] as const;
const SHEET_SNAP_LABELS = ['Peek', 'Half', 'Full'] as const;

/**
 * v2.119.0 (C2) — the per-card edit session.
 *
 * ONE card at a time, and the session is the ONLY place its pending changes
 * live: the overlay handed to the surface is DERIVED from it on every render
 * (see `buildGameCardOverlay`) rather than stored. That is what makes the
 * preview survive a `leaderboard:updated` refetch — the refetch replaces the
 * `leaderboards` array, and the next render simply re-merges the same session
 * over the fresh row (build trap #8).
 */
interface CardEditSession {
  kind: 'game' | 'ranking';
  /** gameId, or ranking-group id. */
  id: string;
  name: string;
  /** `undefined` = art untouched · `null` = "Clear style" staged · else the pick. */
  pick?: ArtPackStyle | null;
  applyAs: ImageApplyType;
  headerDisabled: boolean;
  framing: CardFraming;
  setAsDefault: boolean;
  libraryHasDefault: boolean;
  /** Anything edited at all — drives the switch-card / apply-profile guards.
   *  NOT Apply's enabled state: see `baseline`. */
  touched: boolean;
  /**
   * v2.122.1 — the card's state when the session opened, so Apply can enable on
   * a REAL change instead of on any interaction. The v1 rule ANDed `touched`
   * with "there is an art-pack id to hang framing on", which left Apply dead
   * after a zoom-only edit; framing now has its own endpoint, so the id is no
   * longer a precondition and the honest question is simply "did anything
   * move?".
   */
  baseline: { applyAs: ImageApplyType; headerDisabled: boolean; framing: CardFraming; setAsDefault: boolean };
}

/** The subset of a leaderboard row the card editor can move. */
type CardStyleDraft = Partial<Pick<GameLeaderboard,
  'catalogueStyleId' | 'logoStyleId' | 'bgStyleId' | 'styleHeaderDisabled' |
  'bgZoom' | 'bgPosX' | 'bgPosY' | 'bgHasBg' | 'logoHasHeader' | 'catHasBg' | 'catHasHeader'
>>;

/**
 * Session → the fields the CARDS actually read.
 *
 * Build trap #6: `resolveImages` gates on `bgHasBg`/`catHasBg`/`logoHasHeader`/
 * `catHasHeader`, not on the ids, so a preview that set only the id would show
 * the old art (or none) and lie about what Apply is going to do. The picked
 * style carries `has_background`/`has_header`, so the flags come free.
 *
 * The three branches mirror the three endpoint families exactly — see
 * `applyCardStyle`.
 */
function buildGameCardOverlay(s: CardEditSession): CardStyleDraft {
  const d: CardStyleDraft = {
    styleHeaderDisabled: s.headerDisabled,
    bgZoom: s.framing.zoom,
    bgPosX: s.framing.posX,
    bgPosY: s.framing.posY,
  };
  if (s.pick === null) {
    // DELETE .../style === `removeFromGame`: catalogue style, header flag and
    // framing all go; the independent logo/bg overrides survive.
    d.catalogueStyleId = null;
    d.catHasBg = null;
    d.catHasHeader = null;
    d.styleHeaderDisabled = false;
    d.bgZoom = null;
    d.bgPosX = null;
    d.bgPosY = null;
  } else if (s.pick) {
    if (s.applyAs === 'both') {
      d.catalogueStyleId = s.pick.id;
      d.catHasBg = s.pick.has_background;
      d.catHasHeader = s.pick.has_header;
    } else if (s.applyAs === 'background') {
      d.bgStyleId = s.pick.id;
      d.bgHasBg = s.pick.has_background;
    } else {
      d.logoStyleId = s.pick.id;
      d.logoHasHeader = s.pick.has_header;
    }
  }
  return d;
}

/**
 * ≥1024px (Tailwind `lg`) gets the sticky rail; anything narrower gets the
 * bottom sheet. Only ONE of the two is ever mounted — the panel owns file
 * inputs addressed by element id, so a hidden second copy would shadow them.
 * Defaults to the rail when `matchMedia` is unavailable (jsdom), mirroring the
 * guard idiom in ScoreboardSurface/ThemeProvider.
 */
function useIsWideViewport(): boolean {
  const [wide, setWide] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
    return window.matchMedia('(min-width: 1024px)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const handler = () => setWide(mq.matches);
    handler();
    if (mq.addEventListener) mq.addEventListener('change', handler);
    else mq.addListener(handler);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', handler);
      else mq.removeListener(handler);
    };
  }, []);
  return wide;
}

export default function Leaderboard() {
  const room = useRoom();
  const { toast } = useToast();
  const [leaderboards, setLeaderboards] = useState<GameLeaderboard[]>([]);
  const [rankingGroups, setRankingGroups] = useState<RankingGroupData[]>([]);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<Record<string, string>>({});
  /**
   * v2.116.0 (C1) — the room-display editing rail's DRAFT of `config`. Null
   * means "no editing session": the page then renders `config` and behaves
   * exactly as it did before the rail existed. When a draft exists the SURFACE
   * renders it, so every control on the panel previews against this room's
   * real cards, real styles and real scores.
   */
  const [draftConfig, setDraftConfig] = useState<Record<string, string> | null>(null);
  const [displayPanelOpen, setDisplayPanelOpen] = useState(false);
  const [savingDisplay, setSavingDisplay] = useState(false);
  const isWideViewport = useIsWideViewport();
  /**
   * v2.119.0 (C2) — the card being edited, replacing BOTH `StylePicker` modals
   * (game card + ranking group) on this page. `StylePicker` itself survives for
   * GameLibrary/Tournaments until C3.
   */
  const [cardEdit, setCardEdit] = useState<CardEditSession | null>(null);
  const [applyingCard, setApplyingCard] = useState(false);
  /** A card the admin asked to edit while another card's session was dirty. */
  const [pendingCardEdit, setPendingCardEdit] = useState<
    { kind: 'game'; lb: GameLeaderboard } | { kind: 'ranking'; group: RankingGroupData['group'] } | null
  >(null);
  /** Was the rail already open when card-edit started? Close returns it to
   *  exactly that state rather than always leaving Room display up. */
  const railWasOpenRef = useRef(false);
  /** The edited card's measured fill geometry — see the effect below. */
  const [framingGeom, setFramingGeom] = useState<CoverFramingGeometry | null>(null);
  const framingDragRef = useRef<
    { clientX: number; clientY: number; posX: number; posY: number;
      cardW: number; cardH: number; dispW: number; dispH: number } | null
  >(null);
  /** The gameId whose overlay has already been scrolled into view, so a
   *  re-render mid-drag doesn't yank the strip back under the pointer. */
  const spotlightedRef = useRef<string | null>(null);
  const [displayNameTarget, setDisplayNameTarget] = useState<GameLeaderboard | null>(null);
  const [displayNameInput, setDisplayNameInput] = useState('');
  const [displayNameSaving, setDisplayNameSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<GameLeaderboard | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notesTarget, setNotesTarget] = useState<GameLeaderboard | null>(null);
  const [notesInput, setNotesInput] = useState('');
  const [notesSaving, setNotesSaving] = useState(false);
  const [manageScoresTarget, setManageScoresTarget] = useState<GameLeaderboard | null>(null);
  /** Card-title quick-view popup — the same page-chrome instance the public
   *  Scoreboard owns. Card titles are `<Link>`s on the public page, so they
   *  must be here too, and a title click must do the same thing. */
  const [quickViewLb, setQuickViewLb] = useState<GameLeaderboard | null>(null);
  /**
   * The ROOM's public theme, which is what the public scoreboard renders under.
   * `/:slug/admin/*` runs on the admin's own personal theme (ThemeProvider
   * treats admin routes separately), so without this the mirror would be right
   * in every respect except its colours. See `.sb-theme-scope` in index.css.
   * `getPortal` is the shared slug cache RoomAdminLayout already primed, so
   * this resolves off the cache rather than issuing a second request.
   */
  const [roomTheme, setRoomTheme] = useState<string | null>(null);

  /**
   * v2.118.0 — the manual card order.
   *
   * `cardOrder.active` comes from the server, which runs the SAME
   * self-invalidation the read path runs, so the chip can never claim a manual
   * order that every board has already discarded (a tournament rotated, an
   * admin edited the configured positions). Refetched on `leaderboard:updated`
   * for exactly that reason.
   */
  const [cardOrder, setCardOrder] = useState<{ active: boolean; savedAt: string | null }>({ active: false, savedAt: null });
  const [confirmResetOrder, setConfirmResetOrder] = useState(false);
  /** Geometry of the card strip's scroller, reported by HorizontalScrollNav. */
  const [hscrollMetrics, setHscrollMetrics] = useState<HScrollMetrics | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);

  // Unmount guard for the three loaders — they're fired from the mount effect
  // AND from socket handlers, so an in-flight response can land after unmount
  // (late-setState flake class; the roomTheme effect below already guards the
  // same way with a local flag). A ref because the loaders are shared across
  // both call contexts.
  const unmountedRef = useRef(false);
  useEffect(() => () => { unmountedRef.current = true; }, []);

  // Draft-vs-server diff. Boolean toggles compare by EFFECTIVE state so a
  // switch flipped on and back off reads as clean (an off-default toggle
  // stores nothing until touched) — see `displaySettingChanged`.
  const dirtyDisplayKeys = draftConfig
    ? Array.from(new Set([...Object.keys(config), ...Object.keys(draftConfig)]))
      .filter(k => displaySettingChanged(k, draftConfig, config))
    : [];
  const isDisplayDirty = dirtyDisplayKeys.length > 0;
  // Read by the socket handler and by `loadConfig`, both of which live outside
  // this render's closure.
  const displayDirtyRef = useRef(false);
  useEffect(() => { displayDirtyRef.current = isDisplayDirty; }, [isDisplayDirty]);

  const loadData = () => {
    api.get<GameLeaderboard[]>(`/rooms/${room.roomId}/leaderboard`)
      .then(d => { if (!unmountedRef.current) setLeaderboards(d); })
      .catch(() => { if (!unmountedRef.current) setLeaderboards([]); });
  };

  const loadRankings = () => {
    api.get<RankingGroupData[]>(`/rooms/${room.roomId}/rankings`)
      .then(d => { if (!unmountedRef.current) setRankingGroups(d); })
      .catch(() => { if (!unmountedRef.current) setRankingGroups([]); })
      .finally(() => { if (!unmountedRef.current) setLoading(false); });
  };

  const loadCardOrder = () => {
    api.get<{ active: boolean; savedAt: string | null }>(`/rooms/${room.roomId}/admin/leaderboard/card-order`)
      .then(s => { if (!unmountedRef.current) setCardOrder(s); })
      .catch(() => {});
  };

  const loadConfig = () => {
    api.get<Record<string, string>>(`/rooms/${room.roomId}/scoreboard-config`)
      .then(c => {
        if (unmountedRef.current) return;
        setConfig(c);
        // An UNTOUCHED draft mirrors the server, so keep it in step — that is
        // what lets another admin's save land in an open (but clean) rail. A
        // dirty draft is left alone; see the socket handler below.
        setDraftConfig(prev => (prev && !displayDirtyRef.current ? { ...c } : prev));
      })
      .catch(() => {});
  };

  useEffect(() => {
    loadData();
    loadRankings();
    loadConfig();
    loadCardOrder();

    const socket = getSocket();
    socket.emit('join:room', room.roomId);
    // Re-join on every (re)connect — room membership doesn't survive a reconnect.
    const onConnect = () => socket.emit('join:room', room.roomId);
    socket.on('connect', onConnect);
    const onUpdate = () => { loadData(); loadRankings(); loadCardOrder(); };
    socket.on('leaderboard:updated', onUpdate);
    socket.on('score:new', onUpdate);
    // v2.86.0 — the public Scoreboard has always refetched on rotation; admin
    // did not, so after a maintenance rotation this page showed the previous
    // slot's game until something else happened to refresh it.
    const onRotated = () => { loadData(); };
    socket.on('game:rotated', onRotated);
    // v2.116.0 — someone saved this room's appearance (another admin, or this
    // admin from their phone). Refetch ONLY while this page has no unsaved
    // draft: overwriting an in-progress edit with someone else's save is worse
    // than showing a slightly stale baseline until Save or Discard.
    const onSettings = () => { if (!displayDirtyRef.current) loadConfig(); };
    socket.on('settings:updated', onSettings);

    return () => {
      socket.emit('leave:room', room.roomId);
      socket.off('connect', onConnect);
      // Handler refs — score:new/leaderboard:updated are room-scoped (S4) and
      // the socket is a shared singleton; a bare off() would also remove the
      // public Scoreboard's / Kiosk's listeners for the same event.
      socket.off('leaderboard:updated', onUpdate);
      socket.off('score:new', onUpdate);
      socket.off('game:rotated', onRotated);
      socket.off('settings:updated', onSettings);
    };
  }, [room.roomId]);

  useEffect(() => {
    if (!room.roomSlug) return;
    let cancelled = false;
    getPortal(room.roomSlug)
      .then(p => { if (!cancelled) setRoomTheme(p.public_theme || p.ui_theme || 'dark'); })
      .catch(() => { if (!cancelled) setRoomTheme('dark'); });
    return () => { cancelled = true; };
  }, [room.roomSlug]);

  /**
   * The horizontal-scroll layout can disappear (an admin switches to grid or
   * vertical) without `HorizontalScrollNav` saying so — it simply unmounts and
   * stops reporting. Drop the stale geometry whenever a layout-bearing config
   * value changes; if the strip is still mounted its ResizeObserver re-reports
   * within the same frame.
   */
  const layoutKey = [
    config.SCOREBOARD_STYLE, config.SCOREBOARD_LAYOUT,
    draftConfig?.SCOREBOARD_STYLE, draftConfig?.SCOREBOARD_LAYOUT,
  ].join('|');
  const [lastLayoutKey, setLastLayoutKey] = useState(layoutKey);
  if (layoutKey !== lastLayoutKey) {
    // React's documented "adjust state during render" pattern — an effect here
    // would be a cascading render (and the lint rule says so).
    setLastLayoutKey(layoutKey);
    setHscrollMetrics(null);
  }

  /**
   * v2.118.0 — drag-to-reposition. The payload is the FULL server order with
   * one id moved, so cards hidden by `hideEmpty` keep their positions; the
   * local reorder is optimistic and reverts on failure.
   */
  const handleCardReorder = async (next: string[]) => {
    const previous = leaderboards;
    const byId = new Map(previous.map(lb => [lb.gameId, lb]));
    setLeaderboards(next.map(id => byId.get(id)).filter(Boolean) as GameLeaderboard[]);
    try {
      const saved = await api.put<{ active: boolean; savedAt: string }>(
        `/rooms/${room.roomId}/admin/leaderboard/card-order`, { gameIds: next },
      );
      if (!unmountedRef.current) setCardOrder({ active: true, savedAt: saved.savedAt });
    } catch (err) {
      if (unmountedRef.current) return;
      setLeaderboards(previous);
      toast(err instanceof Error ? err.message : 'Failed to save card order', 'error');
    }
  };

  const reorder = useCardReorder({
    order: leaderboards.map(lb => lb.gameId),
    names: Object.fromEntries(leaderboards.map(lb => [lb.gameId, lb.displayName || lb.gameName])),
    onReorder: handleCardReorder,
  });

  const handleResetCardOrder = async () => {
    setConfirmResetOrder(false);
    try {
      await api.delete(`/rooms/${room.roomId}/admin/leaderboard/card-order`);
      if (unmountedRef.current) return;
      setCardOrder({ active: false, savedAt: null });
      loadData();
      toast('Card order reset to tournament order', 'success');
    } catch (err) {
      if (!unmountedRef.current) toast(err instanceof Error ? err.message : 'Failed to reset card order', 'error');
    }
  };

  /**
   * v2.122.1 — the edited card's LIVE fill geometry, mirrored into state so the
   * rail can offer "Fit whole image" with a real number on it.
   *
   * The card publishes it as data attributes (`useCoverFraming`) because the
   * measurement belongs to the card, not the panel; a MutationObserver is how
   * a sibling learns it changed. Scoped to the surface and to an open game
   * session, coalesced into one animation frame, and torn down with the
   * session — it observes nothing when no card is being edited.
   */
  useEffect(() => {
    if (!cardEdit || cardEdit.kind !== 'game') { setFramingGeom(null); return; }
    let raf = 0;
    const read = () => {
      const overlay = document.querySelector('[data-testid="card-edit-overlay"]');
      const next = readLayerGeometry(overlay?.parentElement?.querySelector(`[${BG_FRAMING_LAYER_ATTR}]`));
      setFramingGeom(prev => (
        prev && next && prev.cardW === next.cardW && prev.cardH === next.cardH
          && prev.dispW === next.dispW && prev.dispH === next.dispH ? prev : next
      ));
    };
    read();
    if (typeof MutationObserver === 'undefined') return;
    const obs = new MutationObserver(() => {
      if (typeof requestAnimationFrame === 'undefined') { read(); return; }
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(read);
    });
    obs.observe(surfaceRef.current ?? document.body, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ['data-bg-card-w', 'data-bg-card-h', 'data-bg-disp-w', 'data-bg-disp-h'],
    });
    return () => {
      obs.disconnect();
      if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(raf);
    };
  }, [cardEdit?.id, cardEdit?.kind]);

  if (loading) return <LoadingState message="Loading leaderboards..." />;

  // v2.86.0 — every config-driven value used to be re-derived here by hand and
  // had drifted from `deriveCardProps`/`deriveScoreboardConfig` (it ignored
  // SCOREBOARD_LOGO_ENABLED, SCOREBOARD_BG_OPACITY, card opacity, the
  // bg 'fill-entire' mapping, and more). ScoreboardSurface owns all of it now,
  // so this page derives nothing about rendering — it just hands over config.

  /**
   * The card overlay, DERIVED (never stored) and merged at RENDER time.
   *
   * Storing merged rows would lose every edit the moment a `leaderboard:updated`
   * socket event replaced the `leaderboards` array mid-edit (build trap #8);
   * deriving them means the next render simply re-merges the same session over
   * whatever the server just sent.
   */
  const cardDrafts: Record<string, CardStyleDraft> =
    cardEdit && cardEdit.kind === 'game' ? { [cardEdit.id]: buildGameCardOverlay(cardEdit) } : {};

  const surfaceLeaderboards = cardEdit && cardEdit.kind === 'game'
    ? leaderboards.map(lb => (cardDrafts[lb.gameId] ? { ...lb, ...cardDrafts[lb.gameId] } : lb))
    : leaderboards;

  const surfaceRankingGroups = cardEdit && cardEdit.kind === 'ranking' && cardEdit.pick !== undefined
    ? rankingGroups.map(g => (g.group.id !== cardEdit.id ? g : {
      ...g,
      group: {
        ...g.group,
        bg_style_id: cardEdit.pick ? cardEdit.pick.id : null,
        bg_has_bg: cardEdit.pick ? cardEdit.pick.has_background : null,
      },
    }))
    : rankingGroups;

  /** The row being edited, WITH the draft applied — the editor reads its
   *  "current" values off this so the panel and the card never disagree. */
  const editedLb = cardEdit && cardEdit.kind === 'game'
    ? surfaceLeaderboards.find(lb => lb.gameId === cardEdit.id)
    : undefined;
  const editedGameName = editedLb?.gameName || '';

  /**
   * The style id Apply will send when a STYLE is what changed. Neither style
   * schema accepts a null id (`AssignStyleSchema`/`AssignImageSchema` both
   * require one), which pre-v2.122.1 meant framing could only ever be saved
   * onto a card that already had an art pack. Framing now has its own endpoint
   * (`framingOnly` below), so a card drawing plain catalogue art can be zoomed
   * and dragged like any other.
   */
  const effectiveStyleId: string | null = cardEdit?.pick !== undefined
    ? (cardEdit?.pick ? cardEdit.pick.id : null)
    : cardEdit?.kind === 'ranking'
      ? (surfaceRankingGroups.find(g => g.group.id === cardEdit.id)?.group.bg_style_id ?? null)
      : cardEdit?.applyAs === 'background'
        ? (editedLb?.bgStyleId ?? editedLb?.catalogueStyleId ?? null)
        : cardEdit?.applyAs === 'logo'
          ? (editedLb?.logoStyleId ?? editedLb?.catalogueStyleId ?? null)
          : (editedLb?.catalogueStyleId ?? null);

  /**
   * The zoom that puts the WHOLE background inside this card. `dispW/dispH`
   * carry the art's aspect (they are the image, scaled), which is all the
   * formula needs — so this is stable while the admin works the zoom slider.
   */
  const fitWhole = framingGeom
    ? fitWholeImageZoom(framingGeom.cardW, framingGeom.cardH, framingGeom.dispW, framingGeom.dispH)
    : null;

  /** Did the framing actually move? Both sides are already defaults-applied. */
  const framingMoved = (a: CardFraming, b: CardFraming) =>
    a.zoom !== b.zoom || a.posX !== b.posX || a.posY !== b.posY;

  /**
   * A pure framing edit — no art pack picked or cleared, no identifier toggle,
   * no Apply-as change. That is the case the `/framing` endpoints exist for:
   * they write `bg_zoom/bg_pos_x/bg_pos_y` and nothing else, so zoom and
   * position apply to ANY card rather than only to art-pack ones.
   */
  const framingOnlyEdit = !!cardEdit && cardEdit.kind === 'game'
    && cardEdit.pick === undefined
    && cardEdit.applyAs === cardEdit.baseline.applyAs
    && cardEdit.headerDisabled === cardEdit.baseline.headerDisabled;

  /** Apply's enabled state: a real difference from the opening state. */
  const cardEditDirty = !cardEdit ? false
    : cardEdit.kind === 'ranking'
      ? cardEdit.touched
      : cardEdit.pick !== undefined
        || cardEdit.applyAs !== cardEdit.baseline.applyAs
        || cardEdit.headerDisabled !== cardEdit.baseline.headerDisabled
        || cardEdit.setAsDefault !== cardEdit.baseline.setAsDefault
        || framingMoved(cardEdit.framing, cardEdit.baseline.framing);

  // -- Card editor (C2) --------------------------------------------------
  /** Opening a card editor while another card still has pending edits would
   *  silently throw them away, so the second click parks and asks first. */
  const requestCardEdit = (next: NonNullable<typeof pendingCardEdit>) => {
    const nextId = next.kind === 'game' ? next.lb.gameId : next.group.id;
    if (cardEdit?.touched && cardEdit.id !== nextId) { setPendingCardEdit(next); return; }
    void openCardEdit(next);
  };

  const openCardEdit = async (next: NonNullable<typeof pendingCardEdit>) => {
    setPendingCardEdit(null);
    railWasOpenRef.current = displayPanelOpen;
    if (next.kind === 'ranking') {
      const rankFraming = { zoom: DEFAULT_BG_ZOOM, posX: DEFAULT_BG_POS, posY: DEFAULT_BG_POS };
      setCardEdit({
        kind: 'ranking', id: next.group.id, name: next.group.name,
        applyAs: 'both', headerDisabled: false,
        framing: rankFraming,
        setAsDefault: false, libraryHasDefault: false, touched: false,
        baseline: { applyAs: 'both', headerDisabled: false, framing: rankFraming, setAsDefault: false },
      });
      setDisplayPanelOpen(true);
      return;
    }
    const lb = next.lb;
    // Trap #9 - this response already carries the library framing too; only
    // the "is there a default at all" bit is needed to word the toggle.
    let libraryHasDefault = false;
    try {
      const libStyle = await api.get<{ catalogueStyleId: string | null }>(
        `/rooms/${room.roomId}/game_library/${encodeURIComponent(lb.gameName)}/style`);
      libraryHasDefault = !!libStyle.catalogueStyleId;
    } catch { /* no library row -> no default */ }
    if (unmountedRef.current) return;
    // `resolveFraming` applies the 100/50/50 defaults, so an unframed card and
    // a card framed AT the defaults compare equal — which is what "did anything
    // move?" means to an admin.
    const f = resolveFraming(lb);
    const framing = { zoom: f.zoom, posX: f.posX, posY: f.posY };
    const headerDisabled = !!lb.styleHeaderDisabled;
    setCardEdit({
      kind: 'game', id: lb.gameId, name: lb.displayName || lb.gameName,
      applyAs: 'both', headerDisabled,
      framing,
      setAsDefault: !libraryHasDefault, libraryHasDefault, touched: false,
      baseline: { applyAs: 'both', headerDisabled, framing, setAsDefault: !libraryHasDefault },
    });
    setDisplayPanelOpen(true);
  };

  const patchCardEdit = (patch: Partial<CardEditSession>) =>
    setCardEdit(prev => (prev ? { ...prev, ...patch, touched: true } : prev));

  /** Cancel / Close. The overlay is DERIVED from the session, so dropping the
   *  session is the discard - no request, nothing to roll back. */
  const closeCardEdit = () => {
    setCardEdit(null);
    spotlightedRef.current = null;
    if (!railWasOpenRef.current && !isDisplayDirty) {
      setDraftConfig(null);
      setDisplayPanelOpen(false);
    }
  };

  const applyCardStyle = async () => {
    if (!cardEdit) return;
    const session = cardEdit;
    setApplyingCard(true);
    try {
      if (session.kind === 'ranking') {
        if (session.pick === null) {
          await api.delete(`/rooms/${room.roomId}/ranking-groups/${session.id}/style`);
          toast('Background removed', 'success');
        } else if (session.pick) {
          await api.put(`/rooms/${room.roomId}/ranking-groups/${session.id}/style`, { styleId: session.pick.id });
          toast('Background applied', 'success');
        }
        loadRankings();
      } else {
        const styleId = effectiveStyleId;
        // Trap #2 - the FULL triple on every write. The backend reads an
        // omitted axis as "unframed" and would silently reset it.
        const framing = { bgZoom: session.framing.zoom, bgPosX: session.framing.posX, bgPosY: session.framing.posY };
        const perImage = session.applyAs !== 'both';
        const clearing = session.pick === null || !styleId;
        // v2.122.1 - a pure framing edit takes the framing-only endpoints, which
        // touch the three columns and no style id at all. Without this branch a
        // zoom on a plain-catalogue-art card had nowhere to go (`clearing` would
        // have DELETEd the style instead of saving the zoom).
        if (framingOnlyEdit) {
          await api.put(`/rooms/${room.roomId}/admin/games/${session.id}/framing`, framing);
          toast('Framing applied', 'success');
          if (session.setAsDefault) {
            const gameName = encodeURIComponent(editedGameName || session.name);
            try {
              await api.put(`/rooms/${room.roomId}/game_library/${gameName}/framing`, framing);
              toast('Default framing updated in library', 'success');
            } catch {
              toast('Failed to update library default', 'error');
            }
          }
          loadData();
          if (!unmountedRef.current) closeCardEdit();
          return;
        }
        if (clearing) {
          await api.delete(`/rooms/${room.roomId}/admin/games/${session.id}/style`);
          toast('Style removed', 'success');
        } else if (perImage) {
          // Trap #3 - the image endpoint family carries the framing separately.
          await api.put(`/rooms/${room.roomId}/admin/games/${session.id}/image`, {
            styleId, imageType: session.applyAs, ...framing,
          });
          toast('Style applied', 'success');
        } else {
          await api.put(`/rooms/${room.roomId}/admin/games/${session.id}/style`, {
            catalogueStyleId: styleId, headerDisabled: session.headerDisabled, ...framing,
          });
          toast('Style applied', 'success');
        }
        if (session.setAsDefault) {
          const gameName = encodeURIComponent(editedGameName || session.name);
          try {
            if (clearing) {
              await api.delete(`/rooms/${room.roomId}/game_library/${gameName}/style`);
              toast('Default style cleared in library', 'success');
            } else if (perImage) {
              await api.put(`/rooms/${room.roomId}/game_library/${gameName}/image`, {
                styleId, imageType: session.applyAs, ...framing,
              });
              toast('Default style updated in library', 'success');
            } else {
              await api.put(`/rooms/${room.roomId}/game_library/${gameName}/style`, {
                catalogueStyleId: styleId, headerDisabled: session.headerDisabled, ...framing,
              });
              toast('Default style updated in library', 'success');
            }
          } catch {
            toast('Failed to update library default', 'error');
          }
        }
        loadData();
      }
      if (!unmountedRef.current) closeCardEdit();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to apply card style', 'error');
    } finally {
      if (!unmountedRef.current) setApplyingCard(false);
    }
  };

  // -- Framing drag, directly on the selected card -----------------------
  /**
   * v2.122.1 — the drag needs the LIVE geometry, not just a box: how far a
   * background-position percentage moves the picture depends on the signed
   * slack between the card and the displayed image, which flips sign when the
   * image is smaller than the card (zoom < 100). The card publishes both on
   * its fill layer (`useCoverFraming`), so the overlay reads them off the DOM
   * of the card it is sitting on — the one coupling that works for all four
   * card types without threading a ref through public card components.
   *
   * Fallback when the layer hasn't measured yet (image still loading, or a
   * mocked card in jsdom): the CARD's own box, with the image assumed to
   * overflow — which is what the layer is still drawing in that window.
   */
  const framingGeometry = (overlay: HTMLElement) => {
    const slot = overlay.parentElement;
    const measured = readLayerGeometry(slot?.querySelector(`[${BG_FRAMING_LAYER_ATTR}]`));
    if (measured) return measured;
    const card = slot?.firstElementChild as HTMLElement | null;
    let rect = card?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) rect = overlay.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return { cardW: rect.width, cardH: rect.height, dispW: rect.width * 2, dispH: rect.height * 2 };
  };

  const beginFramingDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!cardEdit) return;
    // The strip lives inside HorizontalScrollNav, which drags to scroll on
    // pointerdown - the same reason the reorder grip stops propagation.
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const g = framingGeometry(e.currentTarget);
    if (!g) return;
    framingDragRef.current = {
      clientX: e.clientX, clientY: e.clientY,
      posX: cardEdit.framing.posX, posY: cardEdit.framing.posY,
      ...g,
    };
  };

  const moveFramingDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = framingDragRef.current;
    if (!start) return;
    // The picture follows the pointer in BOTH axes; `dragFramingPos` derives
    // the sign from the geometry instead of assuming overflow, and no-ops the
    // axis where the image exactly fits (nothing to slide).
    const posX = dragFramingPos(start.posX, e.clientX - start.clientX, start.cardW, start.dispW);
    const posY = dragFramingPos(start.posY, e.clientY - start.clientY, start.cardH, start.dispH);
    setCardEdit(prev => (prev ? { ...prev, touched: true, framing: { ...prev.framing, posX, posY } } : prev));
  };

  const endFramingDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    framingDragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };
  const handleEditDisplayName = (target: GameLeaderboard) => {
    setDisplayNameInput(target.displayName || '');
    setDisplayNameTarget(target);
  };
  const handleEditNotes = (target: GameLeaderboard) => {
    setNotesInput(target.notes || '');
    setNotesTarget(target);
  };

  // ── Room display rail ──────────────────────────────────────────────────
  const openDisplayPanel = () => {
    setDraftConfig(prev => prev ?? { ...config });
    setDisplayPanelOpen(true);
  };

  const closeDisplayPanel = () => {
    if (isDisplayDirty && !window.confirm('You have unsaved display changes. Close without saving?')) return;
    setDraftConfig(null);
    setDisplayPanelOpen(false);
  };

  const handleDisplayChange = (key: string, value: string) => {
    setDraftConfig(prev => ({ ...(prev ?? config), [key]: value }));
  };

  /** Image upload/delete endpoints write the setting themselves, so the
   *  baseline moves with the draft — reporting it as an unsaved change would
   *  be a lie, and Save would re-post a value that is already stored. */
  const handleDisplayServerChange = (key: string, value: string) => {
    setConfig(prev => ({ ...prev, [key]: value }));
    setDraftConfig(prev => (prev ? { ...prev, [key]: value } : prev));
  };

  const discardDisplayChanges = () => setDraftConfig({ ...config });

  const handleDisplaySave = async () => {
    if (!draftConfig || dirtyDisplayKeys.length === 0) return;
    // Only the changed keys go out. None of them is in the Settings page's
    // DANGEROUS_KEYS set (iScored/Discord/global/join-policy), so there is
    // nothing to confirm before writing.
    const payload: Record<string, string> = {};
    for (const k of dirtyDisplayKeys) payload[k] = draftConfig[k] ?? '';
    setSavingDisplay(true);
    try {
      await api.post(`/rooms/${room.roomId}/settings`, payload);
      const fresh = await api.get<Record<string, string>>(`/rooms/${room.roomId}/scoreboard-config`);
      if (!unmountedRef.current) {
        setConfig(fresh);
        setDraftConfig({ ...fresh });
      }
      toast('Display settings saved', 'success');
    } catch (err: any) {
      toast(err?.message || 'Failed to save display settings', 'error');
    } finally {
      if (!unmountedRef.current) setSavingDisplay(false);
    }
  };

  /** Build trap #4 — "Apply" on a style profile writes server-side at once, so
   *  a dirty draft would silently overwrite it on the next Save. */
  const handleBeforeProfileApply = () => {
    // v2.119.0 (C2) — the same hazard for the per-card session: a profile
    // apply rewrites room settings server-side, and a stale card overlay
    // sitting on top of the refreshed board is a preview that lies.
    const cardDirty = !!cardEdit?.touched;
    if (!isDisplayDirty && !cardDirty) return true;
    if (!window.confirm('Discard unsaved changes and apply this profile?')) return false;
    setDraftConfig(null);
    if (cardDirty) closeCardEdit();
    return true;
  };

  // `sb-theme-scope` restates the default (dark) tokens so the surface is dark
  // even when the admin's own theme is not; the room's theme class, when it
  // has one, then overrides from there. See index.css.
  const roomThemeClass = `sb-theme-scope${roomTheme && roomTheme !== 'dark' ? ` theme-${roomTheme}` : ''}`;

  // The surface renders the DRAFT whenever an editing session is open, so the
  // page itself is the preview — no second renderer, no mock data.
  const surfaceConfig = draftConfig ?? config;

  const displayPanelBody = (
    <DisplaySettingsPanel
      roomId={room.roomId}
      roomName={room.roomName}
      settings={surfaceConfig}
      onChange={handleDisplayChange}
      onServerChange={handleDisplayServerChange}
      hasUnsavedChanges={isDisplayDirty}
      onBeforeProfileApply={handleBeforeProfileApply}
      onProfileApplied={loadConfig}
      toast={toast}
      // Desktop only: on a phone you are already looking at the mobile render.
      renderPhonePreview={isWideViewport ? () => (
        // Height-capped with its own scroll: the full mobile board at 390px is
        // taller than the rail, and uncapped it pushes every control below the
        // rail's max-h cutoff.
        <div className="flex justify-center max-h-[420px] overflow-y-auto overscroll-contain rounded border border-border/50">
          <DevicePreviewFrame width={PHONE_PREVIEW_WIDTH} scale={PHONE_PREVIEW_SCALE}>
            <ScoreboardSurface
              embedded
              forceMobile
              themeClass={roomThemeClass}
              config={surfaceConfig}
              roomName={room.roomName}
              slug={room.roomSlug || ''}
              leaderboards={surfaceLeaderboards}
              rankingGroups={surfaceRankingGroups}
            />
          </DevicePreviewFrame>
        </div>
      ) : undefined}
    />
  );

  const cardEditorBody = cardEdit ? (
    <CardStyleEditor
      mode={cardEdit.kind}
      cardName={cardEdit.name}
      selectedStyleId={effectiveStyleId}
      onPickStyle={style => patchCardEdit({ pick: style })}
      applyAs={cardEdit.applyAs}
      onApplyAs={t => patchCardEdit({ applyAs: t })}
      headerDisabled={cardEdit.headerDisabled}
      onHeaderDisabled={v => patchCardEdit({ headerDisabled: v })}
      framing={cardEdit.framing}
      onFraming={f => patchCardEdit({ framing: f })}
      fitZoom={fitWhole ? fitWhole.zoom : null}
      fitClamped={!!fitWhole?.clamped}
      fillOn={(draftConfig ?? config).SCOREBOARD_CARD_BG_FILL !== 'false'}
      onEnableFill={() => handleDisplayChange('SCOREBOARD_CARD_BG_FILL', 'true')}
      showDefaultOption={cardEdit.kind === 'game'}
      libraryHasDefault={cardEdit.libraryHasDefault}
      setAsDefault={cardEdit.setAsDefault}
      onSetAsDefault={v => patchCardEdit({ setAsDefault: v })}
      uploadPath={cardEdit.kind === 'game' ? `/rooms/${room.roomId}/admin/styles/upload` : undefined}
      gameName={editedGameName || undefined}
      dirty={cardEditDirty}
      applying={applyingCard}
      onApply={applyCardStyle}
      onCancel={closeCardEdit}
      onClear={() => patchCardEdit({ pick: null })}
    />
  ) : null;

  const panelTitle = cardEdit ? 'Edit card' : 'Room display';
  const panelBody = cardEditorBody ?? displayPanelBody;
  const closePanel = cardEdit ? closeCardEdit : closeDisplayPanel;

  const displaySaveBar = isDisplayDirty ? (
    <div
      data-testid="display-settings-savebar"
      className="shrink-0 flex items-center justify-between gap-3 border-t border-border bg-surface px-4 py-3"
    >
      <span className="text-xs text-neon-amber">
        {dirtyDisplayKeys.length} unsaved change{dirtyDisplayKeys.length === 1 ? '' : 's'}
      </span>
      <div className="flex items-center gap-2">
        <NeonButton variant="ghost" onClick={discardDisplayChanges} disabled={savingDisplay}>Discard</NeonButton>
        <NeonButton onClick={handleDisplaySave} disabled={savingDisplay}>
          {savingDisplay ? 'Saving...' : 'Save'}
        </NeonButton>
      </div>
    </div>
  ) : null;

  return (
    <div>
      {/* flex-wrap: with the Display settings button added, the unwrapped row
          overflows a 390px viewport and drags the whole document sideways. */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="font-display text-2xl font-bold">Leaderboards</h1>
        <div className="flex flex-wrap items-center gap-4">
          {cardOrder.active && (
            <span
              data-testid="card-order-chip"
              className="inline-flex items-center gap-2 rounded-full border border-neon-cyan/40 bg-raised px-3 py-1 text-[11px] text-neon-cyan"
              title={cardOrder.savedAt ? `Saved ${new Date(cardOrder.savedAt).toLocaleString()}` : undefined}
            >
              <ListOrdered size={12} /> Manual order
              <button
                type="button"
                onClick={() => setConfirmResetOrder(true)}
                className="bg-transparent border-0 p-0 text-muted hover:text-primary underline cursor-pointer text-[11px]"
              >
                Reset
              </button>
            </span>
          )}
          <NeonButton
            variant={displayPanelOpen ? 'secondary' : 'ghost'}
            className="text-xs"
            onClick={() => (displayPanelOpen ? closeDisplayPanel() : openDisplayPanel())}
            aria-expanded={displayPanelOpen}
          >
            <SlidersHorizontal size={14} /> Display settings
          </NeonButton>
          <a
            href={`/${room.roomSlug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-muted hover:text-neon-cyan transition-colors no-underline"
          >
            <ExternalLink size={14} />
            <span>View Public Leaderboard</span>
          </a>
        </div>
      </div>

      <div className="flex items-start gap-4">
      <div className="flex-1 min-w-0" ref={surfaceRef}>
      {/* The scoreboard, rendered by the SAME component the public page uses.
          Everything below the room theme wrapper is public code — no admin
          fork of card rendering, layout, sizing or config handling exists any
          more. The only admin addition is renderUnderCard.

          What is deliberately NOT passed:
            - viewerUsername / viewerEntry: an admin previews what a fresh
              anonymous visitor sees, so no row is highlighted as "yours".
            - onSubmitScore: submitting is a player affordance, not part of
              the design being previewed. The per-slot "+" button it gates is
              absolutely positioned, so its absence shifts nothing. */}
      <ScoreboardSurface
        embedded
        themeClass={roomThemeClass}
        config={surfaceConfig}
        roomName={room.roomName}
        roomId={room.roomId}
        slug={room.roomSlug || ''}
        leaderboards={surfaceLeaderboards}
        rankingGroups={surfaceRankingGroups}
        titleLinkTo={tournamentCardTitleLink(room.roomSlug || '')}
        titleLinkOnClick={tournamentCardTitleClick(setQuickViewLb)}
        /* v2.118.0 — the arrow overlays reach the viewport edge, so on this
           page the right-hand one sat over the display-settings rail and ate
           its clicks. Replaced here (and ONLY here) by the fixed bottom
           scrollbar below; the public page and kiosk keep their arrows. */
        hscrollArrows={false}
        onHscrollMetrics={setHscrollMetrics}
        renderUnderCard={lb => (
          <AdminControlsStrip
            lb={lb}
            dragHandleProps={reorder.getHandleProps(lb.gameId, lb.displayName || lb.gameName)}
            dragging={reorder.draggingId === lb.gameId}
            editing={cardEdit?.kind === 'game' && cardEdit.id === lb.gameId}
            onStyleClick={lb => requestCardEdit({ kind: 'game', lb })}
            onEditDisplayName={handleEditDisplayName}
            onDeleteGame={setDeleteTarget}
            onEditNotes={handleEditNotes}
            onManageScores={setManageScoresTarget}
          />
        )}
        renderUnderRankingCard={group => (
          <RankingAdminControlsStrip
            group={group}
            editing={cardEdit?.kind === 'ranking' && cardEdit.id === group.id}
            onStyleClick={group => requestCardEdit({ kind: 'ranking', group })}
          />
        )}
        /* v2.119.0 (C2) - the selected card's spotlight ring AND its framing
           drag surface. Null for every other card, and for every card when no
           card is being edited, so the public slot markup is untouched. */
        renderCardOverlay={lb => (
          cardEdit?.kind === 'game' && cardEdit.id === lb.gameId ? (
            <div
              data-testid="card-edit-overlay"
              ref={el => {
                if (!el || spotlightedRef.current === lb.gameId) return;
                spotlightedRef.current = lb.gameId;
                el.scrollIntoView?.({ behavior: 'smooth', block: 'nearest', inline: 'center' });
              }}
              role="application"
              aria-label={`Drag to reposition the background art for ${lb.displayName || lb.gameName}`}
              title="Drag to reposition the background art"
              onPointerDown={beginFramingDrag}
              onPointerMove={moveFramingDrag}
              onPointerUp={endFramingDrag}
              onPointerCancel={endFramingDrag}
              onMouseDown={e => e.stopPropagation()}
              style={{ zIndex: CARD_EDIT_OVERLAY_Z_INDEX }}
              className="absolute inset-0 rounded-lg cursor-move touch-none ring-2 ring-neon-cyan ring-offset-2 ring-offset-transparent"
            />
          ) : null
        )}
      />

      {/* v2.118.0 — the card strip's own scrollbar is hidden by design and the
          arrow overlays are off on this page, so this is the visible scroll
          affordance. Viewport-fixed (the strip is taller than the screen) but
          only as wide as the surface column, so it never runs under the rail.
          Hidden while the mobile sheet is up — the sheet owns the bottom of
          the screen, and a phone scrolls the strip by swiping it anyway. */}
      <FixedHScrollbar
        metrics={hscrollMetrics}
        hidden={displayPanelOpen && !isWideViewport}
        onScrollTo={left => {
          const el = surfaceRef.current?.querySelector('.scoreboard-hscroll-nobar') as HTMLElement | null;
          if (el) el.scrollLeft = left;
        }}
      />

      {/* s20 keyboard/AT parity for the drag handle. */}
      <div aria-live="polite" className="sr-only" data-testid="card-order-live">{reorder.announcement}</div>
      </div>

      {/* Editing rail — desktop. Sticky beside the surface, which reflows on
          width all by itself (the layouts are the public ones). */}
      {displayPanelOpen && isWideViewport && (
        <aside
          data-testid="display-settings-rail"
          aria-label="Display settings"
          className="w-[380px] shrink-0 flex flex-col rounded-lg border border-border bg-surface sticky top-16 max-h-[calc(100vh-5rem)] overflow-hidden"
        >
          <DisplayPanelHeader title={panelTitle} onClose={closePanel} />
          <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">{panelBody}</div>
          {displaySaveBar}
        </aside>
      )}

      {/* Editing sheet — phone/tablet. First-class, not a fallback: the
          driving scenario is a mod in the game room with only a phone,
          watching the kiosk on the wall. */}
      {displayPanelOpen && !isWideViewport && (
        <DisplaySettingsSheet title={panelTitle} onClose={closePanel} footer={displaySaveBar}>
          {panelBody}
        </DisplaySettingsSheet>
      )}
      </div>

      {confirmResetOrder && (
        <ConfirmModal
          title="Reset card order"
          message="Drop the manual card order and go back to the order your tournaments are configured in? Every board in this room updates immediately."
          confirmLabel="Reset"
          onConfirm={handleResetCardOrder}
          onCancel={() => setConfirmResetOrder(false)}
        />
      )}

      {/* Card-title quick-view — mirrors the public Scoreboard exactly, so a
          title click previews the game here the way it does for a player. */}
      {quickViewLb && (
        <GameQuickView
          lb={quickViewLb}
          slug={room.roomSlug || ''}
          fromTab="tournaments"
          onClose={() => setQuickViewLb(null)}
        />
      )}

      {/* Display Name Edit Modal */}
      {displayNameTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setDisplayNameTarget(null)}>
          <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h2 className="font-display text-lg font-bold mb-1">Edit Display Name</h2>
            <p className="text-xs text-muted mb-4">Game: {displayNameTarget.gameName}</p>
            <div className="mb-4">
              <label className="text-xs text-muted block mb-1">Display Name (leave empty to use game name)</label>
              <input
                type="text"
                value={displayNameInput}
                onChange={e => setDisplayNameInput(e.target.value)}
                placeholder={displayNameTarget.gameName}
                className="w-full px-3 py-2 bg-raised border border-border rounded text-sm text-primary focus:outline-none focus:border-neon-cyan/50"
                autoFocus
              />
            </div>
            <div className="flex gap-3 justify-end">
              <NeonButton variant="ghost" onClick={() => setDisplayNameTarget(null)} disabled={displayNameSaving}>Cancel</NeonButton>
              <NeonButton disabled={displayNameSaving} onClick={async () => {
                setDisplayNameSaving(true);
                try {
                  await api.patch(`/rooms/${room.roomId}/admin/games/${displayNameTarget.gameId}/display-name`, {
                    displayName: displayNameInput.trim() || null,
                  });
                  toast(displayNameInput.trim() ? 'Display name updated' : 'Display name cleared', 'success');
                  loadData();
                  setDisplayNameTarget(null);
                } catch (err: any) {
                  toast(err.message, 'error');
                } finally {
                  setDisplayNameSaving(false);
                }
              }}>
                {displayNameSaving ? 'Saving...' : 'Save'}
              </NeonButton>
            </div>
          </div>
        </div>
      )}

      {/* Delete Game Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setDeleteTarget(null)}>
          <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h2 className="font-display text-lg font-bold mb-1 text-red-400">Remove Game</h2>
            <p className="text-sm text-muted mb-2">
              Are you sure you want to remove <strong className="text-primary">{deleteTarget.displayName || deleteTarget.gameName}</strong> from the leaderboard?
            </p>
            <p className="text-xs text-muted mb-4">
              This will delete the game entry and remove it from iScored. Player scores and history will be retained.
            </p>
            <div className="flex gap-3 justify-end">
              <NeonButton variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>Cancel</NeonButton>
              <NeonButton variant="danger" disabled={deleting} onClick={async () => {
                setDeleting(true);
                try {
                  await api.delete(`/rooms/${room.roomId}/admin/games/${deleteTarget.gameId}`);
                  toast(`Removed: ${deleteTarget.displayName || deleteTarget.gameName}`, 'success');
                  loadData();
                  loadRankings();
                  setDeleteTarget(null);
                } catch (err: any) {
                  toast(err.message || 'Failed to remove game', 'error');
                } finally {
                  setDeleting(false);
                }
              }}>
                {deleting ? 'Removing...' : 'Remove Game'}
              </NeonButton>
            </div>
          </div>
        </div>
      )}

      {/* Notes Edit Modal */}
      {notesTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setNotesTarget(null)}>
          <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h2 className="font-display text-lg font-bold mb-1">Edit Game Notes</h2>
            <p className="text-xs text-muted mb-4">Game: {notesTarget.displayName || notesTarget.gameName}</p>
            <div className="mb-4">
              <label className="text-xs text-muted block mb-1">Notes (shown to players via info icon)</label>
              <textarea
                value={notesInput}
                onChange={e => setNotesInput(e.target.value)}
                placeholder="e.g., VPW v1.2, Use cabinet mode..."
                className="w-full px-3 py-2 bg-raised border border-border rounded text-sm text-primary focus:outline-none focus:border-neon-cyan/50 min-h-[80px] resize-y"
                autoFocus
              />
            </div>
            <div className="flex gap-3 justify-end">
              <NeonButton variant="ghost" onClick={() => setNotesTarget(null)} disabled={notesSaving}>Cancel</NeonButton>
              <NeonButton disabled={notesSaving} onClick={async () => {
                setNotesSaving(true);
                try {
                  await api.patch(`/rooms/${room.roomId}/admin/games/${notesTarget.gameId}/notes`, {
                    notes: notesInput.trim() || null,
                  });
                  toast(notesInput.trim() ? 'Notes updated' : 'Notes cleared', 'success');
                  loadData();
                  setNotesTarget(null);
                } catch (err: any) {
                  toast(err.message, 'error');
                } finally {
                  setNotesSaving(false);
                }
              }}>
                {notesSaving ? 'Saving...' : 'Save'}
              </NeonButton>
            </div>
          </div>
        </div>
      )}

      {/* Manage Scores modal — admin per-player delete on the new card style.
          Mirrors the inline trash UI legacy AdminGameCard had on hover. */}
      {manageScoresTarget && (
        <ManageScoresModal
          lb={manageScoresTarget}
          roomId={room.roomId}
          onClose={() => setManageScoresTarget(null)}
          onDeleted={() => { loadData(); loadRankings(); }}
        />
      )}

      {/* v2.119.0 (C2) - guard for switching cards mid-edit. The overlay is
          derived from the session, so confirming simply drops it; there is no
          request to cancel. */}
      {pendingCardEdit && (
        <ConfirmModal
          title="Discard card changes"
          message={`You have unapplied changes on ${cardEdit?.name ?? 'this card'}. Discard them and edit ${pendingCardEdit.kind === 'game' ? (pendingCardEdit.lb.displayName || pendingCardEdit.lb.gameName) : pendingCardEdit.group.name} instead?`}
          confirmLabel="Discard"
          onConfirm={() => { void openCardEdit(pendingCardEdit); }}
          onCancel={() => setPendingCardEdit(null)}
        />
      )}
    </div>
  );
}

/** Shared title bar for both hosts of the display panel. */
function DisplayPanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="shrink-0 flex items-center justify-between gap-2 border-b border-border/50 px-4 py-3">
      <h2 className="font-display text-sm font-bold uppercase tracking-wider">{title}</h2>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close display settings"
        className="min-h-11 min-w-11 inline-flex items-center justify-center rounded text-muted hover:text-primary cursor-pointer bg-transparent border-none"
      >
        <X size={16} />
      </button>
    </div>
  );
}

/**
 * The mobile editing sheet: three snap points (peek / half / full), a drag
 * handle, and scroll containment so a flick inside the panel never scrolls the
 * scoreboard behind it.
 *
 * Height is computed in PIXELS off `window.innerHeight` rather than in `vh`
 * units — mobile browsers report `vh` against the largest viewport (URL bar
 * expanded), which would push the sheet's own footer under the chrome exactly
 * when the Save button is the thing you need.
 *
 * Hand-rolled on pointer events, no new dependency: the drag is a single
 * captured pointer, and release snaps to whichever of the three fractions the
 * gesture ended nearest.
 */
function DisplaySettingsSheet({ title, onClose, footer, children }: {
  title: string;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
}) {
  const [snap, setSnap] = useState(1);
  /** Live drag delta in px (down is positive), or null when not dragging. */
  const [dragDy, setDragDy] = useState<number | null>(null);
  const startYRef = useRef(0);
  /** Fraction the sheet was at when the drag began. State, not a ref: the
   *  render below reads it to size the sheet mid-drag. */
  const [dragStartFrac, setDragStartFrac] = useState<number>(SHEET_SNAPS[1]);
  const [viewportH, setViewportH] = useState(() => (typeof window === 'undefined' ? 800 : window.innerHeight));

  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const frac = dragDy === null
    ? SHEET_SNAPS[snap]
    : Math.min(0.95, Math.max(0.15, dragStartFrac - dragDy / viewportH));

  const endDrag = () => {
    if (dragDy === null) return;
    const target = dragStartFrac - dragDy / viewportH;
    let best = 0;
    SHEET_SNAPS.forEach((s, i) => {
      if (Math.abs(s - target) < Math.abs(SHEET_SNAPS[best] - target)) best = i;
    });
    setSnap(best);
    setDragDy(null);
  };

  return (
    <div
      data-testid="display-settings-sheet"
      role="dialog"
      aria-label="Display settings"
      className="fixed inset-x-0 bottom-0 z-40 flex flex-col rounded-t-2xl border-t border-border bg-surface shadow-2xl"
      style={{
        height: Math.round(viewportH * frac),
        transition: dragDy === null ? 'height 180ms ease' : undefined,
      }}
    >
      <div
        role="separator"
        aria-label="Resize display settings"
        onPointerDown={e => {
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          startYRef.current = e.clientY;
          setDragStartFrac(SHEET_SNAPS[snap]);
          setDragDy(0);
        }}
        onPointerMove={e => { if (dragDy !== null) setDragDy(e.clientY - startYRef.current); }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="shrink-0 py-3 touch-none cursor-grab active:cursor-grabbing"
      >
        <div className="mx-auto h-1.5 w-10 rounded-full bg-border" />
      </div>
      <div className="shrink-0 flex items-center justify-between gap-2 border-b border-border/50 px-4 pb-3">
        <h2 className="font-display text-sm font-bold uppercase tracking-wider">{title}</h2>
        <div className="flex items-center gap-1">
          {SHEET_SNAP_LABELS.map((label, i) => (
            <button
              key={label}
              type="button"
              onClick={() => setSnap(i)}
              aria-pressed={snap === i}
              className={`min-h-11 px-2 text-[11px] font-display uppercase tracking-wider cursor-pointer bg-transparent border-none transition-colors ${
                snap === i ? 'text-neon-cyan' : 'text-faint hover:text-primary'
              }`}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close display settings"
            className="min-h-11 min-w-11 inline-flex items-center justify-center rounded text-muted hover:text-primary cursor-pointer bg-transparent border-none"
          >
            <X size={16} />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 pb-4">{children}</div>
      {footer}
    </div>
  );
}

/** The per-card admin controls, as a contained band UNDER the card rather than
 *  a layer on top of it.
 *
 *  Until v2.85.0 this was an absolutely-positioned cluster pinned to the card's
 *  TOP edge — i.e. directly over the game title. It was hover-revealed on
 *  desktop, but `[@media(hover:none)]` forced it permanently visible on touch,
 *  so on a phone the title of every game was simply unreadable. Moving the
 *  controls below the card removes the conflict outright, which is also why
 *  there is no hover/focus gating left: the strip obscures nothing, so it is
 *  always visible on every device and every button is in the tab order.
 *
 *  Styling follows GlobalGameCard's footer idiom (a filled band with its own
 *  border in the card's tournament colour, so it reads as part of THIS card and
 *  not as a floating row above the next one).
 *
 *  It attaches FLUSH — a fully-rounded bar sitting 4px under the card — rather
 *  than tucking under the card's bottom corners with a negative margin. v2.85.0
 *  had both variants, because a tuck has to know the card's corner radius and
 *  only the legacy in-file admin card had a knowable one (`rounded-lg`, 8px).
 *  v2.86.0 deleted that card in favour of the public `GameCard`, so every card
 *  this strip attaches to now comes from the public rendering path, where radii
 *  vary by style and theme (8px on banner/minimal, 16-20px on the showcase
 *  themes). Flush is correct at ANY radius, and the strip still reads as part
 *  of the card above it via the matching tournament-coloured border.
 *
 *  v2.85.1 — the strip also has to out-rank the card's bottom-anchored QR
 *  overlay, which hangs down across exactly this band and was covering (and
 *  swallowing the clicks for) the Name/Style buttons. Hence the explicit
 *  `ADMIN_CARD_CHROME_Z_INDEX`; see `cardStacking.ts` for the stacking-context
 *  analysis. The QR stays visible behind the strip, which is what the owner
 *  asked for — an admin needs to SEE the QR, not scan it. */
function AdminControlsStrip({ lb, dragHandleProps, dragging, editing, onStyleClick, onEditDisplayName, onDeleteGame, onEditNotes, onManageScores }: {
  lb: GameLeaderboard;
  /** v2.118.0 — everything the drag handle needs, from `useCardReorder`. */
  dragHandleProps?: CardDragHandleProps;
  dragging?: boolean;
  /** v2.119.0 — this card owns the rail's card editor right now. */
  editing?: boolean;
  onStyleClick: (lb: GameLeaderboard) => void;
  onEditDisplayName: (lb: GameLeaderboard) => void;
  onDeleteGame: (lb: GameLeaderboard) => void;
  onEditNotes: (lb: GameLeaderboard) => void;
  onManageScores: (lb: GameLeaderboard) => void;
}) {
  const borderColor = getTournamentBorderColor(lb.tournamentType);
  // The z-index is inline rather than a Tailwind class so it can be read back
  // and compared numerically against the card's QR overlay at runtime — see
  // `cardStacking.ts` and the stacking test in LeaderboardAdminControls.
  return (
    <div
      data-testid="admin-card-controls"
      style={{ zIndex: ADMIN_CARD_CHROME_Z_INDEX }}
      className={`relative flex-shrink-0 min-w-0 flex flex-wrap items-center justify-center gap-1 border-2 ${borderColor} bg-raised px-2 mt-1 py-1.5 rounded-lg`}
    >
      {/* v2.118.0 — drag-to-reposition. A HANDLE, not the whole card: the card
          itself already owns a title link, the score-row expand gesture and
          HorizontalScrollNav's drag-to-scroll. 44px hit target (the button is
          padded out beyond the 11px glyph) per the touch-target rule; the
          keyboard path (Arrow keys) lives on the same button. */}
      {dragHandleProps && (
        <button
          {...dragHandleProps}
          className={`flex items-center justify-center w-11 h-11 -my-2 -ml-1 bg-transparent border-0 transition-colors ${dragging ? 'text-neon-cyan' : 'text-muted hover:text-neon-cyan'}`}
          title="Drag to reorder (or use the arrow keys)"
        >
          <GripHorizontal size={14} />
        </button>
      )}
      <NeonButton variant="ghost" onClick={() => onEditDisplayName(lb)} className="text-[10px] px-1.5 py-0.5" title="Edit display name">
        <Pencil size={11} /> Name
      </NeonButton>
      <NeonButton variant={lb.notes ? 'secondary' : 'ghost'} onClick={() => onEditNotes(lb)} className="text-[10px] px-1.5 py-0.5" title="Edit notes">
        <StickyNote size={11} /> Notes
      </NeonButton>
      {/* v2.119.0 (C2) — relabelled from "Style": it no longer opens a style
          modal, it puts THIS card into the rail's live editor. */}
      <NeonButton
        variant={editing ? 'primary' : lb.catalogueStyleId ? 'secondary' : 'ghost'}
        onClick={() => onStyleClick(lb)}
        className="text-[10px] px-1.5 py-0.5"
        title="Edit this card's art, identifier and background framing"
        aria-pressed={!!editing}
      >
        Edit card
      </NeonButton>
      <NeonButton variant="ghost" onClick={() => onManageScores(lb)} className="text-[10px] px-1.5 py-0.5" title="Manage submitted scores">
        Scores
      </NeonButton>
      <NeonButton variant="ghost" onClick={() => onDeleteGame(lb)} className="text-[10px] px-1.5 py-0.5 text-red-400/60 hover:text-red-400" title="Remove game" aria-label="Remove game">
        <Trash2 size={11} />
      </NeonButton>
    </div>
  );
}

/** v2.9x (ranking-card backgrounds) — the ranking-GROUP-card counterpart of
 *  `AdminControlsStrip` above. A ranking card carries none of the
 *  game-specific affordances (no display name, notes, per-score management,
 *  or delete-from-here — groups are managed on the Rankings admin page), so
 *  this is deliberately a single-button strip: just the Style control that
 *  opens the same `StylePicker` used for game backgrounds. Same flush,
 *  always-visible, z-stacked band as the game strip — see the doc comment
 *  on `AdminControlsStrip` for the layout/QR rationale, unchanged here. */
function RankingAdminControlsStrip({ group, editing, onStyleClick }: {
  group: RankingGroupData['group'];
  editing?: boolean;
  onStyleClick: (group: RankingGroupData['group']) => void;
}) {
  return (
    <div
      data-testid="ranking-admin-card-controls"
      style={{ zIndex: ADMIN_CARD_CHROME_Z_INDEX }}
      /* v2.119.0 — the selected ranking card is marked on its strip rather
         than with the game cards' full-card overlay: a ranking group has no
         framing to drag (its schema is `{ styleId }` and nothing else), so an
         interactive card overlay would only take clicks away for nothing. */
      className={`relative flex-shrink-0 min-w-0 flex flex-wrap items-center justify-center gap-1 border-2 bg-raised px-2 mt-1 py-1.5 rounded-lg ${
        editing ? 'border-neon-cyan' : 'border-border'
      }`}
    >
      <NeonButton
        variant={editing ? 'primary' : group.bg_style_id ? 'secondary' : 'ghost'}
        onClick={() => onStyleClick(group)}
        className="text-[10px] px-1.5 py-0.5"
        title="Edit this card's background"
        aria-pressed={!!editing}
      >
        Edit card
      </NeonButton>
    </div>
  );
}

/** Modal listing all submissions on a game with admin-delete buttons. Used
 *  by the new card path (Banner/Showcase/Minimal) which doesn't have inline
 *  per-row admin chrome. Calls the existing admin "wipe player from game"
 *  endpoint, which now (post-fix) also cascades to score_history so the
 *  deletion sticks across the leaderboard recompute. */
function ManageScoresModal({ lb, roomId, onClose, onDeleted }: {
  lb: GameLeaderboard;
  roomId: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { toast } = useToast();
  const [submissions, setSubmissions] = useState<Submission[] | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [suppressions, setSuppressions] = useState<Suppression[] | null>(null);
  const [removingSuppression, setRemovingSuppression] = useState<string | null>(null);
  // s20: confirm-before-delete for both destructive actions in this modal,
  // replacing native confirm().
  const [pendingConfirm, setPendingConfirm] = useState<
    { kind: 'delete'; sub: Submission } | { kind: 'suppression'; s: Suppression } | null
  >(null);

  const load = () => {
    setSubmissions(null);
    api.get<Submission[]>(`/rooms/${roomId}/leaderboard/${lb.gameId}/submissions`)
      .then(rows => {
        rows.sort((a, b) => b.score - a.score);
        setSubmissions(rows);
      })
      .catch(() => setSubmissions([]));
    setSuppressions(null);
    api.get<{ suppressions: Suppression[] }>(`/rooms/${roomId}/admin/games/${lb.gameId}/suppressions`)
      .then(r => setSuppressions(r.suppressions))
      .catch(() => setSuppressions([]));
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [lb.gameId]);

  const handleDelete = async (sub: Submission) => {
    setDeletingId(sub.id);
    try {
      await api.delete(`/rooms/${roomId}/admin/games/${lb.gameId}/submissions/${encodeURIComponent(sub.id)}`);
      toast(`Deleted: ${sub.iscored_username} (${sub.score.toLocaleString()})`, 'success');
      setSubmissions(prev => prev ? prev.filter(s => s.id !== sub.id) : prev);
      onDeleted();
    } catch (err: any) {
      toast(err.message || 'Failed to delete score', 'error');
    } finally {
      setDeletingId(null);
    }
  };

  const handleRemoveSuppression = async (s: Suppression) => {
    setRemovingSuppression(s.username);
    try {
      await api.delete(`/rooms/${roomId}/admin/games/${lb.gameId}/suppressions/${encodeURIComponent(s.username)}`);
      toast(`Suppression removed: ${s.username} (${s.suppressedScore.toLocaleString()})`, 'success');
      load();
    } catch (err: any) {
      toast(err.message || 'Failed to remove suppression', 'error');
    } finally {
      setRemovingSuppression(null);
    }
  };

  return (
    // m2 fix: the two ConfirmModals below are rendered as SIBLINGS of this
    // backdrop div (not descendants), so a click on a ConfirmModal's own
    // backdrop no longer bubbles up into this div's onClick={onClose} and
    // closes the whole Manage Scores panel underneath it.
    <>
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-lg w-full max-w-lg max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border/50">
          <h2 className="font-display text-lg font-bold mb-0.5">Manage Scores</h2>
          <p className="text-xs text-muted">{lb.displayName || lb.gameName} · {lb.tournamentName}</p>
        </div>
        <div className="flex-1 overflow-y-auto">
          {submissions === null ? (
            <p className="text-faint text-sm text-center py-8">Loading...</p>
          ) : submissions.length === 0 ? (
            <p className="text-muted text-sm text-center py-8">No submissions yet.</p>
          ) : (
            <div className="divide-y divide-border/30">
              {submissions.map((sub, i) => (
                <div key={sub.id} className="flex items-center justify-between px-5 py-2.5 group hover:bg-raised/30 transition-colors">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={`font-display font-bold text-xs w-6 text-center flex-shrink-0 ${
                      i === 0 ? 'text-neon-amber' : i === 1 ? 'text-neon-cyan' : i === 2 ? 'text-neon-green' : 'text-faint'
                    }`}>{i + 1}</span>
                    <span className="text-sm truncate min-w-0">{sub.iscored_username}</span>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="font-display font-bold text-sm flex-shrink-0 whitespace-nowrap tabular-nums">{sub.score.toLocaleString()}</span>
                    <span className="text-faint text-[10px] w-20 text-right">{new Date(sub.timestamp).toLocaleDateString()}</span>
                    <button
                      type="button"
                      onClick={() => setPendingConfirm({ kind: 'delete', sub })}
                      disabled={deletingId === sub.id}
                      className="p-4 -m-2 text-red-400/60 hover:text-red-400 transition-colors disabled:opacity-30"
                      title="Delete score (wipes player from this game)"
                      aria-label="Delete score (wipes player from this game)"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="px-5 pt-4 pb-1 border-t border-border/50 mt-2">
            <h3 className="font-display text-sm font-bold mb-0.5">Suppressed scores</h3>
            <p className="text-[11px] text-faint">Deleted scores that iScored will not re-import until removed.</p>
          </div>
          {suppressions === null ? (
            <p className="text-faint text-sm text-center py-6">Loading...</p>
          ) : suppressions.length === 0 ? (
            <p className="text-muted text-sm text-center py-6">No suppressed scores</p>
          ) : (
            <div className="divide-y divide-border/30">
              {suppressions.map(s => (
                <div key={`${s.gameId}-${s.username}`} className="flex items-center justify-between px-5 py-2.5 group hover:bg-raised/30 transition-colors">
                  <div className="flex items-center gap-3 min-w-0">
                    <Lock size={12} className="text-faint flex-shrink-0" />
                    <span className="text-sm truncate min-w-0">{s.username}</span>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="font-display font-bold text-sm flex-shrink-0 whitespace-nowrap tabular-nums">{s.suppressedScore.toLocaleString()}</span>
                    <span className="text-faint text-[10px] w-28 text-right truncate" title={s.deletedBy ? `Deleted by ${s.deletedBy}` : 'Deleted'}>
                      {new Date(s.deletedAt).toLocaleDateString()}{s.deletedBy ? ` · ${s.deletedBy}` : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPendingConfirm({ kind: 'suppression', s })}
                      disabled={removingSuppression === s.username}
                      className="p-4 -m-2 text-red-400/60 hover:text-red-400 transition-colors disabled:opacity-30"
                      title="Remove suppression (allows iScored re-import)"
                      aria-label="Remove suppression (allows iScored re-import)"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-border/50 flex justify-end">
          <NeonButton variant="ghost" onClick={onClose}>Close</NeonButton>
        </div>
      </div>
    </div>
    {pendingConfirm?.kind === 'delete' && (
      <ConfirmModal
        title="Delete score"
        message={`Delete ${pendingConfirm.sub.iscored_username}'s score (${pendingConfirm.sub.score.toLocaleString()})? This wipes the row from the leaderboard and removes their score history for this game. Scores at or below this value that still exist on iScored will not re-import.`}
        confirmLabel="Delete"
        onConfirm={() => {
          const sub = pendingConfirm.sub;
          setPendingConfirm(null);
          handleDelete(sub);
        }}
        onCancel={() => setPendingConfirm(null)}
      />
    )}
    {pendingConfirm?.kind === 'suppression' && (
      <ConfirmModal
        title="Remove suppression"
        message={`Remove the suppression for ${pendingConfirm.s.username} (${pendingConfirm.s.suppressedScore.toLocaleString()})? Their iScored score for this game will re-import on the next sync cycle.`}
        confirmLabel="Remove"
        onConfirm={() => {
          const s = pendingConfirm.s;
          setPendingConfirm(null);
          handleRemoveSuppression(s);
        }}
        onCancel={() => setPendingConfirm(null)}
      />
    )}
    </>
  );
}
