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
    // Token expired or invalid — clear and redirect based on context
    setToken(null);
    const slug = getSlugFromPath();
    if (slug) {
      window.location.href = `/${slug}/login`;
    } else if (window.location.pathname.startsWith('/admin')) {
      window.location.href = '/login';
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
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
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
