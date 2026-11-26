import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { Drawer } from '@base-ui/react/drawer';
import type { DialogFrameParts, DialogImplProps } from './Dialog';

/**
 * G23 - the Arcaid dialog's real half, a chunk of its own (`parts/Dialog.tsx`
 * loads it; base-ui never reaches the main bundle).
 *
 * base-ui carries the behaviour: the focus trap, Escape, a press outside,
 * the page's scroll lock, focus going back on close, `aria-labelledby` and
 * `aria-describedby`, hiding the rest of the page from screen readers, and the
 * enter and exit states CSS animates (`data-starting-style`,
 * `data-ending-style`). A `sheet` is base-ui's Drawer, so on a phone the
 * swipe down to close (follow the finger, then close past half the sheet or
 * on a flick, else spring back) is the library's too. Above 600 px the sheet is a centred dialog
 * and does not swipe. The slab itself is `DialogFrame`, the same markup the
 * stand-in draws, handed in as `Frame` (this chunk imports nothing back from
 * the main bundle).
 *
 * A nested dialog (one rendered inside another's children, G23c) draws its own
 * backdrop too (`forceRender`; base-ui leaves it out by default), so the dialog
 * under it dims as the stand-in's does and as it did before the pop-ups nested.
 */

const DIALOG_PARTS: DialogFrameParts = {
    Popup: BaseDialog.Popup, Title: BaseDialog.Title, Description: BaseDialog.Description, Close: BaseDialog.Close, Body: 'div',
};
const SHEET_PARTS: DialogFrameParts = {
    Popup: Drawer.Popup, Title: Drawer.Title, Description: Drawer.Description, Close: Drawer.Close, Body: Drawer.Content,
};

/** The sheet's breakpoint, the same as the CSS's and Sonner's. */
const PHONE_QUERY = '(max-width: 600px)';

function subscribePhone(onChange: () => void): () => void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
    const mq = window.matchMedia(PHONE_QUERY);
    if (typeof mq.addEventListener !== 'function') return () => {};
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
}

function isPhone(): boolean {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
}

export default function DialogImpl({ handoff, Frame, ...dialog }: DialogImplProps) {
    const { open, onOpenChange, sheet = false, initialFocusRef } = dialog;
    const phone = useSyncExternalStore(subscribePhone, isPhone, () => false);
    const popupRef = useRef<HTMLDivElement | null>(null);
    // Taking over from the stand-in (it was on screen when this chunk arrived):
    // no second entrance, focus stays where it was, and it goes back to what
    // had it before the stand-in opened. Until this dialog has closed once.
    const [entry, setEntry] = useState(handoff);
    const returnToRef = useRef<HTMLElement | null>(handoff?.returnTo ?? null);

    const initialFocus = useCallback((): HTMLElement | boolean => {
        const picked = entry?.pickFocus(popupRef.current);
        if (picked) return picked;
        return initialFocusRef?.current ?? true;
    }, [entry, initialFocusRef]);
    const finalFocus = useCallback((): HTMLElement | boolean => {
        const el = returnToRef.current;
        returnToRef.current = null;
        return el && el.isConnected ? el : true;
    }, []);
    // A modal base-ui dialog closes on a press on its own backdrop only, so a
    // press on a toast (toasts sit above dialogs) leaves it open.
    const onChange = useCallback((next: boolean) => onOpenChange(next), [onOpenChange]);
    const onChangeComplete = useCallback((next: boolean) => {
        if (!next) setEntry(null);
    }, []);

    const stage = entry ? 'handoff' : 'live';
    const popupProps: Record<string, unknown> = { ref: popupRef, initialFocus, finalFocus, 'aria-modal': 'true' };

    if (sheet) {
        // No Drawer.VirtualKeyboardProvider (G23d): on a tap in a text field it
        // cancels the touch's default action to refocus the field itself, which
        // also cancels the browser placing the caret where the finger landed, so
        // a digit typed after tapping mid-score went to the end (the v2.128.0
        // caret fix undone, in the score sheet and the correction). The old
        // overlays never had its keyboard help either.
        return (
            <Drawer.Root open={open} onOpenChange={onChange} onOpenChangeComplete={onChangeComplete} swipeDirection="down">
                    <Drawer.Portal>
                        <Drawer.Backdrop className="arc-dialog-backdrop" forceRender />
                        <Drawer.Viewport className="arc-dialog-vp arc-dialog-vp--sheet">
                            <Frame
                                dialog={dialog}
                                parts={SHEET_PARTS}
                                stage={stage}
                                // A centred dialog (above 600 px) is not dragged anywhere.
                                popupProps={phone ? popupProps : { ...popupProps, 'data-base-ui-swipe-ignore': '' }}
                            />
                        </Drawer.Viewport>
                    </Drawer.Portal>
            </Drawer.Root>
        );
    }

    return (
        <BaseDialog.Root open={open} onOpenChange={onChange} onOpenChangeComplete={onChangeComplete}>
            <BaseDialog.Portal>
                <BaseDialog.Backdrop className="arc-dialog-backdrop" forceRender />
                <BaseDialog.Viewport className="arc-dialog-vp">
                    <Frame dialog={dialog} parts={DIALOG_PARTS} stage={stage} popupProps={popupProps} />
                </BaseDialog.Viewport>
            </BaseDialog.Portal>
        </BaseDialog.Root>
    );
}
