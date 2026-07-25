import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    // v2.39.0 (approval rooms) — the server's join:room/join:lobby/join:game
    // handlers verify approval-room membership off this token (see
    // src/api/websocket.ts). Read directly from localStorage (this module
    // isn't a React consumer) — player token preferred (public pages), the
    // admin token as a fallback so admin-only surfaces (Leaderboard, Kiosk
    // viewed while logged in as an admin) still authenticate the socket.
    // Guests/open rooms are unaffected either way.
    const token = localStorage.getItem('arcaid_player_token') || localStorage.getItem('arcaid_token') || undefined;
    socket = io({
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      auth: { token },
    });
  }
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
