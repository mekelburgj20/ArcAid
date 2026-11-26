import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { TextInput, TextArea, Select, SearchInput } from '../Field';

describe('Field parts (G23)', () => {
    it('wires the label, the hint and the error to the control', () => {
        render(<TextInput id="n" label="Name" hint="Shown on boards." error="Too short." optional />);
        const input = screen.getByLabelText(/Name/);
        expect(screen.getByText('(optional)')).toBeInTheDocument();
        expect(input.getAttribute('aria-invalid')).toBe('true');
        expect(input.getAttribute('aria-describedby')).toBe('n-hint n-error');
        expect(document.getElementById('n-hint')).toHaveTextContent('Shown on boards.');
        expect(document.getElementById('n-error')).toHaveTextContent('Too short.');
        expect(input.closest('.part-field')?.classList.contains('part-field--error')).toBe(true);
    });

    it('has no aria-invalid or describedby when there is nothing to say', () => {
        render(<TextInput id="n" label="Name" />);
        const input = screen.getByLabelText('Name');
        expect(input.hasAttribute('aria-invalid')).toBe(false);
        expect(input.hasAttribute('aria-describedby')).toBe(false);
    });

    it('keeps a describedby the caller passes', () => {
        render(<TextInput id="n" label="Name" hint="h" aria-describedby="x" />);
        expect(screen.getByLabelText('Name').getAttribute('aria-describedby')).toBe('x n-hint');
    });

    it('draws the score size with numeric input mode', () => {
        render(<TextInput id="s" label="Score" size="score" />);
        const input = screen.getByLabelText('Score');
        expect(input.className).toContain('part-field__input--score');
        expect(input.getAttribute('inputmode')).toBe('numeric');
    });

    it('forwards refs and marks a disabled field', () => {
        const ref = createRef<HTMLInputElement>();
        render(<TextInput id="d" label="Code" disabled ref={ref} />);
        expect(ref.current).toBe(screen.getByLabelText('Code'));
        expect(ref.current?.closest('.part-field')?.classList.contains('part-field--disabled')).toBe(true);
    });

    it('renders a textarea and a native select', () => {
        render(<>
            <TextArea id="t" label="Note" />
            <Select id="s" label="Table" defaultValue="b"><option value="a">A</option><option value="b">B</option></Select>
        </>);
        expect(screen.getByLabelText('Note').tagName).toBe('TEXTAREA');
        const sel = screen.getByLabelText('Table') as HTMLSelectElement;
        expect(sel.tagName).toBe('SELECT');
        expect(sel.value).toBe('b');
    });

    it('shows a clear button only with text; it empties the field, fires onChange and returns focus', () => {
        const onChange = vi.fn();
        const onClear = vi.fn();
        render(<SearchInput id="q" label="Search" onChange={onChange} onClear={onClear} />);
        const input = screen.getByLabelText('Search') as HTMLInputElement;
        expect(screen.queryByRole('button', { name: 'Clear the search' })).toBeNull();
        fireEvent.change(input, { target: { value: 'tilt' } });
        const clear = screen.getByRole('button', { name: 'Clear the search' });
        clear.focus();
        fireEvent.click(clear);
        expect(input.value).toBe('');
        expect(document.activeElement).toBe(input);
        expect(onClear).toHaveBeenCalled();
        expect(onChange.mock.calls.at(-1)?.[0].target.value).toBe('');
        expect(screen.queryByRole('button', { name: 'Clear the search' })).toBeNull();
    });

    it('works controlled', () => {
        const seen: string[] = [];
        render(<SearchInput id="q" label="Search" value="abc" onChange={e => seen.push(e.target.value)} />);
        fireEvent.click(screen.getByRole('button', { name: 'Clear the search' }));
        expect(seen).toEqual(['']);
    });
});
