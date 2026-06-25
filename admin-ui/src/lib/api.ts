const BASE = '/api';

let authToken: string | null = localStorage.getItem('arcaid_token');

export function setToken(token: string | null) {
  authToken = token;
  if (token) {
    localStorage.setItem('arcaid_token', token);
  } else {
    localStorage.removeItem('arcaid_token');
  }
}

export function getToken(): string | null {
  return authToken;
}

export function isAuthenticated(): boolean {
  return !!authToken;
}

export function getAnonUserId(): string {
  let id = localStorage.getItem('arcaid_anon_id');
  if (!id) {
    id = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('arcaid_anon_id', id);
  }
  return id;
}

/** Extract the room slug from the current URL path, if any. */
export function getSlugFromPath(): string | null {
  const path = window.location.pathname;
  // Match /:slug/admin/* pattern
  const match = path.match(/^\/([^/]+)\/admin(\/|$)/);
  return match ? match[1] : null;
}

async function tryRefreshAdminToken(): Promise<string | null> {
  const refreshToken = localStorage.getItem('arcaid_admin_refresh_token');
  if (!refreshToken) return null;
  try {
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    setToken(data.token);
    localStorage.setItem('arcaid_admin_refresh_token', data.refreshToken);
    return data.token;
  } catch {
    return null;
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string> || {}),
  };

  headers['x-user-id'] = getAnonUserId();

  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  if (options?.body && typeof options.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    const newToken = await tryRefreshAdminToken();
    if (newToken) {
      headers['Authorization'] = `Bearer ${newToken}`;
      const retryRes = await fetch(`${BASE}${path}`, { ...options, headers });
      if (!retryRes.ok) {
        const error = await retryRes.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(error.error || `HTTP ${retryRes.status}`);
      }
      return retryRes.json();
    }
    setToken(null);
    localStorage.removeItem('arcaid_admin_refresh_token');
    const slug = getSlugFromPath();
    if (slug) {
      window.location.href = `/${slug}/login`;
    } else {
      window.location.href = '/login';
    }
    throw new Error('Session expired');
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) => request<T>(path, {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  put: <T>(path: string, body: unknown) => request<T>(path, {
    method: 'PUT',
    body: JSON.stringify(body),
  }),
  patch: <T>(path: string, body: unknown) => request<T>(path, {
    method: 'PATCH',
    body: JSON.stringify(body),
  }),
  delete: <T>(path: string, body?: unknown) => request<T>(path, {
    method: 'DELETE',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }),
  /**
   * Trigger a binary file download for an authenticated endpoint.
   * api.get expects res.json(); for binary payloads we fetch the blob with the
   * admin Bearer + x-user-id header and synthesize a temporary anchor click.
   */
  download: async (path: string, filename?: string) => {
    const headers: Record<string, string> = {};
    headers['x-user-id'] = getAnonUserId();
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const res = await fetch(`${BASE}${path}`, { headers });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Download failed' }));
      throw new Error(error.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    if (filename) a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  /** Upload multipart form data (for file uploads). */
  upload: <T>(path: string, formData: FormData) => {
    const headers: Record<string, string> = {};
    headers['x-user-id'] = getAnonUserId();
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    // Do NOT set Content-Type — browser sets it with boundary for multipart
    return fetch(`${BASE}${path}`, { method: 'POST', body: formData, headers })
      .then(async res => {
        if (res.status === 401) {
          setToken(null);
          window.location.href = '/login';
          throw new Error('Session expired');
        }
        if (!res.ok) {
          const error = await res.json().catch(() => ({ error: 'Upload failed' }));
          throw new Error(error.error || `HTTP ${res.status}`);
        }
        return res.json() as Promise<T>;
      });
  },
};

/**
 * Submit-moment ranking (S5). Computed best-effort by the BE after an insert
 * and attached to the JSON of the four submit paths: /submit-score,
 * /freeplay-score, /global/scores, and /submission-drafts/:state/commit.
 *
 * These submits are issued via raw fetch inside SubmissionSheet.tsx (they need
 * FormData + the player Bearer + x-user-id anon header, which api.upload can't
 * supply — it injects the admin token), so this type is the single shared
 * home for the rank shape rather than a function return. Any field may be null:
 * the helper returns an all-null object on failure, and gap/previousBest are
 * null when the submitter is rank #1 or it's their first-ever submission.
 */
export interface SubmitRank {
  // rank/totalPlayers (not just the gaps) are null when the BE's best-effort
  // computation failed — it returns an all-null object rather than throwing.
  // The success card treats a null rank as "no rank" and shows plain success.
  rank: number | null;
  totalPlayers: number | null;
  previousBest: number | null;
  gapToNext: number | null;
  gapToFirst: number | null;
}

/** Shape of the JSON returned by the score-submit endpoints (S5). */
export interface SubmitScoreResponse {
  displayName?: string;
  suffixed?: boolean;
  requested?: string;
  rank?: SubmitRank | null;
}
