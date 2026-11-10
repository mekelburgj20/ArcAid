import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { roomFetch } from '../roomFetch';

/**
 * v2.241.1 (D19). In an `approval` room the server answers a room read only
 * when it carries the viewer's login; a public page that read without it
 * showed members an empty page ("Full Leaderboard" on a Mox's Game Room card,
 * owner 2026-11-10). `roomFetch` attaches the token; the guard below keeps a
 * new page from going back to a bare `fetch`.
 */

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

const authOf = (init: RequestInit | undefined) => new Headers(init?.headers).get('Authorization');

describe('roomFetch', () => {
  it('signed out, it is exactly the bare fetch it replaces', async () => {
    await roomFetch('/api/rooms/r1/leaderboard');
    expect(fetchMock).toHaveBeenCalledWith('/api/rooms/r1/leaderboard');

    const init = { signal: new AbortController().signal };
    await roomFetch('/api/rooms/r1/history', init);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/rooms/r1/history', init);
  });

  it('signed in, it sends the player token', async () => {
    localStorage.setItem('arcaid_player_token', 'tok-1');
    await roomFetch('/api/rooms/r1/leaderboard');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/rooms/r1/leaderboard');
    expect(authOf(init)).toBe('Bearer tok-1');
  });

  it('keeps the call\'s own headers, and its own Authorization wins', async () => {
    localStorage.setItem('arcaid_player_token', 'tok-1');
    await roomFetch('/api/rooms/r1/ratings/X', { headers: { 'x-user-id': 'u1' } });
    let init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get('x-user-id')).toBe('u1');
    expect(authOf(init)).toBe('Bearer tok-1');

    await roomFetch('/api/rooms/r1/x', { headers: { Authorization: 'Bearer admin' } });
    init = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(authOf(init)).toBe('Bearer admin');
  });

  it('reads the token at call time, so a refreshed token is the one sent', async () => {
    localStorage.setItem('arcaid_player_token', 'old');
    await roomFetch('/api/rooms/r1/a');
    localStorage.setItem('arcaid_player_token', 'new');
    await roomFetch('/api/rooms/r1/b');
    expect(authOf(fetchMock.mock.calls[1]![1] as RequestInit)).toBe('Bearer new');
  });
});

/**
 * Guard: no admin-ui source makes a bare GET `fetch(\`/api/rooms/...\`)`.
 * Only `/portal` and `/scoreboard-config` answer before `roomVisibilityGate`.
 * A call that sends its own headers is left to the author (most carry the
 * token already); this catches the common slip, a read with no options.
 */
describe('roomFetch guard', () => {
  const SRC = path.resolve(__dirname, '../..');
  const OPEN_ROUTES = /\/(scoreboard-config|portal)$/;

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__') sourceFiles(p, out); continue; }
      if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  }

  function bareRoomReads(src: string): string[] {
    const found: string[] = [];
    const re = /(?<![\w.])fetch\(\s*`(\/api\/rooms\/[^`]*)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      let depth = 0;
      let end = src.length;
      for (let i = m.index + 'fetch'.length; i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')' && --depth === 0) { end = i; break; }
      }
      const call = src.slice(m.index, end + 1);
      if (/headers|method:/.test(call) || OPEN_ROUTES.test(m[1]!)) continue;
      found.push(`line ${src.slice(0, m.index).split('\n').length}: ${m[1]}`);
    }
    return found;
  }

  it('the scanner catches a bare read and passes the allowed shapes', () => {
    expect(bareRoomReads('fetch(`/api/rooms/${id}/leaderboard`).then(r => r.json())')).toHaveLength(1);
    expect(bareRoomReads('roomFetch(`/api/rooms/${id}/leaderboard`)')).toHaveLength(0);
    expect(bareRoomReads('fetch(`/api/rooms/${id}/scoreboard-config`)')).toHaveLength(0);
    expect(bareRoomReads('fetch(`/api/rooms/${id}/x`, { method: \'POST\' })')).toHaveLength(0);
  });

  it('every room read in admin-ui goes through roomFetch', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      for (const hit of bareRoomReads(fs.readFileSync(file, 'utf8'))) {
        offenders.push(`${path.relative(SRC, file)} ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
