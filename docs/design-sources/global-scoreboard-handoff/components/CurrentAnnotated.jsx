// Faithful recreation of the current Global Scoreboard, with annotations.

function CurrentScoreboardCard({ game }) {
  const podium = game.top;
  return (
    <div style={{
      borderRadius: 12, border: `1px solid ${ARCAID.border}`,
      background: ARCAID.surface, overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ padding: '12px 12px 4px', textAlign: 'center' }}>
        <div style={{
          fontFamily: ARCAID.fontDisplay, fontWeight: 700, fontSize: 15,
          lineHeight: 1.15, color: ARCAID.primary,
        }}>{game.name}</div>
        <div style={{ fontSize: 10.5, color: ARCAID.muted, marginTop: 2 }}>
          {game.manufacturer} · {game.year} · {game.scoreCount} scores
        </div>
      </div>

      <BackglassPlaceholder hue={game.hue} style={{ height: 82, margin: '4px 12px 8px' }} />

      {/* 1st place big */}
      <div style={{ padding: '0 12px', display: 'flex', justifyContent: 'center' }}>
        <div style={{
          width: '62%', minWidth: 100, borderRadius: 8,
          border: '1px solid rgba(250, 190, 80, 0.35)',
          background: 'rgba(250, 190, 80, 0.12)',
          padding: '6px 6px', textAlign: 'center',
        }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: ARCAID.amber, letterSpacing: 0.4 }}>🏆 1st</div>
          {podium[0] && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'center', marginTop: 2 }}>
                <Avatar name={podium[0].name} size={16} />
                <span style={{ fontSize: 11, fontWeight: 600 }}>{podium[0].name}</span>
              </div>
              <div style={{ fontFamily: ARCAID.fontMono, fontSize: 11, fontWeight: 700, color: ARCAID.amber }}>
                {formatScore(podium[0].score)}
              </div>
            </>
          )}
        </div>
      </div>
      {/* 2 + 3 */}
      <div style={{ display: 'flex', gap: 6, padding: '6px 12px 0' }}>
        {[1, 2].map(i => {
          const e = podium[i];
          const s = rankColor(i + 1);
          return (
            <div key={i} style={{
              flex: 1, borderRadius: 8,
              border: `1px solid ${s.border}`, background: s.bg,
              padding: '6px 4px', minHeight: 40, textAlign: 'center',
            }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: s.text }}>{i === 1 ? '2nd' : '3rd'}</div>
              {e ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 3, justifyContent: 'center', marginTop: 2 }}>
                    <Avatar name={e.name} size={13} />
                    <span style={{ fontSize: 10, fontWeight: 500 }}>{e.name}</span>
                  </div>
                  <div style={{ fontFamily: ARCAID.fontMono, fontSize: 10, color: s.text }}>{formatScore(e.score)}</div>
                </>
              ) : (
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.15)', marginTop: 8, fontStyle: 'italic' }}>—</div>
              )}
            </div>
          );
        })}
      </div>

      {game.more && game.more.length > 0 && (
        <div style={{ padding: '8px 12px 0', borderTop: `1px solid ${ARCAID.border}40`, margin: '8px 12px 0' }}>
          {game.more.map(m => (
            <div key={m.rank} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, padding: '2px 0' }}>
              <span style={{ width: 14, color: ARCAID.muted, fontFamily: ARCAID.fontMono, textAlign: 'right' }}>{m.rank}.</span>
              <Avatar name={m.name} size={11} />
              <span style={{ flex: 1, color: ARCAID.primary }}>{m.name}</span>
              <span style={{ fontFamily: ARCAID.fontMono, color: ARCAID.muted }}>{formatScore(m.score)}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ flex: 1 }} />
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        padding: '8px 12px', borderTop: `1px solid ${ARCAID.border}30`,
      }}>
        <div style={{ display: 'flex', gap: 1 }}>
          {[1,2,3,4,5].map(s => (
            <span key={s} style={{ fontSize: 9, color: s <= (game.rating || 0) ? ARCAID.amber : 'rgba(255,255,255,0.15)' }}>★</span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', justifyContent: 'center' }}>
          {game.platforms.map(p => <PlatformPill key={p}>{p}</PlatformPill>)}
        </div>
        <button style={{
          fontSize: 10, padding: '4px 8px', borderRadius: 6,
          border: `1px solid ${ARCAID.cyan}66`, color: ARCAID.cyan,
          background: 'transparent', fontFamily: ARCAID.fontBody, cursor: 'pointer',
        }}>↑ Submit</button>
      </div>
    </div>
  );
}

function CurrentAnnotated() {
  return (
    <ArcAidFrame width={1100} height={920} label="Current">
      <div style={{ padding: '24px 28px', overflow: 'hidden', flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <span style={{ color: ARCAID.cyan, fontSize: 22 }}>🏆</span>
          <h1 style={{
            fontFamily: ARCAID.fontDisplay, fontSize: 28, fontWeight: 700,
            margin: 0, letterSpacing: 0.5,
          }}>Global Scoreboard</h1>
        </div>
        <p style={{ color: ARCAID.muted, fontSize: 12, margin: '4px 0 20px' }}>
          High scores from every ArcAid room, all in one place. Submit your own scores with Discord login.
        </p>

        {/* Search + filters */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
          <div style={{
            flex: 1, height: 36, borderRadius: 4, border: `1px solid ${ARCAID.border}`,
            background: ARCAID.surface, display: 'flex', alignItems: 'center',
            padding: '0 12px', gap: 8, color: ARCAID.muted, fontSize: 12,
          }}>
            <span>🔍</span> Search games…
          </div>
          <div style={{
            height: 36, borderRadius: 4, border: `1px solid ${ARCAID.border}`,
            background: ARCAID.surface, display: 'flex', alignItems: 'center',
            padding: '0 12px', gap: 8, fontSize: 12, width: 130, justifyContent: 'space-between',
          }}>Popular <span>⌄</span></div>
          <div style={{
            height: 36, borderRadius: 4, border: `1px solid ${ARCAID.border}`,
            background: ARCAID.surface, display: 'flex', alignItems: 'center',
            padding: '0 12px', gap: 8, fontSize: 12, width: 180, justifyContent: 'space-between',
          }}>All rooms (global) <span>⌄</span></div>
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 14, alignItems: 'center' }}>
          <span style={{ color: ARCAID.muted, fontSize: 11 }}>▼</span>
          {['All platforms', 'Physical', 'Virtual Pinball', 'Arcade & Video'].map((p, i) => (
            <span key={p} style={{
              fontSize: 10, padding: '4px 10px', borderRadius: 999,
              background: i === 0 ? 'rgba(100,200,240,0.15)' : 'transparent',
              color: i === 0 ? ARCAID.cyan : ARCAID.muted,
              border: `1px solid ${i === 0 ? ARCAID.cyan + '55' : ARCAID.border}`,
            }}>{p}</span>
          ))}
        </div>

        <div style={{ fontSize: 10, color: ARCAID.muted, marginBottom: 10 }}>Showing 30 of 2,427 games</div>

        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14,
        }}>
          {MOCK_GAMES.map(g => <CurrentScoreboardCard key={g.id} game={g} />)}
        </div>
      </div>
    </ArcAidFrame>
  );
}

window.CurrentAnnotated = CurrentAnnotated;
window.CurrentScoreboardCard = CurrentScoreboardCard;
