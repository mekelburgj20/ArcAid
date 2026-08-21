import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import CalloutsCard from '../../components/CalloutsCard';
import { ToastProvider } from '../../components/Toast';
import { parseCalloutsJson } from '../../lib/callouts';

/**
 * v2.123.0 — the super-admin Callouts card on /admin/settings.
 *
 * The card replaced a git-tracked `data/callouts.json`, so the upload path is
 * the one that matters: parse → preview → confirm → PUT. Covered here plus the
 * counts header and the per-row enable/disable. The inline editor's PATCH
 * plumbing is the same `api.patch` call as the toggle, so only the toggle is
 * pinned.
 */

const SAMPLE = [
  { triggers: ['seafood', 'milk'], responses: ['MEOW MEOW MEOW MEOW!'] },
  { triggers: ['addams family', 'taf', '!tafl'], responses: ['THIIIING!', 'The Mamushka!'] },
];

/** Same list plus a live-data entry (the "what's the table today?" ask). */
const WITH_ACTION = [
  ...SAMPLE,
  { triggers: ['what table', 'table today'], action: 'active_games' as const },
];

type FetchArgs = [url: string, init?: RequestInit];

function stubFetch(entries: ReadonlyArray<{
  triggers: string[]; responses?: string[]; action?: string;
}> = SAMPLE) {
  const rows = entries.map((e, i) => ({
    id: i + 1,
    triggers: e.triggers,
    responses: (e as { responses?: string[] }).responses ?? [],
    action: (e as { action?: string }).action ?? null,
    enabled: true,
    sort_order: i,
    created_at: '2026-08-21',
    updated_at: '2026-08-21',
  }));
  const counts = {
    total: rows.length,
    enabled: rows.length,
    disabled: 0,
    responses: rows.reduce((n, r) => n + r.responses.length, 0),
    actions: rows.filter(r => r.action !== null).length,
  };
  const fetchMock = vi.fn((...args: FetchArgs) => {
    const [url, init] = args;
    const method = (init?.method || 'GET').toUpperCase();
    const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (url.includes('/admin/callouts') && method === 'GET') return j({ entries: rows, counts });
    if (url.includes('/admin/callouts') && method === 'PUT') return j({ success: true, counts });
    if (url.includes('/admin/callouts') && method === 'PATCH') return j(rows[0]);
    if (url.includes('/admin/callouts') && method === 'DELETE') return j({ success: true });
    return j({});
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderCard() {
  return render(<ToastProvider><CalloutsCard /></ToastProvider>);
}

/** Drives the file input the way a real upload does. */
function uploadJson(text: string, name = 'callouts.json') {
  const input = screen.getByLabelText('Callouts JSON file') as HTMLInputElement;
  const file = new File([text], name, { type: 'application/json' });
  fireEvent.change(input, { target: { files: [file] } });
}

function lastCall(fetchMock: ReturnType<typeof stubFetch>, method: string): FetchArgs | undefined {
  return fetchMock.mock.calls.find(
    (c: FetchArgs) => (c[1]?.method || 'GET').toUpperCase() === method,
  ) as FetchArgs | undefined;
}

describe('CalloutsCard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('renders the entry / enabled / disabled / response counts', async () => {
    stubFetch();
    renderCard();

    const counts = await screen.findByTestId('callout-counts');
    expect(counts).toHaveTextContent('2 entries');
    expect(counts).toHaveTextContent('2 enabled');
    expect(counts).toHaveTextContent('0 disabled');
    expect(counts).toHaveTextContent('3 responses');
    expect(counts).toHaveTextContent('0 live answers');
  });

  it('counts the live-data entries separately', async () => {
    stubFetch(WITH_ACTION);
    renderCard();

    const counts = await screen.findByTestId('callout-counts');
    expect(counts).toHaveTextContent('3 entries');
    expect(counts).toHaveTextContent('1 live answers');
  });

  it('badges a live-data entry instead of listing responses', async () => {
    stubFetch(WITH_ACTION);
    renderCard();

    const badge = await screen.findByTestId('callout-action-badge');
    expect(badge).toHaveTextContent("Live answer: What's active now (live)");
    expect(screen.getByText('Rendered from live room data')).toBeInTheDocument();
  });

  it('the editor offers the four actions and PATCHes the chosen one', async () => {
    const fetchMock = stubFetch(WITH_ACTION);
    renderCard();
    await waitFor(() => expect(screen.getAllByTestId('callout-row').length).toBe(3));

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    const select = screen.getByLabelText(/Live answer/) as HTMLSelectElement;
    expect(Array.from(select.options).map(o => o.value))
      .toEqual(['', 'active_games', 'picks_link', 'scores_link', 'how_to_submit']);

    fireEvent.change(select, { target: { value: 'picks_link' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(lastCall(fetchMock, 'PATCH')).toBeDefined());
    expect(JSON.parse(lastCall(fetchMock, 'PATCH')![1]!.body as string).action).toBe('picks_link');
  });

  it('the editor can clear an action back to a static entry', async () => {
    const fetchMock = stubFetch(WITH_ACTION);
    renderCard();
    await waitFor(() => expect(screen.getAllByTestId('callout-row').length).toBe(3));

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[2]);
    const select = screen.getByLabelText(/Live answer/) as HTMLSelectElement;
    expect(select.value).toBe('active_games');

    fireEvent.change(select, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(lastCall(fetchMock, 'PATCH')).toBeDefined());
    expect(JSON.parse(lastCall(fetchMock, 'PATCH')![1]!.body as string).action).toBeNull();
  });

  it('lists each entry as trigger chips with its responses', async () => {
    stubFetch();
    renderCard();

    await waitFor(() => expect(screen.getAllByTestId('callout-row').length).toBe(2));
    expect(screen.getByText('seafood')).toBeInTheDocument();
    expect(screen.getByText('!tafl')).toBeInTheDocument();
    expect(screen.getByText('THIIIING! · The Mamushka!')).toBeInTheDocument();
  });

  it('upload preview reports the entry and response counts', async () => {
    stubFetch();
    renderCard();
    await screen.findByTestId('callout-counts');

    uploadJson(JSON.stringify(SAMPLE), 'my-callouts.json');

    const preview = await screen.findByTestId('callout-upload-preview');
    expect(preview).toHaveTextContent('my-callouts.json: 2 entries, 3 responses');
    expect(screen.getByRole('button', { name: 'Replace list' })).not.toBeDisabled();
  });

  it('upload preview reports the first validation error with its index', async () => {
    stubFetch();
    renderCard();
    await screen.findByTestId('callout-counts');

    uploadJson(JSON.stringify([
      { triggers: ['ok'], responses: ['fine'] },
      { triggers: ['ok'], responses: [] },
    ]));

    const preview = await screen.findByTestId('callout-upload-preview');
    expect(preview).toHaveTextContent('entry 1: responses must be a non-empty array');
    expect(screen.getByRole('button', { name: 'Replace list' })).toBeDisabled();
  });

  it('upload preview reports a JSON syntax error', async () => {
    stubFetch();
    renderCard();
    await screen.findByTestId('callout-counts');

    uploadJson('{ not json');

    expect(await screen.findByTestId('callout-upload-preview')).toHaveTextContent('Not valid JSON');
    expect(screen.getByRole('button', { name: 'Replace list' })).toBeDisabled();
  });

  it('Replace confirms, then PUTs the parsed list', async () => {
    const fetchMock = stubFetch();
    renderCard();
    await screen.findByTestId('callout-counts');

    uploadJson(JSON.stringify(SAMPLE));
    await screen.findByTestId('callout-upload-preview');

    fireEvent.click(screen.getByRole('button', { name: 'Replace list' }));
    // Nothing goes out until the ConfirmModal is accepted.
    expect(lastCall(fetchMock, 'PUT')).toBeUndefined();
    expect(screen.getByRole('dialog')).toHaveTextContent('Replace the callout list?');

    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));

    await waitFor(() => expect(lastCall(fetchMock, 'PUT')).toBeDefined());
    const [url, init] = lastCall(fetchMock, 'PUT')!;
    expect(url).toContain('/admin/callouts');
    expect(JSON.parse(init!.body as string)).toEqual({ entries: SAMPLE });
  });

  it('cancelling the confirm sends nothing', async () => {
    const fetchMock = stubFetch();
    renderCard();
    await screen.findByTestId('callout-counts');

    uploadJson(JSON.stringify(SAMPLE));
    await screen.findByTestId('callout-upload-preview');
    fireEvent.click(screen.getByRole('button', { name: 'Replace list' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(lastCall(fetchMock, 'PUT')).toBeUndefined();
  });

  it('the per-row switch PATCHes enabled', async () => {
    const fetchMock = stubFetch();
    renderCard();
    await waitFor(() => expect(screen.getAllByTestId('callout-row').length).toBe(2));

    fireEvent.click(screen.getAllByRole('button', { name: 'Disable callout' })[0]);

    await waitFor(() => expect(lastCall(fetchMock, 'PATCH')).toBeDefined());
    const [url, init] = lastCall(fetchMock, 'PATCH')!;
    expect(url).toContain('/admin/callouts/1');
    expect(JSON.parse(init!.body as string)).toEqual({ enabled: false });
  });
});

/**
 * The FE validator is a deliberate mirror of the backend's
 * `validateCalloutEntries` — same rules, same error strings — so the upload
 * preview can be useful before the network round-trip. These lock the mirror.
 */
describe('parseCalloutsJson', () => {
  it('accepts and trims a valid list', () => {
    expect(parseCalloutsJson(JSON.stringify([{ triggers: ['  taf '], responses: [' Thing! '] }])))
      .toEqual({ ok: true, entries: [{ triggers: ['taf'], responses: ['Thing!'] }], responseCount: 1 });
  });

  it('rejects a non-array top level', () => {
    const result = parseCalloutsJson('{"triggers":["a"],"responses":["b"]}');
    expect(result).toEqual({ ok: false, error: 'Expected a JSON array of callout entries' });
  });

  it('rejects an exclusion-only entry', () => {
    const result = parseCalloutsJson(JSON.stringify([{ triggers: ['!got'], responses: ['x'] }]));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/not an exclusion/);
  });

  it('preserves enabled:false so a download/upload round-trip is lossless', () => {
    const input = [{ triggers: ['a'], responses: ['b'], enabled: false }];
    const result = parseCalloutsJson(JSON.stringify(input));
    expect(result.ok && result.entries).toEqual(input);
  });

  it('accepts an action entry with no responses, and round-trips it', () => {
    const input = [{ triggers: ['what table'], action: 'active_games' }];
    const result = parseCalloutsJson(JSON.stringify(input));
    expect(result.ok && result.entries).toEqual(input);
  });

  it('rejects an entry with neither responses nor action', () => {
    const result = parseCalloutsJson(JSON.stringify([{ triggers: ['what table'] }]));
    expect(result).toEqual({ ok: false, error: 'entry 0: responses must be a non-empty array' });
  });

  it('rejects an unknown action', () => {
    const result = parseCalloutsJson(JSON.stringify([{ triggers: ['x'], action: 'nope' }]));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/action must be one of/);
  });
});
