// Main app — critique + five directions on a design canvas.

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "showPostIts": true,
  "density": "comfortable",
  "accent": "cyan"
}/*EDITMODE-END*/;

function App() {
  const [tweaks, setTweaks] = React.useState(TWEAK_DEFAULTS);
  const [editMode, setEditMode] = React.useState(false);

  React.useEffect(() => {
    const onMsg = (e) => {
      if (!e.data) return;
      if (e.data.type === '__activate_edit_mode') setEditMode(true);
      if (e.data.type === '__deactivate_edit_mode') setEditMode(false);
    };
    window.addEventListener('message', onMsg);
    window.parent.postMessage({ type: '__edit_mode_available' }, '*');
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const patch = (k, v) => {
    setTweaks(t => ({ ...t, [k]: v }));
    window.parent.postMessage({ type: '__edit_mode_set_keys', edits: { [k]: v } }, '*');
  };

  const showPostIts = tweaks.showPostIts;

  return (
    <>
      <DesignCanvas>
        {/* Intro panel */}
        <div style={{ padding: '0 60px 40px', maxWidth: 980 }}>
          <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: -0.5, color: 'rgba(40,30,20,0.88)' }}>
            ArcAid — Global Scoreboard
          </div>
          <div style={{ fontSize: 16, color: 'rgba(60,50,40,0.7)', marginTop: 6, lineHeight: 1.5 }}>
            Critique of the live page, then five redesign directions ranging from minimal-intervention to full aesthetic shift. The primary user here is a casual player checking scores after a session, on a hub page that also has to support search, submit, and cross-room browsing.
          </div>
          <div style={{
            marginTop: 18, padding: 16, background: '#fff8e1', border: '1px solid #f0d97a',
            borderRadius: 6, fontSize: 13, color: '#5a4a1a', lineHeight: 1.5, maxWidth: 760,
          }}>
            <strong>System note</strong> — The repo tokens, fonts (Orbitron + Inter + JetBrains Mono + Press Start 2P) and OKLCH neon palette are preserved across every direction so any of these can be lifted straight into the real Tailwind/CSS-vars setup in <code>admin-ui/src/index.css</code>.
          </div>
        </div>

        {/* CURRENT + annotations */}
        <DCSection
          title="1 · Current, annotated"
          subtitle="What works, what doesn't. Live page recreated from the screenshot + component source."
        >
          <div style={{ position: 'relative' }}>
            <DCArtboard label="arcaid.app/scoreboard — current">
              <CurrentAnnotated />
            </DCArtboard>
            {showPostIts && (
              <>
                <DCPostIt top={-30} right={-220} rotate={3} width={210}>
                  <strong>Empty 2nd/3rd slots.</strong> Games with only one score show two giant dashes — reads as "broken."
                </DCPostIt>
                <DCPostIt top={210} right={-230} rotate={-2} width={220}>
                  <strong>Card hierarchy inverts.</strong> Title is centered and huge but the game <em>art</em> is the real entry point. You lead with text where you should lead with image.
                </DCPostIt>
                <DCPostIt top={430} right={-220} rotate={2} width={210}>
                  <strong>Footer is a traffic jam.</strong> Stars + 3 platform pills + Submit button compete for attention on every card. Most cards have 0 ratings.
                </DCPostIt>
                <DCPostIt top={640} right={-230} rotate={-1} width={220}>
                  <strong>Tiny fonts everywhere.</strong> 9–11px monospace is a readability problem — scores are the whole reason you're here.
                </DCPostIt>
                <DCPostIt top={-30} left={-230} rotate={-3} width={210}>
                  <strong>Filters are clean</strong> — search + sort + scope + platform chips is the right shape. Keep.
                </DCPostIt>
                <DCPostIt top={200} left={-240} rotate={2} width={220}>
                  <strong>Podium metaphor fights itself.</strong> You show a medal podium AND a ranked list (4–10). Pick one per card state, or let the card expand.
                </DCPostIt>
                <DCPostIt top={420} left={-240} rotate={-2} width={220}>
                  <strong>No sense of momentum.</strong> Toasts aside, the page is static. No "updated 2m ago", no live pulse, no what's-new.
                </DCPostIt>
                <DCPostIt top={620} left={-240} rotate={2} width={220}>
                  <strong>Submit CTA is buried.</strong> Small ghost button in a cluttered footer. For a hub that wants submissions, make it the obvious next click.
                </DCPostIt>
              </>
            )}
          </div>
        </DCSection>

        {/* DIR A */}
        <DCSection
          title="2 · Direction A — Trim & Fix"
          subtitle="Minimal intervention. Same card shape, smaller footprint, collapses empty states."
        >
          <div style={{ position: 'relative' }}>
            <DCArtboard label="A · Trimmed">
              <DirA />
            </DCArtboard>
            {showPostIts && (
              <>
                <DCPostIt top={40} right={-240} rotate={-2} width={220}>
                  <strong>Empty states collapse.</strong> No more ghost 2nd/3rd slots; a single "be the first" line when needed.
                </DCPostIt>
                <DCPostIt top={220} right={-240} rotate={2} width={220}>
                  <strong>Art leads, title overlays.</strong> Faster scan — you see what game this is before you read.
                </DCPostIt>
                <DCPostIt top={400} right={-240} rotate={-2} width={220}>
                  <strong>List replaces podium.</strong> Same info, half the vertical real estate, scales to any number of scores.
                </DCPostIt>
              </>
            )}
          </div>
        </DCSection>

        {/* DIR B */}
        <DCSection
          title="3 · Direction B — Champion Forward"
          subtitle="The player with the crown is the hero. Game art becomes mood background. Best for social/bragging casual users."
        >
          <div style={{ position: 'relative' }}>
            <DCArtboard label="B · Podium hero">
              <DirB />
            </DCArtboard>
            {showPostIts && (
              <>
                <DCPostIt top={40} right={-240} rotate={2} width={220}>
                  <strong>Face first.</strong> You see <em>who</em> is holding the crown before <em>what</em> game. Matches your casual-player persona.
                </DCPostIt>
                <DCPostIt top={220} right={-240} rotate={-2} width={220}>
                  <strong>Single CTA: "Beat this score."</strong> The whole card orients around one action.
                </DCPostIt>
                <DCPostIt top={400} right={-240} rotate={2} width={220}>
                  <strong>Challengers get a strip.</strong> 2nd/3rd are visible but clearly secondary; 4+ lives on the detail page.
                </DCPostIt>
              </>
            )}
          </div>
        </DCSection>

        {/* DIR C */}
        <DCSection
          title="4 · Direction C — Dense Leaderboard"
          subtitle="Table rows. Sacrifice visual warmth for raw scan speed. Good as an optional density toggle."
        >
          <div style={{ position: 'relative' }}>
            <DCArtboard label="C · List">
              <DirC />
            </DCArtboard>
            {showPostIts && (
              <>
                <DCPostIt top={60} right={-240} rotate={-2} width={220}>
                  <strong>8 → ~20 games per viewport.</strong> The right answer for power users who know what they're looking for.
                </DCPostIt>
                <DCPostIt top={260} right={-240} rotate={2} width={220}>
                  <strong>Thumb still present.</strong> 44px tile keeps art recognition without dominating.
                </DCPostIt>
                <DCPostIt top={460} right={-240} rotate={-2} width={220}>
                  <strong>Offer as a "Compact" toggle</strong> alongside the cards grid — don't replace, augment.
                </DCPostIt>
              </>
            )}
          </div>
        </DCSection>

        {/* DIR D */}
        <DCSection
          title="5 · Direction D — Broadcast Hero"
          subtitle="Editorial / Twitch-style. One big hero card for the day's most-played, cinematic tiles around it."
        >
          <div style={{ position: 'relative' }}>
            <DCArtboard label="D · Broadcast">
              <DirD />
            </DCArtboard>
            {showPostIts && (
              <>
                <DCPostIt top={40} right={-240} rotate={2} width={220}>
                  <strong>Page has a front page.</strong> Solves "the page feels flat" — different sizes create rhythm and highlight a weekly trend.
                </DCPostIt>
                <DCPostIt top={240} right={-240} rotate={-2} width={220}>
                  <strong>LIVE badge + "updated 12s ago"</strong> sells the fact that this is a real-time thing, not a static wall.
                </DCPostIt>
                <DCPostIt top={440} right={-240} rotate={2} width={220}>
                  <strong>Empty tiles become CTAs.</strong> "Claim 1st →" turns blank slots into hooks instead of gaps.
                </DCPostIt>
              </>
            )}
          </div>
        </DCSection>

        {/* DIR D2 — merged proposal */}
        <DCSection
          title="6 · Direction D v2 — Merged proposal (based on your feedback)"
          subtitle="D's cinematic hero + A's quick wins + prominent search + a personalized &quot;My Pins&quot; rail for logged-in users. Three states: logged-out discovery, logged-in personalized, and active search."
        >
          <div style={{ position: 'relative' }}>
            <DCArtboard label="D2 · Logged-out / cold traffic — discovery">
              <D2LoggedOut />
            </DCArtboard>
            {showPostIts && (
              <>
                <DCPostIt top={40} right={-240} rotate={2} width={220}>
                  <strong>Search is top-shelf.</strong> Full-width, high-contrast, ⌘K shortcut hint. For 2,427 games it's the primary nav, not a secondary filter.
                </DCPostIt>
                <DCPostIt top={230} right={-240} rotate={-2} width={220}>
                  <strong>Sort pills replace the dropdown.</strong> Popular / Recent / Top rated / Most scores / A–Z — visible, one-click, no menu.
                </DCPostIt>
                <DCPostIt top={420} right={-240} rotate={2} width={220}>
                  <strong>Hero sells discovery.</strong> Cold visitor sees what's HOT + a live update pulse + the current champion. Big single CTA: "Submit your score."
                </DCPostIt>
                <DCPostIt top={620} right={-240} rotate={-2} width={220}>
                  <strong>Login nudge is inline, not a wall.</strong> "Log in with Discord to submit, pin favorites, and get rank alerts" lives in the subhead.
                </DCPostIt>
                <DCPostIt top={40} left={-240} rotate={-2} width={220}>
                  <strong>Ratings gone from cards.</strong> Still available as a sort option ("Top rated"). Less noise, same signal.
                </DCPostIt>
                <DCPostIt top={230} left={-240} rotate={2} width={220}>
                  <strong>Tile footer = score count + Submit.</strong> No stars, no three platform pills. Platform badge stays overlaid on art (one, not three).
                </DCPostIt>
              </>
            )}
          </div>

          <div style={{ height: 40 }} />

          <div style={{ position: 'relative' }}>
            <DCArtboard label="D2 · Logged-in — personalized with pinned rail" height={1080}>
              <D2LoggedIn />
            </DCArtboard>
            {showPostIts && (
              <>
                <DCPostIt top={40} right={-240} rotate={-2} width={230}>
                  <strong>📌 My Pins rail.</strong> Logged-in users curate up to ~12 games. Horizontal scroll, compact chips, rank-delta arrows show movement since last visit.
                </DCPostIt>
                <DCPostIt top={230} right={-240} rotate={2} width={230}>
                  <strong>Alert bell is passive.</strong> Rank changes + new #1 posts for pinned games trigger Discord DMs or email. No per-card bell spam.
                </DCPostIt>
                <DCPostIt top={420} right={-240} rotate={-2} width={230}>
                  <strong>Welcome line is action-oriented.</strong> "You have 2 new rank changes on pinned games" — not "Hi, mekeburgj."
                </DCPostIt>
                <DCPostIt top={620} right={-240} rotate={2} width={230}>
                  <strong>Card gains a "YOU" row.</strong> If you've submitted a score for this game, your rank + score shows under the #1 line. Answers "how am I doing?" at a glance.
                </DCPostIt>
                <DCPostIt top={810} right={-240} rotate={-2} width={230}>
                  <strong>Pin hotspot on every card.</strong> Top-left of art, one-tap add to rail. Cheapest possible curation gesture.
                </DCPostIt>
                <DCPostIt top={40} left={-240} rotate={2} width={230}>
                  <strong>Compact view toggle lives here.</strong> Power-user density (Direction C's table) available per-user, remembered.
                </DCPostIt>
                <DCPostIt top={240} left={-250} rotate={-2} width={230}>
                  <strong>Future: "My games" as a sort.</strong> Default sort for logged-in = pinned first, then Popular. Answers "show me what I care about" without a separate tab.
                </DCPostIt>
              </>
            )}
          </div>

          <div style={{ height: 40 }} />

          <div style={{ position: 'relative' }}>
            <DCArtboard label="D2 · Search active — the critical path" height={880}>
              <D2SearchActive />
            </DCArtboard>
            {showPostIts && (
              <>
                <DCPostIt top={40} right={-240} rotate={-2} width={230}>
                  <strong>Search is a command palette, not a filter.</strong> Overlay, keyboard-first. ↵ submits to the top match immediately — fastest path to "post my score."
                </DCPostIt>
                <DCPostIt top={240} right={-240} rotate={2} width={230}>
                  <strong>Fuzzy + manufacturer aware.</strong> "haunt" → Haunted House. "stern 95" → everything Stern made in 1995.
                </DCPostIt>
                <DCPostIt top={440} right={-240} rotate={-2} width={230}>
                  <strong>Top match highlighted.</strong> Pre-selected so ↵ works. Shows current #1 + score right inline — you can decide if it's worth challenging before clicking.
                </DCPostIt>
                <DCPostIt top={620} right={-240} rotate={2} width={230}>
                  <strong>Keyboard hints.</strong> Teaches power-user shortcuts. Becomes muscle memory — your heaviest users will love it.
                </DCPostIt>
              </>
            )}
          </div>
        </DCSection>

        {/* 6b - Card density explorations */}
        <DCSection
          title="7 · How much leaderboard per card?"
          subtitle="You're right — just 1st + your score isn't enough. Here are five ways to size the 'backglass'. The whole leaderboard still lives on the game detail page; this is about what to surface on the hub."
        >
          <DCArtboard width={1640} height={720} label="Card density — side by side">
            <div style={{
              padding: 40, background: ARCAID.deep, width: '100%', height: '100%',
              display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap',
              fontFamily: ARCAID.fontBody, color: ARCAID.primary,
            }}>
              <Variant1_Top3 />
              <Variant2_Top5 />
              <Variant3_Top3PlusYouPlusMinus />
              <Variant4_Top3PlusNextToBeat />
              <Variant5_NotPlayed />
            </div>
          </DCArtboard>

          <div style={{ height: 30 }} />

          <div style={{
            padding: 20, background: '#fff', border: '1px solid #ddd',
            borderRadius: 8, fontSize: 13, lineHeight: 1.55, color: '#222',
            maxWidth: 980,
          }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8 }}>Tradeoffs</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #ddd', textAlign: 'left' }}>
                  <th style={{ padding: '6px 8px' }}>Variant</th>
                  <th style={{ padding: '6px 8px' }}>Strength</th>
                  <th style={{ padding: '6px 8px' }}>Cost</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: '8px', fontWeight: 700 }}>A — Top 3</td>
                  <td style={{ padding: '8px' }}>Shortest card. Classic podium.</td>
                  <td style={{ padding: '8px', color: '#a44' }}>Doesn't show you unless you're top 3.</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: '8px', fontWeight: 700 }}>B — Top 5</td>
                  <td style={{ padding: '8px' }}>Covers most people's rank. Readable.</td>
                  <td style={{ padding: '8px', color: '#a44' }}>If you're #20, still no "you." Tall cards.</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #eee', background: '#e8f5ed' }}>
                  <td style={{ padding: '8px', fontWeight: 700 }}>C — Top 3 + You ±1 ★</td>
                  <td style={{ padding: '8px' }}>Guarantees you see yourself AND your neighbors. Motivates the "one rank up" push.</td>
                  <td style={{ padding: '8px' }}>Tallest card. Needs a break line.</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: '8px', fontWeight: 700 }}>D — Top 3 + Next to beat</td>
                  <td style={{ padding: '8px' }}>Action-oriented: beat this one score.</td>
                  <td style={{ padding: '8px' }}>Hides who's chasing you.</td>
                </tr>
                <tr>
                  <td style={{ padding: '8px', fontWeight: 700 }}>E — Not played yet</td>
                  <td style={{ padding: '8px' }}>Clear qualifier threshold when you have no score.</td>
                  <td style={{ padding: '8px' }}>Edge case; companion to C/D.</td>
                </tr>
              </tbody>
            </table>
            <div style={{ marginTop: 14, padding: 12, background: '#eef6ff', borderLeft: `3px solid ${ARCAID.cyan}`, fontSize: 13 }}>
              <strong>My vote: C (Top 3 + You ±1)</strong> when logged in with a score, falls back to <strong>B (Top 5)</strong> when logged-out or for games you haven't played. It's the most motivating because it tells you exactly who to overtake next. Card height is taller — worth it.
            </div>
          </div>
        </DCSection>

        {/* 7b - Interactive toggle prototype */}
        <DCSection
          title="8 · Interactive — Top 6 / My Score toggle"
          subtitle="One toggle at the top of the page flips every card between the two modes. Click between them to see the cards update live."
        >
          <DCArtboard width={1400} height={720} label="Live prototype · click toggles on each card">
            <ToggleCardGrid />
          </DCArtboard>

          <div style={{ height: 20 }} />

          <div style={{
            padding: 20, background: '#fff', border: '1px solid #ddd',
            borderRadius: 8, fontSize: 13, lineHeight: 1.55, color: '#222',
            maxWidth: 860,
          }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8 }}>How it works</div>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              <li><strong>Single page toggle</strong> at the top of the Global Scoreboard flips every card at once between the two modes. Remembered per user.</li>
              <li><strong>Top 6 mode</strong> — straight top of the leaderboard, no personalization, works identically for logged-out visitors.</li>
              <li><strong>My Score mode</strong> — Top 3 + You ±1. If you're in the top 3, it just shows Top 5 (no break). If you haven't played, the card swaps to an "Unranked — beat #6 to qualify" prompt.</li>
              <li><strong>No toggle when logged-out</strong> — only Top 6 makes sense.</li>
            </ul>
          </div>
        </DCSection>

        {/* 6c - Hero with expanded LB */}
        <DCSection
          title="9 · Hero card — with expanded leaderboard"
          subtitle="Apply the same thinking to the big hero tile. More room = more leaderboard in view."
        >
          <DCArtboard width={700} height={520} label="Hero · Top 6 + You">
            <div style={{
              padding: 40, background: ARCAID.deep, width: '100%', height: '100%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Variant_HeroTop6PlusYou />
            </div>
          </DCArtboard>
        </DCSection>

        {/* DIR E */}
        <DCSection
          title="10 · Direction E — Marquee Wall"
          subtitle="Lean hardest into the cabinet aesthetic. Full-bleed art, pixel titles, LED high-score panel."
        >
          <div style={{ position: 'relative' }}>
            <DCArtboard label="E · Marquee">
              <DirE />
            </DCArtboard>
            {showPostIts && (
              <>
                <DCPostIt top={40} right={-240} rotate={-2} width={220}>
                  <strong>Every card is a cabinet.</strong> Pinball/arcade theme isn't decoration — it's the entire visual language.
                </DCPostIt>
                <DCPostIt top={240} right={-240} rotate={2} width={220}>
                  <strong>LED high-score panel.</strong> Amber JetBrains Mono score inside a black rectangle — the actual UI of a real pin readout.
                </DCPostIt>
                <DCPostIt top={440} right={-240} rotate={-2} width={220}>
                  <strong>"INSERT COIN ▸ FIRST PLACE"</strong> turns an empty state into character. Risk: can get loud at 30 cards. Best paired with your existing theme picker so it's opt-in.
                </DCPostIt>
              </>
            )}
          </div>
        </DCSection>

        {/* Summary recommendations */}
        <DCSection
          title="11 · What I'd actually ship — revised"
          subtitle="Opinionated takeaways."
        >
          <DCArtboard width={820} height={780} label="Recommendations v2">
            <div style={{ padding: '28px 32px', fontSize: 14, lineHeight: 1.55, color: '#222' }}>
              <div style={{
                padding: 12, background: '#e8f5ed', border: '1px solid #9dcfb1',
                borderRadius: 6, marginBottom: 16, fontSize: 13,
              }}>
                <strong>✓ Resolved from our discussion</strong>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  <li>Target aesthetic: <strong>Direction D</strong> (Broadcast Hero)</li>
                  <li>Cold traffic → <strong>discovery</strong>; logged-in → <strong>personalized with pinned games + rank alerts</strong></li>
                  <li><strong>Search is critical</strong> — promoted to primary UI element, not a filter afterthought</li>
                  <li>Ratings <strong>removed from cards</strong>, kept as a sort option ("Top rated")</li>
                  <li>Marquee / E-style treatment → <strong>opt-in via theme picker, not default</strong></li>
                  <li>Card leaderboard density → <strong>Top 3 + You ±1</strong> when logged-in with a score; <strong>Top 5</strong> otherwise</li>
                </ul>
              </div>

              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 10 }}>Quick wins (ship this week)</div>
              <ol style={{ margin: 0, paddingLeft: 20, color: '#333' }}>
                <li>Collapse empty 2nd/3rd podium slots — every score-starved card is an embarrassment today.</li>
                <li>Move the title onto the art (overlay), not stacked above it.</li>
                <li>Bump score font size from 10–11px to 13–15px; <code>text-wrap: pretty</code> on titles.</li>
                <li>Solid <code>bg-neon-cyan</code> Submit button. Ghost buttons hide your primary action.</li>
                <li>Drop the 5-star row. Nobody wants five gray ghosts on every card.</li>
                <li>Show 1 platform on card, not 3. Rest on hover / detail page.</li>
              </ol>

              <div style={{ fontWeight: 700, fontSize: 16, marginTop: 18, marginBottom: 10 }}>Bigger bets (next sprint)</div>
              <ul style={{ margin: 0, paddingLeft: 20, color: '#333' }}>
                <li><strong>Pinned games + rank alerts.</strong> Biggest retention lever in the whole redesign. Pin → Discord DM on rank change or new #1. Horizontal rail at the top of the page for logged-in users.</li>
                <li><strong>Command-palette search.</strong> ⌘K or focus the top bar → fuzzy search with keyboard-selectable results, ↵ goes straight to Submit-Score. Fastest path to scoreboard's purpose #2.</li>
                <li><strong>Broadcast hero for discovery.</strong> One "● HOT / trending this week" hero tile above the grid. Sells the hub as alive.</li>
                <li><strong>"YOU" row on cards.</strong> Logged-in cards show your rank + score under #1. Answers "how am I doing?" without clicking.</li>
                <li><strong>Sort pills, not a dropdown.</strong> Popular / Recent / Top rated / Most scores / A–Z — one click, visible state.</li>
                <li><strong>Density toggle.</strong> Grid / Compact per-user, remembered. Direction C is a power-user gift, not a replacement.</li>
              </ul>

              <div style={{
                marginTop: 18, padding: 12, background: '#e8f5ed', border: '1px solid #9dcfb1',
                borderRadius: 6, fontSize: 13, lineHeight: 1.5,
              }}>
                <strong>✓ Resolved Apr 30 + repo sync</strong>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  <li><strong>Pin limit:</strong> unlimited.</li>
                  <li><strong>Alerts:</strong> Discord DM (existing opt-in feature) + in-app bell in the new Lobby. Email skipped (no SendGrid).</li>
                  <li><strong>Default sort (logged-in):</strong> Pinned first, then Popular. The "My Pins" rail stays at top — pinned games appear in both for fast scan + full leaderboard context.</li>
                </ul>
              </div>

              <div style={{ fontWeight: 700, fontSize: 16, marginTop: 18, marginBottom: 8 }}>Repo sync notes (Apr 30, 2026)</div>
              <ul style={{ margin: 0, paddingLeft: 20, color: '#333' }}>
                <li>Verified <code>admin-ui/src/pages/GlobalScoreboard.tsx</code> matches the "Current" mock — no drift since last review. Critique still applies in full.</li>
                <li>Tokens in <code>index.css</code> unchanged — all neon OKLCH values, fonts, and the 16 themes (incl. <em>marquee</em>) still line up with the mocks.</li>
                <li><strong>Lobby exists</strong> (<code>pages/Lobby.tsx</code> + <code>components/lobby/*</code>) with WebSocket feed events. <strong>Implication:</strong> rank-change alerts for pinned games can ride the existing <code>lobby:event</code> socket as a new <code>rank_change</code> event type — no new infra needed for the in-app bell.</li>
                <li>Discord login (<code>DiscordLoginButton</code>, <code>useViewerAuth</code>) and Discord-bot integration are already wired — Discord DM alerts are the cheapest channel to ship first.</li>
                <li><code>SubmissionSheet</code>, <code>StarRating</code>, <code>RoomTag</code>, <code>PlayerAvatar</code>, <code>UserMenu</code> all stay; only <code>GameCard</code> gets rebuilt as <code>D2Tile</code>. <code>StarRating</code> moves off the card but keeps its detail-page role.</li>
              </ul>
            </div>
          </DCArtboard>
        </DCSection>

        <div style={{ padding: '0 60px 60px', color: 'rgba(60,50,40,0.5)', fontSize: 12 }}>
          Drag the canvas to pan · pinch/scroll to zoom · use Tweaks to toggle post-its
        </div>
      </DesignCanvas>

      {/* Tweaks panel */}
      {editMode && (
        <div style={{
          position: 'fixed', bottom: 16, right: 16, zIndex: 100,
          background: '#1a1d26', color: '#fff', padding: 16, borderRadius: 8,
          border: '1px solid oklch(35% 0.02 255)', minWidth: 240,
          fontFamily: 'Inter, sans-serif', fontSize: 12,
          boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
        }}>
          <div style={{ fontWeight: 700, marginBottom: 10, fontFamily: 'Orbitron, sans-serif', letterSpacing: 0.5 }}>Tweaks</div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={tweaks.showPostIts} onChange={e => patch('showPostIts', e.target.checked)} />
            Show critique post-its
          </label>

          <div style={{ marginBottom: 10 }}>
            <div style={{ color: '#8a8fa3', marginBottom: 4 }}>Density (not wired to mocks, preview knob)</div>
            <div style={{ display: 'flex', gap: 4 }}>
              {['compact', 'comfortable', 'roomy'].map(d => (
                <button key={d} onClick={() => patch('density', d)} style={{
                  flex: 1, padding: '4px 8px', fontSize: 11,
                  background: tweaks.density === d ? 'oklch(74% 0.16 232.661)' : 'transparent',
                  color: tweaks.density === d ? '#111' : '#fff',
                  border: '1px solid oklch(35% 0.02 255)', borderRadius: 3, cursor: 'pointer',
                }}>{d}</button>
              ))}
            </div>
          </div>
          <div style={{ color: '#8a8fa3', fontSize: 10, lineHeight: 1.4 }}>
            Toggle Tweaks off in the toolbar to hide this panel.
          </div>
        </div>
      )}
    </>
  );
}

window.App = App;
