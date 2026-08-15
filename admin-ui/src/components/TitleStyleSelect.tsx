import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { getTitleStyleClass } from './ScoreboardComponents';

/**
 * Style-system revamp P1 (owner ask, 2026-08-13): "the title style options
 * should render in their own style."
 *
 * A native `<select>` cannot do this — browsers refuse to apply text-shadow,
 * gradient fills, or custom fonts to `<option>` elements, so every entry in
 * the Game Title Style dropdown looked identical and the admin had to pick
 * blind and check the preview. This is the same idea already used for the
 * ROOM title style (a grid of styled buttons in Settings.tsx), reshaped as a
 * dropdown because this control sits in a compact label-left/control-right
 * row where a 12-tile grid would not fit.
 *
 * Keyboard/ARIA follows the listbox pattern: the trigger is a `combobox`,
 * the panel a `listbox`, arrows move the highlight, Enter/Space commits,
 * Escape closes and returns focus to the trigger.
 */
interface TitleStyleSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  /** Rendered inside each option alongside the label. Defaults to the label
   *  itself, which is what makes the style legible. */
  sampleText?: string;
  className?: string;
}

export default function TitleStyleSelect({ value, onChange, options, sampleText, className = '' }: TitleStyleSelectProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const selectedIndex = Math.max(0, options.findIndex(o => o.value === value));
  const selected = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  /** Opening seeds the highlight from the current selection. Done here rather
   *  than in an effect — a setState inside an effect body just to mirror a
   *  prop causes a cascading render (react-hooks/set-state-in-effect). */
  const openPanel = () => {
    setHighlight(selectedIndex);
    setOpen(true);
  };

  const commit = (index: number) => {
    const opt = options[index];
    if (opt) onChange(opt.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openPanel();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight(h => Math.min(options.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight(h => Math.max(0, h - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setHighlight(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setHighlight(options.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      commit(highlight);
    }
  };

  return (
    <div ref={rootRef} className={`relative ${className}`} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => (open ? setOpen(false) : openPanel())}
        className="flex w-full items-center justify-between gap-2 rounded border border-border bg-raised px-2 py-1 text-sm text-primary cursor-pointer"
      >
        <span className={`font-display uppercase tracking-wider truncate ${getTitleStyleClass(selected?.value ?? 'default')}`}>
          {selected?.label ?? 'Default'}
        </span>
        <ChevronDown size={14} className="shrink-0 text-muted" />
      </button>

      {open && (
        <ul
          role="listbox"
          aria-label="Game title style"
          className="absolute right-0 z-50 mt-1 max-h-72 w-56 overflow-y-auto rounded border border-border bg-surface py-1 shadow-lg"
        >
          {options.map((opt, i) => (
            <li key={opt.value}>
              <button
                type="button"
                role="option"
                aria-selected={opt.value === value}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => commit(i)}
                className={`block w-full px-3 py-2 text-left cursor-pointer border-none ${
                  i === highlight ? 'bg-neon-cyan/10' : 'bg-transparent'
                } ${opt.value === value ? 'ring-1 ring-inset ring-neon-cyan/40' : ''}`}
              >
                <span className={`font-display text-sm uppercase tracking-wider ${getTitleStyleClass(opt.value)}`}>
                  {sampleText ?? opt.label}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
