import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import StylePicker from '../StylePicker';

/**
 * Background framing in the art-pack picker (v2.115.0, owner ask).
 *
 * The drag maths is unit-tested through `bgTransformStyle`; what this file
 * pins is the wiring a screenshot can't show — that the section only appears
 * for targets that HAVE a background to frame (never for the ranking-group
 * picker, whose endpoint takes a style id and nothing else), and that the
 * values actually leave the modal on Apply. Without the second half the
 * control looks like it works and silently saves nothing.
 */

const STYLES = [
  { id: 'style-bg', name: 'Neon Wall', author: 'Tester', has_background: 1, has_header: 1, source: 'custom' },
  { id: 'style-hdr', name: 'Logo Only', author: 'Tester', has_background: 0, has_header: 1, source: 'custom' },
];

function stubFetch() {
  const fetchMock = vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ styles: STYLES, total: STYLES.length }) }),
  );
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

async function renderPicker(props: Partial<React.ComponentProps<typeof StylePicker>> = {}) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <StylePicker currentStyleId="style-bg" onSelect={onSelect} onClose={onClose} {...props} />,
  );
  await waitFor(() => expect(screen.getByText('Neon Wall')).toBeInTheDocument());
  return { ...utils, onSelect, onClose };
}

describe('StylePicker — background framing', () => {
  beforeEach(() => { stubFetch(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('stays hidden for targets that do not opt in (e.g. ranking groups)', async () => {
    await renderPicker();
    expect(screen.queryByText('Background framing')).not.toBeInTheDocument();
  });

  it('stays hidden when the selection has no background image at all', async () => {
    await renderPicker({ showFraming: true, currentStyleId: 'style-hdr' });
    expect(screen.queryByText('Background framing')).not.toBeInTheDocument();
  });

  it('appears — with a preview — once there is a background to frame', async () => {
    await renderPicker({ showFraming: true });
    expect(screen.getByText('Background framing')).toBeInTheDocument();
    const preview = screen.getByTestId('framing-preview').firstElementChild as HTMLElement;
    expect(preview.style.backgroundImage).toContain('/api/styles/images/backgrounds/style-bg.png');
  });

  it('falls back to the catalogue art when the style carries no background', async () => {
    await renderPicker({ showFraming: true, currentStyleId: 'style-hdr', fallbackBgUrl: 'https://cdn/mm.png' });
    const preview = screen.getByTestId('framing-preview').firstElementChild as HTMLElement;
    expect(preview.style.backgroundImage).toContain('https://cdn/mm.png');
  });

  it('prefills from the stored framing and hands the current values to onSelect', async () => {
    const { onSelect } = await renderPicker({ showFraming: true, bgZoom: 180, bgPosX: 25, bgPosY: 70 });

    const zoom = screen.getByLabelText('Background zoom') as HTMLInputElement;
    expect(zoom.value).toBe('180');
    fireEvent.change(zoom, { target: { value: '220' } });

    fireEvent.click(screen.getByText('Apply Style'));
    expect(onSelect).toHaveBeenCalledWith('style-bg', false, undefined, undefined, {
      bgZoom: 220, bgPosX: 25, bgPosY: 70,
    });
  });

  it('resets framing back to the unzoomed, centred default', async () => {
    const { onSelect } = await renderPicker({ showFraming: true, bgZoom: 180, bgPosX: 25, bgPosY: 70 });

    fireEvent.click(screen.getByText('Reset framing'));
    expect((screen.getByLabelText('Background zoom') as HTMLInputElement).value).toBe('100');

    fireEvent.click(screen.getByText('Apply Style'));
    expect(onSelect).toHaveBeenCalledWith('style-bg', false, undefined, undefined, {
      bgZoom: 100, bgPosX: 50, bgPosY: 50,
    });
  });

  it('sends no framing at all when the picker was opened without it', async () => {
    const { onSelect } = await renderPicker();
    fireEvent.click(screen.getByText('Apply Style'));
    expect(onSelect).toHaveBeenCalledWith('style-bg', false, undefined, undefined, undefined);
  });
});
