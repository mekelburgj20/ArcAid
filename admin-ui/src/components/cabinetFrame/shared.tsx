import { useLayoutEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import QRCode from 'qrcode';
import type { CabinetBoardRow } from '../../lib/cabinetFrameTypes';

import { artStyle, nameOf } from './helpers';

const ONE_LINE_MIN = 0.6;

/** 1, 0.96, ... down to `min` (inclusive). */
function steps(from: number, min: number): number[] {
    const out: number[] = [];
    for (let f = from; f > min + 1e-6; f -= 0.04) out.push(Math.round(f * 100) / 100);
    out.push(min);
    return out;
}

/**
 * A title that never ellipsises (ADR 0046): shrink to fit on one line (down to
 * 60%), then wrap. `base` is the kit size the title starts at.
 *
 * A title with a limit (the DMD header, which has a fixed band above the dot
 * window) goes on shrinking while it wraps, down to `minScale`, until it is
 * at most `maxLines` lines AND ends above `bottomLimit` (px in frame
 * coordinates). `oneLine` never wraps (labels): it shrinks to `minScale`.
 */
export function FitTitle({ children, className = '', style, base = 'var(--aw-fs-title)', minScale = ONE_LINE_MIN, maxLines, bottomLimit, oneLine = false }: {
    children: string;
    className?: string;
    style?: CSSProperties;
    base?: string;
    minScale?: number;
    maxLines?: number;
    bottomLimit?: number;
    oneLine?: boolean;
}) {
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const fitsWidth = () => el.scrollWidth <= el.clientWidth + 1;
        const fitsBox = () => {
            const fontPx = parseFloat(getComputedStyle(el).fontSize);
            if (maxLines && Number.isFinite(fontPx) && fontPx > 0) {
                const lh = parseFloat(getComputedStyle(el).lineHeight);
                const linePx = Number.isFinite(lh) ? lh : fontPx * 1.2;
                if (el.scrollHeight > linePx * maxLines + 2) return false;
            }
            if (bottomLimit != null) {
                const root = el.closest('.cf-root');
                if (root) {
                    const r = root.getBoundingClientRect();
                    const k = r.height && (root as HTMLElement).offsetHeight ? r.height / (root as HTMLElement).offsetHeight : 1;
                    const bottom = (el.getBoundingClientRect().top - r.top) / k + el.scrollHeight;
                    if (bottom > bottomLimit) return false;
                }
            }
            return true;
        };
        const fit = () => {
            el.style.whiteSpace = 'nowrap';
            const oneLineMin = oneLine ? minScale : Math.max(minScale, ONE_LINE_MIN);
            for (const f of steps(1, oneLineMin)) {
                el.style.setProperty('--cf-fit', String(f));
                if (fitsWidth()) return;
            }
            if (oneLine) return;
            el.style.whiteSpace = 'normal';
            for (const f of steps(ONE_LINE_MIN, Math.min(minScale, ONE_LINE_MIN))) {
                el.style.setProperty('--cf-fit', String(f));
                if (fitsBox()) return;
            }
        };
        fit();
        // The display face loads late: measure again once the fonts are in.
        let live = true;
        void document.fonts?.ready?.then(() => { if (live) fit(); });
        return () => { live = false; };
    }, [children, base, minScale, maxLines, bottomLimit, oneLine]);
    return (
        <div ref={ref} className={className} style={{ fontSize: `calc(${base} * var(--cf-fit, 1))`, ...style }}>
            {children}
        </div>
    );
}

/** Board rows in the kit's `aw-board-row`: gold-less kit colours (1st pink, 2nd cyan, 3rd ice), the player's row the kit's current row. */
export function BoardRows({ rows, where = false }: { rows: CabinetBoardRow[]; where?: boolean }) {
    return (
        <>
            {rows.map((r, i) => {
                const cls = ['aw-board-row'];
                if (r.rank === '1' || r.rank === '2' || r.rank === '3') cls.push(`aw-board-row--${r.rank}`);
                if (r.me) cls.push('aw-board-row--current');
                return (
                    <div key={`${r.rank}-${i}`} className={cls.join(' ')}>
                        <span className="aw-board-row__rank">{r.rank}</span>
                        <span className="aw-board-row__name">{nameOf(r.name)}</span>
                        {where && <span className="cf-where">{r.region ?? ''}</span>}
                        <span className="aw-board-row__score">{r.score}</span>
                    </div>
                );
            })}
        </>
    );
}

/** The card shell: art under a 55% scrim, the light bar, the content on top. */
export function ArtCard({ artUrl, children }: { artUrl: string | null; children: ReactNode }) {
    return (
        <div className="cf-card">
            <div className="cf-art" style={artStyle(artUrl)} />
            <div className="cf-scrim" />
            <div className="cf-bar" />
            <div className="cf-content">{children}</div>
        </div>
    );
}

/** A real QR for `text`, drawn as one SVG path of the kit's canvas colour on an ice plate. */
export function QrCode({ text, size }: { text: string; size: number }) {
    const qr = useMemo(() => {
        try {
            const q = QRCode.create(text, { errorCorrectionLevel: 'M' });
            const n = q.modules.size;
            let d = '';
            for (let y = 0; y < n; y++) {
                for (let x = 0; x < n; x++) if (q.modules.get(y, x)) d += `M${x} ${y}h1v1h-1z`;
            }
            return { n, d };
        } catch {
            return null;
        }
    }, [text]);
    if (!qr) return null;
    return (
        <svg className="cf-qr" width={size} height={size} viewBox={`0 0 ${qr.n} ${qr.n}`} shapeRendering="crispEdges" role="img" aria-label="QR code to pair this cabinet">
            <path d={qr.d} />
        </svg>
    );
}
