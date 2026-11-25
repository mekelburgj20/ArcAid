import { createContext } from 'react';

/**
 * G13 - how a page's `<RoomNoticeSlot />` tells `PublicLayout` where to put the
 * room notices (see RoomNoticeSlot.tsx). Kept apart from the component so the
 * component file exports only a component (react-refresh).
 */
export interface RoomNoticeSlotApi {
  /** `el` null unregisters; `from` is the slot element that is going away, so a
   *  late cleanup never clears a newer page's slot. */
  register: (el: HTMLElement | null, from?: HTMLElement) => void;
}

export const RoomNoticeSlotContext = createContext<RoomNoticeSlotApi | null>(null);
