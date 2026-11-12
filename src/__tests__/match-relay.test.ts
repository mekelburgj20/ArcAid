import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb } from './helpers.js';
import { WitnessService } from '../services/WitnessService.js';
import {
    MatchRelay,
    type RelaySocket,
    MATCH_MAX_SOCKETS,
    MATCH_MAX_DATA_BYTES,
    MATCH_RELAY_LIMIT,
    MATCH_RELAY_WINDOW_MS,
    MATCH_HOST_GRACE_MS,
    MATCH_ROOM_TTL_MS,
    MATCH_MISS_LIMIT,
    MATCH_LOCKOUT_MS,
    MATCH_ATTEMPTS_PER_DEVICE,
    MATCH_ATTEMPTS_PER_IP,
    MATCH_REVERIFY_MS,
    MATCH_ATTEMPT_WINDOW_MS,
} from '../api/matchRelay.js';

/**
 * W8.4 - the Castcade match relay (ADR 0039). ArcAid forwards opaque control
 * frames between a match's host and its clients so the host needs no forwarded
 * port. The Castcade companion is built against this wire contract, so the
 * event names, ack shapes and error words below are pinned.
 *
 * Pinned, worst-bug-first:
 *   1. Addressing: a client's frame reaches the host only; a host's frame
 *      reaches the one peer it names. A client never sees another client.
 *   2. Only a paired, unrevoked Witness device gets past any `match:*` event
 *      (checked against the real `witness_devices` table).
 *   3. Another device cannot take a live code; the owner resumes inside 30 s;
 *      the room closes for everyone after 30 s without the host, or at 12 h.
 *   4. Size cap, message rate limit, room cap, and the code-guessing lockout
 *      (per device, never per address).
 *   5. A revoked device leaves a match under way; a locked match takes no
 *      new devices but lets a seated one back in.
 *
 * The relay is driven through the `RelaySocket` slice with in-process fake
 * sockets (the backend has no socket.io client dependency); each fake records
 * what the server emitted to it.
 */

class FakeSocket implements RelaySocket {
    private static next = 1;
    id = `sock-${FakeSocket.next++}`;
    handshake: RelaySocket['handshake'];
    sent: Array<{ event: string; payload: any }> = [];
    private listeners = new Map<string, (...args: any[]) => void>();

    constructor(auth: unknown, ip = '203.0.113.10') {
        this.handshake = { auth, address: '10.0.0.2', headers: { 'x-forwarded-for': ip } };
    }
    on(event: string, listener: (...args: any[]) => void) {
        this.listeners.set(event, listener);
        return this;
    }
    emit(event: string, payload?: any) {
        this.sent.push({ event, payload });
        return true;
    }
    /** Client -> server with an ack; resolves with what the server acked. */
    request(event: string, payload?: unknown): Promise<any> {
        return new Promise((resolve) => this.listeners.get(event)!(payload, resolve));
    }
    /** Client -> server, no ack. */
    send(event: string, payload?: unknown) {
        this.listeners.get(event)!(payload);
    }
    disconnect() {
        this.listeners.get('disconnect')!('transport close');
    }
    got(event: string): any[] {
        return this.sent.filter((m) => m.event === event).map((m) => m.payload);
    }
}

let relay: MatchRelay;
let deviceSeq = 0;

/** Pair a fresh desktop device for a fresh account through the real pairing path. */
async function pairedAuth(userId?: string) {
    const n = ++deviceSeq;
    const { code } = await WitnessService.createPairingCode(userId ?? `1000000000000000${String(n).padStart(2, '0')}`);
    const deviceId = `test-device-${n}`;
    const { token } = await WitnessService.redeemPairingCode(code, deviceId, null, 'desktop');
    return { deviceId, deviceToken: token };
}

async function connect(auth?: unknown, ip?: string) {
    const socket = new FakeSocket(auth === undefined ? await pairedAuth() : auth, ip);
    relay.register(socket);
    return socket;
}

beforeEach(async () => {
    await setupTestDb();
    relay = new MatchRelay();
});

afterEach(() => {
    relay.reset();
    vi.useRealTimers();
});

describe('match relay: round trip and addressing', () => {
    it('carries frames host <-> two clients, and a client never receives another client\'s frames', async () => {
        const host = await connect();
        const a = await connect();
        const b = await connect();

        expect(await host.request('match:host', { code: 'ABCDEF' })).toEqual({ ok: true, peers: [] });
        const joinA = await a.request('match:join', { code: 'ABCDEF' });
        const joinB = await b.request('match:join', { code: 'ABCDEF' });
        expect(joinA.ok).toBe(true);
        expect(joinB.ok).toBe(true);
        expect(joinA.peer).not.toBe(joinB.peer);

        expect(host.got('match:peer')).toEqual([
            { peer: joinA.peer, state: 'joined' },
            { peer: joinB.peer, state: 'joined' },
        ]);

        a.send('match:relay', { data: 'from-a' });
        b.send('match:relay', { data: 'from-b' });
        expect(host.got('match:relay')).toEqual([
            { from: joinA.peer, data: 'from-a' },
            { from: joinB.peer, data: 'from-b' },
        ]);

        host.send('match:relay', { to: joinA.peer, data: 'to-a' });
        host.send('match:relay', { to: joinB.peer, data: 'to-b' });
        expect(a.got('match:relay')).toEqual([{ data: 'to-a' }]);
        expect(b.got('match:relay')).toEqual([{ data: 'to-b' }]);

        // Nothing but its own frames, and no peer ids of the others.
        expect(JSON.stringify(a.sent)).not.toContain(joinB.peer);
        expect(JSON.stringify(b.sent)).not.toContain(joinA.peer);
        expect(JSON.stringify(a.sent)).not.toContain('from-b');
    });

    it('the peer id is server-assigned and is not the device id', async () => {
        const host = await connect();
        const auth = await pairedAuth();
        const client = await connect(auth);
        await host.request('match:host', { code: 'ABCDEF' });
        const { peer } = await client.request('match:join', { code: 'ABCDEF' });
        expect(peer).toMatch(/^[A-Za-z0-9_-]{12}$/);
        expect(peer).not.toBe(auth.deviceId);
        expect(JSON.stringify(host.sent)).not.toContain(auth.deviceId);
    });

    it('a client cannot address another peer: `to` from a client is ignored and the frame goes to the host', async () => {
        const host = await connect();
        const a = await connect();
        const b = await connect();
        await host.request('match:host', { code: 'ABCDEF' });
        const joinA = await a.request('match:join', { code: 'ABCDEF' });
        const joinB = await b.request('match:join', { code: 'ABCDEF' });

        a.send('match:relay', { to: joinB.peer, data: 'sneaky' });
        expect(b.got('match:relay')).toEqual([]);
        expect(host.got('match:relay')).toEqual([{ from: joinA.peer, data: 'sneaky' }]);
    });

    it('a host frame to an unknown peer is dropped with no_such_peer', async () => {
        const host = await connect();
        const a = await connect();
        await host.request('match:host', { code: 'ABCDEF' });
        await a.request('match:join', { code: 'ABCDEF' });
        host.send('match:relay', { to: 'nobody', data: 'x' });
        host.send('match:relay', { data: 'x' });
        expect(host.got('match:error')).toEqual([{ error: 'no_such_peer' }, { error: 'no_such_peer' }]);
        expect(a.got('match:relay')).toEqual([]);
    });

    it('the host is told when a client leaves; a leaving client frees its seat', async () => {
        const host = await connect();
        const a = await connect();
        await host.request('match:host', { code: 'ABCDEF' });
        const { peer } = await a.request('match:join', { code: 'ABCDEF' });
        a.disconnect();
        expect(host.got('match:peer')).toEqual([{ peer, state: 'joined' }, { peer, state: 'left' }]);
        host.send('match:relay', { to: peer, data: 'late' });
        expect(host.got('match:error')).toEqual([{ error: 'no_such_peer' }]);
    });

    it('rooms are separate: two matches never see each other', async () => {
        const host1 = await connect();
        const host2 = await connect();
        const c1 = await connect();
        const c2 = await connect();
        await host1.request('match:host', { code: 'AAAAAA' });
        await host2.request('match:host', { code: 'BBBBBB' });
        await c1.request('match:join', { code: 'AAAAAA' });
        await c2.request('match:join', { code: 'BBBBBB' });
        c1.send('match:relay', { data: 'one' });
        c2.send('match:relay', { data: 'two' });
        expect(host1.got('match:relay').map((m) => m.data)).toEqual(['one']);
        expect(host2.got('match:relay').map((m) => m.data)).toEqual(['two']);
    });
});

describe('match relay: auth', () => {
    it('a socket with no device auth, or one that does not verify, is refused on every match event', async () => {
        for (const auth of [{}, null, { token: 'some.jwt.value' }, { deviceId: 'old-companion', deviceToken: 'unknown' }]) {
            const socket = await connect(auth);
            expect(await socket.request('match:host', { code: 'ABCDEF' })).toEqual({ ok: false, error: 'unauthorized' });
            expect(await socket.request('match:join', { code: 'ABCDEF' })).toEqual({ ok: false, error: 'unauthorized' });
            socket.send('match:relay', { data: 'x' });
            await vi.waitFor(() => expect(socket.got('match:error')).toEqual([{ error: 'unauthorized' }]));
        }
        expect(relay.roomCount()).toBe(0);
    });

    it('a wrong token, an unknown device and a revoked device are all refused', async () => {
        const good = await pairedAuth('200000000000000001');

        const wrongToken = await connect({ deviceId: good.deviceId, deviceToken: 'not-the-token' });
        expect(await wrongToken.request('match:host', { code: 'ABCDEF' })).toEqual({ ok: false, error: 'unauthorized' });

        const unknown = await connect({ deviceId: 'never-paired', deviceToken: good.deviceToken });
        expect(await unknown.request('match:join', { code: 'ABCDEF' })).toEqual({ ok: false, error: 'unauthorized' });

        const nonString = await connect({ deviceId: { $ne: '' }, deviceToken: ['x'] });
        expect(await nonString.request('match:host', { code: 'ABCDEF' })).toEqual({ ok: false, error: 'unauthorized' });

        expect(await WitnessService.revokeDevice('200000000000000001', good.deviceId)).toBe(true);
        const revoked = await connect(good);
        expect(await revoked.request('match:host', { code: 'ABCDEF' })).toEqual({ ok: false, error: 'unauthorized' });
    });

    it('a paired socket that is in no match gets not_in_match on relay', async () => {
        const socket = await connect();
        socket.send('match:relay', { data: 'x' });
        await vi.waitFor(() => expect(socket.got('match:error')).toEqual([{ error: 'not_in_match' }]));
    });

    it('the roster seam: admitJoin refusing a device answers unauthorized', async () => {
        const seen: string[] = [];
        relay = new MatchRelay({
            admitJoin: (device, code) => { seen.push(`${device.canonicalUserId}:${code}`); return false; },
        });
        const host = await connect();
        const client = await connect(await pairedAuth('300000000000000001'));
        await host.request('match:host', { code: 'ABCDEF' });
        expect(await client.request('match:join', { code: 'ABCDEF' })).toEqual({ ok: false, error: 'unauthorized' });
        expect(seen).toEqual(['300000000000000001:ABCDEF']);
        expect(host.got('match:peer')).toEqual([]);
    });
});

describe('match relay: codes and room size', () => {
    it('refuses a malformed code on host, and answers no_such_match for one on join', async () => {
        const socket = await connect();
        for (const code of ['abcdef', 'ABCDE', 'ABCDEFG', 'ABC1EF', '', 123456, null, undefined]) {
            expect(await socket.request('match:host', { code })).toEqual({ ok: false, error: 'bad_code' });
        }
        expect(await socket.request('match:join', { code: 'abcdef' })).toEqual({ ok: false, error: 'no_such_match' });
        expect(await socket.request('match:join', undefined)).toEqual({ ok: false, error: 'no_such_match' });
    });

    it('a second device cannot host a live code (code_in_use), and the first match is untouched', async () => {
        const host = await connect();
        const other = await connect();
        const client = await connect();
        await host.request('match:host', { code: 'ABCDEF' });
        await client.request('match:join', { code: 'ABCDEF' });

        expect(await other.request('match:host', { code: 'ABCDEF' })).toEqual({ ok: false, error: 'code_in_use' });
        client.send('match:relay', { data: 'still-here' });
        expect(host.got('match:relay').map((m) => m.data)).toEqual(['still-here']);
        expect(other.got('match:relay')).toEqual([]);
    });

    it('holds 8 sockets (host + 7 clients); the next join is full', async () => {
        const host = await connect();
        await host.request('match:host', { code: 'ABCDEF' });
        for (let i = 0; i < MATCH_MAX_SOCKETS - 1; i++) {
            const c = await connect();
            expect((await c.request('match:join', { code: 'ABCDEF' })).ok).toBe(true);
        }
        const extra = await connect();
        expect(await extra.request('match:join', { code: 'ABCDEF' })).toEqual({ ok: false, error: 'full' });
        expect(host.got('match:peer')).toHaveLength(MATCH_MAX_SOCKETS - 1);
    });

    it('a device hosting a second code closes its first room', async () => {
        const auth = await pairedAuth();
        const host = await connect(auth);
        const client = await connect();
        await host.request('match:host', { code: 'AAAAAA' });
        await client.request('match:join', { code: 'AAAAAA' });
        expect(await host.request('match:host', { code: 'BBBBBB' })).toEqual({ ok: true, peers: [] });
        expect(client.got('match:closed')).toEqual([{ reason: 'host_left' }]);
        expect(relay.roomCount()).toBe(1);
    });

    it('match:leave: a client leaves quietly, a host closes the room', async () => {
        const host = await connect();
        const a = await connect();
        const b = await connect();
        await host.request('match:host', { code: 'ABCDEF' });
        const { peer } = await a.request('match:join', { code: 'ABCDEF' });
        await b.request('match:join', { code: 'ABCDEF' });

        expect(await a.request('match:leave')).toEqual({ ok: true });
        expect(host.got('match:peer').at(-1)).toEqual({ peer, state: 'left' });
        expect(await host.request('match:leave', {})).toEqual({ ok: true });
        expect(b.got('match:closed')).toEqual([{ reason: 'host_left' }]);
        expect(relay.roomCount()).toBe(0);
    });
});

describe('match relay: size cap and message rate limit', () => {
    it('forwards a frame of exactly 256 KB and drops a larger one with too_large', async () => {
        const host = await connect();
        const client = await connect();
        await host.request('match:host', { code: 'ABCDEF' });
        const { peer } = await client.request('match:join', { code: 'ABCDEF' });

        const atCap = 'x'.repeat(MATCH_MAX_DATA_BYTES);
        client.send('match:relay', { data: atCap });
        expect(host.got('match:relay')).toHaveLength(1);
        expect(host.got('match:relay')[0].data.length).toBe(MATCH_MAX_DATA_BYTES);

        client.send('match:relay', { data: atCap + 'x' });
        // Bytes, not characters: half the characters, three bytes each.
        client.send('match:relay', { data: '€'.repeat(MATCH_MAX_DATA_BYTES / 2) });
        host.send('match:relay', { to: peer, data: atCap + 'x' });
        expect(host.got('match:relay')).toHaveLength(1);
        expect(client.got('match:relay')).toEqual([]);
        expect(client.got('match:error')).toEqual([{ error: 'too_large' }, { error: 'too_large' }]);
        expect(host.got('match:error')).toEqual([{ error: 'too_large' }]);
    });

    it('data that is not a string is refused, never forwarded', async () => {
        const host = await connect();
        const client = await connect();
        await host.request('match:host', { code: 'ABCDEF' });
        await client.request('match:join', { code: 'ABCDEF' });
        for (const data of [{ a: 1 }, 42, null, undefined, ['x']]) client.send('match:relay', { data });
        client.send('match:relay', undefined);
        expect(host.got('match:relay')).toEqual([]);
        expect(client.got('match:error')).toHaveLength(6);
        expect(client.got('match:error')[0]).toEqual({ error: 'invalid_message' });
    });

    it('drops past 200 messages in 10 s with one rate_limited notice, then recovers in the next window', async () => {
        const host = await connect();
        const client = await connect();
        const quiet = await connect();
        await host.request('match:host', { code: 'ABCDEF' });
        await client.request('match:join', { code: 'ABCDEF' });
        await quiet.request('match:join', { code: 'ABCDEF' });

        vi.useFakeTimers();
        for (let i = 0; i < MATCH_RELAY_LIMIT + 25; i++) client.send('match:relay', { data: `m${i}` });
        expect(host.got('match:relay')).toHaveLength(MATCH_RELAY_LIMIT);
        expect(client.got('match:error')).toEqual([{ error: 'rate_limited' }]);

        // Per socket: another client in the same room is not throttled.
        quiet.send('match:relay', { data: 'q' });
        expect(host.got('match:relay')).toHaveLength(MATCH_RELAY_LIMIT + 1);

        vi.advanceTimersByTime(MATCH_RELAY_WINDOW_MS);
        client.send('match:relay', { data: 'after' });
        expect(host.got('match:relay').at(-1).data).toBe('after');
    });

    it('the host socket is limited per destination: 200 per 10 s to EACH peer', async () => {
        const host = await connect();
        const a = await connect();
        const b = await connect();
        await host.request('match:host', { code: 'ABCDEF' });
        const pa = (await a.request('match:join', { code: 'ABCDEF' })).peer;
        const pb = (await b.request('match:join', { code: 'ABCDEF' })).peer;

        vi.useFakeTimers();
        // A send-to-all of 200 messages is 400 emits: all of them pass.
        for (let i = 0; i < MATCH_RELAY_LIMIT; i++) {
            host.send('match:relay', { to: pa, data: 'x' });
            host.send('match:relay', { to: pb, data: 'x' });
        }
        expect(a.got('match:relay')).toHaveLength(MATCH_RELAY_LIMIT);
        expect(b.got('match:relay')).toHaveLength(MATCH_RELAY_LIMIT);
        expect(host.got('match:error')).toEqual([]);

        // More to A is over A's bucket only; B's bucket fills separately.
        for (let i = 0; i < 5; i++) host.send('match:relay', { to: pa, data: 'over' });
        expect(a.got('match:relay')).toHaveLength(MATCH_RELAY_LIMIT);
        expect(host.got('match:error')).toEqual([{ error: 'rate_limited' }]);
        host.send('match:relay', { to: pb, data: 'over' });
        expect(b.got('match:relay')).toHaveLength(MATCH_RELAY_LIMIT);
        expect(host.got('match:error')).toEqual([{ error: 'rate_limited' }, { error: 'rate_limited' }]);

        vi.advanceTimersByTime(MATCH_RELAY_WINDOW_MS);
        host.send('match:relay', { to: pa, data: 'after' });
        expect(a.got('match:relay').at(-1)).toEqual({ data: 'after' });
    });

    it('host frames to peers that do not exist share one budget, so unknown ids cannot mint buckets', async () => {
        const host = await connect();
        await host.request('match:host', { code: 'ABCDEF' });
        vi.useFakeTimers();
        for (let i = 0; i < MATCH_RELAY_LIMIT + 50; i++) host.send('match:relay', { to: `ghost-${i}`, data: 'x' });
        const errors = host.got('match:error').map((e) => e.error);
        expect(errors.filter((e) => e === 'no_such_peer')).toHaveLength(MATCH_RELAY_LIMIT);
        expect(errors.filter((e) => e === 'rate_limited')).toHaveLength(1);
    });

    it('match:join again from a socket already in the room answers ok with the same peer', async () => {
        const host = await connect();
        const client = await connect();
        await host.request('match:host', { code: 'ABCDEF' });
        const first = await client.request('match:join', { code: 'ABCDEF' });
        expect(await client.request('match:join', { code: 'ABCDEF' })).toEqual({ ok: true, peer: first.peer });
        expect(host.got('match:peer')).toEqual([{ peer: first.peer, state: 'joined' }]);
    });
});

describe('match relay: host drop, resume, close, expiry', () => {
    it('the same device resumes its room inside 30 s; clients stay and frames flow again', async () => {
        const auth = await pairedAuth();
        const host = await connect(auth);
        const client = await connect();
        await host.request('match:host', { code: 'ABCDEF' });
        const { peer } = await client.request('match:join', { code: 'ABCDEF' });

        vi.useFakeTimers();
        host.disconnect();
        client.send('match:relay', { data: 'while-away' });   // dropped silently
        vi.advanceTimersByTime(MATCH_HOST_GRACE_MS - 1000);
        vi.useRealTimers();

        // Another device cannot take the code while the host is away.
        const thief = await connect();
        expect(await thief.request('match:host', { code: 'ABCDEF' })).toEqual({ ok: false, error: 'code_in_use' });

        const host2 = await connect(auth);
        expect(await host2.request('match:host', { code: 'ABCDEF' })).toEqual({ ok: true, peers: [peer] });
        // The resumed host is told again who is in the room.
        expect(host2.got('match:peer')).toEqual([{ peer, state: 'joined' }]);

        client.send('match:relay', { data: 'back' });
        expect(host2.got('match:relay')).toEqual([{ from: peer, data: 'back' }]);
        host2.send('match:relay', { to: peer, data: 'hello-again' });
        expect(client.got('match:relay')).toEqual([{ data: 'hello-again' }]);
        expect(client.got('match:closed')).toEqual([]);
        expect(client.got('match:error')).toEqual([]);
    });

    it('a resumed room does not close when the old grace would have run out', async () => {
        const auth = await pairedAuth();
        const host = await connect(auth);
        const client = await connect();
        await host.request('match:host', { code: 'ABCDEF' });
        await client.request('match:join', { code: 'ABCDEF' });
        host.disconnect();
        const host2 = await connect(auth);
        await host2.request('match:host', { code: 'ABCDEF' });

        vi.useFakeTimers();
        // The resume cleared the first timer; nothing fires at the old deadline.
        vi.advanceTimersByTime(MATCH_HOST_GRACE_MS * 2);
        expect(client.got('match:closed')).toEqual([]);
        expect(relay.roomCount()).toBe(1);
    });

    it('closes for every client after 30 s without the host, and the code is free again', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
        const host = await connect();
        const a = await connect();
        const b = await connect();
        await host.request('match:host', { code: 'ABCDEF' });
        await a.request('match:join', { code: 'ABCDEF' });
        await b.request('match:join', { code: 'ABCDEF' });

        host.disconnect();
        vi.advanceTimersByTime(MATCH_HOST_GRACE_MS - 1);
        expect(a.got('match:closed')).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(a.got('match:closed')).toEqual([{ reason: 'host_gone' }]);
        expect(b.got('match:closed')).toEqual([{ reason: 'host_gone' }]);
        expect(relay.roomCount()).toBe(0);

        const next = await connect();
        expect(await next.request('match:host', { code: 'ABCDEF' })).toEqual({ ok: true, peers: [] });
        expect(await a.request('match:join', { code: 'ABCDEF' })).toMatchObject({ ok: true });
    });

    it('expires 12 h after creation, host and clients told, even while in use', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
        const host = await connect();
        const client = await connect();
        await host.request('match:host', { code: 'ABCDEF' });
        await client.request('match:join', { code: 'ABCDEF' });

        vi.advanceTimersByTime(MATCH_ROOM_TTL_MS - 1);
        expect(relay.roomCount()).toBe(1);
        vi.advanceTimersByTime(1);
        expect(host.got('match:closed')).toEqual([{ reason: 'expired' }]);
        expect(client.got('match:closed')).toEqual([{ reason: 'expired' }]);
        expect(relay.roomCount()).toBe(0);
        expect(await client.request('match:join', { code: 'ABCDEF' })).toEqual({ ok: false, error: 'no_such_match' });
    });

    it('a second socket of the owning device takes the host seat over; the old one is told', async () => {
        const auth = await pairedAuth();
        const host = await connect(auth);
        const client = await connect();
        await host.request('match:host', { code: 'ABCDEF' });
        const { peer } = await client.request('match:join', { code: 'ABCDEF' });

        const host2 = await connect(auth);
        expect(await host2.request('match:host', { code: 'ABCDEF' })).toEqual({ ok: true, peers: [peer] });
        expect(host2.got('match:peer')).toEqual([{ peer, state: 'joined' }]);
        // The older socket is the same host to the companion: it is never told the match closed.
        expect(host.got('match:closed')).toEqual([]);
        host.send('match:relay', { to: peer, data: 'stale' });
        expect(client.got('match:relay')).toEqual([]);
        client.send('match:relay', { data: 'x' });
        expect(host2.got('match:relay')).toHaveLength(1);
        expect(host.got('match:relay')).toEqual([]);

        // The old socket going away must not start a grace on the live room.
        vi.useFakeTimers();
        host.disconnect();
        vi.advanceTimersByTime(MATCH_HOST_GRACE_MS + 1);
        expect(client.got('match:closed')).toEqual([]);
    });
});

describe('match relay: attempt limits and the code-guessing lockout', () => {
    it('locks a device out after repeated no_such_match, even for a code that then exists', async () => {
        const host = await connect(undefined, '203.0.113.1');
        await host.request('match:host', { code: 'ABCDEF' });

        const guesser = await connect(undefined, '203.0.113.2');
        for (let i = 0; i < MATCH_MISS_LIMIT; i++) {
            expect(await guesser.request('match:join', { code: 'ZZZZZ' + 'ABCDEFGH'[i] })).toEqual({ ok: false, error: 'no_such_match' });
        }
        expect(await guesser.request('match:join', { code: 'ABCDEF' })).toEqual({ ok: false, error: 'rate_limited' });
        expect(await guesser.request('match:host', { code: 'QQQQQQ' })).toEqual({ ok: false, error: 'rate_limited' });
        expect(host.got('match:peer')).toEqual([]);
    });

    it('the lockout is the device\'s alone: a shared address is never locked out, and it lifts after the lockout time', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
        const host = await connect(undefined, '203.0.113.1');
        await host.request('match:host', { code: 'ABCDEF' });

        // One device guesses itself into a lockout behind a shared address.
        const guesserAuth = await pairedAuth();
        const guesser = await connect(guesserAuth, '203.0.113.3');
        for (let i = 0; i < MATCH_MISS_LIMIT; i++) {
            expect((await guesser.request('match:join', { code: 'ZZZZZZ' })).error).toBe('no_such_match');
        }
        expect(await guesser.request('match:join', { code: 'ABCDEF' })).toEqual({ ok: false, error: 'rate_limited' });

        // The lockout follows the device to a new socket and a new address.
        const moved = await connect(guesserAuth, '203.0.113.77');
        expect(await moved.request('match:join', { code: 'ABCDEF' })).toEqual({ ok: false, error: 'rate_limited' });

        // Another device at the SAME address is untouched.
        const neighbour = await connect(undefined, '203.0.113.3');
        expect((await neighbour.request('match:join', { code: 'ABCDEF' })).ok).toBe(true);

        vi.advanceTimersByTime(MATCH_LOCKOUT_MS + 1);
        expect((await guesser.request('match:join', { code: 'ABCDEF' })).ok).toBe(true);
    });

    it('misses spread over many devices at one address lock nobody out', async () => {
        const host = await connect(undefined, '203.0.113.1');
        await host.request('match:host', { code: 'ABCDEF' });
        for (let i = 0; i < MATCH_MISS_LIMIT + 2; i++) {
            const s = await connect(undefined, '203.0.113.3');
            expect((await s.request('match:join', { code: 'ZZZZZZ' })).error).toBe('no_such_match');
        }
        const fresh = await connect(undefined, '203.0.113.3');
        expect((await fresh.request('match:join', { code: 'ABCDEF' })).ok).toBe(true);
    });

    it('caps host/join attempts per device per minute', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
        const socket = await connect();
        for (let i = 0; i < MATCH_ATTEMPTS_PER_DEVICE; i++) {
            expect(await socket.request('match:host', { code: 'ABCDEF' })).toMatchObject({ ok: true });
        }
        expect(await socket.request('match:host', { code: 'ABCDEF' })).toEqual({ ok: false, error: 'rate_limited' });
        vi.advanceTimersByTime(MATCH_ATTEMPT_WINDOW_MS);
        expect(await socket.request('match:host', { code: 'ABCDEF' })).toMatchObject({ ok: true });
    });

    it('caps raw attempts per address before the token check, keyed on the last X-Forwarded-For hop (the proxy\'s)', async () => {
        // Unverifiable sockets: the cap must bite without a single device read succeeding.
        for (let i = 0; i < MATCH_ATTEMPTS_PER_IP; i++) {
            const s = await connect({ deviceId: `guess-${i}`, deviceToken: 'x' }, `198.51.100.${i}, 203.0.113.9`);
            expect(await s.request('match:join', { code: 'ZZZZZZ' })).toEqual({ ok: false, error: 'unauthorized' });
        }
        // A client-supplied prefix does not make a new key.
        const s = await connect({ deviceId: 'guess-x', deviceToken: 'x' }, '198.51.100.200, 203.0.113.9');
        expect(await s.request('match:join', { code: 'ZZZZZZ' })).toEqual({ ok: false, error: 'rate_limited' });
        // A paired device there is capped too (raw cap, not a lockout), and another address is not.
        const paired = await connect(undefined, '203.0.113.9');
        expect(await paired.request('match:host', { code: 'ABCDEF' })).toEqual({ ok: false, error: 'rate_limited' });
        const elsewhere = await connect(undefined, '203.0.113.10');
        expect(await elsewhere.request('match:host', { code: 'ABCDEF' })).toMatchObject({ ok: true });
    });
});

describe('match relay: a revoked device leaves a match under way', () => {
    const USER_A = '400000000000000001';
    const USER_H = '400000000000000002';

    it('a revoked client is refused on its next frame after the 60 s verdict runs out, and the host is told it left', async () => {
        const host = await connect();
        const auth = await pairedAuth(USER_A);
        const client = await connect(auth);
        const other = await connect();
        await host.request('match:host', { code: 'ABCDEF' });
        const { peer } = await client.request('match:join', { code: 'ABCDEF' });
        await other.request('match:join', { code: 'ABCDEF' });

        vi.useFakeTimers({ toFake: ['Date'] });
        expect(await WitnessService.revokeDevice(USER_A, auth.deviceId)).toBe(true);

        // Inside the 60 s the cached verdict still stands.
        vi.setSystemTime(Date.now() + MATCH_REVERIFY_MS - 1000);
        client.send('match:relay', { data: 'still-cached' });
        await new Promise((r) => setTimeout(r, 50));
        expect(client.got('match:error')).toEqual([]);

        vi.setSystemTime(Date.now() + 2000);
        client.send('match:relay', { data: 'trigger' });
        await vi.waitFor(() => expect(client.got('match:error')).toEqual([{ error: 'unauthorized' }]));
        expect(host.got('match:peer').at(-1)).toEqual({ peer, state: 'left' });

        // Its seat is gone: nothing more is carried either way, and the rest of the match goes on.
        const before = host.got('match:relay').length;
        client.send('match:relay', { data: 'after' });
        host.send('match:relay', { to: peer, data: 'to-revoked' });
        expect(host.got('match:relay')).toHaveLength(before);
        expect(client.got('match:relay')).toEqual([]);
        expect(other.got('match:closed')).toEqual([]);
        other.send('match:relay', { data: 'fine' });
        expect(host.got('match:relay').at(-1).data).toBe('fine');
        // And it cannot come back.
        expect(await client.request('match:join', { code: 'ABCDEF' })).toEqual({ ok: false, error: 'unauthorized' });
    });

    it('a revoked host closes the room for everyone with host_gone', async () => {
        const auth = await pairedAuth(USER_H);
        const host = await connect(auth);
        const client = await connect();
        await host.request('match:host', { code: 'ABCDEF' });
        const { peer } = await client.request('match:join', { code: 'ABCDEF' });

        vi.useFakeTimers({ toFake: ['Date'] });
        expect(await WitnessService.revokeDevice(USER_H, auth.deviceId)).toBe(true);
        vi.setSystemTime(Date.now() + MATCH_REVERIFY_MS + 1);
        host.send('match:relay', { to: peer, data: 'x' });

        await vi.waitFor(() => expect(client.got('match:closed')).toEqual([{ reason: 'host_gone' }]));
        expect(host.got('match:error')).toEqual([{ error: 'unauthorized' }]);
        expect(relay.roomCount()).toBe(0);
    });

    it('costs one device read per socket per minute, however many frames are sent', async () => {
        let reads = 0;
        relay = new MatchRelay({
            authenticate: async (deviceId) => { reads++; return { deviceId, canonicalUserId: `user-of-${deviceId}` }; },
        });
        const host = await connect({ deviceId: 'h', deviceToken: 't' });
        const client = await connect({ deviceId: 'c', deviceToken: 't' });
        await host.request('match:host', { code: 'ABCDEF' });
        await client.request('match:join', { code: 'ABCDEF' });
        expect(reads).toBe(2);

        vi.useFakeTimers({ toFake: ['Date'] });
        for (let i = 0; i < 150; i++) client.send('match:relay', { data: 'x' });
        expect(reads).toBe(2);

        vi.setSystemTime(Date.now() + MATCH_REVERIFY_MS);
        for (let i = 0; i < 150; i++) client.send('match:relay', { data: 'x' });
        expect(reads).toBe(3);

        vi.setSystemTime(Date.now() + MATCH_REVERIFY_MS);
        for (let i = 0; i < 20; i++) client.send('match:relay', { data: 'x' });
        expect(reads).toBe(4);
        await new Promise((r) => setTimeout(r, 20));
        expect(client.got('match:error')).toEqual([]);
        expect(host.got('match:relay')).toHaveLength(320);
    });
});

describe('match relay: match:lock', () => {
    it('only the host may lock; a client, a socket in no match and an unpaired socket get unauthorized', async () => {
        const host = await connect();
        const client = await connect();
        const idle = await connect();
        const anon = await connect({});
        await host.request('match:host', { code: 'ABCDEF' });
        await client.request('match:join', { code: 'ABCDEF' });

        for (const s of [client, idle, anon]) {
            expect(await s.request('match:lock')).toEqual({ ok: false, error: 'unauthorized' });
        }
        // Not locked by any of those: a new device still gets in.
        const late = await connect();
        expect((await late.request('match:join', { code: 'ABCDEF' })).ok).toBe(true);

        expect(await host.request('match:lock')).toEqual({ ok: true });
        expect(await host.request('match:lock', {})).toEqual({ ok: true });
    });

    it('a locked match refuses a device that never held a seat, and that refusal is not a miss', async () => {
        const host = await connect();
        const client = await connect();
        await host.request('match:host', { code: 'ABCDEF' });
        await client.request('match:join', { code: 'ABCDEF' });
        await host.request('match:lock');

        const stranger = await connect();
        for (let i = 0; i < MATCH_MISS_LIMIT + 2; i++) {
            expect(await stranger.request('match:join', { code: 'ABCDEF' })).toEqual({ ok: false, error: 'locked' });
        }
        expect(host.got('match:peer')).toHaveLength(1);
        // Still not locked out: a wrong code is answered as a wrong code.
        expect(await stranger.request('match:join', { code: 'ZZZZZZ' })).toEqual({ ok: false, error: 'no_such_match' });
        // The device ids the room remembers are never sent to anyone.
        for (const s of [host, client, stranger]) expect(JSON.stringify(s.sent)).not.toContain('test-device-');
    });

    it('a device seated before the lock may re-join on a new socket; the lock survives a host resume', async () => {
        const hostAuth = await pairedAuth();
        const clientAuth = await pairedAuth();
        const host = await connect(hostAuth);
        const client = await connect(clientAuth);
        await host.request('match:host', { code: 'ABCDEF' });
        const first = await client.request('match:join', { code: 'ABCDEF' });
        await host.request('match:lock');

        client.disconnect();
        const back = await connect(clientAuth);
        const second = await back.request('match:join', { code: 'ABCDEF' });
        expect(second.ok).toBe(true);
        expect(second.peer).not.toBe(first.peer);
        // Already seated and asking again: the same peer, as before the lock.
        expect(await back.request('match:join', { code: 'ABCDEF' })).toEqual({ ok: true, peer: second.peer });

        host.disconnect();
        const host2 = await connect(hostAuth);
        expect(await host2.request('match:host', { code: 'ABCDEF' })).toEqual({ ok: true, peers: [second.peer] });
        const stranger = await connect();
        expect(await stranger.request('match:join', { code: 'ABCDEF' })).toEqual({ ok: false, error: 'locked' });
    });

    it('a new room on the same code starts unlocked and remembers nobody', async () => {
        const host = await connect();
        const client = await connect();
        await host.request('match:host', { code: 'ABCDEF' });
        await client.request('match:join', { code: 'ABCDEF' });
        await host.request('match:lock');
        await host.request('match:leave');

        const host2 = await connect();
        await host2.request('match:host', { code: 'ABCDEF' });
        const stranger = await connect();
        expect((await stranger.request('match:join', { code: 'ABCDEF' })).ok).toBe(true);
    });
});

describe('match relay: the existing socket events are untouched', () => {
    it('registers only match:* and disconnect listeners', async () => {
        const events: string[] = [];
        const probe: RelaySocket = {
            id: 'probe',
            handshake: { auth: {}, address: '', headers: {} },
            on: (event) => { events.push(event); return probe; },
            emit: () => true,
        };
        relay.register(probe);
        expect(events.sort()).toEqual(['disconnect', 'match:host', 'match:join', 'match:leave', 'match:lock', 'match:relay']);
    });
});
