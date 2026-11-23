import { usePartSkin, type PartTone } from './skin';

/** One chip of the jump list: the `id` of the `PanelGroup` it jumps to, its title and its colour. */
export interface JumpItem { id: string; title: string; tone: PartTone }

/**
 * G21 - the jump list beside a page's groups (G20 Account Settings): a row of
 * chips on a phone or a laptop, a column that stays in view on a wide screen
 * (`.aw-jump` in public/aw-theme/aw-web.css; `.part-jump` in src/index.css).
 * Each chip wears its group's colour.
 */
export default function JumpList({ items, label = 'Sections' }: { items: JumpItem[]; label?: string }) {
    const arcaid = usePartSkin() === 'arcaid';
    return (
        // Buttons, not `#` links: a link would add a history entry per jump,
        // and Back (in the page header) would then step through them.
        <nav className={arcaid ? 'aw-jump' : 'part-jump'} aria-label={label}>
            {items.map(g => (
                <button
                    key={g.id}
                    type="button"
                    className={arcaid ? `aw-jump__item aw-group--${g.tone}` : `part-jump__item part-tone--${g.tone}`}
                    onClick={() => document.getElementById(g.id)?.scrollIntoView({
                        block: 'start',
                        behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
                    })}
                >
                    {g.title}
                </button>
            ))}
        </nav>
    );
}
