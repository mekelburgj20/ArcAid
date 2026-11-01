/**
 * v2.213.0 - readable sentences for the room join / write refusal codes.
 *
 * `DISCORD_LINK_REQUIRED` and `ROLE_REQUIRED` come from `POST /api/me/rooms/:roomId`
 * on a "Discord role required" room; `JOIN_REQUIRED` comes from any score
 * submit or pick in a room that requires membership before you can write.
 * The server's own message is preferred when it sent one (it names the room
 * and the required roles); these are the fallbacks.
 */
export type JoinErrorCode = 'DISCORD_LINK_REQUIRED' | 'ROLE_REQUIRED' | 'JOIN_REQUIRED' | 'APPROVAL_REQUIRED';

const FALLBACK: Record<JoinErrorCode, string> = {
  DISCORD_LINK_REQUIRED: 'Link your Discord account in Account Settings first - this room checks your Discord roles before you can join.',
  ROLE_REQUIRED: "You don't have the Discord role this room needs to join.",
  JOIN_REQUIRED: 'Join the room first, then submit your score.',
  APPROVAL_REQUIRED: 'This room approves new members. Ask to join from the room page.',
};

export function isJoinErrorCode(code: unknown): code is JoinErrorCode {
  return typeof code === 'string' && code in FALLBACK;
}

export function joinErrorMessage(code: unknown, serverMessage?: string | null): string {
  if (serverMessage && serverMessage.trim()) return serverMessage;
  if (isJoinErrorCode(code)) return FALLBACK[code];
  return 'Could not join this room - try again.';
}
