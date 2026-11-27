import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DiscordRunRecapPosts, { DISCORD_RUN_RECAPS_ENABLED_KEY } from '../DiscordRunRecapPosts';

/** B31.5 - Room Settings -> Discord -> Post run recaps to Discord. Absent = off; instant save. */

describe('DiscordRunRecapPosts', () => {
  it('starts off', () => {
    render(<DiscordRunRecapPosts settings={{}} onSaveNow={vi.fn()} />);
    expect(screen.getByRole('switch', { name: 'Post run recaps to Discord' }).getAttribute('aria-checked')).toBe('false');
  });

  it('the toggle saves the key instantly, and off removes it', () => {
    const onSaveNow = vi.fn();
    const { rerender } = render(<DiscordRunRecapPosts settings={{}} onSaveNow={onSaveNow} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Post run recaps to Discord' }));
    expect(onSaveNow).toHaveBeenLastCalledWith({ [DISCORD_RUN_RECAPS_ENABLED_KEY]: 'true' });
    rerender(<DiscordRunRecapPosts settings={{ [DISCORD_RUN_RECAPS_ENABLED_KEY]: 'true' }} onSaveNow={onSaveNow} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Post run recaps to Discord' }));
    expect(onSaveNow).toHaveBeenLastCalledWith({ [DISCORD_RUN_RECAPS_ENABLED_KEY]: '' });
  });
});
