/**
 * Shared avatar-URL resolution (v2.35.0, Google login).
 *
 * The BE/JWT `avatar` contract: Discord users carry a bare avatar HASH
 * (unchanged shape — `GET /avatars/:id/:hash.png` CDN template), Google
 * users carry a full picture URL straight from their Google profile. The FE
 * disambiguates by `startsWith('http')` rather than by provider, so any
 * future provider that also ships full URLs needs no changes here.
 *
 * Replaces 4 previously-hardcoded `https://cdn.discordapp.com/avatars/...`
 * template sites: AccountSettings.tsx, Friends.tsx, ScoreboardComponents.tsx,
 * LandingPage.tsx.
 */
export function resolveAvatarUrl(
    userId: string | null | undefined,
    avatar: string | null | undefined,
): string | null {
    if (!avatar) return null;
    if (avatar.startsWith('http')) return avatar;
    if (!userId) return null;
    return `https://cdn.discordapp.com/avatars/${userId}/${avatar}.png`;
}
