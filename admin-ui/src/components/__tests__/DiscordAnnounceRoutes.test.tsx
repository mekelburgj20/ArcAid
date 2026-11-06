import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import DiscordAnnounceRoutes, { DISCORD_ANNOUNCE_ROUTES_KEY } from '../DiscordAnnounceRoutes';

/**
 * E8 (v2.221.0) - Room Settings -> Discord -> Announcement channels. Three
 * kinds, one select each; a change saves the one routes key instantly.
 */

vi.mock('../../lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import { api } from '../../lib/api';
const mockedGet = vi.mocked(api.get);

const TOURNEYS = '3000000000000000001';
const POLLS_FORUM = '3000000000000000002';
const TALK = '3000000000000000003';

beforeEach(() => {
  mockedGet.mockReset();
  mockedGet.mockImplementation((url: string) => {
    if (url.endsWith('/admin/discord/channels?forums=1')) {
      return Promise.resolve({ channels: [
        { id: TOURNEYS, name: 'lu-tourneys', parent: 'LU HUB', type: 'text' },
        { id: POLLS_FORUM, name: 'lu-polls', parent: 'LU HUB', type: 'forum' },
        { id: TALK, name: 'lu-tourney-talk', parent: 'LU HUB', type: 'text' },
      ] });
    }
    return Promise.resolve({});
  });
});

describe('DiscordAnnounceRoutes', () => {
  it('renders three selects, each starting on the room default, with forums labelled', async () => {
    render(<DiscordAnnounceRoutes roomId="r1" settings={{}} onSaveNow={vi.fn()} />);
    const tournament = screen.getByLabelText('Tournament posts') as HTMLSelectElement;
    const picks = screen.getByLabelText('Pick prompts and warnings') as HTMLSelectElement;
    const polls = screen.getByLabelText('Polls') as HTMLSelectElement;
    for (const s of [tournament, picks, polls]) expect(s.value).toBe('');
    expect(await within(polls).findByRole('option', { name: '#lu-polls (forum)' })).toBeInTheDocument();
    expect(within(polls).getAllByRole('option')[0]).toHaveTextContent('Room default channel');
    expect(screen.getByText('A forum gets a new post per poll, titled with the poll question.')).toBeInTheDocument();
    expect(mockedGet).toHaveBeenCalledWith('/rooms/r1/admin/discord/channels?forums=1');
  });

  it('a change saves the routes JSON at once', async () => {
    const onSaveNow = vi.fn();
    render(<DiscordAnnounceRoutes roomId="r1" settings={{}} onSaveNow={onSaveNow} />);
    const polls = screen.getByLabelText('Polls');
    await within(polls).findByRole('option', { name: '#lu-polls (forum)' });
    fireEvent.change(polls, { target: { value: POLLS_FORUM } });
    expect(onSaveNow).toHaveBeenCalledTimes(1);
    const patch = onSaveNow.mock.calls[0][0] as Record<string, string>;
    expect(JSON.parse(patch[DISCORD_ANNOUNCE_ROUTES_KEY])).toEqual({ version: 1, routes: { polls: POLLS_FORUM } });
  });

  it('keeps the other routes, and back to Room default removes the key', async () => {
    const onSaveNow = vi.fn();
    const stored = JSON.stringify({ version: 1, routes: { tournament: TOURNEYS, polls: POLLS_FORUM } });
    const { rerender } = render(
      <DiscordAnnounceRoutes roomId="r1" settings={{ [DISCORD_ANNOUNCE_ROUTES_KEY]: stored }} onSaveNow={onSaveNow} />,
    );
    const picks = screen.getByLabelText('Pick prompts and warnings');
    await within(picks).findByRole('option', { name: '#lu-tourney-talk' });
    expect((screen.getByLabelText('Tournament posts') as HTMLSelectElement).value).toBe(TOURNEYS);
    fireEvent.change(picks, { target: { value: TALK } });
    expect(JSON.parse((onSaveNow.mock.calls[0][0] as Record<string, string>)[DISCORD_ANNOUNCE_ROUTES_KEY]))
      .toEqual({ version: 1, routes: { tournament: TOURNEYS, picks: TALK, polls: POLLS_FORUM } });

    const onlyTournament = JSON.stringify({ version: 1, routes: { tournament: TOURNEYS } });
    rerender(<DiscordAnnounceRoutes roomId="r1" settings={{ [DISCORD_ANNOUNCE_ROUTES_KEY]: onlyTournament }} onSaveNow={onSaveNow} />);
    fireEvent.change(screen.getByLabelText('Tournament posts'), { target: { value: '' } });
    expect(onSaveNow).toHaveBeenLastCalledWith({ [DISCORD_ANNOUNCE_ROUTES_KEY]: '' });
  });
});
