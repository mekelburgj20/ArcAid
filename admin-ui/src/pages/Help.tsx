import { useState, useEffect, useRef } from 'react';
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
  const observerRef = useRef<IntersectionObserver | null>(null);

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

  const tableClass = 'w-full border-collapse';
  const tableWrapClass = 'overflow-x-auto rounded-lg border border-border';

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
                    className={`block w-full text-left text-sm px-2 py-1.5 rounded cursor-pointer bg-transparent border-none transition-colors ${
                      activeSection === s.id
                        ? 'text-neon-cyan bg-neon-cyan/10'
                        : 'text-muted hover:text-primary'
                    }`}
                  >
                    {s.label}
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
                  className={`block w-full text-left text-sm px-2 py-1.5 rounded cursor-pointer bg-transparent border-none transition-colors ${
                    activeSection === s.id
                      ? 'text-neon-cyan bg-neon-cyan/10 font-medium'
                      : 'text-muted hover:text-primary'
                  }`}
                >
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      {/* Main content */}
      <div className="flex-1 min-w-0">
        <h1 className="font-display text-2xl font-bold mb-2">Help &amp; Guide</h1>
        <p className="text-muted text-sm mb-8">
          Everything you need to know about managing your game room in ArcAid.
        </p>

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
            This works if your Discord user has been added as a room admin in Settings &rarr; User Management.
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

          <SubHeading>Status Bar</SubHeading>
          <p className="text-muted text-sm mb-2">Three indicators across the top:</p>
          <ul className="list-disc list-inside text-sm text-primary space-y-1 mb-4">
            <li><span className="text-neon-green font-medium">Bot Online</span> &mdash; Green pulse when connected, magenta when offline</li>
            <li><span className="text-neon-cyan font-medium">Active Tournaments</span> &mdash; Number of tournaments currently running</li>
            <li><span className="text-neon-amber font-medium">Participants</span> &mdash; Total unique players with scores</li>
          </ul>

          <SubHeading>Active Now</SubHeading>
          <p className="text-muted text-sm mb-2">
            One card per active tournament showing:
          </p>
          <ul className="list-disc list-inside text-sm text-primary space-y-1 mb-4">
            <li>Current game name</li>
            <li>Tournament name and badge</li>
            <li>Current leader and their score</li>
            <li>Next scheduled rotation time</li>
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
          Settings are organized into categories. Click <strong className="text-primary">Save All Changes</strong> at the top to persist edits.
        </p>

        {/* Game Room */}
        <NeonCard title="Game Room" className="mb-4">
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead><tr><Th className="w-1/3">Setting</Th><Th>What It Does</Th></tr></thead>
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

        {/* Tournament Defaults */}
        <NeonCard title="Tournament Defaults" className="mb-4">
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead><tr><Th className="w-1/3">Setting</Th><Th>What It Does</Th></tr></thead>
              <tbody>
                <tr><Td><strong>Game Eligibility Cooldown (days)</strong></Td><Td>After a game finishes, how many days before it can be picked again. Prevents the same games from repeating too frequently.</Td></tr>
                <tr><Td><strong>Winner Pick Window (minutes)</strong></Td><Td>How long the winner of a tournament round has to pick the next game before the pick passes to the runner-up.</Td></tr>
                <tr><Td><strong>Runner-up Pick Window (minutes)</strong></Td><Td>How long the runner-up has to pick if the winner did not. After this expires, the system auto-selects a game.</Td></tr>
                <tr><Td><strong>Bot Timezone</strong></Td><Td>Default timezone for all schedules (e.g., <Code>America/Chicago</Code>). Can be overridden per tournament.</Td></tr>
              </tbody>
            </table>
          </div>
        </NeonCard>

        {/* Theme */}
        <NeonCard title="Theme" className="mb-4">
          <p className="text-primary text-sm mb-3">Choose the visual theme for your public-facing pages:</p>
          <ul className="space-y-2 text-sm mb-4">
            <li><span className="text-neon-cyan font-medium">Arcade</span> <span className="text-muted">&mdash; Neon glow aesthetic with dark background (default)</span></li>
            <li><span className="text-neon-green font-medium">Dark</span> <span className="text-muted">&mdash; Clean dark theme without neon effects</span></li>
            <li><span className="text-neon-amber font-medium">Light</span> <span className="text-muted">&mdash; Standard light theme</span></li>
          </ul>
          <p className="text-muted text-sm">
            You can set a <strong className="text-primary">Global Theme</strong> for all visitors, and optionally set a
            <strong className="text-primary"> Personal Override</strong> for your own admin experience.
          </p>
        </NeonCard>

        {/* Platforms */}
        <NeonCard title="Platforms" className="mb-4">
          <p className="text-primary text-sm mb-3">
            Platforms define what gaming systems your room supports. Games in your library can be tagged with one
            or more platforms, and tournaments can require or exclude specific platforms.
          </p>
          <p className="text-muted text-sm mb-3">
            Common platforms: <Code>AtGames</Code>, <Code>VPXS</Code>, <Code>VR</Code>, <Code>IRL</Code>
          </p>
          <p className="text-muted text-sm">
            Click <strong className="text-primary">Add Platform</strong> to add a new one.
            Click the <strong className="text-neon-magenta">&times;</strong> next to a platform to remove it.
          </p>
        </NeonCard>

        {/* User Management */}
        <NeonCard title="User Management" className="mb-4">
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

        {/* System Actions */}
        <NeonCard title="System Actions" className="mb-4">
          <div className="space-y-4">
            <div>
              <p className="text-sm text-primary font-medium mb-1">Reload Scheduler</p>
              <p className="text-muted text-sm">
                After changing timezones or tournament schedules, click this to apply changes immediately
                without restarting. The scheduler also reloads automatically when you save tournament changes.
              </p>
            </div>
            <div>
              <p className="text-sm text-primary font-medium mb-1">Merge / Rename Player</p>
              <p className="text-muted text-sm">
                Consolidate two player usernames into one, or correct a misspelling. Updates all scores,
                submissions, and mappings across every tournament in the room. If the name was also wrong
                on iScored, fix it there first to prevent re-importing the old name on next sync.
              </p>
            </div>
          </div>
        </NeonCard>

        {/* ------------------------------------------------------------------ */}
        {/* 4. GAME LIBRARY */}
        {/* ------------------------------------------------------------------ */}
        <SectionHeading id="game-library">4. Game Library</SectionHeading>
        <NeonCard className="mb-4">
          <p className="text-primary text-sm mb-4">
            The Game Library is your catalog of all games available for tournaments.
            Navigate to <strong>Game Library</strong> in the sidebar.
          </p>

          <SubHeading>Importing Games</SubHeading>
          <p className="text-muted text-sm mb-3">ArcAid supports three bulk import methods:</p>
          <div className="space-y-3 mb-4">
            <div className="bg-raised border border-border rounded-lg px-4 py-3">
              <p className="text-sm font-medium text-neon-cyan mb-1">CSV Upload</p>
              <p className="text-muted text-sm">
                Upload a CSV file with columns: <Code>name</Code>, <Code>aliases</Code>, <Code>style_id</Code>,
                <Code>mode</Code>, <Code>platforms</Code>. Click <strong className="text-primary">Download Template</strong> for
                a pre-formatted example file.
              </p>
            </div>
            <div className="bg-raised border border-border rounded-lg px-4 py-3">
              <p className="text-sm font-medium text-neon-green mb-1">Import from VPS</p>
              <p className="text-muted text-sm">
                One-click bulk import from the Virtual Pinball Spreadsheet database.
                Imports hundreds of pinball tables instantly.
              </p>
            </div>
            <div className="bg-raised border border-border rounded-lg px-4 py-3">
              <p className="text-sm font-medium text-neon-amber mb-1">Import VPXS Wizard</p>
              <p className="text-muted text-sm">
                One-click import of VPXS Wizard tables from the community GitHub repository.
                All imported games are tagged with the <Code>VPXS</Code> platform.
              </p>
            </div>
          </div>

          <SubHeading>Adding a Game Manually</SubHeading>
          <ol className="list-decimal list-inside text-sm text-primary space-y-1 mb-4">
            <li>Enter the <strong>Game Name</strong> (required)</li>
            <li>Select the <strong>Mode</strong> &mdash; Pinball or Video Game</li>
            <li>Enter <strong>Platforms</strong> &mdash; comma-separated (e.g., <Code>AtGames, VPXS</Code>)</li>
            <li>Optionally fill in <strong>Style ID</strong>, <strong>Aliases</strong>, and advanced CSS styling fields</li>
            <li>Click <strong>Add Game</strong></li>
          </ol>

          <SubHeading>Managing Games</SubHeading>
          <p className="text-muted text-sm mb-2">The game table supports:</p>
          <ul className="list-disc list-inside text-sm text-primary space-y-1 mb-4">
            <li><strong>Search</strong> &mdash; Filter by name or platform</li>
            <li><strong>Mode filter</strong> &mdash; Toggle Pinball / Video Game visibility</li>
            <li><strong>Platform filter</strong> &mdash; Click platform chips to filter</li>
            <li><strong>Sort</strong> &mdash; Click column headers to sort by name, mode, platforms, rating, or style ID</li>
            <li><strong>Edit</strong> &mdash; Click the edit icon to modify any game's details</li>
            <li><strong>Rate</strong> &mdash; Click the stars to rate a game (community average shown)</li>
            <li><strong>Bulk Delete</strong> &mdash; Check multiple games and click <strong className="text-neon-magenta">Delete Selected</strong></li>
          </ul>

          <SubHeading>Activating a Game</SubHeading>
          <p className="text-muted text-sm mb-2">To manually start a game in a tournament:</p>
          <ol className="list-decimal list-inside text-sm text-primary space-y-1">
            <li>Click the <strong>Activate</strong> button on any game row</li>
            <li>Select which tournament to activate it for</li>
            <li>The game will be created on iScored and appear on your leaderboard</li>
          </ol>
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
                <tr><Td><strong>Schedule</strong></Td><Td>How often the tournament rotates (daily, weekly, monthly)</Td></tr>
                <tr><Td><strong>Display Order</strong></Td><Td>Position in the scoreboard and announcement order (lower = first)</Td></tr>
                <tr><Td><strong>Max Active Games</strong></Td><Td>How many games run simultaneously in this tournament (1&ndash;10)</Td></tr>
                <tr><Td><strong>Cleanup Rule</strong></Td><Td>What happens to finished games on iScored (see below)</Td></tr>
                <tr><Td><strong>Platform Rules</strong></Td><Td>Require or exclude specific platforms for game eligibility</Td></tr>
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
          <p className="text-muted text-sm mb-2">If your room has multiple platforms, you can scope tournaments to specific ones:</p>
          <ul className="list-disc list-inside text-sm text-primary space-y-1 mb-4">
            <li><strong>Require</strong> &mdash; Only games tagged with these platforms are eligible</li>
            <li><strong>Exclude</strong> &mdash; Games tagged with these platforms are ineligible</li>
            <li><strong>No rules</strong> &mdash; All games are eligible regardless of platform</li>
          </ul>

          <SubHeading>Tournament List</SubHeading>
          <p className="text-muted text-sm mb-2">
            The table below the creation form shows all your tournaments with their name, tag badge, mode,
            position, max slots, and schedule.
          </p>
          <ul className="list-disc list-inside text-sm text-primary space-y-1 mb-4">
            <li><strong>Edit</strong> &mdash; Opens the full edit modal to change any setting</li>
            <li><strong>Delete</strong> &mdash; Removes the tournament (confirmation required)</li>
            <li><strong>Sync iScored Lineup</strong> &mdash; Reorders the iScored game lineup to match your display order settings</li>
          </ul>

          <SubHeading>Active Games</SubHeading>
          <p className="text-muted text-sm mb-2">
            Below the tournament list, the <strong className="text-primary">Active Games</strong> section shows all
            currently running games with their tournament, start date, and iScored link status.
          </p>
          <p className="text-muted text-sm mb-2">
            <strong className="text-primary">Deactivate</strong> &mdash; Stop an active game with two options:
          </p>
          <ul className="list-disc list-inside text-sm text-primary space-y-1">
            <li><strong>Deactivate + Lock on iScored</strong> &mdash; Marks complete in ArcAid and locks the game on iScored</li>
            <li><strong>DB Only</strong> &mdash; Only updates ArcAid's database (does not touch iScored)</li>
          </ul>
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
            One card per active game showing the top 10 scores. Click any score row to expand and see all
            submissions for that player, sorted by score.
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
            <li>Click <strong>Create Ranking Group</strong></li>
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
            <li><strong>Recompute</strong> &mdash; Refresh the cached rankings</li>
            <li><strong>Edit</strong> &mdash; Change settings or tournament selection</li>
            <li><strong>Delete</strong> &mdash; Remove the ranking group</li>
          </ul>
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
                <tr><Td><Code>/setup</Code></Td><Td>Configure Discord channels, roles, and pick windows</Td><Td className="text-muted">Initial bot setup or reconfiguration</Td></tr>
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
                <tr><Td><strong>Scoreboard</strong></Td><Td><Code>/your_slug/</Code></Td><Td>Live leaderboards for all active games and ranking groups</Td></tr>
                <tr><Td><strong>Player List</strong></Td><Td><Code>/your_slug/players</Code></Td><Td>All players with stats, clickable for detail</Td></tr>
                <tr><Td><strong>Player Detail</strong></Td><Td><Code>/your_slug/players/Name</Code></Td><Td>Individual player stats, win rate, history</Td></tr>
                <tr><Td><strong>Game Detail</strong></Td><Td><Code>/your_slug/games/GameName</Code></Td><Td>Game-specific stats, records, community rating</Td></tr>
                <tr><Td><strong>Game Availability</strong></Td><Td><Code>/your_slug/games</Code></Td><Td>Which games are available vs. on cooldown, with a random picker</Td></tr>
              </tbody>
            </table>
          </div>
          <Tip>
            The <strong>Game Availability</strong> page is particularly useful for players who need to pick the next
            game &mdash; it shows which games are eligible (past the cooldown period) and includes a pinball-themed
            random picker.
          </Tip>
        </NeonCard>

        {/* ------------------------------------------------------------------ */}
        {/* 12. SETUP CHECKLIST */}
        {/* ------------------------------------------------------------------ */}
        <SectionHeading id="setup-checklist">12. Setup Checklist</SectionHeading>
        <NeonCard glowColor="green" className="mb-8">
          <p className="text-primary text-sm mb-4">
            Quick reference when setting up a new room from scratch:
          </p>
          <ul className="space-y-0.5">
            <CheckItem>Log in with provided credentials</CheckItem>
            <CheckItem><strong>Settings &rarr; Game Room</strong>: Set your room name and slug</CheckItem>
            <CheckItem><strong>Settings &rarr; Discord</strong>: Enter Guild ID, announcement channel, and admin role</CheckItem>
            <CheckItem><strong>Settings &rarr; iScored</strong>: Enter iScored credentials and public URL</CheckItem>
            <CheckItem><strong>Settings &rarr; Tournament Defaults</strong>: Set cooldown, pick windows, and timezone</CheckItem>
            <CheckItem><strong>Settings &rarr; Theme</strong>: Choose your preferred theme</CheckItem>
            <CheckItem><strong>Settings &rarr; Platforms</strong>: Add your gaming platforms (e.g., AtGames, VPXS)</CheckItem>
            <CheckItem><strong>Game Library</strong>: Import games (VPS, VPXS Wizard, or CSV)</CheckItem>
            <CheckItem><strong>Tournaments</strong>: Create your first tournament with a schedule</CheckItem>
            <CheckItem><strong>Settings &rarr; User Management</strong>: Invite additional admins if needed</CheckItem>
            <CheckItem>Share the public scoreboard URL with your community</CheckItem>
            <CheckItem>Test: Run <Code>/list-active</Code> in Discord to verify bot connectivity</CheckItem>
          </ul>
        </NeonCard>

        <div className="border-t border-border pt-4 pb-8">
          <p className="text-faint text-xs text-center">
            For technical support, contact your ArcAid administrator.
          </p>
        </div>
      </div>
    </div>
  );
}
