import { Link } from 'react-router-dom';
import { ArrowLeft, Home, ScrollText } from 'lucide-react';

/**
 * Static terms of service for ArcAid. Public, no auth, no data fetching.
 * Mirrors the AccountSettings.tsx skeleton (own Back/Home nav + max-w-xl main).
 *
 * NOTE: This copy is a plain-language starting point and should be reviewed by
 * the operator (and, where required, legal counsel) before launch — especially
 * the disclaimer and liability section.
 */
const LAST_UPDATED = 'July 2026';

export default function Terms() {
  return (
    <div className="min-h-screen bg-deep text-primary">
      <nav className="border-b border-border bg-surface/80 backdrop-blur-sm">
        <div className="max-w-xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
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
          <ScrollText size={20} className="text-neon-cyan" />
          Terms of Service
        </h1>
        <p className="text-xs text-faint mb-6">Last updated: {LAST_UPDATED}</p>

        <section className="mb-6">
          <h2 className="text-sm font-medium mb-1.5">1. Acceptance</h2>
          <p className="text-sm text-muted leading-relaxed">
            By accessing or using ArcAid (arcaid.app), you agree to these terms. If you do not agree,
            please do not use the service.
          </p>
        </section>

        <section className="mb-6">
          <h2 className="text-sm font-medium mb-1.5">2. What ArcAid is</h2>
          <p className="text-sm text-muted leading-relaxed">
            ArcAid is a community platform for running tournaments and leaderboards for virtual pinball
            and retro arcade gaming. Individual "rooms" are operated by community organizers; a room's
            administrators set its rules and manage its tournaments.
          </p>
        </section>

        <section className="mb-6">
          <h2 className="text-sm font-medium mb-1.5">3. Your account</h2>
          <p className="text-sm text-muted leading-relaxed">
            You can browse as a guest or sign in with Discord. You are responsible for activity under
            your account and for keeping your Discord login secure. Do not impersonate other players or
            choose a name designed to mislead.
          </p>
        </section>

        <section className="mb-6">
          <h2 className="text-sm font-medium mb-1.5">4. Fair play</h2>
          <p className="text-sm text-muted leading-relaxed">
            ArcAid runs on trust in the scores people post. Do not submit false, manipulated, or
            fraudulently obtained scores, and do not attempt to game the leaderboards or rankings. Room
            and site administrators may verify, adjust, hide, or remove scores, and may suspend or ban
            accounts that break the rules.
          </p>
        </section>

        <section className="mb-6">
          <h2 className="text-sm font-medium mb-1.5">5. Acceptable use</h2>
          <p className="text-sm text-muted leading-relaxed">
            Do not harass, threaten, or abuse other players; do not upload unlawful, hateful, or
            infringing content; and do not attempt to disrupt, overload, reverse-engineer, or gain
            unauthorized access to the service.
          </p>
        </section>

        <section className="mb-6">
          <h2 className="text-sm font-medium mb-1.5">6. Content you submit</h2>
          <p className="text-sm text-muted leading-relaxed">
            You keep ownership of what you submit — scores, proof photos, comments, tips, and ratings. By
            submitting it, you grant ArcAid and the room you post in permission to store and display it as
            part of the service. You confirm you have the right to share anything you upload and that it
            does not violate anyone else's rights.
          </p>
        </section>

        <section className="mb-6">
          <h2 className="text-sm font-medium mb-1.5">7. Moderation</h2>
          <p className="text-sm text-muted leading-relaxed">
            Administrators may remove content or accounts at their discretion to keep rooms fair and
            welcoming. Score adjustments and tournament decisions are ultimately up to the operators of
            each room.
          </p>
        </section>

        <section className="mb-6">
          <h2 className="text-sm font-medium mb-1.5">8. Availability</h2>
          <p className="text-sm text-muted leading-relaxed">
            ArcAid is provided "as is" and "as available." We do not guarantee that it will be
            uninterrupted or error-free, or that data will never be lost, and features may change or be
            discontinued at any time.
          </p>
        </section>

        <section className="mb-6">
          <h2 className="text-sm font-medium mb-1.5">9. Disclaimer and liability</h2>
          <p className="text-sm text-muted leading-relaxed">
            To the fullest extent permitted by law, ArcAid and its operators provide the service without
            warranties of any kind and are not liable for indirect, incidental, or consequential damages
            arising from your use of the service.
          </p>
        </section>

        <section className="mb-6">
          <h2 className="text-sm font-medium mb-1.5">10. Termination</h2>
          <p className="text-sm text-muted leading-relaxed">
            You may stop using ArcAid and delete your account at any time from Account Settings. Operators
            may suspend or terminate access for conduct that violates these terms.
          </p>
        </section>

        <section className="mb-6">
          <h2 className="text-sm font-medium mb-1.5">11. Changes to these terms</h2>
          <p className="text-sm text-muted leading-relaxed">
            We may update these terms from time to time. Continued use after an update means you accept
            the revised terms.
          </p>
        </section>

        <section className="mb-2">
          <h2 className="text-sm font-medium mb-1.5">12. Contact</h2>
          <p className="text-sm text-muted leading-relaxed">
            Questions about these terms? Contact your room's administrators or the site operator through
            the community's Discord.
          </p>
        </section>

        <div className="mt-8 pt-6 border-t border-border flex items-center justify-between text-sm">
          <Link to="/privacy" className="text-neon-cyan hover:underline no-underline">
            Privacy Policy →
          </Link>
          <Link to="/" className="text-muted hover:text-neon-cyan no-underline">
            Home
          </Link>
        </div>
      </main>
    </div>
  );
}
