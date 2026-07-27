import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api';
import NeonCard from '../components/NeonCard';

const SECTIONS = [
  { id: 'getting-started', label: 'Getting Started' },
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'settings', label: 'Settings' },
  { id: 'game-library', label: 'Game Library' },
  { id: 'tournaments', label: 'Tournaments' },
  { id: 'leaderboard', label: 'Leaderboard' },
  { id: 'rankings', label: 'Rankings' },
  { id: 'stats', label: 'Stats' },
  { id: 'history', label: 'History' },
  { id: 'discord-commands', label: 'Discord Commands' },
  { id: 'public-pages', label: 'Public Pages' },
  { id: 'styles', label: 'Style Catalogue' },
  { id: 'game-states', label: 'Game States' },
  { id: 'setup-checklist', label: 'Setup Checklist' },
];

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="font-display text-xl font-bold text-primary mt-10 mb-4 scroll-mt-6">
      {children}
    </h2>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="font-display text-base font-bold text-neon-cyan mt-6 mb-3">{children}</h3>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={`text-left text-xs font-display uppercase tracking-wider text-muted px-3 py-2 border-b border-border ${className}`}>
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={`text-sm text-primary px-3 py-2 border-b border-border ${className}`}>
      {children}
    </td>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="font-mono text-xs bg-raised border border-border rounded px-1.5 py-0.5 text-neon-amber">
      {children}
    </code>
  );
}

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-neon-amber/30 bg-neon-amber/5 rounded-lg px-4 py-3 my-3">
      <span className="text-neon-amber font-display text-xs uppercase tracking-wider font-bold">Tip: </span>
      <span className="text-muted text-sm">{children}</span>
    </div>
  );
}

function CheckItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm text-primary py-1">
      <span className="text-neon-green mt-0.5 flex-shrink-0">&#9744;</span>
      <span>{children}</span>
    </li>
  );
}

export default function Help() {
  const [activeSection, setActiveSection] = useState(SECTIONS[0].id);
  const [tocOpen, setTocOpen] = useState(false);
  const [version, setVersion] = useState<{ version: string; commit: string | null; builtAt: string | null } | null>(null);
  const [query, setQuery] = useState('');
  const [sectionText, setSectionText] = useState<Record<string, string>>({});
  const [matchCount, setMatchCount] = useState(0);
  const [activeMatch, setActiveMatch] = useState(-1);
  const contentRef = useRef<HTMLDivElement>(null);
  const rangesRef = useRef<Range[]>([]);
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    api.get<{ version: string; commit: string | null; builtAt: string | null }>('/version')
      .then(setVersion)
      .catch(() => {});
  }, []);

  // Build a full-text search index per section by walking the rendered content
  // once after mount — keeps the static JSX intact (no per-section refactor).
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const index: Record<string, string> = {};
    let currentId: string | null = null;
    for (const child of Array.from(root.children)) {
      const el = child as HTMLElement;
      if (el.tagName === 'H2' && el.id && SECTIONS.some(s => s.id === el.id)) {
        currentId = el.id;
        index[currentId] = el.textContent || '';
      } else if (currentId) {
        index[currentId] += ' ' + (el.textContent || '');
      }
    }
    for (const k of Object.keys(index)) index[k] = index[k].toLowerCase();
    setSectionText(index);
  }, []);

  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
          }
        }
      },
      { rootMargin: '-80px 0px -70% 0px', threshold: 0 }
    );

    for (const section of SECTIONS) {
      const el = document.getElementById(section.id);
      if (el) observerRef.current.observe(el);
    }

    return () => observerRef.current?.disconnect();
  }, []);

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
    setTocOpen(false);
  };

  // In-page search highlighting via the CSS Custom Highlight API — highlights
  // every occurrence of each term across the rendered guide WITHOUT mutating the
  // DOM (safe against React re-renders). Degrades to the jump-to chips when the
  // API is unavailable.
  const hlSupported = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof (globalThis as any).Highlight !== 'undefined';

  useEffect(() => {
    if (!hlSupported) return;
    const H = (CSS as any).highlights as Map<string, unknown>;
    H.delete('help-hl');
    H.delete('help-hl-active');
    const root = contentRef.current;
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!root || terms.length === 0) { rangesRef.current = []; setMatchCount(0); setActiveMatch(-1); return; }

    const ranges: Range[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        let el = (node as Text).parentElement;
        while (el && el !== root) {
          if (el.dataset && 'noHighlight' in el.dataset) return NodeFilter.FILTER_REJECT;
          el = el.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const lower = node.nodeValue!.toLowerCase();
      for (const term of terms) {
        let i = lower.indexOf(term);
        while (i !== -1) {
          const r = document.createRange();
          r.setStart(node, i);
          r.setEnd(node, i + term.length);
          ranges.push(r);
          i = lower.indexOf(term, i + term.length);
        }
      }
    }
    ranges.sort((a, b) => a.compareBoundaryPoints(Range.START_TO_START, b));
    rangesRef.current = ranges;
    setMatchCount(ranges.length);
    setActiveMatch(ranges.length ? 0 : -1);
    if (ranges.length) {
      H.set('help-hl', new (globalThis as any).Highlight(...ranges));
      // Show the current-match emphasis immediately (no scroll — scrolling is
      // reserved for explicit navigation so typing doesn't jump the page).
      const active = new (globalThis as any).Highlight(ranges[0]);
      active.priority = 1;
      H.set('help-hl-active', active);
    }

    return () => { H.delete('help-hl'); H.delete('help-hl-active'); };
  }, [query, hlSupported]);

  // Emphasize + scroll to the active match.
  useEffect(() => {
    if (!hlSupported) return;
    const H = (CSS as any).highlights as Map<string, unknown>;
    H.delete('help-hl-active');
    const ranges = rangesRef.current;
    if (activeMatch < 0 || activeMatch >= ranges.length) return;
    const r = ranges[activeMatch];
    const active = new (globalThis as any).Highlight(r);
    active.priority = 1;
    H.set('help-hl-active', active);
    (r.startContainer.parentElement as HTMLElement | null)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeMatch, hlSupported]);

  const gotoMatch = (dir: number) => {
    const n = rangesRef.current.length;
    if (n === 0) return;
    setActiveMatch((prev) => ((prev + dir) % n + n) % n);
  };

  const tableClass = 'w-full border-collapse';
  const tableWrapClass = 'overflow-x-auto rounded-lg border border-border';

  const q = query.trim().toLowerCase();
  const terms = q ? q.split(/\s+/).filter(Boolean) : [];
  const sectionHits: Record<string, number> = {};
  if (terms.length) {
    for (const s of SECTIONS) {
      const text = s.label.toLowerCase() + ' ' + (sectionText[s.id] || '');
      let c = 0;
      for (const t of terms) { let i = text.indexOf(t); while (i !== -1) { c++; i = text.indexOf(t, i + t.length); } }
      sectionHits[s.id] = c;
    }
  }
  const sectionsWithHits = SECTIONS.filter(s => (sectionHits[s.id] || 0) > 0);

  return (
    <div className="flex gap-8">
      {/* Mobile TOC toggle */}
      <button
        onClick={() => setTocOpen(!tocOpen)}
        className="lg:hidden fixed bottom-4 right-4 z-50 bg-surface border border-neon-cyan/40 text-neon-cyan rounded-full w-12 h-12 flex items-center justify-center shadow-lg cursor-pointer"
        title="Table of contents"
      >
        <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* Mobile TOC overlay */}
      {tocOpen && (
        <div className="lg:hidden fixed inset-0 z-40 bg-black/60" onClick={() => setTocOpen(false)}>
          <nav
            className="absolute right-0 top-0 bottom-0 w-64 bg-surface border-l border-border p-6 overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="font-display text-xs uppercase tracking-wider text-muted mb-4">Contents</p>
            <ul className="space-y-1">
              {SECTIONS.map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => scrollTo(s.id)}
                    className={`w-full text-left text-sm px-2 py-1.5 rounded cursor-pointer bg-transparent border-none transition-colors flex items-center justify-between gap-2 ${
                      activeSection === s.id
                        ? 'text-neon-cyan bg-neon-cyan/10'
                        : 'text-muted hover:text-primary'
                    }`}
                  >
                    <span>{s.label}</span>
                    {q && (sectionHits[s.id] || 0) > 0 && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-neon-cyan/15 text-neon-cyan">{sectionHits[s.id]}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      )}

      {/* Desktop sticky sidebar TOC */}
      <nav className="hidden lg:block w-52 flex-shrink-0">
        <div className="sticky top-6">
          <p className="font-display text-xs uppercase tracking-wider text-muted mb-4">Contents</p>
          <ul className="space-y-0.5">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => scrollTo(s.id)}
                  className={`w-full text-left text-sm px-2 py-1.5 rounded cursor-pointer bg-transparent border-none transition-colors flex items-center justify-between gap-2 ${
                    activeSection === s.id
                      ? 'text-neon-cyan bg-neon-cyan/10 font-medium'
                      : 'text-muted hover:text-primary'
                  }`}
                >
                  <span>{s.label}</span>
                  {q && (sectionHits[s.id] || 0) > 0 && (
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-neon-cyan/15 text-neon-cyan">{sectionHits[s.id]}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      {/* Main content */}
      <div ref={contentRef} className="flex-1 min-w-0">
        <h1 className="font-display text-2xl font-bold mb-2">Help &amp; Guide</h1>
        <p className="text-muted text-sm mb-6">
          Everything you need to know about managing your game room in ArcAid.
        </p>

        {/* Search — highlights every match in-page + match navigation + jump-to */}
        <div className="mb-8" data-no-highlight>
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-faint pointer-events-none" width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="7" strokeWidth="2" />
              <path strokeLinecap="round" strokeWidth="2" d="M21 21l-4.3-4.3" />
            </svg>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); gotoMatch(e.shiftKey ? -1 : 1); } }}
              placeholder="Search the guide…  (Enter / Shift+Enter jumps between matches)"
              aria-label="Search the help guide"
              className="w-full bg-raised border border-border rounded-lg pl-10 pr-9 py-2.5 text-sm text-primary placeholder:text-faint focus:outline-none focus:border-neon-cyan/50"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-faint hover:text-primary bg-transparent border-none cursor-pointer text-sm"
              >
                ✕
              </button>
            )}
          </div>
          {q && (
            <div className="mt-3">
              {(hlSupported ? matchCount > 0 : sectionsWithHits.length > 0) ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                  {hlSupported && (
                    <div className="inline-flex items-center gap-2">
                      <span className="text-muted">{matchCount} match{matchCount === 1 ? '' : 'es'}{sectionsWithHits.length > 1 ? ` in ${sectionsWithHits.length} sections` : ''}</span>
                      <span className="inline-flex items-center border border-border rounded-md overflow-hidden">
                        <button onClick={() => gotoMatch(-1)} aria-label="Previous match" className="px-2 py-0.5 text-muted hover:text-neon-cyan bg-transparent border-none cursor-pointer">‹</button>
                        <span className="px-2 py-0.5 font-mono text-faint border-l border-r border-border">{activeMatch + 1}/{matchCount}</span>
                        <button onClick={() => gotoMatch(1)} aria-label="Next match" className="px-2 py-0.5 text-muted hover:text-neon-cyan bg-transparent border-none cursor-pointer">›</button>
                      </span>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-faint">Jump to:</span>
                    {sectionsWithHits.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => scrollTo(s.id)}
                        className="text-xs px-2.5 py-1 rounded-full border border-neon-cyan/30 text-neon-cyan bg-neon-cyan/5 hover:bg-neon-cyan/10 cursor-pointer inline-flex items-center gap-1"
                      >
                        {s.label}<span className="opacity-70">{sectionHits[s.id]}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-faint text-sm px-1">No matches for “{query}”.</p>
              )}
            </div>
          )}
        </div>

        {/* ------------------------------------------------------------------ */}
        {/* 1. GETTING STARTED */}
        {/* ------------------------------------------------------------------ */}
        <SectionHeading id="getting-started">1. Getting Started</SectionHeading>
        <NeonCard className="mb-4">
          <p className="text-primary text-sm mb-4">
            Navigate to the login URL provided by your ArcAid administrator. The URL follows the format:
          </p>
          <div className="bg-raised border border-border rounded px-4 py-2 mb-4">
            <code className="font-mono text-sm text-neon-amber">https://arcaid.app/your_room_slug/login</code>
          </div>

          <SubHeading>Option A: Local Admin (Username / Password)</SubHeading>
          <p className="text-primary text-sm mb-3">
            Enter the username and password provided during onboarding, then click <strong>Log In</strong>.
            Local admin accounts are created through the invite system by an existing admin.
          </p>

          <SubHeading>Option B: Discord OAuth</SubHeading>
          <p className="text-primary text-sm mb-3">
            Click <strong>Login with Discord</strong> to authenticate with your Discord account.
            This works if your Discord user has been added as a room admin in Settings &rarr; Users.
          </p>

          <Tip>
            After logging in you will land on the Dashboard. Your session persists until you
            log out or the token expires.
          </Tip>
        </NeonCard>

        {/* ------------------------------------------------------------------ */}
        {/* 2. DASHBOARD */}
        {/* ------------------------------------------------------------------ */}
        <SectionHeading id="dashboard">2. Dashboard</SectionHeading>
        <NeonCard className="mb-4">
          <p className="text-primary text-sm mb-4">
            The Dashboard gives you a quick snapshot of your room's current state.
          </p>

          <SubHeading>System Status</SubHeading>
          <p className="text-muted text-sm mb-2">A single card across the top showing live health, refreshed every 30 seconds:</p>
          <ul className="list-disc list-inside text-sm text-primary space-y-1 mb-4">
            <li><span className="text-neon-green font-medium">Discord</span> &mdash; Real gateway connection state (green pulse = connected, magenta = offline), plus <span className="text-primary">in server</span> / <span className="text-neon-amber">not in server</span> when a Guild ID is set. Shows <span className="text-muted">Discord disabled</span> if the bot is turned off for this room.</li>
            <li><span className="text-neon-green font-medium">iScored Sync</span> &mdash; Background score-sync health with the time of the last successful sync (reads <span className="text-muted">Sync paused / degraded / idle</span> as appropriate). If an account keeps failing, a red line names the account, the consecutive-failure count, and the last error.</li>
            <li><span className="text-neon-cyan font-medium">Active Tournaments</span> &amp; <span className="text-neon-green font-medium">Active Players</span> &mdash; Counts of running tournaments and of unique players with scores.</li>
            <li><span className="text-neon-amber font-medium">Version</span> &mdash; The running app version (and build) so you can confirm what's deployed.</li>
          </ul>

          <SubHeading>Active Now</SubHeading>
          <p className="text-muted text-sm mb-2">
            One card per active tournament showing:
          </p>
          <ul className="list-disc list-inside text-sm text-primary space-y-1 mb-4">
            <li>Current game name</li>
            <li>Tournament name and badge</li>
            <li>Player count and a "Time Left" countdown to the next rotation</li>
            <li>Current leader and their score</li>
          </ul>

          <SubHeading>Recent Winners</SubHeading>
          <p className="text-muted text-sm">
            The last 5 tournament winners with their game, score, and completion date.
          </p>
        </NeonCard>

        {/* ------------------------------------------------------------------ */}
        {/* 3. SETTINGS */}
        {/* ------------------------------------------------------------------ */}
        <SectionHeading id="settings">3. Settings</SectionHeading>
        <p className="text-muted text-sm mb-4">
          Navigate to <strong className="text-primary">Settings</strong> in the sidebar to configure your game room.
          Settings are grouped into cards. As you edit, an <strong className="text-primary">"N unsaved changes"</strong> indicator
          appears and <strong className="text-primary">Save All Changes</strong> stays disabled until something actually changes;
          ArcAid also warns you before you navigate away with unsaved edits. Access-affecting toggles (login required, iScored,
          Discord, global scoreboard) ask for confirmation on save.
        </p>

        {/* Game Room */}
        <NeonCard title="Game Room" className="mb-4">
          <p className="text-muted text-sm mb-3">
            Your room's <strong>Name</strong> and <strong>Slug</strong> are shown here <strong>read-only</strong> &mdash; they're set
            by the super-admin when your room is created. To rename a room or change its URL, contact your server admin.
          </p>
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead><tr><Th className="w-1/3">Field</Th><Th>What It Is</Th></tr></thead>
              <tbody>
                <tr><Td><strong>Game Room Name</strong></Td><Td>Display name shown on the public landing page and all public pages</Td></tr>
                <tr><Td><strong>Game Room Slug</strong></Td><Td>URL identifier (e.g., <Code>my_room</Code> makes your scoreboard available at <Code>/my_room/</Code>)</Td></tr>
              </tbody>
            </table>
          </div>
        </NeonCard>

        {/* Discord */}
        <NeonCard title="Discord" className="mb-4">
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead><tr><Th className="w-1/3">Setting</Th><Th>What It Does</Th></tr></thead>
              <tbody>
                <tr><Td><strong>Discord Guild ID</strong></Td><Td>Your Discord server's ID. Right-click your server name &rarr; Copy Server ID</Td></tr>
                <tr><Td><strong>Default Announcement Channel</strong></Td><Td>Default channel for tournament announcements. Used as a fallback when a tournament doesn't have its own channel configured</Td></tr>
                <tr><Td><strong>Admin Role</strong></Td><Td>Discord role ID that grants access to admin-only bot commands</Td></tr>
              </tbody>
            </table>
          </div>
          <Tip>
            To get a Channel ID or Role ID: Enable <strong>Developer Mode</strong> in Discord
            (User Settings &rarr; Advanced &rarr; Developer Mode), then right-click the channel or role &rarr; Copy ID.
          </Tip>
        </NeonCard>

        {/* iScored */}
        <NeonCard title="iScored" className="mb-4">
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead><tr><Th className="w-1/3">Setting</Th><Th>What It Does</Th></tr></thead>
              <tbody>
                <tr><Td><strong>iScored Username</strong></Td><Td>Login email/username for your room's iScored.info account</Td></tr>
                <tr><Td><strong>iScored Password</strong></Td><Td>Password for the iScored account (masked by default, click the eye icon to reveal)</Td></tr>
                <tr><Td><strong>iScored Public URL</strong></Td><Td>The public leaderboard URL used for score scraping (e.g., <Code>https://iscored.info/your_account</Code>)</Td></tr>
              </tbody>
            </table>
          </div>
          <p className="text-muted text-sm mt-3">
            These credentials allow ArcAid to automate game creation, locking, and score retrieval on iScored.
          </p>
        </NeonCard>

        {/* Integrations */}
        <NeonCard title="Integrations" className="mb-4">
          <p className="text-muted text-sm mb-3">
            Feature toggles for this room. Changing an access-affecting one prompts for confirmation on save.
          </p>
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead><tr><Th className="w-1/3">Toggle</Th><Th>What It Does</Th></tr></thead>
              <tbody>
                <tr><Td><strong>iScored Integration</strong></Td><Td>Enable/disable iScored sync + game management for this room</Td></tr>
                <tr><Td><strong>Discord Integration</strong></Td><Td>Enable/disable the Discord bot for this room (announcements, commands, DMs)</Td></tr>
                <tr><Td><strong>Discord @Mentions</strong></Td><Td>Whether announcements @-mention players</Td></tr>
                <tr><Td><strong>Post Scores to Global Scoreboard</strong></Td><Td>Fan this room's scores out to the cross-room Global Scoreboard</Td></tr>
                <tr><Td><strong>Require Login for Score Submissions</strong></Td><Td>Force Discord login before anyone can submit a score</Td></tr>
                <tr><Td><strong>Enable Game Pick Award</strong></Td><Td>Turn on the winner-picks-next-game flow (and the Mystery Award)</Td></tr>
                <tr><Td><strong>Callouts</strong></Td><Td>Fun automated bot replies to trigger phrases</Td></tr>
              </tbody>
            </table>
          </div>
          <Tip>
            Cooldown, pick windows, timezone, and platform rules are configured <strong>per tournament</strong> on the Tournaments page &mdash; not here.
          </Tip>
        </NeonCard>

        {/* Kiosk */}
        <NeonCard title="Kiosk" className="mb-4">
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead><tr><Th className="w-1/3">Setting</Th><Th>What It Does</Th></tr></thead>
              <tbody>
                <tr><Td><strong>Kiosk Mode</strong></Td><Td>Enable the full-screen kiosk leaderboard at <Code>/your_slug/kiosk</Code> for TV displays</Td></tr>
                <tr><Td><strong>Kiosk Auto-Refresh</strong></Td><Td>How often (seconds) the kiosk view refreshes</Td></tr>
              </tbody>
            </table>
          </div>
        </NeonCard>

        {/* Theme */}
        <NeonCard title="Theme" className="mb-4">
          <p className="text-primary text-sm mb-3">
            Choose from ArcAid's themes (17 and counting &mdash; Dark, Light, Retro, Cyberpunk, Ocean, Sunset, Backglass,
            CRT Green, Cabinet, Silverball, and more).
          </p>
          <p className="text-muted text-sm">
            Set a <strong className="text-primary">Public Theme</strong> that every visitor sees, and optionally an
            <strong className="text-primary"> Admin Theme</strong> that only changes your own admin experience.
          </p>
        </NeonCard>

        {/* Scoreboard Display */}
        <NeonCard title="Leaderboard Display" className="mb-4">
          <p className="text-primary text-sm mb-3">
            Controls the appearance of your public scoreboard. Uses a 2-level selection system.
          </p>
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead><tr><Th className="w-1/3">Setting</Th><Th>What It Does</Th></tr></thead>
              <tbody>
                <tr><Td><strong>Card Style</strong></Td><Td>Choose a card layout: <strong>Banner</strong> (280px, iScored-compatible), <strong>Showcase</strong> (380px, art-forward with podium), or <strong>Minimal</strong> (typography-only)</Td></tr>
                <tr><Td><strong>Theme</strong></Td><Td>Visual skin for Showcase cards: <strong>Glass Deck</strong> (dark glass, pyramid podium) or <strong>Neon Circuit</strong> (circuit board background, animated glow). Only applies to Showcase style</Td></tr>
                <tr><Td><strong>Scores Per Card</strong></Td><Td>How many scores to show per game card (5, 10, 15, or 20)</Td></tr>
                <tr><Td><strong>Show Timer</strong></Td><Td>Display countdown to next scheduled rotation on each card</Td></tr>
                <tr><Td><strong>Layout</strong></Td><Td>Grid (auto-filling columns) or Scroll (horizontal scrolling row)</Td></tr>
                <tr><Td><strong>Hide Empty Games</strong></Td><Td>When enabled, games with no scores yet are hidden from the public scoreboard</Td></tr>
                <tr><Td><strong>QR Code Mode</strong></Td><Td>Show score-submission QR codes on cards: Disabled, Kiosk Only, or All</Td></tr>
                <tr><Td><strong>Zoom</strong></Td><Td>Scale the whole leaderboard (50%&ndash;200%) for TV/kiosk displays</Td></tr>
              </tbody>
            </table>
          </div>
          <Tip>
            The new card system is the default. Older presets are still available under <strong>Show more styles</strong>.
          </Tip>
        </NeonCard>

        {/* Branding */}
        <NeonCard title="Leaderboard Branding" className="mb-4">
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead><tr><Th className="w-1/3">Setting</Th><Th>What It Does</Th></tr></thead>
              <tbody>
                <tr><Td><strong>Background Image</strong></Td><Td>Full-page background for the leaderboard (uploaded or URL)</Td></tr>
                <tr><Td><strong>Logo</strong></Td><Td>Logo image with configurable position (left, right, above, below title), max height, and a show/hide toggle</Td></tr>
                <tr><Td><strong>Leaderboard Title</strong></Td><Td>Text shown above the leaderboard (defaults to room name), with a Title Style and Title Size. Can be hidden</Td></tr>
              </tbody>
            </table>
          </div>
        </NeonCard>

        {/* Platforms moved to the Game Library page (per-room platforms + tags) */}

        {/* Users */}
        <NeonCard title="Users" className="mb-4">
          <SubHeading>Discord Admins</SubHeading>
          <p className="text-muted text-sm mb-3">
            Add Discord users who can log in via OAuth. Enter their Discord username or numeric ID.
            They can log in immediately after being added.
          </p>

          <SubHeading>Local Admins</SubHeading>
          <p className="text-muted text-sm mb-3">
            Username/password accounts listed here. These are created through the invite system (see below).
          </p>

          <SubHeading>Inviting a New Admin</SubHeading>
          <ol className="list-decimal list-inside text-sm text-primary space-y-1 mb-3">
            <li>Click <strong>Invite Local User</strong></li>
            <li>Enter a display name for the new admin</li>
            <li>Optionally enter their Discord username to send the invite via DM</li>
            <li>Click <strong>Send Invite</strong></li>
            <li>Copy the invite link and share it (link expires in 48 hours)</li>
          </ol>
          <p className="text-muted text-sm">
            The invited user visits the link, creates a username and password, and can immediately log in.
          </p>
        </NeonCard>

        {/* Moved actions */}
        <NeonCard title="Where did System Actions go?" className="mb-4">
          <div className="space-y-3">
            <p className="text-muted text-sm">
              <strong className="text-primary">Refresh Schedules</strong> (formerly "Reload Scheduler") now lives on the
              <strong className="text-primary"> Tournaments</strong> page &mdash; it re-applies schedule/timezone changes
              immediately. The scheduler also reloads automatically when you save a tournament.
            </p>
            <p className="text-muted text-sm">
              <strong className="text-primary">Merge / Rename Player</strong> now has its own <strong className="text-primary">Identity</strong>
              page: consolidate two usernames or fix a misspelling (updates scores, submissions, and mappings across the room,
              with a dry-run preview). If the name was also wrong on iScored, fix it there first so the old name doesn't re-import.
            </p>
          </div>
        </NeonCard>

        {/* ------------------------------------------------------------------ */}
        {/* 4. GAME LIBRARY */}
        {/* ------------------------------------------------------------------ */}
        <SectionHeading id="game-library">4. Game Library</SectionHeading>
        <NeonCard className="mb-4">
          <p className="text-primary text-sm mb-4">
            Your Game Library is a view of ArcAid's <strong>shared global catalogue</strong> &mdash; the same catalogue every
            room draws from. Navigate to <strong>Game Library</strong> in the sidebar to search it, activate games, pin games,
            tag them for your room, and propose new titles.
          </p>

          <SubHeading>Adding Games to the Catalogue</SubHeading>
          <p className="text-muted text-sm mb-3">
            Most games already exist in the catalogue &mdash; just search and use them. To add something new you propose it for
            super-admin review; approved titles then become available to every room:
          </p>
          <div className="space-y-3 mb-4">
            <div className="bg-raised border border-border rounded-lg px-4 py-3">
              <p className="text-sm font-medium text-neon-cyan mb-1">Add Game</p>
              <p className="text-muted text-sm">
                Enter a <strong>Name</strong>, <strong>Mode</strong> (Pinball / Video Game), and <strong>Platforms</strong>, then click
                <strong className="text-primary"> Check catalogue</strong>. ArcAid runs a duplicate check; if it's genuinely new you can
                <strong className="text-primary"> Submit to the global catalogue for review</strong>.
              </p>
            </div>
            <div className="bg-raised border border-border rounded-lg px-4 py-3">
              <p className="text-sm font-medium text-neon-green mb-1">Import CSV</p>
              <p className="text-muted text-sm">
                Upload a CSV with columns <Code>name</Code>, <Code>manufacturer</Code>, <Code>year</Code>, <Code>mode</Code>,
                <Code>platforms</Code> (grab <strong className="text-primary">CSV Template</strong> for the format). It runs a dedup
                preview, then submits the new rows to the catalogue as pending.
              </p>
            </div>
          </div>
          <Tip>
            Bulk catalogue imports (VPS, VPXS Wizard, OPDB, IGDB, Steam, FX VR, AtGames) are a <strong>super-admin</strong> function on
            the Catalogue admin page &mdash; they aren't run from a room's Game Library.
          </Tip>

          <SubHeading>Working With Games</SubHeading>
          <p className="text-muted text-sm mb-2">Each game row offers:</p>
          <ul className="list-disc list-inside text-sm text-primary space-y-1 mb-4">
            <li><strong>Activate</strong> &mdash; Start the game in a tournament (created on iScored, appears on your leaderboard)</li>
            <li><strong>Pin</strong> &mdash; Pin a standalone game to your scoreboard without a tournament</li>
            <li><strong>Tag</strong> &mdash; Add per-room platform tags (also available as a bulk action)</li>
            <li><strong>Style</strong> &mdash; Choose or upload card art for the game</li>
          </ul>
          <p className="text-muted text-sm mb-2">Finding games:</p>
          <ul className="list-disc list-inside text-sm text-primary space-y-1 mb-4">
            <li><strong>Smart search</strong> matches name, manufacturer, year, designers, themes, table authors, aliases, platforms, and your room tags &mdash; plus year ranges like <Code>1990-1999</Code></li>
            <li><strong>Mode</strong> and <strong>Platform</strong> filters; sort by name, mode, platforms, or rating</li>
            <li>Click a game's name to open its <strong>catalogue detail</strong>; click the stars to <strong>rate</strong> it</li>
            <li>Select multiple games for the <strong>bulk action bar</strong> (Tag, Activate, Pin)</li>
          </ul>
          <p className="text-muted text-sm">
            Games come from the shared catalogue, so a room can't delete catalogue entries &mdash; use Tags and Pins to curate what your room shows.
          </p>
        </NeonCard>

        {/* ------------------------------------------------------------------ */}
        {/* 5. TOURNAMENTS */}
        {/* ------------------------------------------------------------------ */}
        <SectionHeading id="tournaments">5. Tournaments</SectionHeading>
        <NeonCard className="mb-4">
          <p className="text-primary text-sm mb-4">
            Navigate to <strong>Tournaments</strong> in the sidebar to create and manage tournament schedules.
          </p>

          <SubHeading>Creating a Tournament</SubHeading>
          <div className={`${tableWrapClass} mb-4`}>
            <table className={tableClass}>
              <thead><tr><Th className="w-1/3">Field</Th><Th>Description</Th></tr></thead>
              <tbody>
                <tr><Td><strong>Name</strong></Td><Td>Display name (e.g., "Daily Grind", "Weekly Challenge")</Td></tr>
                <tr><Td><strong>Tag</strong></Td><Td>Short code used as the iScored tag prefix. Must be unique (e.g., <Code>DG</Code>, <Code>WG-VPXS</Code>, <Code>MG</Code>)</Td></tr>
                <tr><Td><strong>Mode</strong></Td><Td>Pinball or Video Game &mdash; controls terminology (e.g., "table" vs "game") throughout the UI and Discord</Td></tr>
                <tr><Td><strong>Schedule</strong></Td><Td>How often the tournament rotates (daily, weekly, monthly), with time + timezone</Td></tr>
                <tr><Td><strong>Lineup Position</strong></Td><Td>Position in the scoreboard and announcement order (lower = first)</Td></tr>
                <tr><Td><strong>Active Slots</strong></Td><Td>How many games run simultaneously in this tournament</Td></tr>
                <tr><Td><strong>Game Rotation</strong></Td><Td>Whether the round winner picks the next game, or ArcAid auto-picks</Td></tr>
                <tr><Td><strong>Cooldown Days</strong></Td><Td>After a game finishes, how long before it can be picked again</Td></tr>
                <tr><Td><strong>Winner / Runner-up Window</strong></Td><Td>Minutes the winner (then runner-up) has to pick before auto-selection</Td></tr>
                <tr><Td><strong>Cleanup Rule</strong></Td><Td>What happens to finished games on iScored (see below)</Td></tr>
                <tr><Td><strong>Platform Rules</strong></Td><Td>Require or exclude specific platforms (see below)</Td></tr>
                <tr><Td><strong>Discord Channel</strong></Td><Td>Override the default announcement channel for this tournament</Td></tr>
              </tbody>
            </table>
          </div>

          <SubHeading>Schedule Options</SubHeading>
          <ul className="list-disc list-inside text-sm text-primary space-y-1 mb-4">
            <li><strong>Daily</strong> &mdash; Rotates every day at the specified time</li>
            <li><strong>Weekly</strong> &mdash; Rotates on a specific day of the week at the specified time</li>
            <li><strong>Monthly</strong> &mdash; Rotates on a specific day of the month (1st&ndash;31st, or <strong>Last day</strong> for end-of-month)</li>
          </ul>
          <p className="text-muted text-sm mb-4">
            All schedules include a <strong className="text-primary">time</strong> and <strong className="text-primary">timezone</strong> setting.
          </p>

          <SubHeading>Cleanup Rules</SubHeading>
          <p className="text-muted text-sm mb-2">After a tournament round completes, the finished game on iScored can be handled in three ways:</p>
          <ul className="list-disc list-inside text-sm text-primary space-y-1 mb-4">
            <li><strong>Immediate Hide</strong> &mdash; Game is hidden on iScored right after completion</li>
            <li><strong>Retain Last N</strong> &mdash; Keep the last N completed games visible, hide older ones</li>
            <li><strong>Scheduled</strong> &mdash; Run cleanup on a separate cron schedule</li>
          </ul>

          <SubHeading>Platform Rules</SubHeading>
          <p className="text-muted text-sm mb-2">If your room has multiple platforms, you can scope a tournament two independent ways:</p>
          <ul className="list-disc list-inside text-sm text-primary space-y-1 mb-4">
            <li><strong>Must be available on</strong> &mdash; A game qualifies only if it lists at least one of these platforms (controls game eligibility)</li>
            <li><strong>Not allowed on</strong> &mdash; Blocks <em>score submissions</em> from these platforms (it does not change which games are eligible)</li>
            <li><strong>No rules</strong> &mdash; All games eligible, all platforms may submit</li>
          </ul>

          <SubHeading>Tournament List</SubHeading>
          <p className="text-muted text-sm mb-2">
            The table below the creation form shows each tournament with its name, tag badge, mode, position, slots, schedule,
            and &mdash; from the health data &mdash; its <strong>Last run</strong> (OK / Skipped / Error + when) and <strong>Next fire</strong> time.
          </p>
          <ul className="list-disc list-inside text-sm text-primary space-y-1 mb-4">
            <li><strong>Pause / Resume</strong> &mdash; Temporarily stop a tournament rotating (it shows a dimmed "Paused" badge); Resume restarts it</li>
            <li><strong>Edit</strong> &mdash; Opens the full edit modal to change any setting</li>
            <li><strong>Delete</strong> &mdash; Removes the tournament. If it has active/queued games the delete is blocked and lists them; you can opt to auto-deactivate the active game(s) first, then delete</li>
            <li><strong>Sync iScored Lineup</strong> &mdash; Reorders the iScored game lineup to match your position settings</li>
            <li><strong>Refresh Schedules</strong> &mdash; Re-applies schedule/timezone changes to the scheduler immediately</li>
          </ul>

          <SubHeading>Active Games</SubHeading>
          <p className="text-muted text-sm mb-2">
            Below the tournament list, the <strong className="text-primary">Active Games</strong> section shows all
            currently running games with their tournament, start date, and iScored link status.
          </p>
          <p className="text-muted text-sm mb-2">Each active game has these actions:</p>
          <ul className="list-disc list-inside text-sm text-primary space-y-1 mb-3">
            <li><strong>Edit</strong> &mdash; Change the game's display name (shown on scoreboard instead of the raw library name)</li>
            <li><strong>Style</strong> &mdash; Choose or upload art for the game card (background and/or identifier images)</li>
            <li><strong>Deactivate</strong> &mdash; Mark the game as completed (see below)</li>
            <li><strong>Delete</strong> &mdash; Remove the game entirely (type-to-confirm), right here on this page. Scores and history are kept</li>
          </ul>
          <p className="text-muted text-sm mb-2">
            <strong className="text-primary">Deactivate</strong> marks the game as COMPLETED and locks it on iScored.
            The game remains visible on iScored (locked) and in score history. Two options:
          </p>
          <ul className="list-disc list-inside text-sm text-primary space-y-1 mb-3">
            <li><strong>Deactivate + Lock on iScored</strong> &mdash; Marks complete in ArcAid and locks the game on iScored</li>
            <li><strong>DB Only</strong> &mdash; Only updates ArcAid's database (does not touch iScored)</li>
          </ul>
          <p className="text-muted text-sm">
            A <strong className="text-primary">Retained Completed Games</strong> section lists finished games still shown on the public
            leaderboard (per your Retain-Last-N cleanup rule), each with its own Delete.
          </p>
        </NeonCard>

        {/* ------------------------------------------------------------------ */}
        {/* 6. LEADERBOARD */}
        {/* ------------------------------------------------------------------ */}
        <SectionHeading id="leaderboard">6. Leaderboard</SectionHeading>
        <NeonCard className="mb-4">
          <p className="text-primary text-sm mb-4">
            Navigate to <strong>Leaderboard</strong> in the sidebar for a live view of all active game scores and ranking groups.
          </p>

          <SubHeading>Game Cards</SubHeading>
          <p className="text-muted text-sm mb-3">
            One card per active game showing the top scores. Each card includes admin action buttons:
          </p>
          <ul className="list-disc list-inside text-sm text-primary space-y-1 mb-4">
            <li><strong>Name</strong> (pencil icon) &mdash; Edit the display name shown on the public scoreboard</li>
            <li><strong>Notes</strong> (sticky note icon) &mdash; Add notes shown to players via the info icon (e.g., table version, special rules). Highlighted when notes exist</li>
            <li><strong>Style</strong> &mdash; Choose or upload background/identifier art for the card. Highlighted when a style is applied</li>
            <li><strong>Scores</strong> &mdash; Open the Manage Scores modal to review and remove individual submissions (see below)</li>
            <li><strong>Delete</strong> (trash icon) &mdash; Remove the game from the leaderboard and iScored entirely. Player scores and history are retained for stats. Use this for games that were accidentally created or should no longer appear</li>
          </ul>

          <SubHeading>Score Management</SubHeading>
          <p className="text-muted text-sm mb-3">
            Click a card's <strong>Scores</strong> button to open the <strong>Manage Scores</strong> modal, which lists every submission for that game with a per-row delete. (On legacy cards &mdash; rooms that haven't upgraded to the new card system &mdash; you can instead click a score row to expand it and hover a submission to delete it.)
          </p>

          <SubHeading>Suppressed Scores</SubHeading>
          <p className="text-muted text-sm mb-3">
            When you delete a score that also exists on iScored, ArcAid records a <em>suppression</em> so the next sync doesn't simply re-import it. The Manage Scores modal has a <strong>Suppressed scores</strong> section listing each suppressed player and value with a <strong>Remove suppression</strong> button &mdash; removing it lets that score re-import on the next sync. (The delete confirmation warns you whenever a suppression will be created.)
          </p>

          <SubHeading>Game Info Icon</SubHeading>
          <p className="text-muted text-sm mb-3">
            On the public scoreboard, games with external URLs or admin notes show an info icon (&#x24D8;) next to
            the title. Clicking it reveals a popup with the notes and a clickable link to the game's source
            (VPS page for VPX games, GitHub for VPXS games).
          </p>

          <SubHeading>Ranking Cards</SubHeading>
          <p className="text-muted text-sm mb-3">
            If you have ranking groups configured, they appear alongside game cards with a purple accent.
            Shows the overall standings across tournaments.
          </p>

          <SubHeading>Real-Time Updates</SubHeading>
          <p className="text-muted text-sm">
            Leaderboards update in real-time via WebSocket &mdash; scores appear within seconds of being submitted.
          </p>
        </NeonCard>

        {/* ------------------------------------------------------------------ */}
        {/* 7. RANKINGS */}
        {/* ------------------------------------------------------------------ */}
        <SectionHeading id="rankings">7. Rankings</SectionHeading>
        <NeonCard className="mb-4">
          <p className="text-primary text-sm mb-4">
            Navigate to <strong>Rankings</strong> in the sidebar to set up cross-tournament player rankings.
            Rankings aggregate scores across multiple tournaments into a single overall leaderboard.
          </p>

          <SubHeading>Creating a Ranking Group</SubHeading>
          <ol className="list-decimal list-inside text-sm text-primary space-y-1 mb-4">
            <li>Click <strong>+ New Ranking Group</strong></li>
            <li>Enter a <strong>Name</strong> and optional <strong>Description</strong></li>
            <li>Choose a <strong>Ranking Method</strong> (see table below)</li>
            <li>Set <strong>Best N Games</strong> &mdash; Only the top N scores count toward the ranking (default: 25)</li>
            <li>Set <strong>Minimum Games</strong> &mdash; Player must have played at least this many games to qualify (default: 1)</li>
            <li>Select which <strong>Tournaments</strong> to include (check the boxes)</li>
            <li>Click <strong>Save</strong></li>
          </ol>

          <SubHeading>Ranking Methods</SubHeading>
          <div className={`${tableWrapClass} mb-4`}>
            <table className={tableClass}>
              <thead><tr><Th className="w-1/4">Method</Th><Th>How It Works</Th></tr></thead>
              <tbody>
                <tr>
                  <Td><strong className="text-neon-cyan">Max 10</strong></Td>
                  <Td>Awards points to the top 10 finishers: 100, 80, 65, 50, 40, 30, 20, 15, 10, 5. Final score is the sum of the player's best N games.</Td>
                </tr>
                <tr>
                  <Td><strong className="text-neon-green">Average Rank</strong></Td>
                  <Td>Average finishing position across all games. Lower is better. A player who consistently finishes 2nd will rank higher than one who alternates between 1st and 10th.</Td>
                </tr>
                <tr>
                  <Td><strong className="text-neon-amber">Best Game (PAPA)</strong></Td>
                  <Td>PAPA-style points: 100, 90, 85, 84, 83, 82... Final score is the sum of the player's best N games.</Td>
                </tr>
                <tr>
                  <Td><strong className="text-neon-magenta">Best Game (Linear)</strong></Td>
                  <Td>Linear points: 100, 99, 98, 97... Final score is the sum of the player's best N games.</Td>
                </tr>
              </tbody>
            </table>
          </div>

          <SubHeading>Managing Rankings</SubHeading>
          <p className="text-muted text-sm mb-2">Each ranking group card shows:</p>
          <ul className="list-disc list-inside text-sm text-primary space-y-1">
            <li>Current standings with rank, player name, points/average, and games played</li>
            <li><strong>View / Hide</strong> &mdash; Expand or collapse a group's standings</li>
            <li><strong>Recompute</strong> &mdash; Refresh the cached rankings</li>
            <li><strong>Edit</strong> &mdash; Change settings or tournament selection</li>
            <li><strong>Delete</strong> &mdash; Remove the ranking group</li>
          </ul>

          <SubHeading>Display Style</SubHeading>
          <p className="text-muted text-sm">
            At the top of the page, choose how ranking cards render on the public scoreboard &mdash; Match Leaderboard, Plaque,
            Compact List, or Sidebar Block. Admins can set a personal override without changing the room-wide default.
          </p>
        </NeonCard>

        {/* ------------------------------------------------------------------ */}
        {/* 8. STATS */}
        {/* ------------------------------------------------------------------ */}
        <SectionHeading id="stats">8. Stats &amp; Analytics</SectionHeading>
        <NeonCard className="mb-4">
          <p className="text-primary text-sm mb-4">
            Navigate to <strong>Stats</strong> in the sidebar to browse player and game statistics.
          </p>

          <SubHeading>Player List</SubHeading>
          <p className="text-muted text-sm mb-3">
            A table of all players with their total games played, best score, and average score.
            Click any player name to view their detail page.
          </p>

          <SubHeading>Player Detail</SubHeading>
          <p className="text-muted text-sm mb-2">Shows four stat cards:</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            {[
              { label: 'Games Played', desc: 'Total number of games', color: 'text-neon-cyan' },
              { label: 'Wins', desc: 'First-place finishes', color: 'text-neon-green' },
              { label: 'Win Rate', desc: 'Percentage of games won', color: 'text-neon-amber' },
              { label: 'Best Score', desc: 'Highest score achieved', color: 'text-neon-magenta' },
            ].map((s) => (
              <div key={s.label} className="bg-raised border border-border rounded-lg p-3 text-center">
                <p className={`text-xs font-display uppercase tracking-wider ${s.color}`}>{s.label}</p>
                <p className="text-xs text-faint mt-1">{s.desc}</p>
              </div>
            ))}
          </div>
          <p className="text-muted text-sm mb-3">
            Plus the player's best game and a list of recent scores.
          </p>

          <SubHeading>Game Lookup</SubHeading>
          <p className="text-muted text-sm mb-2">
            Use the search box to look up any game by name. The game detail view shows:
          </p>
          <ul className="list-disc list-inside text-sm text-primary space-y-1">
            <li><strong>Times Played</strong> &mdash; How many tournaments featured this game</li>
            <li><strong>All-Time High</strong> &mdash; Highest score ever recorded</li>
            <li><strong>Record Holder</strong> &mdash; Player with the all-time high</li>
            <li><strong>Average Score</strong> &mdash; Mean score across all plays</li>
          </ul>
        </NeonCard>

        {/* ------------------------------------------------------------------ */}
        {/* 9. HISTORY */}
        {/* ------------------------------------------------------------------ */}
        <SectionHeading id="history">9. History</SectionHeading>
        <NeonCard className="mb-4">
          <p className="text-primary text-sm mb-3">
            Navigate to <strong>History</strong> in the sidebar to view completed games.
          </p>
          <p className="text-muted text-sm mb-3">
            The history table shows every completed game with its tournament, winner, winning score, and
            completion date. Use the filters at the top to narrow by tournament or type.
          </p>
          <p className="text-muted text-sm">
            Results are paginated at <strong className="text-primary">20 per page</strong>.
          </p>
        </NeonCard>

        {/* ------------------------------------------------------------------ */}
        {/* 10. DISCORD COMMANDS */}
        {/* ------------------------------------------------------------------ */}
        <SectionHeading id="discord-commands">10. Discord Bot Commands</SectionHeading>
        <p className="text-muted text-sm mb-4">
          Players interact with ArcAid primarily through Discord slash commands.
        </p>

        {/* Player Commands */}
        <NeonCard title="Player Commands" glowColor="cyan" className="mb-4">
          <p className="text-muted text-sm mb-3">Available to all members in your Discord server.</p>
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead>
                <tr>
                  <Th className="w-1/5 whitespace-nowrap">Command</Th>
                  <Th className="w-2/5">What It Does</Th>
                  <Th>When to Use</Th>
                </tr>
              </thead>
              <tbody>
                <tr><Td><Code>/list-active</Code></Td><Td>Shows all currently active games across your tournaments</Td><Td className="text-muted">Check what games are running</Td></tr>
                <tr><Td><Code>/list-scores</Code></Td><Td>Shows the leaderboard for active games. Optional <Code>@user</Code> filter and pagination</Td><Td className="text-muted">See who is winning the current round</Td></tr>
                <tr><Td><Code>/submit-score</Code></Td><Td>Submit a score with a photo to iScored. Auto-links Discord to iScored on first use</Td><Td className="text-muted">After playing, submit your score</Td></tr>
                <tr><Td><Code>/view-stats</Code></Td><Td>Look up historical stats for any game (with autocomplete)</Td><Td className="text-muted">See all-time records for a game</Td></tr>
                <tr><Td><Code>/my-stats</Code></Td><Td>Personal stats card: wins, win rate, average score, best score, recent games</Td><Td className="text-muted">Check your own performance</Td></tr>
                <tr><Td><Code>/list-winners</Code></Td><Td>Hall of fame showing recent tournament winners</Td><Td className="text-muted">See who has been winning lately</Td></tr>
                <tr><Td><Code>/view-selection</Code></Td><Td>Shows queued games and what is coming up next</Td><Td className="text-muted">See the upcoming lineup</Td></tr>
                <tr><Td><Code>/pick-game</Code></Td><Td>When nominated as picker, choose the next game from eligible options</Td><Td className="text-muted">It is your turn to pick</Td></tr>
                <tr><Td><Code>/map-user</Code></Td><Td>Link your Discord account to your iScored username</Td><Td className="text-muted">First-time setup or username change</Td></tr>
                <tr><Td><Code>/create-backup</Code></Td><Td>Triggers a database backup</Td><Td className="text-muted">Before major changes</Td></tr>
                <tr><Td><Code>/sync-state</Code></Td><Td>Reconciles ArcAid's database with live iScored data</Td><Td className="text-muted">If scores seem out of sync</Td></tr>
                <tr><Td><Code>/arcaid-notifications</Code></Td><Td>Manage your notification preferences &mdash; opt in/out of Discord DMs per type (tournament win, turn to pick, dethroned, etc.)</Td><Td className="text-muted">Turn DM alerts on or off</Td></tr>
                <tr><Td><Code>/ping</Code></Td><Td>Replies with Pong! A quick connectivity test</Td><Td className="text-muted">Check the bot is online</Td></tr>
              </tbody>
            </table>
          </div>
        </NeonCard>

        {/* Admin Commands */}
        <NeonCard title="Admin Commands" glowColor="magenta" className="mb-4">
          <p className="text-muted text-sm mb-3">
            These commands require the Discord Admin Role configured in your room settings.
          </p>
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead>
                <tr>
                  <Th className="w-1/5 whitespace-nowrap">Command</Th>
                  <Th className="w-2/5">What It Does</Th>
                  <Th>When to Use</Th>
                </tr>
              </thead>
              <tbody>
                <tr><Td><Code>/force-maintenance</Code></Td><Td>Manually triggers a full tournament rotation cycle: lock current game, scrape scores, pick winner, activate next game, announce</Td><Td className="text-muted">Force a rotation outside the schedule</Td></tr>
                <tr><Td><Code>/activate-game</Code></Td><Td>Immediately activate a specific game for a tournament</Td><Td className="text-muted">Start a specific game right now</Td></tr>
                <tr><Td><Code>/deactivate-game</Code></Td><Td>Deactivate an active game, optionally locking it on iScored</Td><Td className="text-muted">End a game early</Td></tr>
                <tr><Td><Code>/run-cleanup</Code></Td><Td>Delete completed/orphan games from iScored per your cleanup rules</Td><Td className="text-muted">Clean up old games from iScored</Td></tr>
                <tr><Td><Code>/pause-pick</Code></Td><Td>Inject a specific game into the tournament queue</Td><Td className="text-muted">Queue up a specific game next</Td></tr>
                <tr><Td><Code>/nominate-picker</Code></Td><Td>Manually assign picker rights to a user</Td><Td className="text-muted">Override automatic picker selection</Td></tr>
                <tr><Td><Code>/reorder-lineup</Code></Td><Td>Reorder queued games in a tournament's iScored lineup</Td><Td className="text-muted">Rearrange the upcoming game order</Td></tr>
                <tr><Td><Code>/setup</Code></Td><Td>Configure the Discord announcement channel and admin role (subcommands: announcement-channel, admin-role, view)</Td><Td className="text-muted">Initial bot setup or reconfiguration</Td></tr>
              </tbody>
            </table>
          </div>
        </NeonCard>

        {/* ------------------------------------------------------------------ */}
        {/* 11. PUBLIC PAGES */}
        {/* ------------------------------------------------------------------ */}
        <SectionHeading id="public-pages">11. Public Pages</SectionHeading>
        <NeonCard className="mb-4">
          <p className="text-primary text-sm mb-4">
            Your game room has several public pages that anyone can visit &mdash; no login required.
            Share these URLs with your community.
          </p>
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead>
                <tr>
                  <Th>Page</Th>
                  <Th>URL Pattern</Th>
                  <Th>What It Shows</Th>
                </tr>
              </thead>
              <tbody>
                <tr><Td><strong>Leaderboard</strong></Td><Td><Code>/your_slug/</Code></Td><Td>Live leaderboards for all active games and ranking groups</Td></tr>
                <tr><Td><strong>Lobby</strong></Td><Td><Code>/your_slug/lobby</Code></Td><Td>Community hub &mdash; announcements, a live activity feed, and social links</Td></tr>
                <tr><Td><strong>Picks</strong></Td><Td><Code>/your_slug/picks</Code></Td><Td>Where a round winner picks the next game; shows queued + available games and pending picks (the old <Code>/games</Code> URL redirects here)</Td></tr>
                <tr><Td><strong>Public Stats</strong></Td><Td><Code>/your_slug/stats</Code></Td><Td>Community statistics; the player list lives here (<Code>?view=players</Code>)</Td></tr>
                <tr><Td><strong>Player Detail</strong></Td><Td><Code>/your_slug/players/Name</Code></Td><Td>Individual player stats, win rate, history</Td></tr>
                <tr><Td><strong>Game Detail</strong></Td><Td><Code>/your_slug/games/GameName</Code></Td><Td>Game-specific stats, records, community rating</Td></tr>
                <tr><Td><strong>Kiosk Leaderboard</strong></Td><Td><Code>/your_slug/kiosk</Code></Td><Td>Full-screen auto-scrolling leaderboard for TV displays</Td></tr>
                <tr><Td><strong>Score Submit</strong></Td><Td><Code>/your_slug/submit/:gameId</Code></Td><Td>Standalone score submission page (linked from QR codes on cards)</Td></tr>
                <tr><Td><strong>Global Scoreboard</strong></Td><Td><Code>/scoreboard</Code></Td><Td>Cross-room aggregate leaderboard spanning all ArcAid rooms (not room-specific)</Td></tr>
                <tr><Td><strong>Friends</strong></Td><Td><Code>/friends</Code></Td><Td>Your ArcAid friends / social page (Discord login required)</Td></tr>
              </tbody>
            </table>
          </div>
          <Tip>
            The <strong>Picks</strong> page (<Code>/your_slug/picks</Code>) is where the round winner chooses the next
            game &mdash; it shows which games are eligible (past the cooldown period) and the pending pick.
          </Tip>
        </NeonCard>

        {/* ------------------------------------------------------------------ */}
        {/* 12. STYLE CATALOGUE */}
        {/* ------------------------------------------------------------------ */}
        <SectionHeading id="styles">12. Style Catalogue</SectionHeading>
        <NeonCard className="mb-4">
          <p className="text-primary text-sm mb-4">
            Navigate to <strong>Style Catalogue</strong> in the sidebar to browse and manage game card art.
          </p>

          <SubHeading>Browsing Styles</SubHeading>
          <p className="text-muted text-sm mb-3">
            The catalogue shows all available art packs. Each style can have a <strong>background</strong> image
            (fills the card behind scores) and/or a <strong>game identifier</strong> image &mdash; used as the game's
            wheel icon, thumbnail, sidebar art, or banner depending on the card layout (choose a Square 1:1 or Wide 3:1
            shape). Search by name to find specific styles.
          </p>

          <SubHeading>Uploading Custom Art</SubHeading>
          <p className="text-muted text-sm mb-2">Upload your own art with these guidelines:</p>
          <ul className="list-disc list-inside text-sm text-primary space-y-1 mb-4">
            <li>Supported formats: PNG, APNG (animated), JPEG, WebP</li>
            <li>Max file size: 30MB</li>
            <li>Background images: landscape orientation recommended</li>
            <li>Identifier images: transparent PNG recommended for best overlay effect</li>
            <li>At least one image (background or identifier) is required</li>
          </ul>

          <SubHeading>Applying Styles</SubHeading>
          <p className="text-muted text-sm mb-3">
            Click the <strong>Style</strong> button on any game card (Leaderboard, Tournaments, or Game Library pages)
            to open the style picker. You can browse existing styles, upload new ones, or apply background and
            identifier images independently from different styles.
          </p>
          <Tip>
            Use <strong>Set as Library Default</strong> when applying a style to automatically use it for future
            activations of that game.
          </Tip>
        </NeonCard>

        {/* ------------------------------------------------------------------ */}
        {/* 13. GAME STATES */}
        {/* ------------------------------------------------------------------ */}
        <SectionHeading id="game-states">13. Game States</SectionHeading>
        <NeonCard className="mb-4">
          <p className="text-primary text-sm mb-4">
            Navigate to <strong>Game States</strong> in the sidebar for an advanced escape hatch to manage individual
            game entries directly.
          </p>
          <p className="text-muted text-sm mb-3">
            This page is for troubleshooting and fixing edge cases. Most normal game management should be done through
            Tournaments and Leaderboard pages.
          </p>
          <SubHeading>Available Actions</SubHeading>
          <ul className="list-disc list-inside text-sm text-primary space-y-1 mb-4">
            <li><strong>Force Status</strong> &mdash; One-click <strong>Force Active</strong> or <strong>Force Complete</strong> (game statuses are Active / Queued / Completed / Archived), with optional iScored sync</li>
            <li><strong>Clear Picker</strong> &mdash; Cancel a pending picker timeout assignment</li>
            <li><strong>iScored Sync</strong> &mdash; Granular iScored operations on a single game (Lock, Unlock, Hide, Create)</li>
            <li><strong>Reconcile iScored</strong> &mdash; Diff the live iScored game list against ArcAid's records and clean up drift. Sorts entries into keep / orphaned (gone from ArcAid but still on iScored &mdash; pre-selected) / unmanaged, then bulk-deletes the ones you choose from iScored</li>
            <li><strong>Force Maintenance</strong> &mdash; Trigger a full maintenance cycle for a specific tournament. Waits for the run and reports the real outcome (rotated / skipped / error)</li>
            <li><strong>Clean Phantoms</strong> &mdash; When placeholder or empty queued rows exist, a bulk button appears to remove them all at once</li>
            <li><strong>Delete</strong> &mdash; Remove a game entry entirely (for phantom/orphaned entries). Deleting a live <strong>ACTIVE</strong> game requires an extra force-confirm &mdash; for a normal end-of-round, use <strong>Deactivate</strong> on the Tournaments page instead</li>
          </ul>
          <Tip>
            All game state actions are logged to the Activity Log. Use with caution &mdash; these bypass normal
            tournament flow safeguards.
          </Tip>
        </NeonCard>

        {/* ------------------------------------------------------------------ */}
        {/* 14. SETUP CHECKLIST */}
        {/* ------------------------------------------------------------------ */}
        <SectionHeading id="setup-checklist">14. Setup Checklist</SectionHeading>
        <NeonCard glowColor="green" className="mb-8">
          <p className="text-primary text-sm mb-4">
            Quick reference when setting up a new room from scratch:
          </p>
          <ul className="space-y-0.5">
            <CheckItem>Log in with provided credentials</CheckItem>
            <CheckItem><strong>Settings &rarr; Discord</strong>: Enter Guild ID, announcement channel, and admin role</CheckItem>
            <CheckItem><strong>Settings &rarr; iScored</strong>: Enter iScored credentials and public URL (if you use iScored)</CheckItem>
            <CheckItem><strong>Settings &rarr; Integrations</strong>: Turn on the features your room needs</CheckItem>
            <CheckItem><strong>Settings &rarr; Theme</strong>: Choose your preferred theme</CheckItem>
            <CheckItem><strong>Game Library</strong>: Find games in the catalogue (add new ones via Add Game or CSV); tag or pin them for your room</CheckItem>
            <CheckItem><strong>Tournaments</strong>: Create your first tournament &mdash; its schedule, timezone, cooldown, pick windows, and platform rules are all set here</CheckItem>
            <CheckItem><strong>Settings &rarr; Users</strong>: Invite additional admins if needed</CheckItem>
            <CheckItem>Share the public scoreboard URL with your community</CheckItem>
            <CheckItem>Test: Run <Code>/ping</Code> or <Code>/list-active</Code> in Discord to verify bot connectivity</CheckItem>
          </ul>
        </NeonCard>

        <div className="border-t border-border pt-4 pb-8 text-center space-y-1">
          <p className="text-faint text-xs">
            For technical support, contact your ArcAid administrator.
          </p>
          {version && (
            <p
              className="text-faint text-xs font-mono"
              title={version.builtAt ? `Built ${new Date(version.builtAt).toLocaleString()}` : undefined}
            >
              ArcAid v{version.version}{version.commit ? ` · ${version.commit.slice(0, 7)}` : ''}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
