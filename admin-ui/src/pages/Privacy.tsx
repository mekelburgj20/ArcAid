import { Link } from 'react-router-dom';
import { ArrowLeft, Home, ShieldCheck } from 'lucide-react';

/**
 * Static privacy policy for Arcaid. Public, no auth, no data fetching.
 * Mirrors the AccountSettings.tsx skeleton (own Back/Home nav + max-w-xl main).
 *
 * NOTE: This copy is a plain-language starting point and should be reviewed by
 * the operator (and, where required, legal counsel) before launch. Keep it in
 * sync with what the app actually collects and with AccountDeletionService.
 */
const LAST_UPDATED = 'July 2026';

export default function Privacy() {
  return (
    <div className="min-h-screen bg-deep text-primary">
      <nav className="border-b border-border bg-surface/80 backdrop-blur-sm">
        <div
          className="max-w-xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between"
          style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
        >
          <button
            onClick={() => window.history.back()}
            className="flex items-center gap-1.5 text-sm text-muted hover:text-neon-cyan transition-colors cursor-pointer bg-transparent border-0 p-0"
          >
            <ArrowLeft size={16} />
            Back
          </button>
          <Link to="/" className="flex items-center gap-1.5 text-sm text-muted hover:text-neon-cyan transition-colors no-underline">
            <Home size={16} />
            Home
          </Link>
        </div>
      </nav>

      <main className="max-w-xl mx-auto px-4 sm:px-6 py-6">
        <h1 className="text-xl font-semibold mb-1 flex items-center gap-2">
          <ShieldCheck size={20} className="text-neon-cyan" />
          Privacy Policy
        </h1>
        <p className="text-xs text-faint mb-6">Last updated: {LAST_UPDATED}</p>

        <section className="mb-6">
          <p className="text-sm text-muted leading-relaxed">
            Arcaid (arcaid.app) is a community platform for running tournaments and leaderboards for
            virtual pinball and retro arcade gaming. This policy explains, in plain language, what we
            collect, why, and how you can remove it.
          </p>
        </section>

        <section className="mb-6">
          <h2 className="text-sm font-medium mb-1.5">What we collect</h2>
          <ul className="mt-2 space-y-2 text-sm text-muted list-disc pl-5 marker:text-faint">
            <li>
              <strong className="font-medium text-primary">Discord account info</strong> — only if you
              choose to log in. We use Discord sign-in with the <span className="font-mono text-xs">identify</span>{' '}
              scope only, which gives us your Discord user ID, username, and avatar <em>hash</em>. We do
              not store a copy of your avatar image — it loads directly from Discord. We do not request
              your email address or your list of Discord servers.
            </li>
            <li>
              <strong className="font-medium text-primary">Chosen display name</strong> — an optional
              name you can set so it appears on leaderboards instead of your game handle.
            </li>
            <li>
              <strong className="font-medium text-primary">Linked game handles</strong> — the iScored
              names you submit scores under, linked to your account so scores are credited to you.
            </li>
            <li>
              <strong className="font-medium text-primary">Scores and score history</strong> — each score
              you submit, including the game, platform, value, timestamp, and the tournament it counted toward.
            </li>
            <li>
              <strong className="font-medium text-primary">Score-proof photos (optional)</strong> — if you
              attach a photo to a score, that image file is stored on our server and shown alongside the score.
            </li>
            <li>
              <strong className="font-medium text-primary">Preferences and memberships</strong> — your
              notification and scoreboard settings, and which rooms you have joined.
            </li>
            <li>
              <strong className="font-medium text-primary">Community activity</strong> — players you follow,
              and any comments, tips, and ratings you leave on games.
            </li>
            <li>
              <strong className="font-medium text-primary">Technical information</strong> — to keep you
              signed in, we store login tokens in your browser's localStorage (we do not use tracking
              cookies). We also store a random device identifier (<span className="font-mono text-xs">arcaid_anon_id</span>)
              in localStorage. When administrators take certain actions, we record the IP address involved
              in an audit log for security.
            </li>
          </ul>
        </section>

        <section className="mb-6">
          <h2 className="text-sm font-medium mb-1.5">How we use it</h2>
          <ul className="mt-2 space-y-1 text-sm text-muted list-disc pl-5 marker:text-faint">
            <li>Run tournaments and keep leaderboards and rankings accurate.</li>
            <li>Credit each score to the right player.</li>
            <li>Show your name and avatar to other players, which is how leaderboards work.</li>
            <li>Send the Discord notifications you have opted into.</li>
            <li>Detect and prevent cheating and abuse, and keep the service secure.</li>
          </ul>
        </section>

        <div className="mb-6 rounded border border-border bg-surface/50 px-4 py-3">
          <h2 className="text-sm font-medium mb-1.5">If you don't log in (guests)</h2>
          <p className="text-sm text-muted leading-relaxed">
            You can use Arcaid without logging in with Discord. If you do, we do not store a Discord
            identity for you. All that remains is the random device id in your browser's localStorage and
            any scores you choose to submit under a guest name (plus any proof photo you attach to them).
            Clearing your browser storage removes the device id.
          </p>
        </div>

        <section className="mb-6">
          <h2 className="text-sm font-medium mb-1.5">Who we share it with</h2>
          <p className="text-sm text-muted leading-relaxed">
            We do not sell your data or run advertising trackers. We share only what's needed with the
            services that make Arcaid work: <strong className="font-medium text-primary">Discord</strong>{' '}
            (to sign you in and send notifications) and <strong className="font-medium text-primary">iScored</strong>{' '}
            (to sync scores in rooms that use it). Your display name, avatar, scores, and community
            activity are visible to other players by design.
          </p>
        </section>

        <section className="mb-6">
          <h2 className="text-sm font-medium mb-1.5">Retention and deleting your account</h2>
          <p className="text-sm text-muted leading-relaxed">
            We keep your personal data while your account is active. You can remove it at any time from{' '}
            <strong className="font-medium text-primary">Account Settings → Delete Account</strong>, or by
            asking a room administrator to delete your account for you.
          </p>
          <div className="mt-3 rounded border border-border bg-surface/50 px-4 py-3">
            <p className="text-sm text-muted leading-relaxed">
              <strong className="font-medium text-primary">What deletion does.</strong> We remove your
              personal data — Discord ID, avatar, display name, linked handles, preferences, sessions,
              comments, ratings, friendships, and any score-proof photos. Your{' '}
              <strong className="font-medium text-primary">scores stay on the leaderboards under the game
              handle you used</strong>, but they are de-identified: the link to your Discord identity is
              removed. This keeps historical leaderboards and rankings intact while erasing who you are.
            </p>
          </div>
          <p className="mt-3 text-sm text-muted leading-relaxed">
            A few records are kept even after deletion for legitimate reasons, and we disclose them here
            so you know they exist: security audit logs (which may include a Discord ID and IP address
            from past administrative actions) and any moderation or ban records needed to prevent abuse.
          </p>
        </section>

        <section className="mb-6">
          <h2 className="text-sm font-medium mb-1.5">Your choices</h2>
          <p className="text-sm text-muted leading-relaxed">
            From Account Settings you can set or clear your display name, manage your notification
            preferences, and delete your account. Logging out clears your login tokens from your browser.
          </p>
        </section>

        <section className="mb-6">
          <h2 className="text-sm font-medium mb-1.5">Changes to this policy</h2>
          <p className="text-sm text-muted leading-relaxed">
            We may update this policy from time to time. Material changes will be reflected here with a
            new "last updated" date.
          </p>
        </section>

        <section className="mb-2">
          <h2 className="text-sm font-medium mb-1.5">Contact</h2>
          <p className="text-sm text-muted leading-relaxed">
            Questions about your data or this policy? Reach the administrators of your room, or the site
            operator, through the community's Discord.
          </p>
        </section>

        <div className="mt-8 pt-6 border-t border-border flex items-center justify-between text-sm">
          <Link to="/terms" className="text-neon-cyan hover:underline no-underline">
            Terms of Service →
          </Link>
          <Link to="/" className="text-muted hover:text-neon-cyan no-underline">
            Home
          </Link>
        </div>
      </main>
    </div>
  );
}
