import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SubmissionSheet, { type SubmissionTarget } from '../SubmissionSheet';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import * as photoNormalize from '../../lib/photoNormalize';

/**
 * v2.131.0 — "How was <game>?" on the success card (rate + optional comment).
 *
 * The whole feature reuses endpoints that already existed for the game pages,
 * so what's worth locking here is the WIRING, and specifically the three ways
 * it must not misbehave:
 *
 *   1. The room/global split. A room target must hit
 *      `/api/rooms/:roomId/ratings/:gameName`; a global target must hit
 *      `/api/global/games/:id/rating`. Crossing those wires silently rates the
 *      wrong thing (room ratings have been room-scoped since v2.86.0).
 *   2. The degrade path. The block is gated entirely on a successful rating
 *      GET — a 401 (banned viewer, expired token) must simply hide it. Nothing
 *      here is allowed to stand between the player and Done.
 *   3. Lifecycle. Both POSTs are fire-and-forget relative to the sheet, so
 *      dismissing mid-request must not throw.
 *
 * Harness notes mirror `SubmissionSheet.test.tsx`: a signed-in viewer is
 * required (else the sheet renders `loginRequired`), `MemoryRouter` is needed
 * for the `<Link>`s, and `GET /api/submit/platforms` is stubbed with the shape
 * `parseSubmitPlatformsResponse` expects.
 */

function b64url(obj: object): string {
    return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fakeJwt(payload: object): string {
    return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}

const DISCORD_ID = '222222222222222222';

function signIn(discordId = DISCORD_ID, username = 'Tester') {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    localStorage.setItem('arcaid_player_token', fakeJwt({ discordId, username, avatar: null, exp }));
    localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username, avatar: null }));
}

/** `real` engine → a single compatible device, so the picker auto-locks both axes. */
function platformsPayload() {
    return {
        platforms: ['real'],
        submittable: ['real'],
        features: [],
        tournamentRules: {
            engines: { required: [], excluded: [] },
            devices: { required: [], excluded: [] },
        },
    };
}

interface StubbedResponse {
    ok?: boolean;
    status?: number;
    body?: unknown;
    /** When set, the call hangs on this promise (in-flight simulation). */
    gate?: Promise<void>;
}

interface RenderOpts {
    target?: SubmissionTarget;
    ratingGet?: StubbedResponse;
    ratingPost?: StubbedResponse;
    commentPost?: StubbedResponse;
    submitResponse?: object;
    roomSlug?: string;
    onSubmitted?: () => void;
}

const ROOM_TARGET: SubmissionTarget = {
    kind: 'tournament',
    roomId: 'room-1',
    gameName: 'Attack from Mars',
};

const GLOBAL_TARGET: SubmissionTarget = {
    kind: 'global',
    globalGameId: 'gg-42',
    gameName: 'Medieval Madness',
};

function respond(stub: StubbedResponse | undefined, fallback: unknown) {
    const ok = stub?.ok ?? true;
    const make = () => ({
        ok,
        status: stub?.status ?? (ok ? 200 : 401),
        json: () => Promise.resolve(stub?.body ?? fallback),
    });
    if (stub?.gate) return stub.gate.then(make);
    return Promise.resolve(make());
}

function renderSheet(opts: RenderOpts = {}) {
    const target = opts.target ?? ROOM_TARGET;

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        const href = String(url);
        const method = (init?.method ?? 'GET').toUpperCase();

        if (href.startsWith('/api/submit/platforms')) {
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(platformsPayload()) });
        }
        if (href.includes('/comments')) {
            return respond(opts.commentPost, { id: 1 });
        }
        // Room: `/ratings/:gameName`. Global: `/games/:id/rating`.
        if (href.includes('/ratings/') || href.endsWith('/rating')) {
            return method === 'POST'
                ? respond(opts.ratingPost, { avg_rating: 4.5, rating_count: 3, user_rating: 5 })
                : respond(opts.ratingGet, { avg_rating: 4.2, rating_count: 9, user_rating: 4 });
        }
        if (href.includes('/submit-score/') || href === '/api/global/scores') {
            return Promise.resolve({
                ok: true,
                status: 201,
                json: () => Promise.resolve(opts.submitResponse ?? { displayName: 'Tester' }),
            });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const rendered = render(
        <MemoryRouter>
            <ViewerAuthProvider>
                <SubmissionSheet
                    target={target}
                    onClose={() => {}}
                    onSubmitted={opts.onSubmitted}
                    roomSlug={opts.roomSlug ?? 'room-1'}
                />
            </ViewerAuthProvider>
        </MemoryRouter>,
    );
    return { ...rendered, fetchMock };
}

/**
 * Fill and submit. `global` (and `freeplay`) targets require a photo, so those
 * get a stubbed `normalizePhotoFile` and a file-input change first — the same
 * approach the photo tests in `SubmissionSheet.test.tsx` use, since jsdom has
 * no real canvas to re-encode with.
 */
async function submitScore(container: HTMLElement, opts: { withPhoto?: boolean } = {}) {
    await screen.findByText('Real Cabinet');
    if (opts.withPhoto) {
        const jpeg = new File(['x'], 'photo.jpg', { type: 'image/jpeg' });
        vi.spyOn(photoNormalize, 'normalizePhotoFile').mockResolvedValue(jpeg);
        const input = container.querySelector('input[type="file"]') as HTMLInputElement;
        fireEvent.change(input, { target: { files: [jpeg] } });
        await screen.findByAltText('Score photo');
    }
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '4200' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Score' }));
    await screen.findByRole('button', { name: 'Done' });
}

/** The five interactive stars, in order. */
function starButtons() {
    return screen.getAllByRole('button', { name: /^Rate \d star/ });
}
function filledStarCount() {
    return starButtons().filter(el => el.className.includes('text-neon-amber')).length;
}

function findCall(fetchMock: ReturnType<typeof vi.fn>, predicate: (url: string, init?: RequestInit) => boolean) {
    return fetchMock.mock.calls.find(([url, init]) => predicate(String(url), init as RequestInit | undefined));
}

describe('SubmissionSheet — success-card rating', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('renders the block with the stars pre-filled from the GET, plus the average caption', async () => {
        signIn();
        const { container, fetchMock } = renderSheet();
        await submitScore(container);

        expect(await screen.findByText(/How was/)).toBeInTheDocument();
        await waitFor(() => expect(filledStarCount()).toBe(4)); // user_rating: 4
        expect(screen.getByText(/avg ★ 4\.2 · 9 ratings/)).toBeInTheDocument();

        const get = findCall(fetchMock, (url, init) =>
            url.includes('/ratings/') && (init?.method ?? 'GET') === 'GET');
        expect(get).toBeTruthy();
        expect(String(get![0])).toBe('/api/rooms/room-1/ratings/Attack%20from%20Mars');
    });

    it('a star tap POSTs the room rating with the viewer headers, then says thanks', async () => {
        signIn();
        const { container, fetchMock } = renderSheet();
        await submitScore(container);
        await screen.findByText(/How was/);

        fireEvent.click(starButtons()[4]); // 5 stars

        expect(await screen.findByText('Thanks!')).toBeInTheDocument();

        const post = findCall(fetchMock, (url, init) => url.includes('/ratings/') && init?.method === 'POST');
        expect(post).toBeTruthy();
        expect(String(post![0])).toBe('/api/rooms/room-1/ratings/Attack%20from%20Mars');
        const init = post![1] as RequestInit;
        expect(JSON.parse(init.body as string)).toEqual({ rating: 5 });
        const headers = init.headers as Record<string, string>;
        expect(headers['Content-Type']).toBe('application/json');
        expect(headers.Authorization).toMatch(/^Bearer /);
        expect(headers['x-user-id']).toBe(DISCORD_ID);
    });

    it('a global target rates the global game, not a room', async () => {
        signIn();
        const { container, fetchMock } = renderSheet({ target: GLOBAL_TARGET });
        await submitScore(container, { withPhoto: true });
        await screen.findByText(/How was/);

        fireEvent.click(starButtons()[2]); // 3 stars
        await screen.findByText('Thanks!');

        const post = findCall(fetchMock, (url, init) => url.endsWith('/rating') && init?.method === 'POST');
        expect(post).toBeTruthy();
        expect(String(post![0])).toBe('/api/global/games/gg-42/rating');
        expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({ rating: 3 });
        // No room endpoint was touched.
        expect(findCall(fetchMock, url => url.includes('/ratings/'))).toBeUndefined();
    });

    it('a rejected rating POST reverts the stars and says so inline', async () => {
        signIn();
        const { container } = renderSheet({ ratingPost: { ok: false, status: 403, body: {} } });
        await submitScore(container);
        await screen.findByText(/How was/);
        await waitFor(() => expect(filledStarCount()).toBe(4));

        fireEvent.click(starButtons()[0]); // 1 star

        expect(await screen.findByText("Couldn't save that rating.")).toBeInTheDocument();
        await waitFor(() => expect(filledStarCount()).toBe(4)); // reverted
    });

    it('a 401 on the rating GET hides the whole block — Done still works', async () => {
        signIn();
        const onSubmitted = vi.fn();
        const { container } = renderSheet({ ratingGet: { ok: false, status: 401, body: {} }, onSubmitted });
        await submitScore(container);

        expect(screen.queryByText(/How was/)).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^Rate \d star/ })).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(onSubmitted).toHaveBeenCalledTimes(1);
    });
});

describe('SubmissionSheet — success-card comment', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    async function openEditor(container: HTMLElement) {
        await submitScore(container);
        fireEvent.click(await screen.findByRole('button', { name: 'Add a comment' }));
        return screen.getByLabelText('Comment') as HTMLTextAreaElement;
    }

    it('posts the comment under the resolved submit name and collapses to a game-page link', async () => {
        signIn();
        const { container, fetchMock } = renderSheet({ submitResponse: { displayName: 'Tester_2' } });
        const textarea = await openEditor(container);

        fireEvent.change(textarea, { target: { value: 'Ramps are brutal on this one.' } });
        expect(screen.getByText('29/500')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Post comment' }));

        expect(await screen.findByText(/Posted —/)).toBeInTheDocument();
        const link = screen.getByRole('link', { name: 'see it on the game page' });
        expect(link).toHaveAttribute('href', '/room-1/games/Attack%20from%20Mars');
        // Editor is gone once posted.
        expect(screen.queryByLabelText('Comment')).not.toBeInTheDocument();

        const post = findCall(fetchMock, url => url.includes('/comments'));
        expect(post).toBeTruthy();
        expect(String(post![0])).toBe('/api/rooms/room-1/games/Attack%20from%20Mars/comments');
        const init = post![1] as RequestInit;
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body as string)).toEqual({
            display_name: 'Tester_2',
            type: 'comment',
            body: 'Ramps are brutal on this one.',
        });
        // Author-only delete keys on the anon uuid, not the discord id.
        const headers = init.headers as Record<string, string>;
        expect(headers['x-user-id']).toBe(localStorage.getItem('arcaid-user-id'));
        expect(headers['x-user-id']).not.toBe(DISCORD_ID);
    });

    it('a global target posts to the global comments endpoint', async () => {
        signIn();
        const { container, fetchMock } = renderSheet({ target: GLOBAL_TARGET });
        await submitScore(container, { withPhoto: true });
        fireEvent.click(await screen.findByRole('button', { name: 'Add a comment' }));

        fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Classic.' } });
        fireEvent.click(screen.getByRole('button', { name: 'Post comment' }));

        expect(await screen.findByText(/Posted —/)).toBeInTheDocument();
        const post = findCall(fetchMock, url => url.includes('/comments'));
        expect(String(post![0])).toBe('/api/global/games/gg-42/comments');
        expect(screen.getByRole('link', { name: 'see it on the game page' }))
            .toHaveAttribute('href', '/games/gg-42');
    });

    it('a rejected comment stays in the editor and shows the server message', async () => {
        signIn();
        const { container } = renderSheet({
            commentPost: { ok: false, status: 400, body: { error: 'Comment is too spicy.' } },
        });
        const textarea = await openEditor(container);

        fireEvent.change(textarea, { target: { value: 'nope' } });
        fireEvent.click(screen.getByRole('button', { name: 'Post comment' }));

        expect(await screen.findByText('Comment is too spicy.')).toBeInTheDocument();
        expect(screen.getByLabelText('Comment')).toBeInTheDocument();
        expect(screen.queryByText(/Posted —/)).not.toBeInTheDocument();
    });

    it('the editor expands in place of the caption row (Done stays put)', async () => {
        signIn();
        const { container } = renderSheet();
        await submitScore(container);

        expect(await screen.findByText(/avg ★ 4\.2 · 9 ratings/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Add a comment' }));

        expect(screen.queryByText(/avg ★/)).not.toBeInTheDocument();
        expect(screen.getByLabelText('Comment')).toBeInTheDocument();
        // Done is still rendered throughout.
        expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    });
});

describe('SubmissionSheet — success-card lifecycle', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('Done during an in-flight rating POST does not throw', async () => {
        signIn();
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const onSubmitted = vi.fn();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const { container, unmount } = renderSheet({ ratingPost: { gate }, onSubmitted });
        await submitScore(container);
        await screen.findByText(/How was/);

        fireEvent.click(starButtons()[4]);
        // Dismiss while the POST is still hanging — the caller's terminal
        // action here is to tear the sheet down.
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(onSubmitted).toHaveBeenCalledTimes(1);
        unmount();

        await act(async () => { release(); await gate; });

        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('Done during an in-flight comment POST does not throw', async () => {
        signIn();
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const onSubmitted = vi.fn();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const { container, unmount } = renderSheet({ commentPost: { gate }, onSubmitted });
        await submitScore(container);
        fireEvent.click(await screen.findByRole('button', { name: 'Add a comment' }));
        fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'later' } });
        fireEvent.click(screen.getByRole('button', { name: 'Post comment' }));

        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(onSubmitted).toHaveBeenCalledTimes(1);
        unmount();

        await act(async () => { release(); await gate; });

        expect(errorSpy).not.toHaveBeenCalled();
    });
});
