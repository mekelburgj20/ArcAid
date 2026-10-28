import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import DiscordBotInvite from '../DiscordBotInvite';

// G6 — the "add the bot to your server" box on room Settings → Discord.

type FetchArgs = [string, RequestInit?];
const INVITE = 'https://discord.com/oauth2/authorize?client_id=1&scope=bot+applications.commands&permissions=562949953539072';

function stub(opts: { url: string | null; discord?: unknown }) {
  const fetchMock = vi.fn((...args: FetchArgs) => {
    const [u] = args;
    const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (u.includes('/auth/discord/bot-invite')) {
      const g = new URL(u, 'http://x').searchParams.get('guildId');
      return j({ url: opts.url === null ? null : g ? `${opts.url}&guild_id=${g}` : opts.url });
    }
    if (u.includes('/admin/health')) return j(opts.discord === undefined ? {} : { discord: opts.discord });
    return j({});
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

afterEach(() => { vi.unstubAllGlobals(); });

const GUILD = '123456789012345678';

describe('DiscordBotInvite', () => {
  it('renders the link with the typed server pre-selected', async () => {
    stub({ url: INVITE });
    render(<DiscordBotInvite roomId="r1" guildId={GUILD} />);
    const link = await screen.findByRole('link', { name: /Add the bot to Discord/ });
    expect(link.getAttribute('href')).toContain(`guild_id=${GUILD}`);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(screen.getByText(/Setting the Guild ID does not add the bot/)).toBeInTheDocument();
  });

  it('renders nothing when the Discord application is not configured', async () => {
    const f = stub({ url: null });
    const { container } = render(<DiscordBotInvite roomId="r1" guildId={GUILD} />);
    await waitFor(() => expect(f).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('says the bot is missing from the SAVED server', async () => {
    stub({ url: INVITE, discord: { enabled: true, ready: true, inGuild: false, guildId: GUILD } });
    render(<DiscordBotInvite roomId="r1" guildId={GUILD} />);
    expect(await screen.findByText('The bot is not in this server yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Check again/ })).toBeInTheDocument();
  });

  it('says the bot is in the saved server', async () => {
    stub({ url: INVITE, discord: { enabled: true, ready: true, inGuild: true, guildId: GUILD } });
    render(<DiscordBotInvite roomId="r1" guildId={GUILD} />);
    expect(await screen.findByText('The bot is in this server.')).toBeInTheDocument();
  });

  it('claims nothing about an unsaved Guild ID or an offline bot', async () => {
    stub({ url: INVITE, discord: { enabled: true, ready: true, inGuild: true, guildId: '999999999999999999' } });
    const { unmount } = render(<DiscordBotInvite roomId="r1" guildId={GUILD} />);
    await screen.findByRole('link', { name: /Add the bot to Discord/ });
    expect(screen.queryByRole('status')).toBeNull();
    unmount();

    stub({ url: INVITE, discord: { enabled: true, ready: false, inGuild: null, guildId: GUILD } });
    render(<DiscordBotInvite roomId="r1" guildId={GUILD} />);
    await screen.findByRole('link', { name: /Add the bot to Discord/ });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
