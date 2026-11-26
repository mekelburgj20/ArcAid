import type { CSSProperties, ReactNode } from 'react';
import { ChevronDown, RotateCcw } from 'lucide-react';
import type { Choice } from './model';

/**
 * G34a - the Display settings panel's small controls, drawn in the Arcaid
 * dialog's fixed-dark slab (`index.css` "Display settings, the panel's own
 * controls"). Each control is named by its row's label.
 */

/** A section: its tracked-caps title and the muted caption that says how far it reaches. */
export function Section({ title, caption, id, children }: { title: string; caption?: ReactNode; id: string; children: ReactNode }) {
    return (
        <section className="dset-sec" aria-labelledby={id}>
            <div className="dset-sec__head">
                <h3 className="dset-sec__title" id={id}>{title}</h3>
                {caption && <span className="dset-sec__cap">{caption}</span>}
            </div>
            {children}
        </section>
    );
}

/**
 * One setting: the label column and the control. When the viewer's value
 * differs from the room's (`changed`), a lit dot by the label, a Reset that
 * clears their keys, and the room's value under it.
 */
export function SettingRow({ label, help, changed = false, roomText, onReset, kind = 'inline', testId, children }: {
    label: string;
    help?: ReactNode;
    changed?: boolean;
    /** The room's value, shown while `changed`. */
    roomText?: string;
    onReset?: () => void;
    /** `wide`: the control under the label; `switch`: the switch at the end of the line. */
    kind?: 'inline' | 'wide' | 'switch';
    testId?: string;
    children: ReactNode;
}) {
    const cls = `dset-row${kind === 'wide' ? ' dset-row--wide' : kind === 'switch' ? ' dset-row--switch' : ''}`;
    return (
        <div className={cls} data-changed={changed ? '' : undefined} data-testid={testId}>
            <div className="dset-row__l">
                <span className="dset-row__lbl">
                    <span className="dset-dot" aria-hidden="true" />
                    {label}
                </span>
                {changed && onReset && (
                    <button type="button" className="dset-reset" onClick={onReset} aria-label={`Reset ${label} to the room's`}>
                        <RotateCcw aria-hidden="true" />
                        Reset
                    </button>
                )}
                {help && <span className="dset-row__help">{help}</span>}
                {changed && roomText != null && <span className="dset-row__room">Room: {roomText}</span>}
            </div>
            <div className="dset-row__c">{children}</div>
        </div>
    );
}

/** A segmented choice: one pressed button in a group. */
export function Segmented({ label, value, choices, onChange, icons }: {
    label: string;
    value: string;
    choices: readonly Choice[];
    onChange: (value: string) => void;
    icons?: Partial<Record<string, ReactNode>>;
}) {
    return (
        <div className="dset-seg" role="group" aria-label={label}>
            {choices.map(c => (
                <button key={c.value} type="button" aria-pressed={c.value === value} onClick={() => { if (c.value !== value) onChange(c.value); }}>
                    {icons?.[c.value]}
                    {c.label}
                </button>
            ))}
        </div>
    );
}

export function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (next: boolean) => void }) {
    return (
        <button type="button" role="switch" aria-checked={checked} aria-label={label} className="dset-switch" onClick={() => onChange(!checked)}>
            <span className="dset-switch__track" aria-hidden="true">
                <span className="dset-switch__knob" />
            </span>
        </button>
    );
}

function clampTo(n: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, n));
}

/** Minus, the number, plus. */
export function Stepper({ label, value, min, max, step = 1, format = String, onChange }: {
    label: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    format?: (n: number) => string;
    onChange: (next: number) => void;
}) {
    const go = (dir: 1 | -1) => {
        const next = clampTo(value + dir * step, min, max);
        if (next !== value) onChange(next);
    };
    return (
        <div className="dset-step" role="group" aria-label={label}>
            <button type="button" aria-label={`Less ${label.toLowerCase()}`} onClick={() => go(-1)} disabled={value <= min}>&#8722;</button>
            <output aria-live="polite">{format(value)}</output>
            <button type="button" aria-label={`More ${label.toLowerCase()}`} onClick={() => go(1)} disabled={value >= max}>+</button>
        </div>
    );
}

/** The lit rail with the chrome pinball; every move is a change. */
export function Slider({ label, value, min, max, step, format, onChange }: {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    format: (n: number) => string;
    onChange: (next: number) => void;
}) {
    const along = max > min ? ((clampTo(value, min, max) - min) / (max - min)) * 100 : 0;
    return (
        <div className="dset-range">
            <input
                type="range"
                aria-label={label}
                aria-valuetext={format(value)}
                min={min}
                max={max}
                step={step}
                value={value}
                style={{ '--p': `${along}%` } as CSSProperties}
                onChange={e => onChange(Number(e.target.value))}
            />
            <output>{format(value)}</output>
        </div>
    );
}

/** A native select in the Field part's recessed well. */
export function SelectWell({ label, value, choices, onChange }: {
    label: string;
    value: string;
    choices: readonly Choice[];
    onChange: (value: string) => void;
}) {
    // A stored value the list does not know still shows, as itself.
    const known = choices.some(c => c.value === value);
    return (
        <span className="dset-well">
            <select aria-label={label} value={value} onChange={e => onChange(e.target.value)}>
                {!known && <option value={value}>{value}</option>}
                {choices.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <ChevronDown aria-hidden="true" />
        </span>
    );
}
