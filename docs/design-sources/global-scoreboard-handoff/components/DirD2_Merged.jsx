// Direction D v2 — Broadcast + Discovery + Personalization
// Merges: D hero/tiles + A card cleanup + prominent search + pinned rail for logged-in

function SearchBar({ big = false }) {
  return (
    <div style={{
      display: 'flex', gap: 10, alignItems: 'center',
    }}>
      <div style={{
        flex: 1, height: big ? 48 : 38,
        borderRadius: big ? 8 : 6,
        border: `1px solid ${ARCAID.cyan}55`,
        background: 'rgba(0,0,0,0.35)',
        padding: big ? '0 18px' : '0 14px',
        display: 'flex', alignItems: 'center', gap: 10,
        boxShadow: big ? `0 0 20px ${ARCAID.cyan}22, inset 0 0 20px rgba(0,0,0,0.3)` : 'none',
      }}>
        <span style={{ color: ARCAID.cyan, display: 'inline-flex', alignItems: 'center' }}><LucideSearch size={big ? 16 : 13} /></span>
        <span style={{
          flex: 1, fontSize: big ? 14 : 12,
          color: 'rgba(255,255,255,0.5)',
          fontFamily: ARCAID.fontBody,
        }}>
          Search 2,427 games — "haunted", "stern 1995", "pinball fx"…
        </span>
        <span style={{
          fontSize: 10, padding: '2px 6px',
          border: `1px solid ${ARCAID.border}`, borderRadius: 3,
          color: ARCAID.muted, fontFamily: ARCAID.fontMono,
        }}>⌘K</span>
      </div>
    </div>
  );
}

function SortPills({ active = 'popular' }) {
  const items = [
    ['pinned', 'Pinned first'],
    ['popular', 'Popular'],
    ['recent', 'Recent activity'],
    ['rated', 'Top rated'],
    ['scores', 'Most scores'],
    ['az', 'A–Z'],
  ];
  return (
    <div style={{ display: 'flex', gap: 4, background: ARCAID.surface, border: `1px solid ${ARCAID.border}`, borderRadius: 6, padding: 3 }}>
      {items.map(([k, label]) => (
        <span key={k} style={{
          fontSize: 11, padding: '5px 11px', borderRadius: 3,
          background: active === k ? ARCAID.cyan + '22' : 'transparent',
          color: active === k ? ARCAID.cyan : ARCAID.muted,
          fontWeight: active === k ? 600 : 500,
          cursor: 'pointer',
        }}>{label}</span>
      ))}
    </div>
  );
}

function PlatformChips({ active = 'all' }) {
  const items = ['all', 'Physical', 'Virtual Pinball', 'Arcade & Video'];
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <span style={{ fontSize: 10, color: ARCAID.faint, marginRight: 2 }}>FILTER</span>
      {items.map(p => (
        <span key={p} style={{
          fontSize: 10, padding: '4px 12px', borderRadius: 999,
          background: (p === 'all' && active === 'all') ? ARCAID.cyan + '22' : 'transparent',
          color: (p === 'all' && active === 'all') ? ARCAID.cyan : ARCAID.muted,
          border: `1px solid ${(p === 'all' && active === 'all') ? ARCAID.cyan + '55' : ARCAID.border}`,
        }}>{p === 'all' ? 'All platforms' : p}</span>
      ))}
    </div>
  );
}

// ── Pinned-game chip card (compact, with alert bell) ──
function PinnedChip({ game, rankDelta = 0 }) {
  const first = game.top[0];
  const deltaColor = rankDelta < 0 ? ARCAID.green : rankDelta > 0 ? ARCAID.coral : ARCAID.muted;
  const DeltaIcon = rankDelta < 0 ? LucideTrendingUp : rankDelta > 0 ? LucideTrendingDown : null;

  return (
    <div style={{
      flex: '0 0 auto', width: 220,
      borderRadius: 10, overflow: 'hidden',
      border: `1px solid ${ARCAID.border}`,
      background: ARCAID.surface,
      display: 'flex', flexDirection: 'column',
      position: 'relative',
    }}>
      <div style={{ position: 'relative', height: 64 }}>
        <BackglassPlaceholder hue={game.hue} rounded={0} style={{ position: 'absolute', inset: 0 }} />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, rgba(16,18,26,0.9), rgba(16,18,26,0.3))' }} />
        <div style={{ position: 'absolute', top: 6, right: 6, display: 'flex', gap: 4, alignItems: 'center' }}>
          {rankDelta !== 0 && DeltaIcon && (
            <span style={{
              background: 'rgba(0,0,0,0.6)', padding: '2px 6px', borderRadius: 3,
              fontSize: 9, color: deltaColor, fontFamily: ARCAID.fontMono, fontWeight: 700,
              display: 'inline-flex', alignItems: 'center', gap: 3,
            }}><DeltaIcon size={10} />{Math.abs(rankDelta)}</span>
          )}
          <span style={{
            background: 'rgba(0,0,0,0.6)', padding: '3px 5px', borderRadius: 3,
            color: ARCAID.amber, display: 'inline-flex',
          }}><LucidePin size={10} /></span>
        </div>
        <div style={{ position: 'absolute', left: 10, right: 10, bottom: 6 }}>
          <div style={{
            fontFamily: ARCAID.fontDisplay, fontSize: 12, fontWeight: 700,
            lineHeight: 1.1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{game.name}</div>
        </div>
      </div>
      <div style={{ padding: '7px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
        {first ? (
          <>
            <Avatar name={first.name} size={20} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 9, color: ARCAID.muted, fontWeight: 600, letterSpacing: 0.3 }}>#1</div>
              <div style={{ fontFamily: ARCAID.fontMono, fontSize: 12, fontWeight: 700, color: ARCAID.amber, lineHeight: 1 }}>
                {formatScore(first.score)}
              </div>
            </div>
          </>
        ) : (
          <div style={{ flex: 1, fontSize: 10, color: ARCAID.faint, fontStyle: 'italic' }}>No scores yet</div>
        )}
        <button style={{
          fontSize: 10, padding: '3px 8px', borderRadius: 4,
          background: ARCAID.cyan, color: ARCAID.deep,
          border: 'none', fontWeight: 700, cursor: 'pointer', flexShrink: 0,
        }}>+</button>
      </div>
    </div>
  );
}

// ── Hero card (like D, refined) ──
function D2Hero({ game }) {
  const first = game.top[0];
  const second = game.top[1];
  return (
    <div style={{
      gridColumn: 'span 2', gridRow: 'span 2',
      position: 'relative', borderRadius: 14, overflow: 'hidden',
      border: `1px solid ${ARCAID.cyan}66`,
      boxShadow: `0 0 40px ${ARCAID.cyan}22`,
    }}>
      <BackglassPlaceholder hue={game.hue} rounded={0} style={{ position: 'absolute', inset: 0 }} />
      <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(90deg, rgba(16,18,26,0.95) 10%, rgba(16,18,26,0.5) 55%, transparent 100%)` }} />

      <div style={{ position: 'absolute', top: 12, left: 12, display: 'flex', gap: 6 }}>
        <span style={{
          padding: '3px 10px', borderRadius: 3,
          background: ARCAID.magenta, color: '#fff',
          fontSize: 9, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase',
        }}><LucideFlame size={10} style={{marginRight: 3, verticalAlign: '-2px'}} />HOT</span>
        <span style={{
          padding: '3px 10px', borderRadius: 3,
          background: 'rgba(0,0,0,0.5)', color: ARCAID.primary,
          fontSize: 9, fontWeight: 600, letterSpacing: 0.5,
        }}>+42 scores this week</span>
      </div>
      <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', gap: 4 }}>
        {game.platforms.slice(0, 2).map(p => <PlatformPill key={p} accent={ARCAID.cyan}>{p}</PlatformPill>)}
      </div>

      <div style={{ position: 'absolute', inset: 0, padding: 22, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
        <div style={{ fontSize: 10, color: ARCAID.cyan, fontFamily: ARCAID.fontMono, letterSpacing: 1, marginBottom: 4 }}>
          {game.manufacturer.toUpperCase()} · {game.year} · {game.scoreCount} PLAYERS
        </div>
        <h2 style={{
          fontFamily: ARCAID.fontDisplay, fontSize: 34, fontWeight: 800, lineHeight: 1,
          margin: 0, textShadow: '0 2px 8px rgba(0,0,0,0.8)',
        }}>{game.name}</h2>

        {first && (
          <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
            <Avatar name={first.name} size={46} />
            <div>
              <div style={{ fontSize: 9, color: ARCAID.amber, fontWeight: 700, letterSpacing: 1, display: 'flex', alignItems: 'center', gap: 4 }}><LucideCrown size={11} />CHAMPION</div>
              <div style={{ fontFamily: ARCAID.fontDisplay, fontSize: 15, fontWeight: 700 }}>{first.name}</div>
              <div style={{ fontFamily: ARCAID.fontMono, fontSize: 22, fontWeight: 700, color: ARCAID.amber, textShadow: `0 0 10px ${ARCAID.amber}55` }}>
                {formatScore(first.score)}
              </div>
              {second && (
                <div style={{ fontSize: 10, color: ARCAID.muted, marginTop: 2 }}>
                  +{formatScore(first.score - second.score)} over #2
                </div>
              )}
            </div>
          </div>
        )}
        <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
          <button style={{
            fontSize: 12, padding: '9px 18px', borderRadius: 6,
            background: ARCAID.cyan, color: ARCAID.deep,
            border: 'none', fontWeight: 700, cursor: 'pointer',
          }}>↑ Submit your score</button>
          <button style={{
            fontSize: 12, padding: '9px 16px', borderRadius: 6,
            background: 'rgba(255,255,255,0.08)', color: '#fff',
            border: '1px solid rgba(255,255,255,0.2)', cursor: 'pointer',
          }}><LucidePin size={12} style={{marginRight: 5, verticalAlign: '-2px'}} />Pin</button>
          <button style={{
            fontSize: 12, padding: '9px 14px', borderRadius: 6,
            background: 'rgba(255,255,255,0.04)', color: '#fff',
            border: '1px solid rgba(255,255,255,0.15)', cursor: 'pointer',
          }}>Full leaderboard →</button>
        </div>
      </div>
    </div>
  );
}

// ── Tile (cleaned-up A + D hybrid) ──
function D2Tile({ game, loggedIn = false, myRank = null }) {
  const first = game.top[0];
  return (
    <div style={{
      position: 'relative', borderRadius: 10, overflow: 'hidden',
      border: `1px solid ${ARCAID.border}`,
      background: ARCAID.surface,
      display: 'flex', flexDirection: 'column',
      transition: 'transform 0.15s, border-color 0.15s',
    }}>
      <div style={{ position: 'relative', height: 110 }}>
        <BackglassPlaceholder hue={game.hue} rounded={0} style={{ position: 'absolute', inset: 0 }} />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0.05) 40%, rgba(16,18,26,0.95) 100%)' }} />
        {loggedIn && (
          <button style={{
            position: 'absolute', top: 6, left: 6,
            width: 22, height: 22, borderRadius: 4,
            background: 'rgba(0,0,0,0.55)', color: ARCAID.primary,
            border: '1px solid rgba(255,255,255,0.15)', cursor: 'pointer',
            fontSize: 11,
          }}><LucidePin size={11} /></button>
        )}
        <div style={{ position: 'absolute', top: 6, right: 6, display: 'flex', gap: 3 }}>
          {game.platforms.slice(0, 1).map(p => <PlatformPill key={p} accent={ARCAID.cyan}>{p}</PlatformPill>)}
        </div>
        <div style={{ position: 'absolute', left: 10, right: 10, bottom: 6 }}>
          <div style={{
            fontFamily: ARCAID.fontDisplay, fontSize: 13, fontWeight: 700, lineHeight: 1.15,
            textShadow: '0 1px 4px rgba(0,0,0,0.8)',
            textWrap: 'pretty',
          }}>{game.name}</div>
          <div style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.55)', marginTop: 1 }}>
            {game.manufacturer} · {game.year}
          </div>
        </div>
      </div>

      <div style={{ padding: '10px 12px', flex: 1 }}>
        {first ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Avatar name={first.name} size={22} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 9, color: ARCAID.amber, fontWeight: 700, letterSpacing: 0.3, display: 'flex', alignItems: 'center', gap: 3 }}><LucideMedal size={10} />1ST</div>
                <div style={{ fontSize: 11, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{first.name}</div>
              </div>
              <div style={{ fontFamily: ARCAID.fontMono, fontSize: 14, fontWeight: 700, color: ARCAID.amber, textAlign: 'right' }}>
                {formatScore(first.score)}
              </div>
            </div>
            {loggedIn && myRank && (
              <div style={{
                marginTop: 7, paddingTop: 7,
                borderTop: `1px solid ${ARCAID.border}60`,
                display: 'flex', alignItems: 'center', gap: 8,
                fontSize: 10, color: ARCAID.muted,
              }}>
                <span style={{ color: ARCAID.cyan, fontWeight: 700 }}>YOU</span>
                <span style={{ fontFamily: ARCAID.fontMono }}>#{myRank.rank}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontFamily: ARCAID.fontMono }}>{formatScore(myRank.score)}</span>
              </div>
            )}
          </>
        ) : (
          <div style={{
            padding: '8px 4px', textAlign: 'center',
            border: `1px dashed ${ARCAID.cyan}55`, borderRadius: 6,
            fontSize: 11, color: ARCAID.cyan,
          }}>Claim 1st →</div>
        )}
      </div>

      <div style={{
        padding: '7px 12px',
        borderTop: `1px solid ${ARCAID.border}50`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{ fontSize: 10, color: ARCAID.muted }}>
          {game.scoreCount} {game.scoreCount === 1 ? 'score' : 'scores'}
        </span>
        <button style={{
          fontSize: 10, padding: '4px 10px', borderRadius: 4,
          background: ARCAID.cyan, color: ARCAID.deep,
          border: 'none', fontWeight: 700, cursor: 'pointer',
        }}>Submit</button>
      </div>
    </div>
  );
}

// ── Logged-out view ──
function D2LoggedOut() {
  return (
    <ArcAidFrame width={1200} height={980} showNav={true}>
      <div style={{ padding: '28px 32px', flex: 1, overflow: 'hidden' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <h1 style={{
              fontFamily: ARCAID.fontDisplay, fontSize: 32, fontWeight: 700,
              margin: 0, letterSpacing: 0.5,
            }}>
              <span style={{ color: ARCAID.magenta, display: 'inline-flex', verticalAlign: '-3px', marginRight: 8 }}><LucideCircle size={12} /></span>Global Scoreboard
            </h1>
            <p style={{ color: ARCAID.muted, fontSize: 12.5, margin: '4px 0 0', maxWidth: 540 }}>
              High scores from every ArcAid room. <span style={{ color: ARCAID.cyan, cursor: 'pointer' }}>Log in with Discord</span> to submit, pin favorites, and get rank alerts.
            </p>
          </div>
          <div style={{ fontSize: 10, color: ARCAID.muted, fontFamily: ARCAID.fontMono, textAlign: 'right' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}><span style={{ color: ARCAID.magenta, display: 'inline-flex' }}><LucideCircle size={8} /></span> LIVE · updated 12s ago</div>
            <div style={{ marginTop: 4 }}>2,427 games · 8,132 players</div>
          </div>
        </div>

        {/* Prominent search */}
        <div style={{ marginBottom: 14 }}>
          <SearchBar big />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <PlatformChips />
          <SortPills active="popular" />
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gridAutoRows: '200px',
          gap: 14,
        }}>
          <D2Hero game={MOCK_GAMES[1]} />
          {[MOCK_GAMES[0], MOCK_GAMES[2], MOCK_GAMES[3], MOCK_GAMES[4], MOCK_GAMES[6], MOCK_GAMES[7]].map(g => (
            <D2Tile key={g.id} game={g} />
          ))}
        </div>
      </div>
    </ArcAidFrame>
  );
}

// ── Logged-in view with pinned rail ──
function D2LoggedIn() {
  const pinned = [MOCK_GAMES[0], MOCK_GAMES[3], MOCK_GAMES[4], MOCK_GAMES[6]];
  const myRanks = {
    'haunted-house': { rank: 2, score: 999464323 },
    'dirty-harry': { rank: 3, score: 15000000 },
    'attack-from-mars': { rank: 5, score: 88000000 },
  };

  return (
    <ArcAidFrame width={1200} height={1080} showNav={true}>
      <div style={{ padding: '28px 32px', flex: 1, overflow: 'hidden' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <h1 style={{
              fontFamily: ARCAID.fontDisplay, fontSize: 32, fontWeight: 700,
              margin: 0, letterSpacing: 0.5,
            }}>
              <span style={{ color: ARCAID.magenta, display: 'inline-flex', verticalAlign: '-3px', marginRight: 8 }}><LucideCircle size={12} /></span>Global Scoreboard
            </h1>
            <p style={{ color: ARCAID.muted, fontSize: 12.5, margin: '4px 0 0' }}>
              Welcome back, <span style={{ color: ARCAID.cyan, fontWeight: 600 }}>mekeburgj</span>. You have <span style={{ color: ARCAID.amber }}>2 new rank changes</span> on pinned games.
            </p>
          </div>
          <div style={{ fontSize: 10, color: ARCAID.muted, fontFamily: ARCAID.fontMono, textAlign: 'right' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}><span style={{ color: ARCAID.magenta, display: 'inline-flex' }}><LucideCircle size={8} /></span> LIVE · 12s ago</div>
            <div style={{ marginTop: 4 }}>2,427 games</div>
          </div>
        </div>

        {/* Pinned rail — logged-in only */}
        <div style={{
          padding: 14, borderRadius: 10,
          border: `1px solid ${ARCAID.amber}30`,
          background: `linear-gradient(180deg, ${ARCAID.amber}08, transparent)`,
          marginBottom: 20,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: ARCAID.amber, display: 'inline-flex' }}><LucidePin size={14} /></span>
              <span style={{ fontFamily: ARCAID.fontDisplay, fontSize: 14, fontWeight: 700, letterSpacing: 0.5 }}>
                MY PINS
              </span>
              <span style={{ fontSize: 10, color: ARCAID.muted }}>— {pinned.length} games watched</span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: ARCAID.muted, display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ color: ARCAID.amber, display: 'inline-flex' }}><LucideBell size={11} /></span> Alerts: <span style={{ color: ARCAID.cyan }}>Discord DM + Lobby bell</span>
              </span>
              <span style={{ fontSize: 10, color: ARCAID.muted, cursor: 'pointer' }}>Manage</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, overflowX: 'auto' }}>
            <PinnedChip game={pinned[0]} rankDelta={-1} />
            <PinnedChip game={pinned[1]} rankDelta={2} />
            <PinnedChip game={pinned[2]} rankDelta={0} />
            <PinnedChip game={pinned[3]} rankDelta={-3} />
            <div style={{
              flex: '0 0 auto', width: 80, display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: `1px dashed ${ARCAID.border}`, borderRadius: 10,
              color: ARCAID.faint, fontSize: 22, cursor: 'pointer',
            }}>+</div>
          </div>
        </div>

        {/* Search */}
        <div style={{ marginBottom: 14 }}>
          <SearchBar big />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <PlatformChips />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: ARCAID.faint }}>VIEW</span>
            <div style={{ display: 'flex', gap: 2, background: ARCAID.surface, border: `1px solid ${ARCAID.border}`, borderRadius: 4, padding: 2 }}>
              <span style={{ fontSize: 10, padding: '3px 8px', borderRadius: 2, background: ARCAID.cyan + '22', color: ARCAID.cyan }}>Grid</span>
              <span style={{ fontSize: 10, padding: '3px 8px', borderRadius: 2, color: ARCAID.muted }}>Compact</span>
            </div>
            <SortPills active="pinned" />
          </div>
        </div>

        <div style={{ fontSize: 10, color: ARCAID.faint, marginBottom: 10, letterSpacing: 0.5, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: ARCAID.amber, display: 'inline-flex' }}><LucidePin size={10} /></span>
          PINNED FIRST · THEN POPULAR
        </div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gridAutoRows: '200px',
          gap: 14,
        }}>
          <D2Hero game={MOCK_GAMES[1]} />
          <D2Tile game={MOCK_GAMES[0]} loggedIn myRank={myRanks['haunted-house']} />
          <D2Tile game={MOCK_GAMES[2]} loggedIn />
          <D2Tile game={MOCK_GAMES[3]} loggedIn myRank={myRanks['dirty-harry']} />
          <D2Tile game={MOCK_GAMES[4]} loggedIn />
          <D2Tile game={MOCK_GAMES[6]} loggedIn myRank={myRanks['attack-from-mars']} />
          <D2Tile game={MOCK_GAMES[7]} loggedIn />
        </div>
      </div>
    </ArcAidFrame>
  );
}

// ── Search in action — overlay state ──
function D2SearchActive() {
  const results = [MOCK_GAMES[0], MOCK_GAMES[2]];
  return (
    <ArcAidFrame width={1200} height={880} showNav={true}>
      <div style={{ padding: '28px 32px', flex: 1, overflow: 'hidden', position: 'relative' }}>
        <h1 style={{
          fontFamily: ARCAID.fontDisplay, fontSize: 28, fontWeight: 700,
          margin: '0 0 4px', letterSpacing: 0.5,
        }}>
          <span style={{ color: ARCAID.magenta, display: 'inline-flex', verticalAlign: '-2px', marginRight: 8 }}><LucideCircle size={10} /></span>Global Scoreboard
        </h1>

        <div style={{ marginTop: 18, position: 'relative' }}>
          <div style={{
            flex: 1, height: 48,
            borderRadius: 8,
            border: `1px solid ${ARCAID.cyan}`,
            background: 'rgba(0,0,0,0.55)',
            padding: '0 18px',
            display: 'flex', alignItems: 'center', gap: 10,
            boxShadow: `0 0 30px ${ARCAID.cyan}44`,
          }}>
            <span style={{ color: ARCAID.cyan, display: 'inline-flex' }}><LucideSearch size={16} /></span>
            <span style={{ flex: 1, fontSize: 14, color: ARCAID.primary, fontFamily: ARCAID.fontMono }}>
              haunt<span style={{ borderLeft: `2px solid ${ARCAID.cyan}`, marginLeft: 1, animation: 'blink 1s infinite' }}>&nbsp;</span>
            </span>
            <span style={{ fontSize: 11, color: ARCAID.muted }}>esc to close</span>
          </div>

          {/* Search results dropdown */}
          <div style={{
            position: 'absolute', top: 54, left: 0, right: 0,
            background: ARCAID.surface,
            border: `1px solid ${ARCAID.border}`,
            borderRadius: 8,
            boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            overflow: 'hidden',
            zIndex: 5,
          }}>
            <div style={{
              padding: '10px 18px', fontSize: 10, color: ARCAID.faint, letterSpacing: 1,
              borderBottom: `1px solid ${ARCAID.border}`,
              display: 'flex', justifyContent: 'space-between',
            }}>
              <span>GAMES — 2 MATCHES</span>
              <span style={{ color: ARCAID.cyan }}>Press ↵ for full results</span>
            </div>
            {results.map((g, i) => (
              <div key={g.id} style={{
                display: 'flex', alignItems: 'center', gap: 14,
                padding: '10px 18px',
                borderBottom: i === results.length - 1 ? 'none' : `1px solid ${ARCAID.border}50`,
                background: i === 0 ? 'rgba(100,200,240,0.08)' : 'transparent',
              }}>
                <BackglassPlaceholder hue={g.hue} style={{ width: 42, height: 42 }} rounded={5} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: ARCAID.fontDisplay, fontSize: 14, fontWeight: 700 }}>{g.name}</div>
                  <div style={{ fontSize: 10, color: ARCAID.muted }}>{g.manufacturer} · {g.year} · {g.scoreCount} scores</div>
                </div>
                {g.top[0] && (
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 9, color: ARCAID.muted, display: 'flex', alignItems: 'center', gap: 3, justifyContent: 'flex-end' }}><LucideMedal size={9} />{g.top[0].name}</div>
                    <div style={{ fontFamily: ARCAID.fontMono, fontSize: 12, fontWeight: 700, color: ARCAID.amber }}>
                      {formatScore(g.top[0].score)}
                    </div>
                  </div>
                )}
                <button style={{
                  fontSize: 11, padding: '6px 14px', borderRadius: 4,
                  background: i === 0 ? ARCAID.cyan : 'transparent',
                  color: i === 0 ? ARCAID.deep : ARCAID.cyan,
                  border: i === 0 ? 'none' : `1px solid ${ARCAID.cyan}66`,
                  fontWeight: 700, cursor: 'pointer',
                }}>{i === 0 ? '↵ Submit' : 'Submit'}</button>
              </div>
            ))}
            <div style={{
              padding: '8px 18px', fontSize: 10, color: ARCAID.muted,
              background: 'rgba(0,0,0,0.25)',
              display: 'flex', gap: 18,
            }}>
              <span><kbd style={kbdS}>↑↓</kbd> navigate</span>
              <span><kbd style={kbdS}>↵</kbd> submit score</span>
              <span><kbd style={kbdS}>⌘↵</kbd> open details</span>
              <span style={{ flex: 1 }} />
              <span>26 more games matched "haunt"</span>
            </div>
          </div>
        </div>

        {/* Dimmed bg grid */}
        <div style={{ marginTop: 80, opacity: 0.25, pointerEvents: 'none' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gridAutoRows: 160, gap: 14,
          }}>
            {[0, 1, 2, 3, 4, 5, 6, 7].map(i => (
              <div key={i} style={{ background: ARCAID.surface, borderRadius: 8 }} />
            ))}
          </div>
        </div>
      </div>
    </ArcAidFrame>
  );
}

const kbdS = {
  padding: '1px 5px', borderRadius: 3, background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.15)', fontFamily: 'JetBrains Mono, monospace',
  fontSize: 9, color: 'inherit',
};

Object.assign(window, {
  D2LoggedOut, D2LoggedIn, D2SearchActive,
  D2Hero, D2Tile, PinnedChip, SearchBar, SortPills, PlatformChips,
});
