import { randomBytes } from 'crypto';
import { logInfo } from '../utils/logger.js';
import { WitnessService } from '../services/WitnessService.js';

/**
 * Castcade match relay (W8.4, ADR 0039).
 *
 * A Castcade match is peer-hosted: the host player's companion arbitrates and
 * the other companions talk to it. Without this relay the host needs a
 * forwarded port. Here ArcAid carries the match CONTROL messages (small signed
 * JSON and WebRTC signalling) between the host and each client over the
 * existing socket.io server. Media stays peer to peer.
 *
 * What this module holds to:
 *   - `data` is OPAQUE. It is a string that is size-checked and forwarded. It
 *     is never parsed, logged or stored. Keep it that way: the messages are
 *     signed end to end by the companions and ArcAid is not a party to them.
 *   - Star topology. A client's frame goes to the host only; a host's frame
 *     goes to the one peer it names. A client never sees another client's
 *     frames, and never learns another client's peer id from the server.
 *   - Nothing in the database. Rooms live in this process's memory, so the
 *     relay is correct only while ArcAid is ONE Node process (it is: one
 *     `arcaid` container behind Caddy, no cluster, no socket.io adapter). A
 *     second process needs sticky sessions plus a shared room registry first.
 *   - Only `match:*` events need a paired Witness device (`auth: { deviceId,
 *     deviceToken }` in the handshake). Every other socket event is untouched.
 *     A seated device is verified again at most once a minute, on its next
 *     frame, so a revoked device leaves a match under way.
 *   - The host locks the room when the match starts (`match:lock`): after that
 *     only a device that already held a seat may join (reconnects).
 *
 * The room is keyed by the match's invite code. The roster check the original
 * W8.4 asked for (W8.2 / W8.3) does not exist yet; `admitJoin` is its seam.
 */

export const MATCH_MAX_SOCKETS = 8;                 // host included
export const MATCH_MAX_DATA_BYTES = 256 * 1024;     // UTF-8 bytes of `data`
export const MATCH_RELAY_LIMIT = 200;               // messages ...
export const MATCH_RELAY_WINDOW_MS = 10_000;        // ... per window: per client socket, and per DESTINATION on the host socket
export const MATCH_HOST_GRACE_MS = 30_000;          // host may drop and resume
export const MATCH_ROOM_TTL_MS = 12 * 60 * 60 * 1000;
export const MATCH_MAX_ROOMS = 2000;                // memory bound for the process

/** `match:host` / `match:join` attempts, per device and per IP. */
export const MATCH_ATTEMPT_WINDOW_MS = 60_000;
export const MATCH_ATTEMPTS_PER_DEVICE = 20;
export const MATCH_ATTEMPTS_PER_IP = 60;
/**
 * Code-guessing lockout: this many `no_such_match` inside the window locks the
 * DEVICE out. Never the IP: the device is authenticated, and an address is
 * shared (a household, a venue, a carrier NAT), so one guesser must not lock
 * out everyone behind it. The IP keeps only the raw attempt cap above.
 */
export const MATCH_MISS_LIMIT = 8;
export const MATCH_MISS_WINDOW_MS = 10 * 60_000;
export const MATCH_LOCKOUT_MS = 15 * 60_000;
/** A seated device's verdict is trusted this long, then re-read on its next `match:relay`. */
export const MATCH_REVERIFY_MS = 60_000;

const CODE_RE = /^[A-Z]{6}$/;

export type MatchError =
    | 'unauthorized' | 'rate_limited' | 'bad_code' | 'code_in_use' | 'server_busy'
    | 'no_such_match' | 'full' | 'locked'
    | 'not_in_match' | 'no_such_peer' | 'too_large' | 'invalid_message';

export interface MatchDevice {
    deviceId: string;
    canonicalUserId: string;
}

/** The slice of a socket.io `Socket` the relay uses (a real Socket satisfies it). */
export interface RelaySocket {
    id: string;
    handshake: {
        auth: unknown;
        address: string;
        headers: Record<string, string | string[] | undefined>;
    };
    on(event: string, listener: (...args: any[]) => void): unknown;
    emit(event: string, ...args: any[]): unknown;
}

export interface MatchRelayOptions {
    /** Device-token check. Default: the one Witness check (`WitnessService.verifyDevice`). */
    authenticate?: (deviceId: string, deviceToken: string) => Promise<MatchDevice | null>;
    /**
     * THE ROSTER SEAM (W8.2 / W8.3). Called after the device is authenticated
     * and the room is found, before the socket is admitted. Return false to
     * refuse with `unauthorized`. Today every paired device that knows the
     * code is admitted; when a match is a Throwdown with a roster, look the
     * match up by `code` here and test `device.canonicalUserId` against it.
     */
    admitJoin?: (device: MatchDevice, code: string) => Promise<boolean> | boolean;
}

interface Room {
    code: string;
    ownerDeviceId: string;
    host: RelaySocket | null;           // null while the host is away (grace)
    clients: Map<string, RelaySocket>;  // peer id -> socket
    hostWindows: Map<string, RelayWindow>;  // peer id -> the host's send budget to that peer
    locked: boolean;                    // `match:lock`: no new devices
    everSeated: Set<string>;            // device ids that ever held a seat here; NEVER sent to any socket
    graceTimer: ReturnType<typeof setTimeout> | null;
    expiryTimer: ReturnType<typeof setTimeout>;
}

interface Seat {
    room: Room;
    role: 'host' | 'client';
    peer?: string;
    verifiedAt: number;                 // when this socket's device last verified
}

interface Window { start: number; count: number; }
interface RelayWindow extends Window { warned: boolean; }
interface MissState extends Window { lockedUntil: number; }

type Ack = (reply: Record<string, unknown>) => void;

function asAck(value: unknown): Ack {
    return typeof value === 'function' ? (value as Ack) : () => { /* no ack asked for */ };
}

/**
 * The address rate limits key on. Express runs with `trust proxy = 1` (Caddy
 * in front), so mirror that: the LAST X-Forwarded-For hop is the one our own
 * proxy wrote; anything before it is client-supplied. No header = direct.
 */
function clientIp(socket: RelaySocket): string {
    const raw = socket.handshake.headers['x-forwarded-for'];
    const header = Array.isArray(raw) ? raw[raw.length - 1] : raw;
    const last = header?.split(',').pop()?.trim();
    return last || socket.handshake.address || 'unknown';
}

export class MatchRelay {
    private rooms = new Map<string, Room>();
    private seats = new Map<string, Seat>();                 // socket id -> seat
    private hostedBy = new Map<string, Room>();              // device id -> its room
    private relayWindows = new Map<string, RelayWindow>();     // socket id -> its own budget
    private attempts = new Map<string, Window>();
    private misses = new Map<string, MissState>();
    private strayAuth = new Map<string, Promise<boolean>>();  // socket id -> paired? (relay with no seat)
    private sweeper: ReturnType<typeof setInterval> | null = null;

    private authenticate: NonNullable<MatchRelayOptions['authenticate']>;
    private admitJoin: NonNullable<MatchRelayOptions['admitJoin']>;

    constructor(options: MatchRelayOptions = {}) {
        this.authenticate = options.authenticate ?? ((id, token) => WitnessService.verifyDevice(id, token));
        this.admitJoin = options.admitJoin ?? (() => true);
    }

    /** Wire one connected socket. Adds listeners only; a socket that never emits `match:*` costs nothing. */
    register(socket: RelaySocket): void {
        socket.on('match:host', (payload: unknown, ack: unknown) => {
            void this.onHost(socket, payload, asAck(ack));
        });
        socket.on('match:join', (payload: unknown, ack: unknown) => {
            void this.onJoin(socket, payload, asAck(ack));
        });
        socket.on('match:leave', (payload: unknown, ack: unknown) => {
            this.vacate(socket, 'host_left');
            // Emitted with or without a payload: the ack is whichever argument is a function.
            asAck(typeof payload === 'function' ? payload : ack)({ ok: true });
        });
        socket.on('match:lock', (payload: unknown, ack: unknown) => {
            this.onLock(socket, asAck(typeof payload === 'function' ? payload : ack));
        });
        socket.on('match:relay', (payload: unknown) => {
            this.onRelay(socket, payload);
        });
        socket.on('disconnect', () => {
            this.onDisconnect(socket);
        });
    }

    /** Live room count (ops / tests). */
    roomCount(): number {
        return this.rooms.size;
    }

    /** Close every room and forget every counter (tests, shutdown). */
    reset(): void {
        for (const room of [...this.rooms.values()]) this.closeRoom(room, 'server_restart');
        this.seats.clear();
        this.relayWindows.clear();
        this.strayAuth.clear();
        this.attempts.clear();
        this.misses.clear();
        if (this.sweeper) { clearInterval(this.sweeper); this.sweeper = null; }
    }

    // ---- auth + rate limits -------------------------------------------------

    private async deviceOf(socket: RelaySocket): Promise<MatchDevice | null> {
        const auth = socket.handshake.auth as { deviceId?: unknown; deviceToken?: unknown } | null | undefined;
        const deviceId = typeof auth?.deviceId === 'string' ? auth.deviceId.trim() : '';
        const deviceToken = typeof auth?.deviceToken === 'string' ? auth.deviceToken : '';
        if (!deviceId || !deviceToken || deviceId.length > 200 || deviceToken.length > 200) return null;
        try {
            return await this.authenticate(deviceId, deviceToken);
        } catch {
            // Fail CLOSED: unlike the room-view gate, this opens a write path.
            return null;
        }
    }

    private overAttemptLimit(key: string, max: number): boolean {
        const now = Date.now();
        const w = this.attempts.get(key);
        if (!w || now - w.start >= MATCH_ATTEMPT_WINDOW_MS) {
            this.attempts.set(key, { start: now, count: 1 });
            this.ensureSweeper();
            return false;
        }
        w.count++;
        return w.count > max;
    }

    private lockedOut(key: string): boolean {
        const m = this.misses.get(key);
        return !!m && m.lockedUntil > Date.now();
    }

    private recordMiss(key: string): void {
        const now = Date.now();
        let m = this.misses.get(key);
        if (!m || now - m.start >= MATCH_MISS_WINDOW_MS) {
            m = { start: now, count: 0, lockedUntil: 0 };
            this.misses.set(key, m);
            this.ensureSweeper();
        }
        m.count++;
        if (m.count >= MATCH_MISS_LIMIT) m.lockedUntil = now + MATCH_LOCKOUT_MS;
    }

    /** Drops spent counters once a minute so the maps cannot grow without bound. */
    private ensureSweeper(): void {
        if (this.sweeper) return;
        this.sweeper = setInterval(() => {
            const now = Date.now();
            for (const [k, w] of this.attempts) if (now - w.start >= MATCH_ATTEMPT_WINDOW_MS) this.attempts.delete(k);
            for (const [k, m] of this.misses) {
                if (now - m.start >= MATCH_MISS_WINDOW_MS && m.lockedUntil <= now) this.misses.delete(k);
            }
            if (this.attempts.size === 0 && this.misses.size === 0 && this.sweeper) {
                clearInterval(this.sweeper);
                this.sweeper = null;
            }
        }, 60_000);
        this.sweeper.unref?.();
    }

    /**
     * Shared front door of `match:host` and `match:join`: IP limit, device
     * auth, device limit. Returns the device, or the error to ack.
     */
    private async admit(socket: RelaySocket): Promise<{ device: MatchDevice; deviceKey: string } | { error: MatchError }> {
        // The IP has a raw attempt cap only. It is counted BEFORE the token
        // check, so guessing tokens is capped too; it is never locked out for
        // the misses of the verified devices behind it.
        if (this.overAttemptLimit(`ip:${clientIp(socket)}`, MATCH_ATTEMPTS_PER_IP)) return { error: 'rate_limited' };
        const device = await this.deviceOf(socket);
        if (!device) return { error: 'unauthorized' };
        const deviceKey = `dev:${device.deviceId}`;
        if (this.lockedOut(deviceKey) || this.overAttemptLimit(deviceKey, MATCH_ATTEMPTS_PER_DEVICE)) return { error: 'rate_limited' };
        return { device, deviceKey };
    }

    // ---- match:host ---------------------------------------------------------

    private async onHost(socket: RelaySocket, payload: unknown, ack: Ack): Promise<void> {
        const gate = await this.admit(socket);
        if ('error' in gate) return ack({ ok: false, error: gate.error });
        const { device } = gate;

        const code = (payload as { code?: unknown } | null)?.code;
        if (typeof code !== 'string' || !CODE_RE.test(code)) return ack({ ok: false, error: 'bad_code' });

        const existing = this.rooms.get(code);
        if (existing) {
            if (existing.ownerDeviceId !== device.deviceId) return ack({ ok: false, error: 'code_in_use' });
            // Same device: a resume inside the grace, or a second socket taking over.
            // The older socket just loses the seat: it is told nothing, because to the
            // companion it is the same host and a `match:closed` would end its match.
            if (existing.host && existing.host.id !== socket.id) this.seats.delete(existing.host.id);
            const held = this.seats.get(socket.id);
            if (held && !(held.room === existing && held.role === 'host')) this.vacate(socket, 'host_left');
            if (existing.graceTimer) { clearTimeout(existing.graceTimer); existing.graceTimer = null; }
            existing.host = socket;
            this.seats.set(socket.id, { room: existing, role: 'host', verifiedAt: Date.now() });
            const peers = [...existing.clients.keys()];
            ack({ ok: true, peers });
            // A resumed host may have lost its state: tell it again who is in the room.
            for (const peer of peers) socket.emit('match:peer', { peer, state: 'joined' });
            return;
        }

        // A socket holds one seat, and a device hosts one match at a time.
        this.vacate(socket, 'host_left');
        const previous = this.hostedBy.get(device.deviceId);
        if (previous) this.closeRoom(previous, 'replaced');
        if (this.rooms.size >= MATCH_MAX_ROOMS) return ack({ ok: false, error: 'server_busy' });

        const room: Room = {
            code,
            ownerDeviceId: device.deviceId,
            host: socket,
            clients: new Map(),
            hostWindows: new Map(),
            locked: false,
            everSeated: new Set([device.deviceId]),
            graceTimer: null,
            expiryTimer: setTimeout(() => this.closeRoom(room, 'expired'), MATCH_ROOM_TTL_MS),
        };
        room.expiryTimer.unref?.();
        this.rooms.set(code, room);
        this.hostedBy.set(device.deviceId, room);
        this.seats.set(socket.id, { room, role: 'host', verifiedAt: Date.now() });
        logInfo(`Match relay: room opened (${this.rooms.size} live)`);
        ack({ ok: true, peers: [] });
    }

    // ---- match:join ---------------------------------------------------------

    private async onJoin(socket: RelaySocket, payload: unknown, ack: Ack): Promise<void> {
        const gate = await this.admit(socket);
        if ('error' in gate) return ack({ ok: false, error: gate.error });
        const { device, deviceKey } = gate;

        const code = (payload as { code?: unknown } | null)?.code;
        const room = typeof code === 'string' && CODE_RE.test(code) ? this.rooms.get(code) : undefined;
        if (!room) {
            // A malformed code is a miss too: one answer, one counter.
            this.recordMiss(deviceKey);
            return ack({ ok: false, error: 'no_such_match' });
        }
        // A started match takes no strangers. A device that held a seat before
        // (a reconnect) still gets in. Not a miss: the code was right.
        if (room.locked && !room.everSeated.has(device.deviceId)) return ack({ ok: false, error: 'locked' });

        let allowed = false;
        try { allowed = await this.admitJoin(device, room.code); } catch { allowed = false; }
        if (!allowed) return ack({ ok: false, error: 'unauthorized' });
        // The room may have closed while the roster check ran.
        if (this.rooms.get(room.code) !== room) return ack({ ok: false, error: 'no_such_match' });

        const seat = this.seats.get(socket.id);
        if (seat?.room === room && seat.role === 'client') {
            seat.verifiedAt = Date.now();
            return ack({ ok: true, peer: seat.peer });
        }
        if (seat?.room === room && seat.role === 'host') return ack({ ok: false, error: 'unauthorized' });

        if (room.clients.size + 1 >= MATCH_MAX_SOCKETS) return ack({ ok: false, error: 'full' });
        this.vacate(socket, 'host_left');

        const peer = randomBytes(9).toString('base64url');
        room.clients.set(peer, socket);
        room.everSeated.add(device.deviceId);
        this.seats.set(socket.id, { room, role: 'client', peer, verifiedAt: Date.now() });
        ack({ ok: true, peer });
        room.host?.emit('match:peer', { peer, state: 'joined' });
    }

    // ---- match:lock ---------------------------------------------------------

    /** Host only. Idempotent; there is no unlock (a new match is a new code). */
    private onLock(socket: RelaySocket, ack: Ack): void {
        const seat = this.seats.get(socket.id);
        if (seat?.role !== 'host') return ack({ ok: false, error: 'unauthorized' });
        seat.room.locked = true;
        ack({ ok: true });
    }

    // ---- match:relay --------------------------------------------------------

    /**
     * A revoked device must not stay in a match. The verdict from host / join
     * is trusted for MATCH_REVERIFY_MS; the first frame after that starts ONE
     * device read (the stamp moves first, so a burst cannot start a second).
     * The frame that triggered it is not held back: holding would reorder the
     * stream, and the read settles within milliseconds.
     */
    private reverify(socket: RelaySocket, seat: Seat): void {
        const now = Date.now();
        if (now - seat.verifiedAt < MATCH_REVERIFY_MS) return;
        seat.verifiedAt = now;
        void this.deviceOf(socket).then((device) => {
            if (device || this.seats.get(socket.id) !== seat) return;
            socket.emit('match:error', { error: 'unauthorized' });
            if (seat.role === 'host') this.closeRoom(seat.room, 'host_gone');
            else this.vacate(socket, 'host_gone');
        });
    }

    /** One fixed window; false when this message is over the limit (one `rate_limited` notice per window). */
    private underRate(socket: RelaySocket, windows: Map<string, RelayWindow>, key: string): boolean {
        const now = Date.now();
        let w = windows.get(key);
        if (!w || now - w.start >= MATCH_RELAY_WINDOW_MS) {
            w = { start: now, count: 0, warned: false };
            windows.set(key, w);
        }
        w.count++;
        if (w.count <= MATCH_RELAY_LIMIT) return true;
        // One notice per window: an error per dropped frame would be its own flood.
        if (!w.warned) {
            w.warned = true;
            socket.emit('match:error', { error: 'rate_limited' });
        }
        return false;
    }

    private onRelay(socket: RelaySocket, payload: unknown): void {
        const seat = this.seats.get(socket.id);
        const body = payload as { data?: unknown; to?: unknown } | null;

        // The host's budget is per DESTINATION: its send-to-all is one emit per
        // client, and every client-to-client WebRTC signal passes through it. A
        // client socket, and anything that is not a host frame to a peer in the
        // room (no seat, unknown `to`), draws on the socket's own budget.
        const target = seat?.role === 'host' && typeof body?.to === 'string'
            ? seat.room.clients.get(body.to) : undefined;
        const allowed = target
            ? this.underRate(socket, seat!.room.hostWindows, body!.to as string)
            : this.underRate(socket, this.relayWindows, socket.id);
        if (!allowed) return;

        if (!seat) {
            // Verified once per socket: a flood of stray frames must not become a flood of device reads.
            let known = this.strayAuth.get(socket.id);
            if (!known) {
                known = this.deviceOf(socket).then((device) => !!device);
                this.strayAuth.set(socket.id, known);
            }
            void known.then((paired) => {
                socket.emit('match:error', { error: paired ? 'not_in_match' : 'unauthorized' });
            });
            return;
        }

        this.reverify(socket, seat);

        const data = body?.data;
        if (typeof data !== 'string') {
            socket.emit('match:error', { error: 'invalid_message' });
            return;
        }
        // A string's UTF-8 size is never below its length, so the cheap test goes first.
        if (data.length > MATCH_MAX_DATA_BYTES || Buffer.byteLength(data, 'utf8') > MATCH_MAX_DATA_BYTES) {
            socket.emit('match:error', { error: 'too_large' });
            return;
        }

        if (seat.role === 'client') {
            // Host away (inside its grace): dropped silently. The companions re-link between themselves.
            seat.room.host?.emit('match:relay', { from: seat.peer, data });
            return;
        }
        if (!target) {
            socket.emit('match:error', { error: 'no_such_peer' });
            return;
        }
        target.emit('match:relay', { data });
    }

    // ---- leaving, dropping, closing -----------------------------------------

    private onDisconnect(socket: RelaySocket): void {
        this.relayWindows.delete(socket.id);
        this.strayAuth.delete(socket.id);
        const seat = this.seats.get(socket.id);
        if (!seat) return;
        if (seat.role === 'client') {
            this.vacate(socket, 'host_left');
            return;
        }
        // Host dropped: keep the room and its clients for the grace.
        this.seats.delete(socket.id);
        const room = seat.room;
        if (room.host?.id !== socket.id) return;
        room.host = null;
        room.graceTimer = setTimeout(() => this.closeRoom(room, 'host_gone'), MATCH_HOST_GRACE_MS);
        room.graceTimer.unref?.();
    }

    /** Take a socket out of whatever seat it holds. A host leaving on purpose closes its room at once. */
    private vacate(socket: RelaySocket, hostReason: string): void {
        const seat = this.seats.get(socket.id);
        if (!seat) return;
        this.seats.delete(socket.id);
        if (seat.role === 'host') {
            if (seat.room.host?.id === socket.id) {
                seat.room.host = null;
                this.closeRoom(seat.room, hostReason);
            }
            return;
        }
        if (seat.peer && seat.room.clients.get(seat.peer) === socket) {
            seat.room.clients.delete(seat.peer);
            seat.room.hostWindows.delete(seat.peer);
            seat.room.host?.emit('match:peer', { peer: seat.peer, state: 'left' });
        }
    }

    private closeRoom(room: Room, reason: string): void {
        if (this.rooms.get(room.code) !== room) return;
        this.rooms.delete(room.code);
        if (this.hostedBy.get(room.ownerDeviceId) === room) this.hostedBy.delete(room.ownerDeviceId);
        clearTimeout(room.expiryTimer);
        if (room.graceTimer) clearTimeout(room.graceTimer);
        for (const client of room.clients.values()) {
            this.seats.delete(client.id);
            client.emit('match:closed', { reason });
        }
        room.clients.clear();
        room.hostWindows.clear();
        if (room.host) {
            this.seats.delete(room.host.id);
            room.host.emit('match:closed', { reason });
            room.host = null;
        }
        logInfo(`Match relay: room closed (${reason}; ${this.rooms.size} live)`);
    }
}

/** The process-wide relay `initWebSocket` registers sockets with. */
export const matchRelay = new MatchRelay();
