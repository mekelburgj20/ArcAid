// Direction A — "Trimmed Current". Minimal intervention: keep the existing
// card but fix the most obvious problems.

function CardTrimmed({ game }) {
  const filled = game.top.filter(Boolean);
  const has2 = filled.length >= 2;
  const has3 = filled.length >= 3;

  return (
    <div style={{
      borderRadius: 10, border: `1px solid ${ARCAID.border}`,
      background: ARCAID.surface, overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Art first, title overlaid — more visual, less text-stacked */}
      <div style={{ position: 'relative', height: 96 }}>
        <BackglassPlaceholder hue={game.hue} rounded={0} style={{ position: 'absolute', inset: 0 }} />
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(180deg, rgba(0,0,0,0.1) 40%, rgba(16,18,26,0.95) 100%)',
        }} />
        <div style={{ position: 'absolute', top: 6, right: 6, display: 'flex', gap: 3 }}>
          {game.platforms.slice(0, 2).map(p => <PlatformPill key={p} accent={ARCAID.cyan}>{p}</PlatformPill>)}
        </div>
        <div style={{
          position: 'absolute', left: 10, right: 10, bottom: 6,
        }}>
          <div style={{
            fontFamily: ARCAID.fontDisplay, fontSize: 14, fontWeight: 700, lineHeight: 1.1,
            textShadow: '0 1px 4px rgba(0,0,0,0.8)',
          }}>{game.name}</div>
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.65)', marginTop: 1 }}>
            {game.manufacturer} · {game.year}
          </div>
        </div>
      </div>

      {/* Leaderboard — compact rows, not podium. Empty state collapses cleanly. */}
      <div style={{ padding: '8px 10px', flex: 1 }}>
        {filled.length === 0 ? (
          <div style={{
            textAlign: 'center', fontSize: 10, color: ARCAID.faint,
            fontStyle: 'italic', padding: '12px 0',
          }}>No scores yet — be the first.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {filled.map((e, i) => {
              const s = rankColor(i + 1);
              const medal = ['🥇', '🥈', '🥉'][i] || '';
              return (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '5px 8px',
                  background: i === 0 ? s.bg : 'transparent',
                  borderLeft: i === 0 ? `2px solid ${s.text}` : '2px solid transparent',
                  borderRadius: 4,
                }}>
                  <span style={{ fontSize: 11 }}>{medal}</span>
                  <Avatar name={e.name} size={16} />
                  <span style={{ flex: 1, fontSize: 11, fontWeight: i === 0 ? 600 : 500 }}>{e.name}</span>
                  <span style={{ fontFamily: ARCAID.fontMono, fontSize: 11, fontWeight: 700, color: s.text }}>
                    {formatScore(e.score)}
                  </span>
                </div>
              );
            })}
            {game.more.slice(0, 2).map(m => (
              <div key={m.rank} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '3px 8px', fontSize: 10,
              }}>
                <span style={{ width: 11, fontFamily: ARCAID.fontMono, color: ARCAID.faint }}>{m.rank}</span>
                <Avatar name={m.name} size={13} />
                <span style={{ flex: 1, color: ARCAID.muted }}>{m.name}</span>
                <span style={{ fontFamily: ARCAID.fontMono, color: ARCAID.faint }}>{formatScore(m.score)}</span>
              </div>
            ))}
            {game.scoreCount > filled.length + game.more.slice(0, 2).length && (
              <div style={{ fontSize: 9, color: ARCAID.faint, padding: '2px 10px' }}>
                +{game.scoreCount - filled.length - game.more.slice(0, 2).length} more
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{
        padding: '6px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        borderTop: `1px solid ${ARCAID.border}40`,
      }}>
        <span style={{ fontSize: 10, color: ARCAID.muted }}>{game.scoreCount} scores</span>
        <button style={{
          fontSize: 10, padding: '3px 10px', borderRadius: 4,
          border: `1px solid ${ARCAID.cyan}66`, color: ARCAID.cyan,
          background: 'transparent', cursor: 'pointer',
        }}>Submit score</button>
      </div>
    </div>
  );
}

function DirA() {
  return (
    <ArcAidFrame width={1100} height={900}>
      <div style={{ padding: '24px 28px', flex: 1, overflow: 'hidden' }}>
        <h1 style={{
          fontFamily: ARCAID.fontDisplay, fontSize: 28, fontWeight: 700,
          margin: '0 0 4px', letterSpacing: 0.5,
        }}>
          <span style={{ color: ARCAID.cyan }}>🏆 </span>Global Scoreboard
        </h1>
        <p style={{ color: ARCAID.muted, fontSize: 12, margin: '2px 0 18px' }}>
          High scores from every ArcAid room — submit your own with Discord login.
        </p>

        <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
          <div style={{
            flex: 1, height: 34, borderRadius: 4, border: `1px solid ${ARCAID.border}`,
            background: ARCAID.surface, display: 'flex', alignItems: 'center',
            padding: '0 12px', gap: 8, color: ARCAID.muted, fontSize: 12,
          }}>🔍 Search 2,427 games…</div>
          {['Popular', 'All rooms'].map(l => (
            <div key={l} style={{
              height: 34, borderRadius: 4, border: `1px solid ${ARCAID.border}`,
              background: ARCAID.surface, display: 'flex', alignItems: 'center',
              padding: '0 12px', gap: 8, fontSize: 11,
            }}>{l} <span>⌄</span></div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
          {['All', 'Physical', 'Virtual Pinball', 'Arcade & Video'].map((p, i) => (
            <span key={p} style={{
              fontSize: 10, padding: '4px 12px', borderRadius: 999,
              background: i === 0 ? 'rgba(100,200,240,0.15)' : 'transparent',
              color: i === 0 ? ARCAID.cyan : ARCAID.muted,
              border: `1px solid ${i === 0 ? ARCAID.cyan + '55' : ARCAID.border}`,
            }}>{p}</span>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
          {MOCK_GAMES.map(g => <CardTrimmed key={g.id} game={g} />)}
        </div>
      </div>
    </ArcAidFrame>
  );
}

window.DirA = DirA;
window.CardTrimmed = CardTrimmed;
