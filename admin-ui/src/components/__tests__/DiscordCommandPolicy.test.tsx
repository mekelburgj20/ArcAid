import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DiscordCommandPolicy, { DISCORD_COMMAND_POLICY_KEY } from '../DiscordCommandPolicy';

/**
 * E7 (v2.215.0) - Room Settings -> Discord -> Slash commands. The list comes
 * from the live bot; every control saves the one policy key instantly.
 */

vi.mock('../../lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import { api } from '../../lib/api';
const mockedGet = vi.mocked(api.get);

const ROLE = '4000000000000000001';
const CHANNEL = '3000000000000000001';

function routeGets() {
  mockedGet.mockImplementation((url: string) => {
    if (url.endsWith('/admin/discord/commands')) {
      return Promise.resolve({ commands: [
        { name: 'list-active', description: 'Show the active games' },
        { name: 'pick-game', description: 'Pick the next table' },
      ] });
    }
    if (url.endsWith('/admin/discord/channels')) return Promise.resolve({ channels: [{ id: CHANNEL, name: 'scores', parent: null }] });
    if (url.endsWith('/admin/discord/roles')) return Promise.resolve({ roles: [{ id: ROLE, name: 'Players', position: 1, managed: false }] });
    return Promise.resolve({});
  });
}

describe('DiscordCommandPolicy', () => {
  beforeEach(() => {
    mockedGet.mockReset();
    routeGets();
  });

  it('renders one row per command from the endpoint', async () => {
    render(<DiscordCommandPolicy roomId="r1" settings={{}} onSaveNow={vi.fn()} />);
    expect(await screen.findByText('/list-active')).toBeInTheDocument();
    expect(screen.getByText('/pick-game')).toBeInTheDocument();
    expect(screen.getByText('Show the active games')).toBeInTheDocument();
    expect(screen.getAllByText('Using defaults').length).toBe(4);
  });

  it('toggling a command off saves the policy JSON at once', async () => {
    const onSaveNow = vi.fn();
    render(<DiscordCommandPolicy roomId="r1" settings={{}} onSaveNow={onSaveNow} />);
    const toggle = await screen.findByRole('switch', { name: 'Answer /pick-game' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    expect(onSaveNow).toHaveBeenCalledTimes(1);
    const patch = onSaveNow.mock.calls[0][0] as Record<string, string>;
    expect(JSON.parse(patch[DISCORD_COMMAND_POLICY_KEY])).toEqual({
      version: 1,
      defaults: { channelIds: [], roleIds: [] },
      commands: { 'pick-game': { enabled: false, channelIds: [], roleIds: [] } },
    });
  });

  it('turning the last restriction back on clears the key', async () => {
    const onSaveNow = vi.fn();
    const stored = JSON.stringify({ version: 1, defaults: { channelIds: [], roleIds: [] }, commands: { 'pick-game': { enabled: false, channelIds: [], roleIds: [] } } });
    render(<DiscordCommandPolicy roomId="r1" settings={{ [DISCORD_COMMAND_POLICY_KEY]: stored }} onSaveNow={onSaveNow} />);
    const toggle = await screen.findByRole('switch', { name: 'Answer /pick-game' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    expect(onSaveNow).toHaveBeenCalledWith({ [DISCORD_COMMAND_POLICY_KEY]: '' });
  });

  it('picking a default role saves it and shows its name, never the id', async () => {
    const onSaveNow = vi.fn();
    render(<DiscordCommandPolicy roomId="r1" settings={{}} onSaveNow={onSaveNow} />);
    await screen.findByText('/list-active');
    const defaults = screen.getByTestId('command-policy-default-roles');
    fireEvent.click(defaults.querySelector('input[type="checkbox"]')!);
    const patch = onSaveNow.mock.calls[0][0] as Record<string, string>;
    expect(JSON.parse(patch[DISCORD_COMMAND_POLICY_KEY]).defaults.roleIds).toEqual([ROLE]);
  });

  it('degrades to the server message when the bot is offline', async () => {
    mockedGet.mockImplementation((url: string) => {
      if (url.endsWith('/admin/discord/commands')) return Promise.resolve({ commands: [], message: "The Discord bot isn't connected right now." });
      return Promise.resolve({});
    });
    const stored = JSON.stringify({ defaults: { roleIds: [ROLE] } });
    render(<DiscordCommandPolicy roomId="r1" settings={{ [DISCORD_COMMAND_POLICY_KEY]: stored }} onSaveNow={vi.fn()} />);
    expect(await screen.findByText("The Discord bot isn't connected right now.")).toBeInTheDocument();
    expect(screen.queryByText(ROLE)).not.toBeInTheDocument();
    expect(screen.getAllByText('Unknown role').length).toBeGreaterThan(0);
  });
});
