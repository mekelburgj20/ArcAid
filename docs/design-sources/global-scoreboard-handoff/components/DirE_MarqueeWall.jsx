// Direction E — "Marquee Wall". Cinematic arcade-cabinet wall. Full-bleed
// backglass art; player handle + score overlaid as a LED ticker below title.
// Leans into the pinball aesthetic harder.

function MarqueeCard({ game }) {
  const first = game.top[0];
  const second = game.top[1];
  return (
    <div style={{
      position: 'relative', borderRadius: 8, overflow: 'hidden',
      aspectRatio: '3/4',
      border: `1px solid ${ARCAID.border}`,
      transition: 'transform 0.2s',
    }}>
      {/* Full bleed art */}
      <BackglassPlaceholder hue={game.hue} rounded={0} style={{ position: 'absolute', inset: 0 }} />
      <div style={{
        position: 'absolute', inset: 0,
        background: `linear-gradient(180deg,
          rgba(16,18,26,0.6) 0%,
          transparent 30%,
          transparent 55%,
          rgba(16,18,26,0.98) 100%)`,
      }} />

      {/* Marquee title at top */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0,
        padding: '10px 10px 14px',
        background: 'linear-gradient(180deg, rgba(0,0,0,0.7), transparent)',
      }}>
        <div style={{
          fontFamily: ARCAID.fontPixel, fontSize: 10, lineHeight: 1.3,
          color: '#fff',
          textShadow: `0 0 6px ${getNeon(game.hue)}, 0 0 14px ${getNeon(game.hue)}88`,
          textAlign: 'center', letterSpacing: 1,
        }}>
          {game.name.toUpperCase()}
        </div>
        <div style={{
          textAlign: 'center', fontSize: 8.5, fontFamily: ARCAID.fontMono,
          color: 'rgba(255,255,255,0.5)', marginTop: 4, letterSpacing: 1,
        }}>
          {game.manufacturer} · {game.year}
        </div>
      </div>

      {/* LED score panel */}
      <div style={{
        position: 'absolute', left: 8, right: 8, bottom: 10,
        padding: '7px 10px',
        background: 'rgba(0,0,0,0.82)',
        border: `1px solid ${ARCAID.amber}55`,
        borderRadius: 4,
        boxShadow: `inset 0 0 12px ${ARCAID.amber}22`,
      }}>
        {first ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{
                fontFamily: ARCAID.fontMono, fontSize: 8, letterSpacing: 1,
                color: ARCAID.amber, fontWeight: 700,
              }}>HIGH SCORE</span>
              <span style={{ fontSize: 8, color: ARCAID.muted, fontFamily: ARCAID.fontMono }}>
                {game.scoreCount} PL
              </span>
            </div>
            <div style={{
              fontFamily: ARCAID.fontMono, fontWeight: 700,
              fontSize: 16, color: ARCAID.amber, letterSpacing: 1,
              textShadow: `0 0 8px ${ARCAID.amber}99`,
              marginTop: 2, textAlign: 'right',
            }}>
              {formatScore(first.score)}
            </div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 5, marginTop: 3,
              paddingTop: 3, borderTop: `1px solid ${ARCAID.amber}22`,
            }}>
              <Avatar name={first.name} size={14} />
              <span style={{ fontSize: 10, fontFamily: ARCAID.fontDisplay, fontWeight: 700, color: '#fff', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{first.name}</span>
              {second && (
                <span style={{ fontSize: 8.5, color: ARCAID.muted, fontFamily: ARCAID.fontMono }}>
                  ▲ {formatScore(first.score - second.score)}
                </span>
              )}
            </div>
          </>
        ) : (
          <div style={{
            textAlign: 'center', fontFamily: ARCAID.fontMono,
            fontSize: 10, color: ARCAID.cyan, letterSpacing: 1,
            padding: '4px 0',
          }}>
            INSERT COIN ▸ FIRST PLACE
          </div>
        )}
      </div>

      {/* Hover overlay (always visible for mock) */}
      <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 3 }}>
        {game.platforms.slice(0, 1).map(p => (
          <span key={p} style={{
            fontFamily: ARCAID.fontPixel, fontSize: 7, letterSpacing: 1,
            padding: '3px 5px', background: 'rgba(0,0,0,0.7)',
            color: ARCAID.cyan, border: `1px solid ${ARCAID.cyan}55`,
          }}>{p}</span>
        ))}
      </div>
    </div>
  );
}

function getNeon(hue) {
  return `oklch(80% 0.2 ${hue})`;
}

function DirE() {
  return (
    <ArcAidFrame width={1100} height={900}>
      <div style={{ padding: '24px 28px', flex: 1, overflow: 'hidden' }}>
        <h1 style={{
          fontFamily: ARCAID.fontPixel, fontSize: 18, margin: '0 0 8px',
          color: ARCAID.cyan, letterSpacing: 3,
          textShadow: `0 0 10px ${ARCAID.cyan}, 0 0 20px ${ARCAID.cyan}88`,
        }}>
          GLOBAL SCOREBOARD
        </h1>
        <p style={{ color: ARCAID.muted, fontSize: 11, margin: '4px 0 20px', fontFamily: ARCAID.fontMono, letterSpacing: 0.5 }}>
          ▸ 2,427 CABINETS · 8,132 PLAYERS
        </p>

        <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
          <div style={{
            flex: 1, height: 34, borderRadius: 4, border: `1px solid ${ARCAID.cyan}55`,
            background: 'rgba(0,0,0,0.4)', padding: '0 12px',
            display: 'flex', alignItems: 'center', gap: 8,
            fontSize: 11, color: ARCAID.cyan, fontFamily: ARCAID.fontMono,
          }}>▸ SEARCH CABINET_</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {['ALL', 'PHYSICAL', 'VIRTUAL', 'VIDEO'].map((p, i) => (
              <span key={p} style={{
                fontSize: 10, padding: '6px 12px', fontFamily: ARCAID.fontPixel, letterSpacing: 1,
                background: i === 0 ? ARCAID.cyan + '22' : 'transparent',
                color: i === 0 ? ARCAID.cyan : ARCAID.muted,
                border: `1px solid ${i === 0 ? ARCAID.cyan : ARCAID.border}`,
              }}>{p}</span>
            ))}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          {MOCK_GAMES.map(g => <MarqueeCard key={g.id} game={g} />)}
        </div>
      </div>
    </ArcAidFrame>
  );
}

window.DirE = DirE;
