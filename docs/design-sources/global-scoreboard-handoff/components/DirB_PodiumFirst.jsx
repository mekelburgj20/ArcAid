// Direction B — "Podium First". Game is the supporting cast; the 1st-place
// player is the hero. Big avatar, big score. For a casual after-a-session user
// who wants social/bragging-rights vibes.

function CardPodium({ game }) {
  const first = game.top[0];
  const second = game.top[1];
  const third = game.top[2];

  return (
    <div style={{
      position: 'relative', borderRadius: 12, overflow: 'hidden',
      border: `1px solid ${ARCAID.border}`,
      background: ARCAID.surface,
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Blurred art as mood background */}
      <div style={{ position: 'absolute', inset: 0 }}>
        <BackglassPlaceholder hue={game.hue} rounded={0} style={{ position: 'absolute', inset: 0, filter: 'blur(14px) saturate(1.3)' }} />
        <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(180deg, rgba(16,18,26,0.55), rgba(16,18,26,0.95))` }} />
      </div>

      <div style={{ position: 'relative', padding: '10px 12px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: ARCAID.fontDisplay, fontSize: 12, fontWeight: 700, letterSpacing: 0.3, lineHeight: 1.15, textTransform: 'uppercase' }}>
            {game.name}
          </div>
          <div style={{ fontSize: 9.5, color: ARCAID.muted, marginTop: 1 }}>
            {game.manufacturer} · {game.year}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 2 }}>
          {game.platforms.slice(0, 1).map(p => <PlatformPill key={p} accent={ARCAID.cyan}>{p}</PlatformPill>)}
        </div>
      </div>

      {/* Hero: #1 — big. */}
      <div style={{ position: 'relative', padding: '14px 14px 10px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {first ? (
          <>
            <div style={{ position: 'relative' }}>
              <div style={{
                width: 54, height: 54, borderRadius: '50%',
                background: `radial-gradient(circle, ${ARCAID.amber}33 10%, transparent 70%)`,
                position: 'absolute', inset: -8, filter: 'blur(8px)',
              }} />
              <Avatar name={first.name} size={54} color={`oklch(55% 0.18 ${game.hue})`} />
              <div style={{
                position: 'absolute', top: -4, right: -4,
                background: ARCAID.amber, color: ARCAID.deep,
                fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 99,
                fontFamily: ARCAID.fontDisplay,
              }}>1st</div>
            </div>
            <div style={{ fontFamily: ARCAID.fontDisplay, fontSize: 13, fontWeight: 700, marginTop: 6 }}>
              {first.name}
            </div>
            <div style={{
              fontFamily: ARCAID.fontMono, fontSize: 18, fontWeight: 700, color: ARCAID.amber,
              letterSpacing: -0.5, marginTop: 1,
              textShadow: `0 0 12px ${ARCAID.amber}55`,
            }}>
              {formatScore(first.score)}
            </div>
          </>
        ) : (
          <div style={{
            padding: '20px 8px', textAlign: 'center',
            fontSize: 11, color: ARCAID.faint, fontStyle: 'italic',
          }}>
            No scores yet<br/>
            <span style={{ color: ARCAID.cyan, fontStyle: 'normal', fontSize: 10 }}>↑ be the first</span>
          </div>
        )}
      </div>

      {/* Challengers row */}
      <div style={{ position: 'relative', display: 'flex', gap: 8, padding: '0 12px 10px' }}>
        {[second, third].map((e, i) => e ? (
          <div key={i} style={{
            flex: 1, display: 'flex', alignItems: 'center', gap: 6,
            padding: '5px 7px', borderRadius: 6,
            background: 'rgba(255,255,255,0.04)',
            border: `1px solid rgba(255,255,255,0.08)`,
          }}>
            <span style={{ fontSize: 9, color: ARCAID.muted, fontWeight: 700 }}>{i === 0 ? '2' : '3'}</span>
            <Avatar name={e.name} size={14} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 9.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</div>
              <div style={{ fontFamily: ARCAID.fontMono, fontSize: 9, color: ARCAID.muted }}>{formatScore(e.score)}</div>
            </div>
          </div>
        ) : <div key={i} style={{ flex: 1 }} />)}
      </div>

      <div style={{ flex: 1 }} />
      <div style={{
        position: 'relative', padding: '7px 12px',
        borderTop: `1px solid ${ARCAID.border}80`,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: 'rgba(0,0,0,0.25)',
      }}>
        <span style={{ fontSize: 10, color: ARCAID.muted }}>
          {game.scoreCount} {game.scoreCount === 1 ? 'score' : 'scores'}
        </span>
        <button style={{
          fontSize: 10, padding: '4px 10px', borderRadius: 4,
          border: 'none', background: ARCAID.cyan, color: ARCAID.deep,
          fontWeight: 700, cursor: 'pointer',
        }}>Beat this score →</button>
      </div>
    </div>
  );
}

function DirB() {
  return (
    <ArcAidFrame width={1100} height={900}>
      <div style={{ padding: '24px 28px', flex: 1, overflow: 'hidden' }}>
        <h1 style={{ fontFamily: ARCAID.fontDisplay, fontSize: 28, margin: '0 0 4px' }}>
          <span style={{ color: ARCAID.cyan }}>🏆 </span>Global Scoreboard
        </h1>
        <p style={{ color: ARCAID.muted, fontSize: 12, margin: '2px 0 18px' }}>
          Who's holding the crown across every ArcAid room.
        </p>
        <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
          <div style={{ flex: 1, height: 34, borderRadius: 4, border: `1px solid ${ARCAID.border}`, background: ARCAID.surface, padding: '0 12px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: ARCAID.muted }}>🔍 Search…</div>
          <div style={{ display: 'flex', gap: 4, background: ARCAID.surface, border: `1px solid ${ARCAID.border}`, borderRadius: 4, padding: 3 }}>
            {['Popular', 'New', 'Rated'].map((p, i) => (
              <span key={p} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 2, background: i === 0 ? ARCAID.cyan + '22' : 'transparent', color: i === 0 ? ARCAID.cyan : ARCAID.muted }}>{p}</span>
            ))}
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
          {MOCK_GAMES.map(g => <CardPodium key={g.id} game={g} />)}
        </div>
      </div>
    </ArcAidFrame>
  );
}

window.DirB = DirB;
window.CardPodium = CardPodium;
