import { useLayoutEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import QRCode from 'qrcode';
import type { CabinetBoardRow } from '../../lib/cabinetFrameTypes';

import { artStyle, nameOf } from './helpers';

const FIT_STEPS = [1, 0.92, 0.84, 0.76, 0.68, 0.6];

/**
 * A title that never ellipsises: shrink to fit on one line, down to 60%, then
 * wrap (ADR 0046). `base` is the kit size the title starts at.
 */
export function FitTitle({ children, className = '', style, base = 'var(--aw-fs-title)' }: {
    children: string;
    className?: string;
    style?: CSSProperties;
    base?: string;
}) {
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const fit = () => {
            el.style.whiteSpace = 'nowrap';
            let fitted = false;
            for (const f of FIT_STEPS) {
                el.style.setProperty('--cf-fit', String(f));
                if (el.scrollWidth <= el.clientWidth + 1) { fitted = true; break; }
            }
            if (!fitted) el.style.whiteSpace = 'normal';
        };
        fit();
        // The display face loads late: measure again once the fonts are in.
        let live = true;
        void document.fonts?.ready?.then(() => { if (live) fit(); });
        return () => { live = false; };
    }, [children, base]);
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
