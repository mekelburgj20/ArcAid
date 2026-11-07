import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DiscordScorePosts, { DISCORD_SCORE_POSTS_ENABLED_KEY, DISCORD_SCORE_POSTS_TOP_N_KEY } from '../DiscordScorePosts';

/**
 * E13 (v2.225.0) - Room Settings -> Discord -> Post top scores to Discord.
 * Absent = off; the toggle and Top N save instantly.
 */

describe('DiscordScorePosts', () => {
  it('starts off with the default 10 as placeholder', () => {
    render(<DiscordScorePosts settings={{}} onSaveNow={vi.fn()} />);
    const toggle = screen.getByRole('switch', { name: 'Post top scores to Discord' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    const input = screen.getByTestId('score-posts-top-n') as HTMLInputElement;
    expect(input.placeholder).toBe('10');
    expect(input.disabled).toBe(true);
  });

  it('the toggle saves the enabled key instantly, and off removes it', () => {
    const onSaveNow = vi.fn();
    const { rerender } = render(<DiscordScorePosts settings={{}} onSaveNow={onSaveNow} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Post top scores to Discord' }));
    expect(onSaveNow).toHaveBeenLastCalledWith({ [DISCORD_SCORE_POSTS_ENABLED_KEY]: 'true' });
    rerender(<DiscordScorePosts settings={{ [DISCORD_SCORE_POSTS_ENABLED_KEY]: 'true' }} onSaveNow={onSaveNow} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Post top scores to Discord' }));
    expect(onSaveNow).toHaveBeenLastCalledWith({ [DISCORD_SCORE_POSTS_ENABLED_KEY]: '' });
  });

  it('Top N commits on blur, clamped to 1-50', () => {
    const onSaveNow = vi.fn();
    render(<DiscordScorePosts settings={{ [DISCORD_SCORE_POSTS_ENABLED_KEY]: 'true' }} onSaveNow={onSaveNow} />);
    const input = screen.getByTestId('score-posts-top-n');
    fireEvent.change(input, { target: { value: '5' } });
    expect(onSaveNow).not.toHaveBeenCalled();
    fireEvent.blur(input, { target: { value: '5' } });
    expect(onSaveNow).toHaveBeenLastCalledWith({ [DISCORD_SCORE_POSTS_TOP_N_KEY]: '5' });
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSaveNow).toHaveBeenLastCalledWith({ [DISCORD_SCORE_POSTS_TOP_N_KEY]: '50' });
  });
});
