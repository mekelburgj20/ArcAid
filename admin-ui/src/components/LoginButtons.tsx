import DiscordLoginButton from './DiscordLoginButton';
import GoogleLoginButton from './GoogleLoginButton';

/**
 * Stacks a DiscordLoginButton + GoogleLoginButton together (v2.35.0, Google
 * login). Replaces bare `<DiscordLoginButton>` usages at the shared-component
 * call sites so both providers show consistently. `discordOnly` (derived from
 * a room's REQUIRE_DISCORD_LOGIN === 'discord' policy) suppresses the Google
 * button entirely — used by SubmissionSheet, the one policy-aware call site.
 */
interface Props {
    onDiscordLogin: () => void;
    onGoogleLogin: () => void;
    /** Optional compact label, defaults to "Login" (passed to both buttons). */
    label?: string;
    /** Wrapper container className (layout/spacing). */
    className?: string;
    /** Passed through to both individual buttons. */
    buttonClassName?: string;
    /** Stack vertically (modal/sheet contexts) instead of side-by-side (nav bars). */
    vertical?: boolean;
    /** D4 — REQUIRE_DISCORD_LOGIN === 'discord': only Discord is offered. */
    discordOnly?: boolean;
    /**
     * v2.35.0 — when set (and Google is shown), applied as a native `title`
     * tooltip on the container: "Sign in with Discord to get DM
     * notifications and tournament picks." Nav-bar-compact sites use the
     * tooltip form rather than inline text (no room for a second line).
     */
    nudgeTitle?: string;
}

export default function LoginButtons({
    onDiscordLogin,
    onGoogleLogin,
    label,
    className,
    buttonClassName,
    vertical,
    discordOnly,
    nudgeTitle,
}: Props) {
    return (
        <div
            className={`flex ${vertical ? 'flex-col' : 'flex-row'} items-stretch gap-2 ${className ?? ''}`}
            title={!discordOnly ? nudgeTitle : undefined}
        >
            <DiscordLoginButton onClick={onDiscordLogin} label={label} className={buttonClassName} />
            {!discordOnly && (
                <GoogleLoginButton onClick={onGoogleLogin} label={label} className={buttonClassName} />
            )}
        </div>
    );
}
