interface OnScreenKeyboardProps {
  mode: 'alpha' | 'numeric';
  onKeyPress: (key: string) => void;
  onBackspace: () => void;
  onDone: () => void;
}

const ALPHA_ROWS = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
];

const NUMERIC_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

const keyClass = 'bg-raised border border-border text-primary rounded px-2 py-2.5 text-sm font-medium active:bg-neon-cyan/20 active:border-neon-cyan/50 transition-colors select-none cursor-pointer min-w-[28px] text-center';

export default function OnScreenKeyboard({ mode, onKeyPress, onBackspace, onDone }: OnScreenKeyboardProps) {
  if (mode === 'numeric') {
    return (
      <div className="flex flex-col gap-1.5 p-2 bg-surface border-t border-border">
        <div className="grid grid-cols-3 gap-1.5 max-w-[240px] mx-auto">
          {NUMERIC_KEYS.slice(0, 9).map(k => (
            <button key={k} type="button" className={keyClass} onClick={() => onKeyPress(k)}>{k}</button>
          ))}
          <button type="button" className={`${keyClass} text-neon-amber`} onClick={onBackspace}>⌫</button>
          <button type="button" className={keyClass} onClick={() => onKeyPress('0')}>0</button>
          <button type="button" className={`${keyClass} text-neon-cyan`} onClick={onDone}>Done</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 p-2 bg-surface border-t border-border">
      {ALPHA_ROWS.map((row, i) => (
        <div key={i} className="flex gap-1 justify-center">
          {row.map(k => (
            <button key={k} type="button" className={keyClass} onClick={() => onKeyPress(k)}>{k}</button>
          ))}
        </div>
      ))}
      <div className="flex gap-1 justify-center">
        <button type="button" className={`${keyClass} text-neon-amber px-4`} onClick={onBackspace}>⌫</button>
        <button type="button" className={`${keyClass} flex-1 max-w-[200px]`} onClick={() => onKeyPress(' ')}>space</button>
        <button type="button" className={`${keyClass} text-neon-cyan px-4`} onClick={onDone}>Done</button>
      </div>
    </div>
  );
}
