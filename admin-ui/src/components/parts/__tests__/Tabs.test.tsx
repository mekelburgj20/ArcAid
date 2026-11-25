import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { RailTabs } from '../Tabs';
import { tabPanelProps } from '../tabPanel';

const TABS = [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }, { id: 'c', label: 'Gamma' }];

function Harness({ onChange }: { onChange?: (id: string) => void }) {
    const [v, setV] = useState('a');
    return (
        <>
            <RailTabs label="Sample" idPrefix="t" tabs={TABS} value={v} onChange={id => { setV(id); onChange?.(id); }} />
            <div {...tabPanelProps('t', v)}>panel {v}</div>
        </>
    );
}

describe('RailTabs (G23)', () => {
    it('is a tablist of tabs with ARIA wiring and a roving tabindex', () => {
        render(<Harness />);
        expect(screen.getByRole('tablist', { name: 'Sample' })).toBeInTheDocument();
        const [a, b] = screen.getAllByRole('tab');
        expect(a!.getAttribute('aria-selected')).toBe('true');
        expect(b!.getAttribute('aria-selected')).toBe('false');
        expect(a!.tabIndex).toBe(0);
        expect(b!.tabIndex).toBe(-1);
        expect(a!.id).toBe('t-tab-a');
        expect(a!.getAttribute('aria-controls')).toBe('t-panel');
    });

    it('panel props point back at the active tab', () => {
        expect(tabPanelProps('t', 'b')).toEqual({ role: 'tabpanel', id: 't-panel', 'aria-labelledby': 't-tab-b', tabIndex: 0 });
        render(<Harness />);
        expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 't-tab-a');
    });

    it('arrows, Home and End move focus and selection (wrapping)', () => {
        render(<Harness />);
        const tab = (n: string) => screen.getByRole('tab', { name: n });
        fireEvent.keyDown(tab('Alpha'), { key: 'ArrowRight' });
        expect(tab('Beta').getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(tab('Beta'));
        fireEvent.keyDown(tab('Beta'), { key: 'End' });
        expect(document.activeElement).toBe(tab('Gamma'));
        fireEvent.keyDown(tab('Gamma'), { key: 'ArrowRight' });
        expect(tab('Alpha').getAttribute('aria-selected')).toBe('true');
        fireEvent.keyDown(tab('Alpha'), { key: 'ArrowLeft' });
        expect(tab('Gamma').getAttribute('aria-selected')).toBe('true');
        fireEvent.keyDown(tab('Gamma'), { key: 'Home' });
        expect(document.activeElement).toBe(tab('Alpha'));
        expect(screen.getByRole('tabpanel')).toHaveTextContent('panel a');
    });

    it('a click selects, and clicking the active tab does not fire again', () => {
        const onChange = vi.fn();
        render(<Harness onChange={onChange} />);
        fireEvent.click(screen.getByRole('tab', { name: 'Gamma' }));
        fireEvent.click(screen.getByRole('tab', { name: 'Gamma' }));
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith('c');
    });
});
