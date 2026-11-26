import type { CSSProperties, ReactNode } from 'react';

/**
 * G23 - stat tiles (owner's pick, 2026-11-25, option A "lit tiles"): the number
 * in the display face, a tracked-caps label under it, and a short top light bar
 * in the panel's tone. No box per tile; faint rules divide them; 2 to 4 stay in
 * one row and shrink (the number drops from 30 to 24 px in a narrow panel).
 * Meant to sit inside a `Panel`, whose tone the bar takes (cyan elsewhere).
 */
export default function StatTiles({ tiles }: { tiles: Array<{ label: string; value: ReactNode }> }) {
    const cols = Math.min(Math.max(tiles.length, 2), 4);
    return (
        <div className="part-tiles-box">
            <dl className="part-tiles" style={{ ['--part-tiles-cols' as string]: cols } as CSSProperties}>
                {tiles.map(t => (
                    <div key={t.label} className="part-tile">
                        {/* dt first for assistive tech; CSS `order` draws the number above it. */}
                        <dt className="part-tile__label">{t.label}</dt>
                        <dd className="part-tile__num">{t.value}</dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}
