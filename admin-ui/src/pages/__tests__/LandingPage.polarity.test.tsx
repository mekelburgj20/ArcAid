import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import LandingPage from '../LandingPage';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { ThemeProvider } from '../../components/ThemeProvider';

// B (v2.56.0) — landing-page light mode. The hero, the rotating score tiles
// and the motto were all inline-styled dark and consumed none of the token
// system, so the page never followed A1's light polarity. These tests lock in
// the three fixes: a polarity-swapped hero, token-driven ticker tiles with no
// literal rgba() left, and a motto colour that resolves differently per
// polarity (and clears WCAG AA on the light canvas).

const RECENT_SCORES = [
  {
    id: 'rs-1',
    score: 12345678,
    iscored_username: 'Player One',
    player_display_name: null,
    submitted_at: new Date().toISOString(),
    discord_user_id: '100000000000000001',
    global_game_id: 'gg-1',
    game_name: 'Medieval Madness',
    display_name: null,
    local_image_path: null,
    wheel_image_path: null,
    image_url: null,
    avatar_hash: null,
    avatar_url: null,
  },
];

function mockFetch() {
  const fetchMock = vi.fn((url: string) => {
    if (url.startsWith('/api/global/recent-scores')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(RECENT_SCORES) });
    }
    if (url.startsWith('/api/rooms')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderLanding() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <ThemeProvider>
        <ViewerAuthProvider>
          <LandingPage />
        </ViewerAuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

/** The visitor's explicit global-page polarity choice (ThemeProvider). */
function setPolarity(polarity: 'light' | 'dark') {
  localStorage.setItem('arcaid-global-theme', polarity);
}

describe('LandingPage — light/dark polarity (v2.56.0)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    mockFetch();
  });

  // v2.60.0 — both polarities now render the animated mark. The light branch
  // used to be a static PNG because the logo pack had shipped no animated
  // light source; `ArcaidLogoAnimated`'s `light` variant is that source.
  describe('B2 — hero mark', () => {
    it('dark polarity renders the animated mark in its dark variant', async () => {
      setPolarity('dark');
      const { container } = renderLanding();

      await waitFor(() => expect(screen.getByTestId('landing-motto')).toBeInTheDocument());
      expect(container.querySelector('.arcaid-logo-wrap.arcaid-logo-dark')).toBeTruthy();
      expect(container.querySelector('.arcaid-logo-plate')).toBeNull();
    });

    it('light polarity renders the animated mark in its light variant', async () => {
      setPolarity('light');
      const { container } = renderLanding();

      await waitFor(() => expect(screen.getByTestId('landing-motto')).toBeInTheDocument());
      const wrap = container.querySelector('.arcaid-logo-wrap.arcaid-logo-light');
      expect(wrap).toBeTruthy();
      // The purple backdrop plate is the light composition's tell.
      expect(container.querySelector('.arcaid-logo-plate')).toBeTruthy();
    });

    it('reserves the same layout box in both polarities, so the motto anchor holds', async () => {
      const boxes: string[] = [];
      for (const polarity of ['dark', 'light'] as const) {
        localStorage.clear();
        setPolarity(polarity);
        const view = renderLanding();
        await waitFor(() => expect(screen.getByTestId('landing-motto')).toBeInTheDocument());
        const wrap = view.container.querySelector('.arcaid-logo-wrap') as HTMLElement;
        boxes.push(`${wrap.style.maxWidth}`);
        view.unmount();
      }
      expect(boxes[0]).toBe('680px');
      expect(boxes[1]).toBe(boxes[0]);
    });
  });

  describe('B1 — score ticker tiles', () => {
    it('renders no literal rgba() anywhere in the ticker band or its tiles', async () => {
      setPolarity('light');
      renderLanding();

      const band = await screen.findByTestId('landing-ticker-band');
      const cards = await screen.findAllByTestId('landing-ticker-card');
      expect(cards.length).toBeGreaterThan(0);

      const styled = [band, ...cards.flatMap(c => [c, ...Array.from(c.querySelectorAll('[style]'))])];
      for (const el of styled) {
        expect(el.getAttribute('style') ?? '').not.toMatch(/rgba?\(/);
      }
    });

    it('drives the tile surface, border and shadow from --sb-ticker-* tokens', async () => {
      setPolarity('dark');
      renderLanding();

      const card = (await screen.findAllByTestId('landing-ticker-card'))[0] as HTMLElement;
      const style = card.getAttribute('style') ?? '';
      expect(style).toContain('var(--sb-ticker-card-bg)');
      expect(style).toContain('var(--sb-ticker-card-border)');
      expect(style).toContain('var(--sb-ticker-card-shadow)');
    });

    it('uses the shared PlayerAvatar rather than a local initials chip', async () => {
      setPolarity('dark');
      renderLanding();

      const card = (await screen.findAllByTestId('landing-ticker-card'))[0] as HTMLElement;
      // PlayerAvatar renders an <img alt={username}> for a resolvable avatar and
      // a Tailwind-classed chip otherwise — either way it is class-driven, so no
      // inline background survives on the avatar node.
      const avatar = card.querySelector('.rounded-full');
      expect(avatar).toBeTruthy();
      expect(avatar!.getAttribute('style') ?? '').not.toMatch(/background/);
    });
  });

  describe('B3 — motto colour', () => {
    it('reads its colour and shadow from tokens, in both polarities', async () => {
      for (const polarity of ['dark', 'light'] as const) {
        localStorage.clear();
        setPolarity(polarity);
        const view = renderLanding();
        const motto = await screen.findByTestId('landing-motto');
        const style = motto.getAttribute('style') ?? '';
        expect(style).toContain('var(--sb-motto-fg)');
        expect(style).toContain('var(--sb-motto-shadow)');
        expect(style).not.toMatch(/rgba?\(/);
        view.unmount();
      }
    });
  });
});

// --- Token-level guards -----------------------------------------------------
// jsdom does not evaluate index.css, so the polarity *values* are asserted
// against the stylesheet source. This is the assertion that would have caught
// the original bug: a token defined only in the dark block silently keeps its
// dark value under `.theme-light`.

// Resolved from the vitest root (admin-ui/) — `import.meta.url` is a
// transformed http:// URL under the jsdom environment, not a file:// one.
// `.replace(/\r\n/g, '\n')` — index.css is CRLF-tracked on Windows and the
// block delimiters below are matched with bare \n.
const INDEX_CSS = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
  .replace(/\r\n/g, '\n');

function tokenValue(block: string, token: string): string | null {
  const m = new RegExp(`${token}\\s*:\\s*([^;]+);`).exec(block);
  return m ? m[1].trim() : null;
}

/** `@theme { ... }` — the dark defaults. */
function darkBlock(): string {
  const start = INDEX_CSS.indexOf('@theme {');
  const end = INDEX_CSS.indexOf('\n}', start);
  return INDEX_CSS.slice(start, end);
}

/** The `.theme-light, .theme-arctic, .theme-paper, .theme-speegle { ... }` override block. */
function lightBlock(): string {
  const start = INDEX_CSS.indexOf('.theme-light,\n.theme-arctic,\n.theme-paper,\n.theme-speegle {');
  const end = INDEX_CSS.indexOf('\n}', start);
  return INDEX_CSS.slice(start, end);
}

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe('index.css — landing-page polarity tokens (v2.56.0)', () => {
  const LANDING_TOKENS = [
    '--sb-motto-fg',
    '--sb-motto-shadow',
    '--sb-ticker-band',
    '--sb-ticker-edge',
    '--sb-ticker-card-bg',
    '--sb-ticker-card-border',
    '--sb-ticker-card-shadow',
    '--sb-ticker-card-shadow-hover',
    '--sb-ticker-art-bg',
    '--sb-ticker-art-icon',
    '--sb-ticker-art-sat',
    '--sb-ticker-art-l1',
    '--sb-ticker-art-l2',
    '--sb-ticker-score-fg',
    '--sb-ticker-cta-bg',
    '--sb-ticker-cta-bg-hover',
    '--sb-ticker-cta-border',
    '--sb-ticker-cta-fg',
  ];

  it('defines every landing token in the dark defaults', () => {
    const dark = darkBlock();
    for (const token of LANDING_TOKENS) {
      expect(tokenValue(dark, token), `${token} missing from @theme`).toBeTruthy();
    }
  });

  it('overrides every landing token except the CTA foreground in light polarity', () => {
    const dark = darkBlock();
    const light = lightBlock();
    for (const token of LANDING_TOKENS) {
      const lightValue = tokenValue(light, token);
      expect(lightValue, `${token} missing from the light-polarity block`).toBeTruthy();
      if (token === '--sb-ticker-cta-fg') continue; // white text on both CTAs, deliberately identical
      expect(lightValue, `${token} must differ per polarity`).not.toBe(tokenValue(dark, token));
    }
  });

  it('keeps the dark motto exactly as it was before v2.56.0', () => {
    expect(tokenValue(darkBlock(), '--sb-motto-fg')).toBe('rgba(255, 255, 255, 0.72)');
    expect(tokenValue(darkBlock(), '--sb-motto-shadow'))
      .toBe('0 0 12px rgba(91, 200, 245, 0.35), 0 1px 6px rgba(0, 0, 0, 0.9)');
  });

  it('drops the cyan glow in light polarity', () => {
    expect(tokenValue(lightBlock(), '--sb-motto-shadow')).toBe('none');
  });

  it('clears WCAG AA (4.5:1) for the light motto on the light canvas', () => {
    // `--color-deep` under `.theme-light` is the canvas the motto sits on.
    const canvas = /--color-deep:\s*(#[0-9a-f]{6})/i.exec(INDEX_CSS.slice(INDEX_CSS.indexOf('.theme-light {')));
    expect(canvas).toBeTruthy();
    const motto = tokenValue(lightBlock(), '--sb-motto-fg')!;
    expect(motto).toMatch(/^#[0-9a-f]{6}$/i);
    const ratio = contrastRatio(motto, canvas![1]);
    // Measured 7.12:1 for #6427af on #E8EAF0 — AA needs 4.5:1.
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});
