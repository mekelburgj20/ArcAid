import {
  useCallback, useEffect, useRef, useState,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

/**
 * v2.118.0 — drag-to-reposition for scoreboard cards (admin Leaderboard only).
 *
 * Deliberately hand-rolled on pointer events: no drag library is installed and
 * none is being added. Pointer events give mouse, pen and touch in one path,
 * and `setPointerCapture` keeps a drag alive when the finger leaves the handle.
 *
 * The gesture lives on a HANDLE, not the whole card. Whole-card drag would
 * fight three existing affordances on the same pixels: the card title link,
 * the score-row expand gesture, and `HorizontalScrollNav`'s drag-to-scroll.
 * The handle's `pointerdown` calls `stopPropagation()` precisely so the last
 * of those (a `mousedown` on the scroll wrapper) never engages.
 *
 * The order sent on drop is the FULL server order with the dragged id moved
 * next to the target id — never "the ids I can see". Cards can be missing from
 * the DOM (hide-empty, search filtering), and a partial list would silently
 * delete their positions.
 */

/** Slot elements carry this class in every ScoreboardSurface layout branch. */
const SLOT_SELECTOR = '.scoreboard-card-slot';
/** The scroll element `HorizontalScrollNav` owns (horizontal layout only). */
const SCROLLER_SELECTOR = '.scoreboard-hscroll-nobar';
/** Pointer within this many px of a scroller edge auto-scrolls it. */
const EDGE_PX = 48;
/** Auto-scroll speed while parked at an edge. */
const EDGE_STEP_PX = 8;

export interface UseCardReorderArgs {
  /** The FULL card order as the server returned it. */
  order: string[];
  /** id → human name, used for the aria-live announcement. */
  names?: Record<string, string>;
  /** Turns the handle into an inert, `aria-disabled` button. */
  disabled?: boolean;
  /** Fires once per completed move with the full new order. */
  onReorder: (next: string[]) => void;
}

interface DragState {
  pointerId: number;
  id: string;
  handle: HTMLElement;
  slot: HTMLElement | null;
  scroller: HTMLElement | null;
  targetId: string | null;
  edgeDir: -1 | 0 | 1;
}

/** Moves `id` so it sits immediately next to `targetId`, keeping every other
 *  id's relative order. Exported for direct unit testing. */
export function moveNextTo(order: string[], id: string, targetId: string): string[] {
  const from = order.indexOf(id);
  const to = order.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return order;
  const next = order.slice();
  next.splice(from, 1);
  next.splice(next.indexOf(targetId) + (from < to ? 1 : 0), 0, id);
  return next;
}

/** Moves `id` by one slot in the full order. */
export function moveByOne(order: string[], id: string, delta: -1 | 1): string[] {
  const from = order.indexOf(id);
  if (from < 0) return order;
  const to = from + delta;
  if (to < 0 || to >= order.length) return order;
  const next = order.slice();
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/** Everything a drag handle button needs. Spread onto a `<button>`. */
export type CardDragHandleProps = ReturnType<ReturnType<typeof useCardReorder>['getHandleProps']>;

export function useCardReorder({ order, names, disabled, onReorder }: UseCardReorderArgs) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const dragRef = useRef<DragState | null>(null);
  const rafRef = useRef<number | null>(null);
  // Read inside pointer handlers, which are created once per handle render but
  // may outlive the props they closed over mid-gesture.
  const orderRef = useRef(order);
  useEffect(() => { orderRef.current = order; });

  const nameOf = (id: string) => names?.[id] ?? 'Card';

  const announceMove = useCallback((id: string, next: string[]) => {
    const pos = next.indexOf(id) + 1;
    setAnnouncement(`${nameOf(id)} moved to position ${pos} of ${next.length}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [names]);

  /** Every drag handle currently in the DOM, with the slot it belongs to. */
  const collectSlots = (doc: Document) => {
    const out: Array<{ id: string; el: HTMLElement }> = [];
    doc.querySelectorAll<HTMLElement>('[data-card-drag-id]').forEach(handle => {
      const id = handle.dataset.cardDragId;
      if (!id) return;
      out.push({ id, el: (handle.closest(SLOT_SELECTOR) as HTMLElement) ?? handle });
    });
    return out;
  };

  const setTarget = (state: DragState, targetId: string | null) => {
    if (state.targetId === targetId) return;
    const doc = state.handle.ownerDocument;
    for (const s of collectSlots(doc)) {
      if (s.id === state.id) continue;
      s.el.style.outline = s.id === targetId ? '2px dashed var(--color-neon-cyan)' : '';
      s.el.style.outlineOffset = s.id === targetId ? '4px' : '';
      s.el.style.opacity = s.id === targetId ? '0.65' : '';
    }
    state.targetId = targetId;
  };

  const stopEdgeScroll = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const runEdgeScroll = () => {
    const state = dragRef.current;
    if (!state || !state.scroller || state.edgeDir === 0) { stopEdgeScroll(); return; }
    state.scroller.scrollLeft += state.edgeDir * EDGE_STEP_PX;
    rafRef.current = requestAnimationFrame(runEdgeScroll);
  };

  const cleanup = (state: DragState) => {
    stopEdgeScroll();
    setTarget(state, null);
    if (state.slot) {
      state.slot.style.transform = '';
      state.slot.style.boxShadow = '';
      state.slot.style.zIndex = '';
      state.slot.style.cursor = '';
    }
    state.handle.ownerDocument.body.style.userSelect = '';
    dragRef.current = null;
    setDraggingId(null);
  };

  // A drag interrupted by an unmount must not leave the body unselectable.
  useEffect(() => () => { if (dragRef.current) cleanup(dragRef.current); }, []);

  const getHandleProps = (id: string, label?: string) => ({
    type: 'button' as const,
    'data-card-drag-id': id,
    'aria-label': `Drag to reorder ${label ?? nameOf(id)}`,
    'aria-disabled': disabled || undefined,
    disabled: !!disabled,
    style: { touchAction: 'none' as const, cursor: disabled ? 'not-allowed' : 'grab' },
    /**
     * A mouse press fires pointerdown AND mousedown, and it is the MOUSEDOWN
     * that `HorizontalScrollNav.handleScrollMouseDown` listens for (it only
     * skips INPUT/TEXTAREA targets, so a button would otherwise engage
     * drag-to-scroll on top of the card drag). Stopping pointerdown alone
     * would not save us. Both are stopped, disabled or not.
     */
    onMouseDown: (e: { stopPropagation: () => void; preventDefault: () => void }) => {
      e.stopPropagation();
      e.preventDefault();
    },
    onPointerDown: (e: ReactPointerEvent) => {
      // ALWAYS stop here, disabled or not — see onMouseDown above.
      e.stopPropagation();
      if (disabled || e.button > 0 || dragRef.current) return;
      e.preventDefault();
      const handle = e.currentTarget as HTMLElement;
      // Throws ("no active pointer with the given id") if the pointer is
      // already gone — a stale id must not abort the whole gesture setup.
      try { handle.setPointerCapture?.(e.pointerId); } catch { /* capture is an optimisation */ }
      const slot = (handle.closest(SLOT_SELECTOR) as HTMLElement) ?? null;
      const state: DragState = {
        pointerId: e.pointerId,
        id,
        handle,
        slot,
        scroller: (handle.closest(SCROLLER_SELECTOR) as HTMLElement) ?? null,
        targetId: null,
        edgeDir: 0,
      };
      dragRef.current = state;
      setDraggingId(id);
      if (slot) {
        slot.style.transform = 'scale(1.03)';
        slot.style.boxShadow = '0 12px 32px rgba(0,0,0,0.55)';
        slot.style.zIndex = '20';
        slot.style.cursor = 'grabbing';
      }
      handle.ownerDocument.body.style.userSelect = 'none';
    },
    onPointerMove: (e: ReactPointerEvent) => {
      const state = dragRef.current;
      if (!state || state.pointerId !== e.pointerId) return;
      const px = e.clientX;
      const py = e.clientY;

      // Nearest slot centre wins — Euclidean, so this works unchanged for the
      // horizontal strip, the grid and the single vertical column.
      let best: { id: string; d: number } | null = null;
      for (const s of collectSlots(state.handle.ownerDocument)) {
        if (s.id === state.id) continue;
        const r = s.el.getBoundingClientRect();
        const dx = r.left + r.width / 2 - px;
        const dy = r.top + r.height / 2 - py;
        const d = dx * dx + dy * dy;
        if (!best || d < best.d) best = { id: s.id, d };
      }
      setTarget(state, best?.id ?? null);

      // Edge auto-scroll (horizontal strip only — there is no scroller to find
      // in the grid/vertical branches).
      let dir: -1 | 0 | 1 = 0;
      if (state.scroller) {
        const r = state.scroller.getBoundingClientRect();
        if (px < r.left + EDGE_PX) dir = -1;
        else if (px > r.right - EDGE_PX) dir = 1;
      }
      if (dir !== state.edgeDir) {
        state.edgeDir = dir;
        stopEdgeScroll();
        if (dir !== 0) rafRef.current = requestAnimationFrame(runEdgeScroll);
      }
    },
    onPointerUp: (e: ReactPointerEvent) => {
      const state = dragRef.current;
      if (!state || state.pointerId !== e.pointerId) return;
      const targetId = state.targetId;
      try { (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); } catch { /* never captured */ }
      cleanup(state);
      if (!targetId || targetId === id) return;
      const next = moveNextTo(orderRef.current, id, targetId);
      if (next === orderRef.current) return;
      announceMove(id, next);
      onReorder(next);
    },
    onPointerCancel: () => {
      const state = dragRef.current;
      if (state) cleanup(state);
    },
    onKeyDown: (e: ReactKeyboardEvent) => {
      if (disabled) return;
      const delta = (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1
        : (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1
          : 0;
      if (delta === 0) return;
      e.preventDefault();
      // Keyboard moves must not also scroll the strip (HorizontalScrollNav
      // binds ArrowLeft/Right on the scroll region this button sits inside).
      e.stopPropagation();
      const next = moveByOne(orderRef.current, id, delta as -1 | 1);
      if (next === orderRef.current) return;
      announceMove(id, next);
      onReorder(next);
    },
  });

  return { draggingId, announcement, getHandleProps };
}
