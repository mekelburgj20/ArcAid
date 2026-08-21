// Direction D — "Broadcast Hero". ESPN / Twitch-broadcast vibe.
// Hero card for top trending, grid of cinematic tiles below.

function BroadcastHero({ game }) {
  const first = game.top[0];
  return (
    <div style={{
      gridColumn: 'span 2', gridRow: 'span 2',
      position: 'relative', borderRadius: 14, overflow: 'hidden',
      border: `1px solid ${ARCAID.cyan}55`,
      boxShadow: `0 0 40px ${ARCAID.cyan}22`,
    }}>
      <BackglassPlaceholder hue={game.hue} rounded={0} style={{ position: 'absolute', inset: 0 }} />
      <div style={{
        position: 'absolute', inset: 0,
        background: `linear-gradient(90deg, rgba(16,18,26,0.92) 0%, rgba(16,18,26,0.65) 45%, transparent 100%)`,
      }} />
      <div style={{
        position: 'absolute', top: 10, left: 10,
        padding: '3px 8px', borderRadius: 3,
        background: ARCAID.magenta, color: '#fff',
        fontSize: 9, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase',
      }}>● LIVE · Most played</div>

      <div style={{ position: 'absolute', top: 10, right: 10, display: 'flex', gap: 3 }}>
        {game.platforms.slice(0, 2).map(p => <PlatformPill key={p} accent={ARCAID.cyan}>{p}</PlatformPill>)}
      </div>

      <div style={{ position: 'absolute', inset: 0, padding: 18, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
        <div style={{ fontSize: 10, color: ARCAID.cyan, fontFamily: ARCAID.fontMono, letterSpacing: 1, marginBottom: 4 }}>
          {game.manufacturer.toUpperCase()} · {game.year}
        </div>
        <h2 style={{
          fontFamily: ARCAID.fontDisplay, fontSize: 32, fontWeight: 800, lineHeight: 1,
          margin: 0, textShadow: '0 2px 8px rgba(0,0,0,0.8)',
        }}>{game.name}</h2>
        {first && (
          <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
            <Avatar name={first.name} size={42} />
            <div>
              <div style={{ fontSize: 10, color: ARCAID.amber, fontWeight: 700, letterSpacing: 0.5 }}>CURRENT CHAMPION</div>
              <div style={{ fontFamily: ARCAID.fontDisplay, fontSize: 15, fontWeight: 700 }}>{first.name}</div>
              <div style={{ fontFamily: ARCAID.fontMono, fontSize: 20, fontWeight: 700, color: ARCAID.amber }}>
                {formatScore(first.score)}
              </div>
            </div>
          </div>
        )}
        <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
          <button style={{
            fontSize: 11, padding: '8px 16px', borderRadius: 4,
            background: ARCAID.cyan, color: ARCAID.deep,
            border: 'none', fontWeight: 700, cursor: 'pointer',
          }}>Submit your score →</button>
          <button style={{
            fontSize: 11, padding: '8px 14px', borderRadius: 4,
            background: 'rgba(255,255,255,0.08)', color: '#fff',
            border: '1px solid rgba(255,255,255,0.2)', cursor: 'pointer',
          }}>View leaderboard</button>
        </div>
      </div>
    </div>
  );
}

function BroadcastTile({ game }) {
  const first = game.top[0];
  return (
    <div style={{
      position: 'relative', borderRadius: 10, overflow: 'hidden',
      border: `1px solid ${ARCAID.border}`, aspectRatio: '4/5',
    }}>
      <BackglassPlaceholder hue={game.hue} rounded={0} style={{ position: 'absolute', inset: 0 }} />
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0.2) 30%, rgba(16,18,26,0.95))' }} />
      <div style={{ position: 'absolute', top: 6, right: 6, display: 'flex', gap: 3 }}>
        {game.platforms.slice(0, 1).map(p => <PlatformPill key={p} accent={ARCAID.cyan}>{p}</PlatformPill>)}
      </div>
      <div style={{ position: 'absolute', inset: 0, padding: 10, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
        <div style={{ fontFamily: ARCAID.fontDisplay, fontWeight: 700, fontSize: 13, lineHeight: 1.1, textShadow: '0 1px 4px #000' }}>
          {game.name}
        </div>
        <div style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.55)', marginTop: 1 }}>
          {game.manufacturer} · {game.year}
        </div>
        {first ? (
          <div style={{
            marginTop: 8, padding: '6px 8px',
            background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(6px)',
            borderRadius: 6, display: 'flex', alignItems: 'center', gap: 7,
            border: `1px solid ${ARCAID.amber}40`,
          }}>
            <Avatar name={first.name} size={20} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 10, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{first.name}</div>
              <div style={{ fontFamily: ARCAID.fontMono, fontSize: 11, fontWeight: 700, color: ARCAID.amber }}>
                {formatScore(first.score)}
              </div>
            </div>
            <span style={{ fontSize: 9, color: ARCAID.muted }}>#{1}</span>
          </div>
        ) : (
          <div style={{
            marginTop: 8, padding: '7px 8px', borderRadius: 6,
            border: `1px dashed ${ARCAID.cyan}55`, textAlign: 'center',
            fontSize: 10, color: ARCAID.cyan,
          }}>Claim 1st →</div>
        )}
      </div>
    </div>
  );
}

function DirD() {
  return (
    <ArcAidFrame width={1100} height={900}>
      <div style={{ padding: '24px 28px', flex: 1, overflow: 'hidden' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 18 }}>
          <h1 style={{ fontFamily: ARCAID.fontDisplay, fontSize: 28, margin: 0 }}>
            <span style={{ color: ARCAID.magenta }}>● </span>Global Scoreboard
          </h1>
          <div style={{ fontSize: 11, color: ARCAID.muted, fontFamily: ARCAID.fontMono }}>
            2,427 games · updated 12s ago
          </div>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gridAutoRows: '190px',
          gap: 12,
        }}>
          <BroadcastHero game={MOCK_GAMES[1]} />
          {MOCK_GAMES.slice(0, 8).filter((_, i) => i !== 1).slice(0, 6).map(g => (
            <BroadcastTile key={g.id} game={g} />
          ))}
        </div>
      </div>
    </ArcAidFrame>
  );
}

window.DirD = DirD;
