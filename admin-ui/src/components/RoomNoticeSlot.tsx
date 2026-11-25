import { useContext, useLayoutEffect, useRef } from 'react';
import { RoomNoticeSlotContext } from './roomNoticeSlotContext';

/**
 * G13 (owner, 2026-11-25) - where the room-page notices are painted.
 *
 * `PublicLayout` renders the notices (event banner, Witness lines, the
 * notifications nudge) ONCE, into one stable DOM node, so they never remount
 * and the Arcaid Witness toast that `WitnessScoresGoTo` fires keeps its place
 * across page navigation. Each room page puts `<RoomNoticeSlot />` directly
 * after its OWN header (room name, tabs); the layout moves that node into the
 * slot. A page with no slot gets the node at the top of the content.
 *
 * Exactly one slot should be mounted at a time (the last one to register wins).
 */

export default function RoomNoticeSlot({ className = '' }: { className?: string }) {
  const api = useContext(RoomNoticeSlotContext);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!api || !el) return;
    api.register(el);
    return () => api.register(null, el);
  }, [api]);

  return <div ref={ref} data-testid="room-notice-slot" className={className} />;
}
