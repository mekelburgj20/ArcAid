import { useState } from 'react';
import { Delete, ArrowBigUp } from 'lucide-react';

interface OnScreenKeyboardProps {
  mode: 'alpha' | 'numeric';
  onKeyPress: (key: string) => void;
  onBackspace: () => void;
  onDone: () => void;
}

const NUMBER_ROW = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

const ALPHA_ROWS = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
];

const SYMBOL_ROWS = [
  ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')'],
  ['-', '_', '=', '+', '[', ']', '{', '}', '|', '\\'],
  ['.', ',', '/', '?', '<', '>', '~', '`'],
];

const keyClass = 'bg-raised border border-border text-primary rounded px-2 py-2.5 text-sm font-medium active:bg-neon-cyan/20 active:border-neon-cyan/50 transition-colors select-none cursor-pointer min-w-[28px] text-center';

export default function OnScreenKeyboard({ mode, onKeyPress, onBackspace, onDone }: OnScreenKeyboardProps) {
  const [showSymbols, setShowSymbols] = useState(false);
  const [shift, setShift] = useState(false);

  if (mode === 'numeric') {
    return (
      <div className="flex flex-col gap-1.5 p-2 bg-surface border-t border-border">
        <div className="grid grid-cols-3 gap-1.5 max-w-[240px] mx-auto">
          {NUMBER_ROW.slice(0, 9).map(k => (
            <button key={k} type="button" className={keyClass} onClick={() => onKeyPress(k)}>{k}</button>
          ))}
          <button type="button" aria-label="Backspace" className={`${keyClass} text-neon-amber inline-flex items-center justify-center`} onClick={onBackspace}><Delete size={16} /></button>
          <button type="button" className={keyClass} onClick={() => onKeyPress('0')}>0</button>
          <button type="button" className={`${keyClass} text-neon-cyan`} onClick={onDone}>Done</button>
        </div>
      </div>
    );
  }

  const rows = showSymbols ? SYMBOL_ROWS : ALPHA_ROWS;

  return (
    <div className="flex flex-col gap-1 p-2 bg-surface border-t border-border">
      {/* Number row (always visible) */}
      <div className="flex gap-1 justify-center">
        {NUMBER_ROW.map(k => (
          <button key={k} type="button" className={keyClass} onClick={() => onKeyPress(k)}>{k}</button>
        ))}
      </div>
      {/* Letter or symbol rows. In the alpha view, the Shift toggle applies
          case to letter keys (display + keypress payload); symbol/number rows
          are unaffected and pass their key through verbatim. */}
      {rows.map((row, i) => (
        <div key={i} className="flex gap-1 justify-center">
          {row.map(k => {
            const out = !showSymbols && shift ? k.toUpperCase() : k;
            return (
              <button
                key={k}
                type="button"
                className={keyClass}
                onClick={() => { onKeyPress(out); if (!showSymbols && shift) setShift(false); }}
              >
                {out}
              </button>
            );
          })}
        </div>
      ))}
      {/* Bottom row */}
      <div className="flex gap-1 justify-center">
        {/* Shift (single-shot case toggle) — alpha view only. Resets after one
            letter so it mirrors phone-keyboard behavior. */}
        {!showSymbols && (
          <button
            type="button"
            aria-label="Shift"
            aria-pressed={shift}
            className={`${keyClass} px-3 inline-flex items-center justify-center ${shift ? 'text-neon-cyan border-neon-cyan/50 bg-neon-cyan/20' : 'text-muted'}`}
            onClick={() => setShift(s => !s)}
          >
            <ArrowBigUp size={16} />
          </button>
        )}
        <button type="button" className={`${keyClass} text-neon-purple px-3`} onClick={() => setShowSymbols(!showSymbols)}>
          {showSymbols ? 'ABC' : '#+='}
        </button>
        <button type="button" aria-label="Backspace" className={`${keyClass} text-neon-amber px-4 inline-flex items-center justify-center`} onClick={onBackspace}><Delete size={16} /></button>
        <button type="button" className={`${keyClass} flex-1 max-w-[200px]`} onClick={() => onKeyPress(' ')}>space</button>
        <button type="button" className={`${keyClass} text-neon-cyan px-4`} onClick={onDone}>Done</button>
      </div>
    </div>
  );
}
