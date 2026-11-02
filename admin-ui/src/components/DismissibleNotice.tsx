import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * W83 - one wrapper for every notice at the top of a room page. Always shows an
 * X (desktop and phone); on a touch screen the notice can also be swiped
 * sideways to dismiss it.
 *
 * Swipe rules: only `pointerType === 'touch'` (a mouse drag does nothing). The
 * first ~8px decide the gesture - mostly vertical hands it back to the page
 * scroll (`touch-action: pan-y` lets the browser keep it), mostly horizontal
 * drags the notice. Release past 40% of its width, or a flick faster than
 * 0.5 px/ms, commits with a 150ms slide-out; anything less springs back. A
 * drag swallows the click that follows it, so a swiped link never navigates.
 * `prefers-reduced-motion`: no slide, the notice just goes.
 *
 * The parent owns persistence (`lib/roomNotices.ts`) and removes the notice in
 * `onDismiss`.
 */

const DECIDE_PX = 8;
const COMMIT_FRACTION = 0.4;
const FLICK_PX_PER_MS = 0.5;
const SLIDE_MS = 150;

function prefersReducedMotion(): boolean {
    try {
        return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}

type Gesture = { id: number; x: number; y: number; t: number; mode: 'pending' | 'drag' | 'scroll' };

export default function DismissibleNotice({
    noticeKey, onDismiss, children, className = '',
}: { noticeKey: string; onDismiss: () => void; children: ReactNode; className?: string }) {
    const [dx, setDx] = useState(0);
    const [animating, setAnimating] = useState(false);
    const [leaving, setLeaving] = useState<number | null>(null);
    const gesture = useRef<Gesture | null>(null);
    const suppressClick = useRef(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

    const commit = (direction: number, width: number) => {
        if (prefersReducedMotion()) { onDismiss(); return; }
        setAnimating(true);
        setLeaving(direction * Math.max(width, 1));
        timer.current = setTimeout(onDismiss, SLIDE_MS);
    };

    const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
        suppressClick.current = false;
        if (e.pointerType !== 'touch' || leaving !== null) return;
        gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now(), mode: 'pending' };
        setAnimating(false);
    };

    const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
        const g = gesture.current;
        if (!g || g.id !== e.pointerId || g.mode === 'scroll') return;
        const mx = e.clientX - g.x;
        const my = e.clientY - g.y;
        if (g.mode === 'pending') {
            if (Math.abs(mx) < DECIDE_PX && Math.abs(my) < DECIDE_PX) return;
            // Mostly vertical: the page scroll wins and this gesture is over.
            if (Math.abs(my) > Math.abs(mx)) { g.mode = 'scroll'; return; }
            g.mode = 'drag';
            suppressClick.current = true;
            // jsdom has no setPointerCapture.
            e.currentTarget.setPointerCapture?.(e.pointerId);
        }
        setDx(mx);
    };

    const endGesture = (e: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
        const g = gesture.current;
        if (!g || g.id !== e.pointerId) return;
        gesture.current = null;
        if (g.mode !== 'drag') return;
        const mx = e.clientX - g.x;
        const width = e.currentTarget.getBoundingClientRect().width;
        const elapsed = Math.max(Date.now() - g.t, 1);
        const farEnough = width > 0 && Math.abs(mx) >= width * COMMIT_FRACTION;
        const flick = Math.abs(mx) / elapsed > FLICK_PX_PER_MS;
        if (!cancelled && mx !== 0 && (farEnough || flick)) {
            commit(Math.sign(mx), width);
            return;
        }
        setAnimating(true);
        setDx(0);
    };

    const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        e.preventDefault();
        e.stopPropagation();
    };

    const offset = leaving ?? dx;
    const style: CSSProperties = {
        touchAction: 'pan-y',
        transform: offset ? `translateX(${offset}px)` : undefined,
        opacity: leaving !== null ? 0 : undefined,
        transition: animating ? `transform ${SLIDE_MS}ms ease-out, opacity ${SLIDE_MS}ms ease-out` : undefined,
    };

    return (
        <div
            data-testid="dismissible-notice"
            data-notice-key={noticeKey}
            className={`flex items-start gap-1 ${className}`}
            style={style}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={e => endGesture(e, false)}
            onPointerCancel={e => endGesture(e, true)}
            onClickCapture={onClickCapture}
        >
            <div className="min-w-0 flex-1">{children}</div>
            <button
                type="button"
                aria-label="Dismiss"
                onClick={e => { e.preventDefault(); e.stopPropagation(); onDismiss(); }}
                className="shrink-0 -my-2 -mr-2 inline-flex items-center justify-center min-w-8 min-h-8 rounded text-faint hover:text-primary cursor-pointer bg-transparent border-none"
            >
                <X size={14} aria-hidden="true" />
            </button>
        </div>
    );
}
