import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SubmissionSheet, { type SubmissionTarget } from '../SubmissionSheet';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import * as photoNormalize from '../../lib/photoNormalize';

/**
 * SubmissionSheet — engine/device derivation + remembered-device restore.
 *
 * Covers only the picker-derivation surface (engine/device option lists,
 * auto-lock, and the `arcaid_last_device` restore). Submit flows, drafts and
 * photo upload are deliberately out of scope for this pass — the picker
 * derivation is where the v2.95.1 regression lived and is the part most
 * likely to silently drift again (see `lib/allowedProvenance.ts`'s own doc
 * comment on why the derivation must never fork).
 *
 * Harness notes:
 *   - SubmissionSheet reads `useViewerAuth()`, so it needs `ViewerAuthProvider`
 *     mounted above it; `signIn()` seeds the same localStorage keys
 *     ViewerAuthContext reads on mount (`arcaid_player_token`/`_user`) —
 *     mirrors the idiom in `pages/__tests__/PicksAlertStates.test.tsx`. A
 *     signed-in viewer is required or the sheet renders the `loginRequired`
 *     phase instead of the form.
 *   - It also renders inside a `role="dialog"`/`<Link>`, hence `MemoryRouter`.
 *   - The only network call the derivation surface makes is
 *     `GET /api/submit/platforms?...`; `renderSheet` stubs it with a
 *     configurable response built by `platformsPayload()`, which mirrors the
 *     exact shape `parseSubmitPlatformsResponse` (lib/allowedProvenance.ts)
 *     expects: `{ platforms, submittable, features, tournamentRules }`.
 */

function b64url(obj: object): string {
    return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fakeJwt(payload: object): string {
    return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}
function signIn(discordId = '111111111111111111', username = 'Tester') {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    localStorage.setItem('arcaid_player_token', fakeJwt({ discordId, username, avatar: null, exp }));
    localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username, avatar: null }));
}

interface PlatformsPayloadOpts {
    /** Full game platform set before tournament rules; defaults to `submittable`. */
    platforms?: string[];
    submittable?: string[];
    features?: string[];
    excludedEngines?: string[];
    excludedDevices?: string[];
}

/** Builds a `GET /api/submit/platforms` response body. */
function platformsPayload(opts: PlatformsPayloadOpts) {
    const { platforms, submittable = [], features = [], excludedEngines = [], excludedDevices = [] } = opts;
    return {
        platforms: platforms ?? submittable,
        submittable,
        features,
        tournamentRules: {
            engines: { required: [], excluded: excludedEngines },
            devices: { required: [], excluded: excludedDevices },
        },
    };
}

interface RenderOpts {
    target?: Partial<SubmissionTarget>;
    /** Response body for `/api/submit/platforms`. Omit `fail` to succeed with this body. */
    platformsResponse?: object;
    /** When true, the platforms fetch rejects (simulates a network failure). */
    fail?: boolean;
}

function renderSheet(opts: RenderOpts = {}) {
    const target: SubmissionTarget = {
        kind: 'tournament',
        roomId: 'room-1',
        gameName: 'Attack from Mars',
        ...opts.target,
    } as SubmissionTarget;

    const fetchMock = vi.fn((url: string) => {
        if (url.startsWith('/api/submit/platforms')) {
            if (opts.fail) return Promise.reject(new Error('network failure'));
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve(opts.platformsResponse ?? {}),
            });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const rendered = render(
        <MemoryRouter>
            <ViewerAuthProvider>
                <SubmissionSheet target={target} onClose={() => {}} roomSlug="room-1" />
            </ViewerAuthProvider>
        </MemoryRouter>,
    );
    return { ...rendered, fetchMock };
}

describe('SubmissionSheet — engine/device derivation', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
    });

    it('v2.95.1 regression: a remembered device the tournament EXCLUDES is not shown or held', async () => {
        signIn();
        localStorage.setItem('arcaid_last_device', 'atgames');
        renderSheet({
            platformsResponse: platformsPayload({
                submittable: ['vpx'],
                excludedDevices: ['atgames'],
            }),
        });

        // Engine auto-locks (single engine 'vpx') — the device <select> is the
        // only combobox left once that settles.
        await screen.findByText('Visual Pinball X');
        const select = await screen.findByRole('combobox') as HTMLSelectElement;

        // The remembered value must NOT be selected — pre-fix this held
        // 'atgames' even though the option list (rightly) excludes it.
        await waitFor(() => expect(select.value).not.toBe('atgames'));
        expect(select.value).toBe('');
        expect(screen.queryByRole('option', { name: 'AtGames Cabinet' })).not.toBeInTheDocument();
        // The other, non-excluded devices are still offered.
        expect(screen.getByRole('option', { name: 'PC' })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'VR Headset' })).toBeInTheDocument();
    });

    it('restores a remembered device that IS allowed', async () => {
        signIn();
        localStorage.setItem('arcaid_last_device', 'pc');
        renderSheet({
            platformsResponse: platformsPayload({ submittable: ['vpx'] }),
        });

        await screen.findByText('Visual Pinball X');
        const select = await screen.findByRole('combobox') as HTMLSelectElement;
        await waitFor(() => expect(select.value).toBe('pc'));
    });

    it('single-engine payload auto-locks the engine to a read-only chip', async () => {
        signIn();
        renderSheet({
            platformsResponse: platformsPayload({ submittable: ['vpx'] }),
        });

        expect(await screen.findByText('Visual Pinball X')).toBeInTheDocument();
        expect(screen.getByText('(the only one for this game)')).toBeInTheDocument();
        // No engine dropdown — the chip replaces it.
        expect(screen.queryByText('Choose what you played…')).not.toBeInTheDocument();
    });

    it('single allowed device auto-selects (no dropdown needed)', async () => {
        signIn();
        // engine 'real' → ENGINE_DEVICE_COMPAT.real === ['real_cabinet'] only.
        renderSheet({
            platformsResponse: platformsPayload({ submittable: ['real'] }),
        });

        expect(await screen.findByText('Real Cabinet')).toBeInTheDocument();
        expect(screen.getByText('(the only device that runs it)')).toBeInTheDocument();
        expect(screen.queryByText('Choose the device you played on…')).not.toBeInTheDocument();
    });

    it('survives a platforms-fetch failure without crashing — empty-safe engine/device lists', async () => {
        signIn();
        renderSheet({ fail: true });

        expect(await screen.findByRole('dialog')).toBeInTheDocument();
        expect(await screen.findByText(/Nothing is configured for this game yet/)).toBeInTheDocument();
        // Device section never renders when there are no engine options.
        expect(screen.queryByText('Device')).not.toBeInTheDocument();
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });
});

/**
 * Owner field report (2026-08-11) — unsupported photo formats (e.g. an
 * iPhone's `image/heic` camera default) attempt a client-side JPEG re-encode
 * via `lib/photoNormalize.ts`'s `normalizePhotoFile`. jsdom has no real
 * `<canvas>`, so these tests mock `normalizePhotoFile` itself rather than
 * exercising the real conversion — the module's own test file
 * (`lib/__tests__/photoNormalize.test.ts`) covers the decision logic, and this
 * covers the component wiring: success sets the preview, failure shows the
 * inline error and leaves no file selected.
 */
describe('SubmissionSheet — photo format handling', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
    });

    function selectPhoto(container: HTMLElement, file: File) {
        const input = container.querySelector('input[type="file"]') as HTMLInputElement;
        fireEvent.change(input, { target: { files: [file] } });
        return input;
    }

    it('a successfully-normalized photo sets the preview (no error shown)', async () => {
        signIn();
        const jpeg = new File(['x'], 'photo.jpg', { type: 'image/jpeg' });
        vi.spyOn(photoNormalize, 'normalizePhotoFile').mockResolvedValue(jpeg);
        const { container } = renderSheet({
            platformsResponse: platformsPayload({ submittable: ['real'] }),
        });
        await screen.findByText('Real Cabinet');

        selectPhoto(container, new File(['x'], 'IMG_0001.heic', { type: 'image/heic' }));

        await screen.findByAltText('Score photo');
        expect(screen.queryByText(/format isn't supported/i)).not.toBeInTheDocument();
    });

    it('a photo that fails normalization shows the inline unsupported-format error, not a preview', async () => {
        signIn();
        vi.spyOn(photoNormalize, 'normalizePhotoFile').mockResolvedValue(null);
        const { container } = renderSheet({
            platformsResponse: platformsPayload({ submittable: ['real'] }),
        });
        await screen.findByText('Real Cabinet');

        selectPhoto(container, new File(['x'], 'IMG_0002.heic', { type: 'image/heic' }));

        expect(await screen.findByText("That photo format isn't supported — please use a PNG or JPEG.")).toBeInTheDocument();
        expect(screen.queryByAltText('Score photo')).not.toBeInTheDocument();
    });
});
