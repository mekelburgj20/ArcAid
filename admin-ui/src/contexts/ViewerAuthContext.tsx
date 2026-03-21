import { createContext, useContext } from 'react';

interface ViewerAuth {
  token: string | null;
}

export const ViewerAuthContext = createContext<ViewerAuth>({ token: null });

export function useViewerAuth() {
  return useContext(ViewerAuthContext);
}

/** Build headers object for fetch calls in password-protected rooms. */
export function useViewerHeaders(): Record<string, string> {
  const { token } = useViewerAuth();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
