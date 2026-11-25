import type { CSSProperties } from 'react';

/**
 * G23 - loading is a skeleton in the content's shape (never a spinner in the
 * middle), with the attract-mode glint of the owner's pick (2026-11-25).
 *
 * `Skeleton` is one bar (decorative: `aria-hidden`). `SkeletonRows` (shaped like
 * `ListRow`: a 40 px tile and two bars) and `SkeletonTiles` (shaped like
 * `StatTiles`) are the containers a page drops in: `role="status"` and
 * `aria-busy`, with a visually hidden `label` (default "Loading") for screen
 * readers. The glint moves only for people who have not asked for less motion.
 */

export function Skeleton({ width, height = 14, className = '', style }: {
    width?: number | string;
    height?: number | string;
    className?: string;
    style?: CSSProperties;
}) {
    return <span aria-hidden="true" className={`part-skel__bar ${className}`.trim()} style={{ width, height, ...style }} />;
}

/** Stagger the sweep a little per item so the rows do not flash together. */
const glint = (i: number): CSSProperties => ({ ['--gd' as string]: `${(i * 0.12).toFixed(2)}s` });

export function SkeletonRows({ count = 3, label = 'Loading' }: { count?: number; label?: string }) {
    return (
        <div role="status" aria-busy="true" className="part-rows">
            <span className="sr-only">{label}</span>
            {Array.from({ length: count }, (_, i) => (
                <div key={i} className="part-row" aria-hidden="true" style={glint(i)}>
                    <Skeleton className="part-skel__tile" width={40} height={40} />
                    <span className="part-row__text">
                        <Skeleton width="58%" height={14} style={{ margin: '3px 0' }} />
                        <Skeleton width="38%" height={11} style={{ marginTop: 5 }} />
                    </span>
                </div>
            ))}
        </div>
    );
}

export function SkeletonTiles({ count = 3, label = 'Loading' }: { count?: number; label?: string }) {
    return (
        <div className="part-tiles-box">
            <div
                role="status"
                aria-busy="true"
                className="part-tiles"
                style={{ ['--part-tiles-cols' as string]: Math.min(Math.max(count, 1), 4) }}
            >
                <span className="sr-only">{label}</span>
                {Array.from({ length: count }, (_, i) => (
                    <div key={i} className="part-tile part-tile--skel" aria-hidden="true" style={glint(i)}>
                        <span className="part-tile__num"><Skeleton /></span>
                        <span className="part-tile__label"><Skeleton /></span>
                    </div>
                ))}
            </div>
        </div>
    );
}
