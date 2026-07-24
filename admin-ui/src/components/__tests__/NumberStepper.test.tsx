import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { NumberStepper } from '../TournamentForm';

// v2.34.1 — draft-state fix: pre-fix, `onChange(parseInt(e.target.value) || 0)`
// snapped the field back to `min` on every keystroke, so clearing the field to
// type a new number (e.g. Select-All + "45") was impossible — the field never
// went empty. NumberStepper now holds a local draft string while editing and
// only commits (clamped) on blur.
function ControlledStepper({ initial, min = 0, onChange }: { initial: number; min?: number; onChange?: (v: number) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <NumberStepper
      value={value}
      min={min}
      onChange={v => {
        setValue(v);
        onChange?.(v);
      }}
    />
  );
}

describe('NumberStepper', () => {
  it('does not force min into the input while the field is cleared', () => {
    render(<ControlledStepper initial={5} min={0} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
  });

  it('reverts to the prior valid value on blur after clearing', () => {
    render(<ControlledStepper initial={5} min={0} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(input.value).toBe('5');
  });

  it('propagates the clamped value live while typing a valid number', () => {
    const onChange = vi.fn();
    render(<ControlledStepper initial={5} min={1} onChange={onChange} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.change(input, { target: { value: '45' } });
    expect(onChange).toHaveBeenLastCalledWith(45);
    expect(input.value).toBe('45');
  });

  it('clamps a below-min typed value on blur commit', () => {
    render(<ControlledStepper initial={5} min={3} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    // A value below min doesn't clamp live in this implementation's typing
    // path only insofar as parity with prior behavior isn't required; the
    // authoritative clamp point is blur/commit and the +/- buttons.
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.blur(input);
    expect(input.value).toBe('3');
  });

  it('increments and decrements via the +/- buttons, clamped to min', () => {
    render(<ControlledStepper initial={1} min={1} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    const [minusBtn, plusBtn] = screen.getAllByRole('button');
    fireEvent.click(plusBtn);
    expect(input.value).toBe('2');
    fireEvent.click(minusBtn);
    fireEvent.click(minusBtn);
    expect(input.value).toBe('1'); // clamped at min, doesn't go to 0
  });

  it('clears an in-progress draft when the +/- buttons are clicked', () => {
    render(<ControlledStepper initial={5} min={0} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    const [, plusBtn] = screen.getAllByRole('button');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(plusBtn);
    expect(input.value).toBe('6');
  });
});
