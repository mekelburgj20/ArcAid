import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

interface Tournament {
    id: string;
    name?: string;
    type?: string;
}

interface Props {
    tournaments: Tournament[];
    selectedId: string | null;
    onChange: (id: string) => void;
}

/**
 * v2.2.13 — Pinball cabinet topper that shows the currently-selected
 * tournament pool and reveals the rest on click. Styled like a real
 * cabinet topper (LED glow, chunky silhouette, orange accent) so it
 * reads as part of the machine rather than a browser chrome element.
 *
 * Collapsed: compact "TOURNAMENT POOL — Daily Grind ▼" bar.
 * Expanded: list of options drops down onto the backbox area. Selecting
 * collapses the list again.
 */
export default function TournamentPoolTopper({ tournaments, selectedId, onChange }: Props) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    // Close on outside click / escape.
    useEffect(() => {
        if (!open) return;
        const onDocClick = (e: MouseEvent) => {
            if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDocClick);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDocClick);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const selected = tournaments.find(t => t.id === selectedId);
    const label = (t: Tournament) => t.name || t.type || t.id;

    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                className={`pinball-topper ${open ? 'pinball-topper--open' : ''}`}
                aria-haspopup="listbox"
                aria-expanded={open}
            >
                <span className="pinball-topper__label">Tournament Pool</span>
                <span className="pinball-topper__value">{selected ? label(selected) : '—'}</span>
                <ChevronDown size={14} className="pinball-topper__chevron" />
            </button>
            {open && (
                <div role="listbox" className="pinball-topper__menu">
                    {tournaments.map(t => (
                        <button
                            key={t.id}
                            type="button"
                            role="option"
                            aria-selected={t.id === selectedId}
                            onClick={() => { onChange(t.id); setOpen(false); }}
                            className={`pinball-topper__menu-item ${t.id === selectedId ? 'pinball-topper__menu-item--active' : ''}`}
                        >
                            {label(t)}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
