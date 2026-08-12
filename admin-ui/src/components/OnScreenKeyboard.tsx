import { useState, memo } from 'react';
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

// `touch-manipulation` (v2.100.5, owner iPhone field report): without it, iOS
// applies its double-tap-to-zoom heuristic to every key — the browser WAITS
// (up to ~350ms) after each tap to see if a second tap follows before firing
// the click. Rapid numpad entry felt "laggy" exactly because of that hold.
// touch-action: manipulation disables the double-tap gesture on the element,
// so taps fire immediately.
const keyClass = 'bg-raised border border-border text-primary rounded px-2 py-2.5 text-sm font-medium active:bg-neon-cyan/20 active:border-neon-cyan/50 transition-colors select-none cursor-pointer min-w-[28px] text-center touch-manipulation';

/**
 * v2.101.1 (tester field report, round 2): keys act on POINTER DOWN, not
 * click. A click only fires if the finger lifts while still inside the
 * button — rapid thumb-typing slides slightly between press and release, so
 * keys visibly flashed (:active applies at press) yet never delivered their
 * digit. Acting at press time makes the flash and the input atomic. The
 * `button.onClick` props are gone on purpose — reintroducing one alongside
 * onPointerDown double-fires the key.
 */
function key(handler: () => void) {
  return { onPointerDown: handler };
}

/**
 * v2.101.1: keep the bottom key row clear of the iPhone home-indicator /
 * gesture zone — keys flush with the screen edge got mistaken for the
 * bottom-edge swipe, refreshing the page mid-entry (tester field report).
 * `env(safe-area-inset-bottom)` is only non-zero where the OS actually
 * reserves that strip; the 14px floor keeps a touch margin on browsers that
 * report 0 while still drawing UI near the edge.
 */
const safeAreaPad = { paddingBottom: 'max(env(safe-area-inset-bottom), 14px)' } as const;

function OnScreenKeyboard({ mode, onKeyPress, onBackspace, onDone }: OnScreenKeyboardProps) {
  const [showSymbols, setShowSymbols] = useState(false);
  const [shift, setShift] = useState(false);

  if (mode === 'numeric') {
    return (
      <div className="flex flex-col gap-1.5 p-2 bg-surface border-t border-border" style={safeAreaPad}>
        <div className="grid grid-cols-3 gap-1.5 max-w-[240px] mx-auto">
          {NUMBER_ROW.slice(0, 9).map(k => (
            <button key={k} type="button" className={keyClass} {...key(() => onKeyPress(k))}>{k}</button>
          ))}
          <button type="button" aria-label="Backspace" className={`${keyClass} text-neon-amber inline-flex items-center justify-center`} {...key(onBackspace)}><Delete size={16} /></button>
          <button type="button" className={keyClass} {...key(() => onKeyPress('0'))}>0</button>
          <button type="button" className={`${keyClass} text-neon-cyan`} {...key(onDone)}>Done</button>
        </div>
      </div>
    );
  }

  const rows = showSymbols ? SYMBOL_ROWS : ALPHA_ROWS;

  return (
    <div className="flex flex-col gap-1 p-2 bg-surface border-t border-border" style={safeAreaPad}>
      {/* Number row (always visible) */}
      <div className="flex gap-1 justify-center">
        {NUMBER_ROW.map(k => (
          <button key={k} type="button" className={keyClass} {...key(() => onKeyPress(k))}>{k}</button>
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
                {...key(() => { onKeyPress(out); if (!showSymbols && shift) setShift(false); })}
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
            {...key(() => setShift(s => !s))}
          >
            <ArrowBigUp size={16} />
          </button>
        )}
        <button type="button" className={`${keyClass} text-neon-purple px-3`} {...key(() => setShowSymbols(!showSymbols))}>
          {showSymbols ? 'ABC' : '#+='}
        </button>
        <button type="button" aria-label="Backspace" className={`${keyClass} text-neon-amber px-4 inline-flex items-center justify-center`} {...key(onBackspace)}><Delete size={16} /></button>
        <button type="button" className={`${keyClass} flex-1 max-w-[200px]`} {...key(() => onKeyPress(' '))}>space</button>
        <button type="button" className={`${keyClass} text-neon-cyan px-4`} {...key(onDone)}>Done</button>
      </div>
    </div>
  );
}

// memo (v2.100.5): every keypress updates SubmissionSheet state and re-renders
// its whole ~900-line tree. With the sheet's handlers now useCallback-stable,
// memo lets the keyboard subtree skip those re-renders entirely — on
// phone-class CPUs the per-tap render cost was a visible part of the lag.
export default memo(OnScreenKeyboard);
