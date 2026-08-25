import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { logInfo, logWarn } from '../utils/logger.js';

/**
 * AtGames **authenticated** API — private tournaments and their score sets.
 *
 * Distinct from `AtGamesApiClient`, which reads the PUBLIC catalogue feed and
 * needs no credentials. This one signs in as a room owner's AtGames account so
 * Arcaid can read a private tournament's `rankings[]` — the per-window score
 * set that the public feed cannot give (the public feed exposes all-time top-5
 * only, and a window winner is frequently not in it).
 *
 * ## The contract (reverse-engineered; see `tmp/atgames-research/FINDINGS-0b/0g`)
 *
 * ```
 * POST /api/arcadenet/api/account/login   { email, password }   -> 201
 * POST /api/arcadenet/api/account/sign_in                       -> 201 { account: { ..., token } }
 * GET  /api/retro/api/v1/user/tournaments/private               -> [ ...summaries... ]
 * GET  /api/retro/api/v1/user/tournaments/private/:id           -> { ..., games: [ { ..., rankings: [] } ] }
 * ```
 *
 * Authenticated calls carry **`Authorization: Bearer <token>`** plus **`fp:
 * <device-uuid>`**. `fp` is a stable device fingerprint, not a credential — the
 * site sends the same value on every request including sign-in, so Arcaid mints
 * one per room and reuses it.
 *
 * ## Two sign-in endpoints, and why both are called
 *
 * The capture shows credentials going to `/account/login` and the account
 * object (with the token) coming back from `/account/sign_in`, but it could not
 * distinguish whether `login` ALSO returns the token — Chrome's sanitizer had
 * removed the cookies that would have shown how the two are chained. Rather
 * than bet on one reading, `login` is called first and its response is checked
 * for a token; only if it has none do we call `sign_in`, forwarding any cookies
 * `login` set. Both readings therefore work, and the cheap path wins when it
 * can.
 *
 * ## Token lifetime
 *
 * The token is a self-contained HS256 JWT whose payload carries
 * `{ id, email, user_name, full_name, exp }` — so the AtGames **account id is
 * available straight from the token**, with no extra lookup, and that id is the
 * stable key an Arcaid identity link hangs off. Observed lifetime is ~7 days;
 * the client re-logs-in on a 401 rather than trusting `exp` alone.
 *
 * ## Secrets discipline
 *
 * Nothing in this file ever logs the password or the token. Errors are reported
 * by status code and endpoint. The token is held in memory only (never
 * persisted) — the password lives encrypted in `game_room_settings` per ADR
 * 0003.
 */

const API_BASE = 'https://atgames.net';
const LOGIN_PATH = '/api/arcadenet/api/account/login';
const SIGN_IN_PATH = '/api/arcadenet/api/account/sign_in';
const PRIVATE_TOURNAMENTS_PATH = '/api/retro/api/v1/user/tournaments/private';

const REQUEST_TIMEOUT_MS = 30000;

export interface AtGamesCreds {
    email: string;
    password: string;
    /** Stable per-room device fingerprint sent as the `fp` header. */
    deviceFp: string;
}

/** What a successful sign-in yields. The token is never persisted. */
export interface AtGamesSession {
    token: string;
    /** AtGames account id, read out of the JWT payload (`id`). */
    accountId: number | null;
    /** AtGames display name from the JWT payload (`user_name`). */
    userName: string | null;
    /** `exp` as epoch milliseconds, or null when the payload had none. */
    expiresAt: number | null;
}

/** One row of `GET /user/tournaments/private`. */
export interface AtGamesPrivateTournamentSummary {
    id: number;
    name: string;
    invitationCode?: string | null;
    /** ISO UTC. */
    start?: string | null;
    end?: string | null;
    state?: string | null;
    membershipRole?: string | null;
    gameIds?: number[];
    createdAt?: string | null;
    createdBy?: string | null;
}

/**
 * One score inside a tournament's `rankings[]`.
 *
 * `created_at` is the AtGames **submit** timestamp, which on these cabinets is
 * the moment the player EXITED the table (exit-to-submit) — not when they
 * started playing. That distinction is the whole reason P8's on-device witness
 * exists; nothing here can infer play duration.
 */
export interface AtGamesRanking {
    /** Stable AtGames account id — the identity key. */
    account: number;
    user_name: string;
    signature?: string | null;
    game_id: number;
    /** AtGames sends the score as a decimal string. */
    score: string | number;
    /** Cabinet model code, e.g. `RK9920`. */
    hardware?: string | null;
    series?: string | null;
    /** `"2026-08-23 20:54:42.0"` — UTC, second precision. */
    created_at: string;
    rank?: number;
    avatar?: string | null;
}

/** One game block inside the tournament detail, carrying that game's scores. */
export interface AtGamesTournamentGame {
    game_id?: number;
    id?: number;
    name?: string;
    rankings?: AtGamesRanking[];
    [key: string]: unknown;
}

/** `GET /user/tournaments/private/:id`. */
export interface AtGamesPrivateTournamentDetail {
    id: number;
    name: string;
    status?: string | null;
    style?: string | null;
    start?: string | null;
    end?: string | null;
    games?: AtGamesTournamentGame[];
    game_ids?: number[];
    model_restrictions?: unknown[];
    created_at?: string | null;
}

/** Raised for an auth failure the caller should surface to a room admin. */
export class AtGamesAuthError extends Error {
    readonly status?: number;
    constructor(message: string, status?: number) {
        super(message);
        this.name = 'AtGamesAuthError';
        this.status = status;
    }
}

/**
 * Decodes a JWT payload without verifying it.
 *
 * Verification is AtGames' job — we hold no signing key and the token is only
 * ever replayed back to AtGames. We read the payload purely to learn the
 * account id and expiry, and every field is treated as untrusted.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
    const parts = token.split('.');
    const payloadSegment = parts.length === 3 ? parts[1] : undefined;
    if (!payloadSegment) return null;
    try {
        const json = Buffer.from(payloadSegment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        const parsed: unknown = JSON.parse(json);
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

function maskEmail(email: string): string {
    const at = email.indexOf('@');
    if (at <= 1) return '***';
    return `${email.slice(0, 1)}***${email.slice(at)}`;
}

function statusOf(err: unknown): number | undefined {
    return (err as AxiosError | undefined)?.response?.status;
}

/**
 * Per-account session cache.
 *
 * A poller resolves creds every tick; logging in every tick would be abusive
 * and would burn AtGames' rate limits for no gain, since a token is good for
 * about a week. Keyed by lowercased email so two rooms sharing one AtGames
 * account share one session. In-process only — a restart re-logs-in.
 */
const sessions = new Map<string, AtGamesSession>();

/** Test seam: drops every cached session. */
export function clearAtGamesSessions(): void {
    sessions.clear();
}

export class AtGamesPrivateClient {
    private readonly creds: AtGamesCreds;
    private readonly cacheKey: string;

    constructor(creds: AtGamesCreds) {
        this.creds = creds;
        this.cacheKey = creds.email.trim().toLowerCase();
    }

    /** The cached session for these creds, if any. Exposed for diagnostics. */
    get session(): AtGamesSession | undefined {
        return sessions.get(this.cacheKey);
    }

    /**
     * Signs in and caches the session.
     *
     * `force` bypasses the cache — used by the 401 retry, which must not hand
     * back the very token that was just rejected.
     */
    async ensureSession(force = false): Promise<AtGamesSession> {
        if (!force) {
            const cached = sessions.get(this.cacheKey);
            // A minute of slack: a token that expires mid-flight would cost a
            // wasted round trip and a retry, and we know `exp` up front.
            if (cached && (cached.expiresAt == null || cached.expiresAt - 60_000 > Date.now())) {
                return cached;
            }
        }

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            fp: this.creds.deviceFp,
            Accept: 'application/json',
        };

        let token: string | null = null;
        let cookies: string[] = [];

        try {
            const login = await axios.post(
                `${API_BASE}${LOGIN_PATH}`,
                { email: this.creds.email, password: this.creds.password },
                { headers, timeout: REQUEST_TIMEOUT_MS },
            );
            token = extractToken(login.data);
            cookies = (login.headers?.['set-cookie'] as string[] | undefined) ?? [];
        } catch (err) {
            const status = statusOf(err);
            throw new AtGamesAuthError(
                `AtGames login failed for ${maskEmail(this.creds.email)}${status ? ` (HTTP ${status})` : ''}`,
                status,
            );
        }

        if (!token) {
            // `login` authenticated but did not hand back the account object;
            // `sign_in` is the endpoint that does. Forward whatever cookies
            // `login` set, since that is the only thing that can be carrying
            // the just-established session.
            const signInHeaders = cookies.length
                ? { ...headers, Cookie: cookies.map(c => c.split(';')[0]).join('; ') }
                : headers;
            try {
                const signIn = await axios.post(
                    `${API_BASE}${SIGN_IN_PATH}`,
                    {},
                    { headers: signInHeaders, timeout: REQUEST_TIMEOUT_MS },
                );
                token = extractToken(signIn.data);
            } catch (err) {
                const status = statusOf(err);
                throw new AtGamesAuthError(
                    `AtGames sign_in failed for ${maskEmail(this.creds.email)}${status ? ` (HTTP ${status})` : ''}`,
                    status,
                );
            }
        }

        if (!token) {
            throw new AtGamesAuthError(
                `AtGames sign-in returned no token for ${maskEmail(this.creds.email)} — the response shape may have changed`,
            );
        }

        const payload = decodeJwtPayload(token);
        const rawId = payload?.id;
        const rawExp = payload?.exp;
        const numericId = typeof rawId === 'number'
            ? rawId
            : (rawId != null && Number.isFinite(Number(rawId)) ? Number(rawId) : null);
        const session: AtGamesSession = {
            token,
            accountId: numericId,
            userName: typeof payload?.user_name === 'string' ? payload.user_name : null,
            expiresAt: typeof rawExp === 'number' ? rawExp * 1000 : null,
        };
        sessions.set(this.cacheKey, session);
        logInfo(
            `AtGames: signed in as ${maskEmail(this.creds.email)}` +
            `${session.accountId != null ? ` (account ${session.accountId})` : ''}` +
            `${session.expiresAt ? `, token valid until ${new Date(session.expiresAt).toISOString()}` : ''}`,
        );
        return session;
    }

    /**
     * Authenticated GET with a single re-login retry on 401.
     *
     * One retry, not a loop: if a freshly-minted token is also rejected, the
     * credentials or the contract are wrong and retrying would only hammer
     * AtGames with bad logins.
     */
    private async authedGet<T>(path: string, config?: AxiosRequestConfig): Promise<T> {
        const send = async (token: string): Promise<T> => {
            const res = await axios.get<T>(`${API_BASE}${path}`, {
                ...config,
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${token}`,
                    fp: this.creds.deviceFp,
                    ...(config?.headers ?? {}),
                },
                timeout: config?.timeout ?? REQUEST_TIMEOUT_MS,
            });
            return res.data;
        };

        const session = await this.ensureSession();
        try {
            return await send(session.token);
        } catch (err) {
            if (statusOf(err) !== 401) throw err;
            logWarn(`AtGames: token rejected on ${path} — re-authenticating once`);
            const fresh = await this.ensureSession(true);
            return await send(fresh.token);
        }
    }

    /** Every private tournament this account can see. */
    async listPrivateTournaments(): Promise<AtGamesPrivateTournamentSummary[]> {
        const data = await this.authedGet<unknown>(PRIVATE_TOURNAMENTS_PATH);
        if (Array.isArray(data)) return data as AtGamesPrivateTournamentSummary[];
        // Tolerate an enveloped variant rather than throwing on a shape we have
        // only seen once.
        const inner = (data as { tournaments?: unknown } | null)?.tournaments;
        if (Array.isArray(inner)) return inner as AtGamesPrivateTournamentSummary[];
        logWarn('AtGames: private-tournament list came back in an unrecognised shape');
        return [];
    }

    /** One private tournament, including every game's `rankings[]`. */
    async getPrivateTournament(id: number | string): Promise<AtGamesPrivateTournamentDetail> {
        return this.authedGet<AtGamesPrivateTournamentDetail>(`${PRIVATE_TOURNAMENTS_PATH}/${id}`);
    }

    /**
     * Flattens a tournament detail into its scores.
     *
     * The detail nests scores under each game; every consumer wants one list,
     * and each row already carries its own `game_id`. Rows missing an account
     * id or an unparseable score are dropped — an identity-less score cannot be
     * attributed to anyone, so keeping it would only pollute standings.
     */
    static flattenRankings(detail: AtGamesPrivateTournamentDetail): AtGamesRanking[] {
        const out: AtGamesRanking[] = [];
        for (const game of detail.games ?? []) {
            const gameId = typeof game.game_id === 'number' ? game.game_id
                : typeof game.id === 'number' ? game.id : undefined;
            for (const row of game.rankings ?? []) {
                if (typeof row?.account !== 'number') continue;
                const score = typeof row.score === 'number' ? row.score : Number(row.score);
                if (!Number.isFinite(score)) continue;
                out.push({ ...row, game_id: typeof row.game_id === 'number' ? row.game_id : gameId ?? -1, score });
            }
        }
        return out;
    }
}

/** Pulls `account.token` (or a bare `token`) out of a sign-in response body. */
function extractToken(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const account = (body as { account?: unknown }).account;
    if (account && typeof account === 'object') {
        const t = (account as { token?: unknown }).token;
        if (typeof t === 'string' && t.length > 0) return t;
    }
    const bare = (body as { token?: unknown }).token;
    return typeof bare === 'string' && bare.length > 0 ? bare : null;
}
