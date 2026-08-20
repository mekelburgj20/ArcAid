import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useCardReorder, moveNextTo, moveByOne } from '../useCardReorder';

/**
 * v2.118.0 — the drag handle under each admin card.
 *
 * Three things here are load-bearing and easy to break silently:
 *   1. the handle's press must NOT reach `HorizontalScrollNav`'s
 *      drag-to-scroll (a `mousedown` on the scroll wrapper), or the strip
 *      scrolls out from under the card being dragged;
 *   2. the order sent on drop is the FULL server order, not the visible
 *      cards — `hideEmpty`/search can hide cards, and a partial list would
 *      silently drop their positions;
 *   3. the keyboard path moves and announces, because a drag-only affordance
 *      is not an affordance for everyone (s20 doctrine).
 */

const NAMES: Record<string, string> = { A: 'Alpha', B: 'Bravo', C: 'Charlie', H: 'Hidden' };

function Harness({ order, visible, disabled, onReorder, onWrapperMouseDown }: {
  order: string[];
  visible?: string[];
  disabled?: boolean;
  onReorder: (next: string[]) => void;
  onWrapperMouseDown?: () => void;
}) {
  const r = useCardReorder({ order, names: NAMES, disabled, onReorder });
  const shown = visible ?? order;
  return (
    <div className="scoreboard-hscroll-nobar" data-testid="scroller" onMouseDown={onWrapperMouseDown}>
      <div className="flex">
        {shown.map(id => (
          <div key={id} className="scoreboard-card-slot" data-testid={`slot-${id}`}>
            <span>{NAMES[id]}</span>
            <button {...r.getHandleProps(id)}>grip</button>
          </div>
        ))}
      </div>
      <div data-testid="live" aria-live="polite">{r.announcement}</div>
    </div>
  );
}

/** Lays the visible slots out at 100px intervals so "nearest centre" is
 *  computable: A centred at 50, B at 150, C at 250. */
function layout(ids: string[]) {
  ids.forEach((id, i) => {
    const el = screen.getByTestId(`slot-${id}`);
    const left = i * 100;
    el.getBoundingClientRect = () => ({
      left, right: left + 100, top: 0, bottom: 100, width: 100, height: 100, x: left, y: 0, toJSON: () => ({}),
    }) as DOMRect;
  });
}

const handleFor = (id: string) => screen.getByLabelText(`Drag to reorder ${NAMES[id]}`);

function drag(id: string, toX: number) {
  const handle = handleFor(id);
  fireEvent.pointerDown(handle, { pointerId: 1, clientX: 0, clientY: 50, bubbles: true });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: toX, clientY: 50 });
  fireEvent.pointerUp(handle, { pointerId: 1, clientX: toX, clientY: 50 });
}

describe('moveNextTo / moveByOne', () => {
  it('moves an id next to its target, in either direction', () => {
    expect(moveNextTo(['A', 'B', 'C'], 'A', 'C')).toEqual(['B', 'C', 'A']);
    expect(moveNextTo(['A', 'B', 'C'], 'C', 'A')).toEqual(['C', 'A', 'B']);
    expect(moveNextTo(['A', 'B', 'C'], 'A', 'A')).toEqual(['A', 'B', 'C']);
    expect(moveNextTo(['A', 'B', 'C'], 'A', 'Z')).toEqual(['A', 'B', 'C']);
  });

  it('moves one slot and clamps at the ends', () => {
    expect(moveByOne(['A', 'B', 'C'], 'A', 1)).toEqual(['B', 'A', 'C']);
    expect(moveByOne(['A', 'B', 'C'], 'C', -1)).toEqual(['A', 'C', 'B']);
    expect(moveByOne(['A', 'B', 'C'], 'A', -1)).toEqual(['A', 'B', 'C']);
    expect(moveByOne(['A', 'B', 'C'], 'C', 1)).toEqual(['A', 'B', 'C']);
  });
});

describe('useCardReorder handle', () => {
  it('keeps the press away from HorizontalScrollNav drag-to-scroll', () => {
    const onWrapperMouseDown = vi.fn();
    render(<Harness order={['A', 'B']} onReorder={vi.fn()} onWrapperMouseDown={onWrapperMouseDown} />);

    fireEvent.mouseDown(handleFor('A'), { bubbles: true });
    expect(onWrapperMouseDown).not.toHaveBeenCalled();
  });

  it('yields the full new order on drop', () => {
    const onReorder = vi.fn();
    render(<Harness order={['A', 'B', 'C']} onReorder={onReorder} />);
    layout(['A', 'B', 'C']);

    drag('A', 250); // onto Charlie's centre
    expect(onReorder).toHaveBeenCalledWith(['B', 'C', 'A']);
  });

  it('sends the ids of cards that are not even rendered', () => {
    // 'H' is filtered out of the DOM (hide-empty / search). Its position in
    // the stored order must survive the drag.
    const onReorder = vi.fn();
    render(<Harness order={['A', 'H', 'B', 'C']} visible={['A', 'B', 'C']} onReorder={onReorder} />);
    layout(['A', 'B', 'C']);

    drag('A', 250);
    expect(onReorder).toHaveBeenCalledWith(['H', 'B', 'C', 'A']);
  });

  it('does nothing when the pointer never leaves the dragged card', () => {
    const onReorder = vi.fn();
    render(<Harness order={['A', 'B', 'C']} onReorder={onReorder} />);
    layout(['A', 'B', 'C']);

    const handle = handleFor('A');
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 0, clientY: 50 });
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 250, clientY: 50 });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('is inert and marked disabled when disabled (e.g. a search filter is active)', () => {
    const onReorder = vi.fn();
    render(<Harness order={['A', 'B', 'C']} disabled onReorder={onReorder} />);
    layout(['A', 'B', 'C']);

    expect(handleFor('A')).toBeDisabled();
    drag('A', 250);
    fireEvent.keyDown(handleFor('A'), { key: 'ArrowRight' });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('moves one slot per arrow key and announces the new position', () => {
    const onReorder = vi.fn();
    const { rerender } = render(<Harness order={['A', 'B', 'C']} onReorder={onReorder} />);

    fireEvent.keyDown(handleFor('A'), { key: 'ArrowRight' });
    expect(onReorder).toHaveBeenCalledWith(['B', 'A', 'C']);
    expect(screen.getByTestId('live')).toHaveTextContent('Alpha moved to position 2 of 3');

    rerender(<Harness order={['B', 'A', 'C']} onReorder={onReorder} />);
    fireEvent.keyDown(handleFor('A'), { key: 'ArrowLeft' });
    expect(onReorder).toHaveBeenLastCalledWith(['A', 'B', 'C']);

    // Up/Down are the same move — the cards are a grid on some layouts.
    fireEvent.keyDown(handleFor('C'), { key: 'ArrowUp' });
    expect(onReorder).toHaveBeenLastCalledWith(['B', 'C', 'A']);
    fireEvent.keyDown(handleFor('B'), { key: 'ArrowDown' });
    expect(onReorder).toHaveBeenLastCalledWith(['A', 'B', 'C']);
  });

  it('ignores keys that are not arrows', () => {
    const onReorder = vi.fn();
    render(<Harness order={['A', 'B']} onReorder={onReorder} />);
    fireEvent.keyDown(handleFor('A'), { key: 'Enter' });
    fireEvent.keyDown(handleFor('A'), { key: ' ' });
    expect(onReorder).not.toHaveBeenCalled();
  });
});
