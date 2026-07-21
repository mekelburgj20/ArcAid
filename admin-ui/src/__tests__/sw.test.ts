import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeBuildId, injectBuildId, BUILD_ID_PLACEHOLDER } from '../../scripts/swBuildId';

// S19 — admin-ui/public/sw.js is a classic (non-module) script, so it cannot
// be imported. We read it as text and evaluate it via `new Function` with a
// stubbed self/caches/clients/fetch, matching the real ServiceWorkerGlobalScope
// surface it touches. This lets us exercise the real routing/eviction/activate
// logic (not a re-implementation of it) without a browser or service-worker
// test environment.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SW_SOURCE = fs.readFileSync(path.resolve(__dirname, '../../public/sw.js'), 'utf8');

// The un-built source still contains the literal placeholder (injection is a
// build-time step, see vite.config.ts) — so the "current" static cache name
// under test is deterministic and stable across runs.
const STATIC_CACHE = `arcaid-static-${BUILD_ID_PLACEHOLDER}`;
const IMAGE_CACHE = 'arcaid-images-v1';

type FakeResponse = { ok: boolean; url: string; clone: () => FakeResponse };

function makeResponse(url: string, ok = true): FakeResponse {
  return {
    ok,
    url,
    clone() {
      return makeResponse(url, ok);
    },
  };
}

function makeRequest(url: string, { method = 'GET', mode = 'cors' }: { method?: string; mode?: string } = {}) {
  return { url, method, mode };
}

/** Map-backed Cache/CacheStorage fake. keys() preserves insertion order. */
function createCacheStorage(seed: Record<string, [string, FakeResponse][]> = {}) {
  const store = new Map<string, Map<string, FakeResponse>>();
  for (const [name, entries] of Object.entries(seed)) {
    store.set(name, new Map(entries));
  }

  function cacheFor(name: string) {
    if (!store.has(name)) store.set(name, new Map());
    const entries = store.get(name)!;
    return {
      async match(request: { url: string } | string) {
        const key = typeof request === 'string' ? request : request.url;
        return entries.get(key);
      },
      async put(request: { url: string } | string, response: FakeResponse) {
        const key = typeof request === 'string' ? request : request.url;
        entries.set(key, response);
      },
      async delete(request: { url: string } | string) {
        const key = typeof request === 'string' ? request : request.url;
        return entries.delete(key);
      },
      async keys() {
        return [...entries.keys()].map((url) => ({ url }));
      },
    };
  }

  const caches = {
    async open(name: string) {
      return cacheFor(name);
    },
    async keys() {
      return [...store.keys()];
    },
    async delete(name: string) {
      return store.delete(name);
    },
    async match(request: { url: string } | string) {
      const key = typeof request === 'string' ? request : request.url;
      for (const entries of store.values()) {
        if (entries.has(key)) return entries.get(key);
      }
      return undefined;
    },
  };

  return { caches, store };
}

function loadServiceWorker(opts: {
  seedCaches?: Record<string, [string, FakeResponse][]>;
  fetchImpl?: (request: { url: string; method: string }) => Promise<FakeResponse>;
}) {
  const listeners: Record<string, Array<(event: any) => void>> = {};
  const { caches, store } = createCacheStorage(opts.seedCaches);

  const clientsStub = {
    claim: vi.fn(),
    matchAll: vi.fn().mockResolvedValue([]),
    openWindow: vi.fn(),
  };

  const self: any = {
    addEventListener(type: string, handler: (event: any) => void) {
      (listeners[type] ||= []).push(handler);
    },
    skipWaiting: vi.fn(),
    clients: clientsStub,
    registration: { showNotification: vi.fn() },
    location: { origin: 'https://arcaid.app' },
  };

  const fetchImpl = opts.fetchImpl ?? (async (request: { url: string }) => makeResponse(request.url));

  // eslint-disable-next-line no-new-func -- deliberate: sw.js is a classic
  // script and this is the only way to exercise it outside a real SW context.
  const run = new Function('self', 'caches', 'clients', 'fetch', SW_SOURCE);
  run(self, caches, clientsStub, fetchImpl);

  return { listeners, self, caches, store, clientsStub, fetchImpl };
}

async function dispatchFetch(sw: ReturnType<typeof loadServiceWorker>, request: ReturnType<typeof makeRequest>) {
  const waitUntils: Promise<unknown>[] = [];
  let responded: Promise<FakeResponse> | undefined;
  const event = {
    request,
    respondWith(p: Promise<FakeResponse>) {
      responded = p;
    },
    waitUntil(p: Promise<unknown>) {
      waitUntils.push(p);
    },
  };
  const handlers = sw.listeners.fetch ?? [];
  for (const handler of handlers) handler(event);
  const response = responded ? await responded : undefined;
  await Promise.all(waitUntils);
  return response;
}

async function dispatchActivate(sw: ReturnType<typeof loadServiceWorker>) {
  const waitUntils: Promise<unknown>[] = [];
  const event = {
    waitUntil(p: Promise<unknown>) {
      waitUntils.push(p);
    },
  };
  for (const handler of sw.listeners.activate ?? []) handler(event);
  await Promise.all(waitUntils);
}

describe('sw.js', () => {
  describe('activate', () => {
    it('deletes legacy arcaid-v### and stale arcaid-static-* caches but keeps arcaid-images-v1 and the current static cache', async () => {
      const sw = loadServiceWorker({
        seedCaches: {
          'arcaid-v100': [],
          'arcaid-static-oldbuildhash01': [],
          [IMAGE_CACHE]: [['https://arcaid.app/api/catalogue-images/a.jpg', makeResponse('a.jpg')]],
          [STATIC_CACHE]: [],
        },
      });

      await dispatchActivate(sw);

      const remaining = new Set(await sw.caches.keys());
      expect(remaining.has('arcaid-v100')).toBe(false);
      expect(remaining.has('arcaid-static-oldbuildhash01')).toBe(false);
      expect(remaining.has(IMAGE_CACHE)).toBe(true);
      expect(remaining.has(STATIC_CACHE)).toBe(true);
      expect(sw.self.clients.claim).toHaveBeenCalled();
    });
  });

  describe('fetch routing', () => {
    it('routes image mounts into IMAGE_CACHE, not STATIC_CACHE', async () => {
      const sw = loadServiceWorker({});
      const req = makeRequest('https://arcaid.app/api/catalogue-images/x.jpg', { mode: 'no-cors' });

      const response = await dispatchFetch(sw, req);

      expect(response?.ok).toBe(true);
      const imageCache = sw.store.get(IMAGE_CACHE);
      expect(imageCache?.has(req.url)).toBe(true);
      const staticCache = sw.store.get(STATIC_CACHE);
      expect(staticCache?.has(req.url)).toBeFalsy();
    });

    it('routes /assets/* into STATIC_CACHE', async () => {
      const sw = loadServiceWorker({});
      const req = makeRequest('https://arcaid.app/assets/index-abc123.js');

      const response = await dispatchFetch(sw, req);

      expect(response?.ok).toBe(true);
      const staticCache = sw.store.get(STATIC_CACHE);
      expect(staticCache?.has(req.url)).toBe(true);
    });

    it('never caches API JSON responses (network-only)', async () => {
      const sw = loadServiceWorker({});
      const req = makeRequest('https://arcaid.app/api/rooms/1/leaderboard');

      const response = await dispatchFetch(sw, req);

      expect(response?.ok).toBe(true);
      // Network-only path never opens a cache at all.
      expect(sw.store.size).toBe(0);
    });

    it('never caches an /api/* route whose final segment looks like a static asset (M1 regression)', async () => {
      // iScored usernames land unescaped-dot in URL paths (encodeURIComponent
      // does not encode '.'), so a JSON endpoint like this can end in ".png"
      // for a player literally named "foo.png". Without the /api/ guard in
      // isStaticAsset(), the extension regex would cache this cache-first
      // forever. This uses a path the (benign) leaderboard test above would
      // NOT catch — the extension regex only matches image extensions.
      const sw = loadServiceWorker({});
      const req = makeRequest('https://arcaid.app/api/rooms/1/stats/enhanced/player/foo.png');

      const response = await dispatchFetch(sw, req);

      expect(response?.ok).toBe(true);
      // Network-only path never opens a cache at all.
      expect(sw.store.size).toBe(0);
    });

    it('never caches non-GET requests, even on an image path', async () => {
      const sw = loadServiceWorker({});
      const req = makeRequest('https://arcaid.app/api/catalogue-images/x.jpg', { method: 'POST' });

      const response = await dispatchFetch(sw, req);

      expect(response?.ok).toBe(true);
      expect(sw.store.get(IMAGE_CACHE)?.size ?? 0).toBe(0);
    });
  });

  describe('navigation (network-first)', () => {
    it('caches a successful navigation response in STATIC_CACHE', async () => {
      const sw = loadServiceWorker({});
      const req = makeRequest('https://arcaid.app/rtx_pinball/scoreboard', { mode: 'navigate' });

      const response = await dispatchFetch(sw, req);

      expect(response?.ok).toBe(true);
      expect(sw.store.get(STATIC_CACHE)?.has(req.url)).toBe(true);
    });

    it('does not cache a failed navigation response (m1 regression)', async () => {
      const sw = loadServiceWorker({
        fetchImpl: async (request) => makeResponse(request.url, false),
      });
      const req = makeRequest('https://arcaid.app/rtx_pinball/scoreboard', { mode: 'navigate' });

      const response = await dispatchFetch(sw, req);

      expect(response?.ok).toBe(false);
      expect(sw.store.get(STATIC_CACHE)?.has(req.url)).toBeFalsy();
    });
  });

  describe('image cache LRU', () => {
    it('evicts the oldest entry once IMAGE_CACHE exceeds 200 entries', async () => {
      const seedEntries: [string, FakeResponse][] = Array.from({ length: 200 }, (_, i) => {
        const url = `https://arcaid.app/api/catalogue-images/img${i}.jpg`;
        return [url, makeResponse(url)] as [string, FakeResponse];
      });
      const sw = loadServiceWorker({ seedCaches: { [IMAGE_CACHE]: seedEntries } });

      const newReq = makeRequest('https://arcaid.app/api/catalogue-images/img200.jpg');
      await dispatchFetch(sw, newReq);

      const imageCache = sw.store.get(IMAGE_CACHE)!;
      expect(imageCache.size).toBe(200);
      expect(imageCache.has('https://arcaid.app/api/catalogue-images/img0.jpg')).toBe(false);
      expect(imageCache.has(newReq.url)).toBe(true);
      // The second-oldest (img1) should have survived — only one eviction for one insert.
      expect(imageCache.has('https://arcaid.app/api/catalogue-images/img1.jpg')).toBe(true);
    });

    it('serves a cached image immediately and revalidates in the background', async () => {
      const cachedUrl = 'https://arcaid.app/api/catalogue-images/cached.jpg';
      const cachedResponse = makeResponse(cachedUrl);
      let fetchCount = 0;
      const sw = loadServiceWorker({
        seedCaches: { [IMAGE_CACHE]: [[cachedUrl, cachedResponse]] },
        fetchImpl: async (request) => {
          fetchCount += 1;
          return makeResponse(request.url);
        },
      });

      const response = await dispatchFetch(sw, makeRequest(cachedUrl));

      expect(response).toBe(cachedResponse);
      expect(fetchCount).toBe(1); // the background revalidation fetch
    });
  });

  describe('install', () => {
    it('calls skipWaiting with no precache', async () => {
      const sw = loadServiceWorker({});
      for (const handler of sw.listeners.install ?? []) handler({});
      expect(sw.self.skipWaiting).toHaveBeenCalled();
    });
  });
});

describe('swBuildId', () => {
  it('computeBuildId is deterministic for the same inputs', () => {
    const a = computeBuildId(['assets/index-abc.js', 'assets/index-def.css'], '<html>shell</html>');
    const b = computeBuildId(['assets/index-def.css', 'assets/index-abc.js'], '<html>shell</html>');
    expect(a).toBe(b); // sorted internally — input order shouldn't matter
    expect(a).toMatch(/^[a-f0-9]{12}$/);
  });

  it('computeBuildId changes when index.html content changes', () => {
    const a = computeBuildId(['assets/index-abc.js'], '<html>shell v1</html>');
    const b = computeBuildId(['assets/index-abc.js'], '<html>shell v2</html>');
    expect(a).not.toBe(b);
  });

  it('injectBuildId replaces every occurrence of the placeholder', () => {
    const source = `const STATIC_CACHE = 'arcaid-static-${BUILD_ID_PLACEHOLDER}'; // ${BUILD_ID_PLACEHOLDER}`;
    const injected = injectBuildId(source, 'deadbeef1234');
    expect(injected).toBe("const STATIC_CACHE = 'arcaid-static-deadbeef1234'; // deadbeef1234");
    expect(injected.includes(BUILD_ID_PLACEHOLDER)).toBe(false);
  });

  it('injectBuildId throws when the placeholder is absent', () => {
    expect(() => injectBuildId('const STATIC_CACHE = "arcaid-static-nope";', 'deadbeef1234')).toThrow();
  });
});
