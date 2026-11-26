import {
    forwardRef, useCallback, useRef, useState,
    type ChangeEvent, type InputHTMLAttributes, type ReactNode, type Ref,
    type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';

/**
 * G23 - the shared fields: `TextInput`, `TextArea`, `Select`, `SearchInput`.
 *
 * The owner's pick (2026-11-25, option A): a recessed well, 44 px tall, with a
 * tracked-caps label over it. Keyboard focus lights the well and the label in
 * cyan; an error turns both to the danger ink and adds a small triangle mark.
 * Drawn with site tokens only (like `Button`), so it needs no skin switch.
 *
 * Every field takes `label`, an optional `hint` and `error`, `optional` (adds
 * "(optional)" after the label) and a required `id`. The hint and error are
 * wired through `aria-describedby`, and an error sets `aria-invalid`. The rest
 * are the native element's props. `className` lands on the wrapper (layout
 * only); the well and the control are the part's own.
 *
 * `TextInput size="score"` (or `numeric`) is the big tabular display-face
 * field for a score. It does no grouping: the caller formats the value.
 * `Select` is a NATIVE select drawn as the well with a chevron, so a phone
 * keeps its own picker. `SearchInput` shows a clear button once it has text:
 * it empties the field (a native input event, so `onChange` fires with an empty
 * value), calls `onClear` and puts focus back in the input.
 */

type FieldBase = {
    label: ReactNode;
    id: string;
    hint?: ReactNode;
    error?: ReactNode;
    optional?: boolean;
    /** Layout only (margins, grid span); lands on the wrapper. */
    className?: string;
};

const ERR_TRI = (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <polygon points="16,3 30,28 2,28" strokeWidth="3.2" />
    </svg>
);

function Frame({ id, label, optional, hint, error, disabled, className = '', children }: FieldBase & {
    disabled?: boolean;
    children: ReactNode;
}) {
    const cls = ['part-field', error ? 'part-field--error' : '', disabled ? 'part-field--disabled' : '', className]
        .filter(Boolean).join(' ');
    return (
        <div className={cls}>
            <label className="part-field__label" htmlFor={id}>
                {label}
                {optional && <> <span className="part-field__opt">(optional)</span></>}
            </label>
            {children}
            {hint && <p className="part-field__hint" id={`${id}-hint`}>{hint}</p>}
            {error && <p className="part-field__err" id={`${id}-error`}>{ERR_TRI}<span>{error}</span></p>}
        </div>
    );
}

/** The ids the control points at, joined with any the caller passed. */
function describedBy(id: string, hint: ReactNode, error: ReactNode, extra?: string): string | undefined {
    const ids = [extra, hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ');
    return ids || undefined;
}

type TextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & FieldBase & {
    /** `score`: the big tabular display-face digits. */
    size?: 'md' | 'score';
    /** Same as `size="score"`. */
    numeric?: boolean;
};

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
    { label, id, hint, error, optional, className, size = 'md', numeric, disabled, 'aria-describedby': extra, ...rest },
    ref,
) {
    const score = numeric || size === 'score';
    return (
        <Frame id={id} label={label} hint={hint} error={error} optional={optional} disabled={disabled} className={className}>
            <div className="part-field__box">
                <input
                    ref={ref}
                    id={id}
                    type="text"
                    {...(score ? { inputMode: 'numeric' as const, autoComplete: 'off' } : {})}
                    {...rest}
                    disabled={disabled}
                    className={`part-field__input${score ? ' part-field__input--score' : ''}`}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={describedBy(id, hint, error, extra)}
                />
            </div>
        </Frame>
    );
});

type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & FieldBase;

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
    { label, id, hint, error, optional, className, disabled, rows = 3, 'aria-describedby': extra, ...rest },
    ref,
) {
    return (
        <Frame id={id} label={label} hint={hint} error={error} optional={optional} disabled={disabled} className={className}>
            <div className="part-field__box part-field__box--area">
                <textarea
                    ref={ref}
                    id={id}
                    rows={rows}
                    {...rest}
                    disabled={disabled}
                    className="part-field__input"
                    aria-invalid={error ? true : undefined}
                    aria-describedby={describedBy(id, hint, error, extra)}
                />
            </div>
        </Frame>
    );
});

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & FieldBase;

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
    { label, id, hint, error, optional, className, disabled, children, 'aria-describedby': extra, ...rest },
    ref,
) {
    return (
        <Frame id={id} label={label} hint={hint} error={error} optional={optional} disabled={disabled} className={className}>
            <div className="part-field__box">
                <select
                    ref={ref}
                    id={id}
                    {...rest}
                    disabled={disabled}
                    className="part-field__input part-field__select"
                    aria-invalid={error ? true : undefined}
                    aria-describedby={describedBy(id, hint, error, extra)}
                >
                    {children}
                </select>
                <svg className="part-field__chev" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <path d="M3.5 6 8 10.5 12.5 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </div>
        </Frame>
    );
});

type SearchInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'> & FieldBase & {
    /** Called after the clear button empties the field. */
    onClear?: () => void;
    clearLabel?: string;
};

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
    if (typeof ref === 'function') ref(value);
    else if (ref) (ref as { current: T | null }).current = value;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
    {
        label, id, hint, error, optional, className, disabled, onClear, clearLabel = 'Clear the search',
        value, defaultValue, onChange, 'aria-describedby': extra, ...rest
    },
    ref,
) {
    const inner = useRef<HTMLInputElement | null>(null);
    const [typed, setTyped] = useState(() => String(defaultValue ?? '').length > 0);
    const has = value !== undefined ? String(value).length > 0 : typed;

    const attach = useCallback((el: HTMLInputElement | null) => {
        inner.current = el;
        setRef(ref, el);
    }, [ref]);

    const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
        setTyped(e.target.value.length > 0);
        onChange?.(e);
    };

    const clear = () => {
        const el = inner.current;
        if (el) {
            // A native input event, so React's `onChange` (controlled or not) sees an empty value.
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            setter?.call(el, '');
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.focus();
        }
        onClear?.();
    };

    return (
        <Frame id={id} label={label} hint={hint} error={error} optional={optional} disabled={disabled} className={className}>
            <div className="part-field__box">
                <svg className="part-field__icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                    <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
                    <path d="m13 13 4.5 4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                </svg>
                <input
                    ref={attach}
                    id={id}
                    type="search"
                    autoComplete="off"
                    {...rest}
                    {...(value !== undefined ? { value } : { defaultValue })}
                    onChange={handleChange}
                    disabled={disabled}
                    className="part-field__input"
                    aria-invalid={error ? true : undefined}
                    aria-describedby={describedBy(id, hint, error, extra)}
                />
                {has && !disabled && (
                    <button type="button" className="part-field__clear" aria-label={clearLabel} onClick={clear}>
                        <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                            <path d="m5 5 10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                        </svg>
                    </button>
                )}
            </div>
        </Frame>
    );
});
