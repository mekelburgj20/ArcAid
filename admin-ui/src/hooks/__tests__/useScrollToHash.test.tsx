import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { useScrollToHash } from '../useScrollToHash';

/**
 * A14.2 - the game pages' `#ratings` block mounts only after a fetch, so the
 * hook scrolls when `ready` flips true, and only once.
 */
function Probe({ ready }: { ready: boolean }) {
  useScrollToHash(ready);
  return ready ? <div id="ratings">ratings</div> : null;
}

describe('useScrollToHash', () => {
  const original = Element.prototype.scrollIntoView;
  let spy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    spy = vi.fn();
    Element.prototype.scrollIntoView = spy as unknown as typeof Element.prototype.scrollIntoView;
    window.history.replaceState(null, '', '/games/g1#ratings');
  });

  afterEach(() => {
    Element.prototype.scrollIntoView = original;
    window.history.replaceState(null, '', '/');
  });

  it('scrolls to the hash target once when ready flips true', () => {
    const { rerender } = render(<Probe ready={false} />);
    expect(spy).not.toHaveBeenCalled();

    rerender(<Probe ready />);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });

    rerender(<Probe ready={false} />);
    rerender(<Probe ready />);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a hash', () => {
    window.history.replaceState(null, '', '/games/g1');
    render(<Probe ready />);
    expect(spy).not.toHaveBeenCalled();
  });
});
