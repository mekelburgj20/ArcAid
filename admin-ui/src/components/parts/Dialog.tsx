import { useCallback, useEffect, useId, useRef, useState, type ElementType, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import Button from './Button';
import { lazyPart } from '../../lib/lazyPart';

/**
 * G23 - the Arcaid dialog and phone sheet (owner pick 2026-11-25, style plan
 * decision 8; ADR 0042).
 *
 * The confirm pop-up and the form pop-up are one slab, the toast and menu
 * family, fixed dark on every theme: the double-line neon edge and the top
 * light bar in the tone, the logo's triangle beside a tracked-caps label, a
 * plain title, a corner ×, then the body and the actions. `tone` is cyan
 * (default), pink for attention (Leave room) or red for harm (Delete score).
 * With `sheet`, a phone (600 px or less) gets it as a bottom sheet with a grab
 * handle (a short lit rail with the chrome pinball resting on it): drag it
 * down to close. Every pixel is `index.css` "The Arcaid dialog and sheet".
 *
 * base-ui carries the behaviour (focus trap, Escape, outside press, scroll
 * lock, returning focus, ARIA; the sheet's swipe is its Drawer) and lives in
 * `DialogImpl`, a chunk of its own: this file is in the main bundle and must
 * never import base-ui. The chunk is fetched when the browser is idle after
 * the first `Dialog` mounts. A dialog that opens before it has arrived, or
 * after it failed to load (a stale deploy, offline), is drawn here by hand
 * with the same markup and classes: `role="dialog"`, Escape and a press
 * outside cancel, focus starts where the real one would, the same buttons.
 * When the chunk arrives the real dialog takes its place without a jump.
 *
 * Callers that keep the part mounted and flip `open` get the exit animation;
 * callers that unmount it on close do not (accepted).
 */

export type DialogTone = 'cyan' | 'pink' | 'red';

export interface DialogProps {
    open: boolean;
    /** Escape, a press outside, the × and the sheet's drag call this with `false`. */
    onOpenChange: (open: boolean) => void;
    tone?: DialogTone;
    /** The tracked-caps line above the title, in the tone (uppercased by CSS). */
    label: string;
    /** The dialog's name. */
    title: ReactNode;
    description?: ReactNode;
    /** The actions row: `parts/Button`s, the quieter one first. */
    footer?: ReactNode;
    /** On a phone (600 px or less) a bottom sheet with a grab handle; a centred dialog above that. */
    sheet?: boolean;
    /** `sm` 28rem, `md` 32rem (a form). */
    size?: 'sm' | 'md';
    /** Where focus starts; the first focusable element when absent. */
    initialFocusRef?: RefObject<HTMLElement | null>;
    /** The body, which scrolls inside the dialog while the title and the actions stay. */
    children?: ReactNode;
}

/** What the stand-in hands the real dialog when the chunk arrives while it is open. */
export interface DialogHandoff {
    /** The element of the real slab at the place the stand-in's focus was (null: none had it). */
    pickFocus: (slab: HTMLElement | null) => HTMLElement | null;
    /** What had focus before the dialog opened, to give it back on close. */
    returnTo: HTMLElement | null;
}

export interface DialogImplProps extends DialogProps {
    handoff: DialogHandoff | null;
    /** `DialogFrame`, handed over so the chunk imports nothing back from the main bundle. */
    Frame: typeof DialogFrame;
}

type ImplModule = { default: (props: DialogImplProps) => ReactNode };

const dialogPart = lazyPart<ImplModule>('dialog', () => import('./DialogImpl'));

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The slab's focusable elements, in order. */
function focusablesIn(root: HTMLElement | null): HTMLElement[] {
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => !el.closest('[inert]'));
}

/** The element types a `DialogFrame` is drawn with: plain HTML here, base-ui's parts in `DialogImpl`. */
export interface DialogFrameParts {
    Popup: ElementType;
    Title: ElementType;
    Description: ElementType;
    Close: ElementType;
    Body: ElementType;
}

/**
 * The slab and everything in it, the one markup both the stand-in and the
 * real dialog draw (so the swap cannot move a pixel). `popupProps` go on the
 * slab element (role and ARIA here, base-ui's focus props in `DialogImpl`).
 */
export function DialogFrame({ dialog, parts, popupProps, titleId, descriptionId, closeProps, stage }: {
    dialog: DialogProps;
    parts: DialogFrameParts;
    popupProps: Record<string, unknown>;
    titleId?: string;
    descriptionId?: string;
    closeProps?: Record<string, unknown>;
    /** `stand-in` animates itself in; `handoff` replaced a stand-in and must not animate again. */
    stage: 'stand-in' | 'live' | 'handoff';
}) {
    const { tone = 'cyan', size = 'sm', sheet = false, label, title, description, footer, children } = dialog;
    const { Popup, Title, Description, Close, Body } = parts;
    const form = children != null && children !== false;
    const className = [
        'arc-dialog sb-theme-scope',
        `arc-dialog--${tone}`,
        `arc-dialog--${size}`,
        form ? 'arc-dialog--form' : 'arc-dialog--confirm',
        sheet ? 'arc-dialog--sheet' : '',
        stage === 'stand-in' ? 'arc-dialog--stand-in' : '',
        stage === 'handoff' ? 'arc-dialog--handoff' : '',
    ].filter(Boolean).join(' ');
    return (
        <Popup className={className} {...popupProps}>
            {sheet && (
                <div className="arc-dialog__grab" aria-hidden="true">
                    <span className="arc-dialog__rail" />
                    <span className="arc-dialog__ball" />
                </div>
            )}
            <div className="arc-dialog__top">
                <div className="arc-dialog__head">
                    {/* The Arcaid logo's own double-line triangle, in the tone. */}
                    <svg className="arc-dialog__em" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
                        <polygon className="arc-dialog__em-outer" points="13.1,3.3 29.3,21.3 5.6,26.4" />
                        <polygon className="arc-dialog__em-inner" points="14.1,8 24.8,19.9 9.1,23.2" />
                    </svg>
                    <div className="arc-dialog__heading">
                        <p className="arc-dialog__label">{label}</p>
                        <Title className="arc-dialog__title" id={titleId}>{title}</Title>
                    </div>
                    <Close className="arc-dialog__x" aria-label="Close" {...closeProps}>
                        <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                            <path d="M5 5l10 10M15 5 5 15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                        </svg>
                    </Close>
                </div>
                {description != null && description !== false && (
                    <Description className="arc-dialog__desc" id={descriptionId}>{description}</Description>
                )}
            </div>
            {form && <Body className="arc-dialog__body">{children}</Body>}
            {footer != null && footer !== false && (
                <div className="arc-dialog__foot">
                    <div className="arc-dialog__acts">{footer}</div>
                </div>
            )}
        </Popup>
    );
}

const STAND_IN_PARTS: DialogFrameParts = { Popup: 'div', Title: 'h2', Description: 'p', Close: 'button', Body: 'div' };

/**
 * The hand-drawn dialog, while the chunk is late or missing: no base-ui, the
 * same slab. Escape and a press outside cancel, Tab stays inside, the page
 * behind does not scroll, and focus goes back where it was on close (but not
 * when the real dialog takes over: that one has it then).
 */
function StandInDialog({ dialog, slabRef, returnToRef, isSwapping }: {
    dialog: DialogProps;
    slabRef: RefObject<HTMLDivElement | null>;
    returnToRef: RefObject<HTMLElement | null>;
    /** True when this stand-in leaves because the real dialog takes over. */
    isSwapping: () => boolean;
}) {
    const titleId = useId();
    const descriptionId = useId();
    const { onOpenChange, initialFocusRef } = dialog;
    const onOpenChangeRef = useRef(onOpenChange);
    useEffect(() => { onOpenChangeRef.current = onOpenChange; }, [onOpenChange]);

    useEffect(() => {
        const slab = slabRef.current;
        const before = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
        returnToRef.current = before;
        (initialFocusRef?.current ?? focusablesIn(slab)[0] ?? slab)?.focus({ preventScroll: true });

        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                // As base-ui does: the dialog's Escape is not also a page's (a modal under it, say).
                e.preventDefault();
                e.stopPropagation();
                onOpenChangeRef.current(false);
                return;
            }
            if (e.key !== 'Tab' || !slab) return;
            const items = focusablesIn(slab);
            if (items.length === 0) { e.preventDefault(); return; }
            const first = items[0]!;
            const last = items[items.length - 1]!;
            const at = document.activeElement;
            if (!slab.contains(at)) { e.preventDefault(); first.focus(); }
            else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
        };
        document.addEventListener('keydown', onKey);
        const root = document.documentElement;
        const overflow = root.style.overflow;
        root.style.overflow = 'hidden';
        return () => {
            document.removeEventListener('keydown', onKey);
            root.style.overflow = overflow;
            if (!isSwapping() && before && document.contains(before)) before.focus({ preventScroll: true });
        };
    }, [slabRef, returnToRef, isSwapping, initialFocusRef]);

    const cancel = () => onOpenChangeRef.current(false);
    const onViewportClick = (e: MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget) cancel();
    };

    return createPortal(
        <>
            <div className="arc-dialog-backdrop arc-dialog-backdrop--stand-in" aria-hidden="true" />
            <div className={`arc-dialog-vp${dialog.sheet ? ' arc-dialog-vp--sheet' : ''}`} onClick={onViewportClick}>
                <DialogFrame
                    dialog={dialog}
                    parts={STAND_IN_PARTS}
                    stage="stand-in"
                    titleId={titleId}
                    descriptionId={dialog.description != null && dialog.description !== false ? descriptionId : undefined}
                    popupProps={{
                        ref: slabRef,
                        role: 'dialog',
                        'aria-modal': 'true',
                        'aria-labelledby': titleId,
                        'aria-describedby': dialog.description != null && dialog.description !== false ? descriptionId : undefined,
                        tabIndex: -1,
                    }}
                    closeProps={{ type: 'button', onClick: cancel }}
                />
            </div>
        </>,
        document.body,
    );
}

/** The Arcaid dialog (see the top of this file). */
export function Dialog(props: DialogProps) {
    const [mod, setMod] = useState<ImplModule | null>(() => dialogPart.loaded());
    const [handoff, setHandoff] = useState<DialogHandoff | null>(null);
    const slabRef = useRef<HTMLDivElement | null>(null);
    const returnToRef = useRef<HTMLElement | null>(null);
    const swappingRef = useRef(false);
    const isSwapping = useCallback(() => swappingRef.current, []);
    const { open } = props;

    // The first dialog on a page fetches the chunk when the browser is idle, open or not.
    useEffect(() => { dialogPart.prefetch(); }, []);

    // Open before the chunk is in: ask for it now (again after a failure; the stand-in works meanwhile).
    const Impl = (mod ?? dialogPart.loaded())?.default;
    useEffect(() => {
        if (!open || Impl) return;
        let live = true;
        dialogPart.load().then(
            m => {
                if (!live) return;
                const slab = slabRef.current;
                if (slab) {
                    // The stand-in is on screen: hand over its focus and where focus goes back to.
                    const at = focusablesIn(slab).indexOf(document.activeElement as HTMLElement);
                    swappingRef.current = true;
                    setHandoff({
                        pickFocus: real => (at >= 0 ? focusablesIn(real)[at] ?? null : null),
                        returnTo: returnToRef.current,
                    });
                }
                setMod(m);
            },
            () => { /* the stand-in stays; the next open tries again */ },
        );
        return () => { live = false; };
    }, [open, Impl]);

    if (Impl) return <Impl {...props} handoff={handoff} Frame={DialogFrame} />;
    if (!open) return null;
    return <StandInDialog dialog={props} slabRef={slabRef} returnToRef={returnToRef} isSwapping={isSwapping} />;
}

export interface ConfirmDialogProps {
    open: boolean;
    onCancel: () => void;
    onConfirm: () => void;
    title: string;
    message: ReactNode;
    /** The action's words; also the label above the title. */
    confirmLabel?: string;
    /** `red` (default) for harm, `pink` for attention. */
    tone?: DialogTone;
    /** The action is under way: its button is disabled. */
    busy?: boolean;
}

/**
 * "Are you sure?": the dialog with Cancel and the action. Focus starts on
 * Cancel; Escape, a press outside and the × all cancel. On a phone the two
 * stack full width, the action on top.
 */
export function ConfirmDialog({ open, onCancel, onConfirm, title, message, confirmLabel = 'Confirm', tone = 'red', busy = false }: ConfirmDialogProps) {
    const cancelRef = useRef<HTMLButtonElement>(null);
    return (
        <Dialog
            open={open}
            onOpenChange={next => { if (!next) onCancel(); }}
            tone={tone}
            label={confirmLabel}
            title={title}
            description={message}
            initialFocusRef={cancelRef}
            footer={(
                <>
                    <Button ref={cancelRef} variant="secondary" onClick={onCancel}>Cancel</Button>
                    {/* Pink is the dialog's lead (`primary`), as on the Arcaid look; red is `danger`. */}
                    <Button variant={tone === 'red' ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy} aria-busy={busy || undefined}>
                        {confirmLabel}
                    </Button>
                </>
            )}
        />
    );
}

export default Dialog;
