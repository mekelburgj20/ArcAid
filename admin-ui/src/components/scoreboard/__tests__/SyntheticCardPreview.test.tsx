import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SyntheticCardPreview, { PLACEHOLDER_ROWS, type SyntheticCardSource } from '../SyntheticCardPreview';
import { stubResizeObserver } from '../../../test/stubResizeObserver';

stubResizeObserver();

/**
 * v2.124.0 (C3) — the synthetic card the GameLibrary / Tournaments editor
 * sheet previews on.
 *
 * The whole point is that it is NOT a picture of a card: it is the room's own
 * card, rendered through the same `ScoreCardGrid` → `CardRouter` path the
 * public Scores tabs use, with only the PLAYERS faked. So the contract worth
 * pinning is that the room's config decides which card component renders (a
 * preview that always drew a Banner would be exactly the lie `StylePicker`'s
 * 128px strip told), and that the live edit overlay reaches the row.
 *
 * The four card components are mocked — the dispatch under test is
 * `CardRouter`'s, and it is real.
 */

const LB_FIELDS = [
  'gameId', 'gameName', 'imageUrl', 'catalogueStyleId', 'logoStyleId', 'bgStyleId',
  'styleHeaderDisabled', 'bgZoom', 'bgPosX', 'bgPosY', 'catHasBg', 'catHasHeader',
] as const;

function cardMock(testid: string) {
  return {
    default: (props: { lb: Record<string, unknown> }) => (
      <div
        data-testid={testid}
        data-lb={JSON.stringify(Object.fromEntries(LB_FIELDS.map(k => [k, props.lb[k] ?? null])))}
        data-rows={JSON.stringify(
          (props.lb.rankings as { iscored_username: string }[]).map(r => r.iscored_username),
        )}
      />
    ),
  };
}

vi.mock('../BannerCard', () => cardMock('banner-card'));
vi.mock('../ArcadeCard', () => cardMock('arcade-card'));
vi.mock('../ShowcaseCard', () => cardMock('showcase-card'));
vi.mock('../MinimalCard', () => cardMock('minimal-card'));

const ROOM_ID = 'room-1';

const SOURCE: SyntheticCardSource = {
  gameName: 'Medieval Madness',
  displayName: null,
  imageUrl: '/api/catalogue-images/mm.png',
  catalogueStyleId: 'style-old',
  styleHeaderDisabled: false,
  bgZoom: null,
  bgPosX: null,
  bgPosY: null,
};

function renderPreview(props: Partial<React.ComponentProps<typeof SyntheticCardPreview>> = {}) {
  return render(
    <MemoryRouter>
      <SyntheticCardPreview roomId={ROOM_ID} source={SOURCE} config={{ SCOREBOARD_STYLE: 'banner' }} {...props} />
    </MemoryRouter>,
  );
}

function cardLb(testid: string): Record<string, unknown> {
  return JSON.parse(screen.getByTestId(testid).getAttribute('data-lb')!);
}

describe('SyntheticCardPreview', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('renders the ROOM’s configured card style, with the placeholder roster', () => {
    renderPreview();

    expect(screen.getByTestId('banner-card')).toBeInTheDocument();
    expect(screen.queryByTestId('arcade-card')).not.toBeInTheDocument();

    // Six deterministic rows, and not one real player among them.
    const rows = JSON.parse(screen.getByTestId('banner-card').getAttribute('data-rows')!);
    expect(rows).toHaveLength(6);
    expect(rows).toEqual(PLACEHOLDER_ROWS.map(r => r.iscored_username));
    expect(rows[0]).toBe('Player One');
  });

  it('a room on Arcade previews an Arcade card, not a Banner one', () => {
    renderPreview({ config: { SCOREBOARD_STYLE: 'arcade' } });

    expect(screen.getByTestId('arcade-card')).toBeInTheDocument();
    expect(screen.queryByTestId('banner-card')).not.toBeInTheDocument();
  });

  it('renders the source row’s own art and framing when there is no overlay', () => {
    renderPreview({ source: { ...SOURCE, bgZoom: 180, bgPosX: 25, bgPosY: 70, styleHeaderDisabled: true } });

    const lb = cardLb('banner-card');
    expect(lb.catalogueStyleId).toBe('style-old');
    expect(lb.imageUrl).toBe('/api/catalogue-images/mm.png');
    expect(lb).toMatchObject({ bgZoom: 180, bgPosX: 25, bgPosY: 70, styleHeaderDisabled: true });
    // A source that doesn't track the flags (games.catalogue_style_id has no
    // companion columns) is assumed to carry both — build trap #6 in reverse:
    // dropping them would blank art the real card draws.
    expect(lb.catHasBg).toBe(1);
    expect(lb.catHasHeader).toBe(1);
  });

  it('merges the live edit overlay — style pick AND framing — into the row', () => {
    renderPreview({
      overlay: {
        catalogueStyleId: 'style-new', catHasBg: 1, catHasHeader: 0,
        styleHeaderDisabled: true, bgZoom: 60, bgPosX: 20, bgPosY: 80,
      },
    });

    const lb = cardLb('banner-card');
    expect(lb.catalogueStyleId).toBe('style-new');
    // Trap #6: the cards gate on the flags, not the id.
    expect(lb.catHasHeader).toBe(0);
    expect(lb).toMatchObject({ styleHeaderDisabled: true, bgZoom: 60, bgPosX: 20, bgPosY: 80 });
  });

  it('fetches the room’s scoreboard-config when the host does not supply one', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve({ SCOREBOARD_STYLE: 'arcade', SCOREBOARD_CARD_BG_FILL: 'false' }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const onConfig = vi.fn();

    render(
      <MemoryRouter>
        <SyntheticCardPreview roomId={ROOM_ID} source={SOURCE} onConfig={onConfig} />
      </MemoryRouter>,
    );

    await screen.findByTestId('arcade-card');
    expect(fetchMock.mock.calls[0]![0]).toContain(`/api/rooms/${ROOM_ID}/scoreboard-config`);
    // The host needs the map back: `SCOREBOARD_CARD_BG_FILL` is what makes the
    // editor honest about framing having no visible effect.
    await waitFor(() => expect(onConfig).toHaveBeenCalledWith(
      expect.objectContaining({ SCOREBOARD_CARD_BG_FILL: 'false' }),
    ));
  });
});
