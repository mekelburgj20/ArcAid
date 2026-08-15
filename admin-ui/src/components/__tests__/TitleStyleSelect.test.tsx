import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TitleStyleSelect from '../TitleStyleSelect';
import { getTitleStyleClass } from '../ScoreboardComponents';

/**
 * Style-system revamp P1 (owner ask): the game-title-style options must render
 * IN their own style. A native <select> cannot do that, hence the custom
 * listbox — so the things worth locking down are (a) each option actually
 * carries its style class, and (b) it behaves like a listbox.
 */
const OPTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'glow', label: 'Neon Cyan' },
  { value: 'chrome', label: 'Chrome' },
  { value: 'fire', label: 'Fire' },
];

describe('TitleStyleSelect', () => {
  it('renders every option with its own title-style class, not a plain <option>', () => {
    render(<TitleStyleSelect value="default" onChange={() => {}} options={OPTIONS} />);
    fireEvent.click(screen.getByRole('combobox'));

    for (const opt of OPTIONS) {
      const styled = screen.getByRole('option', { name: opt.label }).querySelector('span')!;
      const expected = getTitleStyleClass(opt.value);
      if (expected) {
        expect(styled.className).toContain(expected);
      } else {
        // 'default' has no class — assert it did not pick up a neighbour's.
        expect(styled.className).not.toMatch(/title-/);
      }
    }
  });

  it('shows the current selection in its own style on the closed trigger', () => {
    render(<TitleStyleSelect value="fire" onChange={() => {}} options={OPTIONS} />);
    const trigger = screen.getByRole('combobox');
    expect(trigger.querySelector('span')!.className).toContain('title-fire');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('commits a click selection and closes', () => {
    const onChange = vi.fn();
    render(<TitleStyleSelect value="default" onChange={onChange} options={OPTIONS} />);

    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'Chrome' }));

    expect(onChange).toHaveBeenCalledWith('chrome');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('supports keyboard: ArrowDown opens, arrows move, Enter commits', () => {
    const onChange = vi.fn();
    render(<TitleStyleSelect value="default" onChange={onChange} options={OPTIONS} />);

    const trigger = screen.getByRole('combobox');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    // Highlight seeds from the selection (index 0) — two downs lands on 'Chrome'.
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('chrome');
  });

  it('Escape closes without committing and returns focus to the trigger', () => {
    const onChange = vi.fn();
    render(<TitleStyleSelect value="default" onChange={onChange} options={OPTIONS} />);

    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'Escape' });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes on an outside click', () => {
    render(<TitleStyleSelect value="default" onChange={() => {}} options={OPTIONS} />);
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('marks the selected option with aria-selected', () => {
    render(<TitleStyleSelect value="glow" onChange={() => {}} options={OPTIONS} />);
    fireEvent.click(screen.getByRole('combobox'));

    expect(screen.getByRole('option', { name: 'Neon Cyan' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'Fire' })).toHaveAttribute('aria-selected', 'false');
  });
});
