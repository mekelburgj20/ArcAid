// Direction C — "Leaderboard List". Dense table-style rows. Best for
// power users / lots of games. Game becomes a left rail.

function RowLeaderboard({ game }) {
  const first = game.top[0];
  const second = game.top[1];
  const third = game.top[2];

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '44px 1fr 1.4fr 120px 100px',
      gap: 14, alignItems: 'center',
      padding: '10px 14px',
      borderBottom: `1px solid ${ARCAID.border}70`,
      cursor: 'pointer',
    }}>
      <BackglassPlaceholder hue={game.hue} style={{ width: 44, height: 44 }} rounded={6} label="" />

      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: ARCAID.fontDisplay, fontWeight: 700, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {game.name}
        </div>
        <div style={{ fontSize: 10, color: ARCAID.muted, marginTop: 1, display: 'flex', gap: 6, alignItems: 'center' }}>
          <span>{game.manufacturer} · {game.year}</span>
          <span style={{ color: ARCAID.faint }}>·</span>
          <div style={{ display: 'flex', gap: 2 }}>
            {game.platforms.slice(0, 2).map(p => <PlatformPill key={p}>{p}</PlatformPill>)}
          </div>
        </div>
      </div>

      {/* Inline podium */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        {first ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontSize: 10, color: ARCAID.amber, fontWeight: 800, width: 12 }}>1</span>
            <Avatar name={first.name} size={18} />
            <span style={{ fontSize: 11, fontWeight: 600 }}>{first.name}</span>
            <span style={{ fontFamily: ARCAID.fontMono, fontSize: 11, fontWeight: 700, color: ARCAID.amber }}>
              {formatScore(first.score)}
            </span>
          </div>
        ) : (
          <span style={{ fontSize: 10, color: ARCAID.faint, fontStyle: 'italic' }}>No scores yet</span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        {[second, third].map((e, i) => e ? (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: ARCAID.muted }}>
            <span style={{ width: 8, color: i === 0 ? '#d4d4d4' : ARCAID.bronze, fontWeight: 700 }}>{i + 2}</span>
            <Avatar name={e.name} size={12} />
            <span style={{ fontFamily: ARCAID.fontMono }}>{formatScore(e.score)}</span>
          </div>
        ) : null)}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, alignItems: 'center' }}>
        <span style={{ fontSize: 10, color: ARCAID.muted }}>{game.scoreCount}</span>
        <button style={{
          fontSize: 10, padding: '3px 9px', borderRadius: 4,
          border: `1px solid ${ARCAID.cyan}66`, color: ARCAID.cyan,
          background: 'transparent', cursor: 'pointer',
        }}>Submit</button>
      </div>
    </div>
  );
}

function DirC() {
  return (
    <ArcAidFrame width={1100} height={900}>
      <div style={{ padding: '24px 28px', flex: 1, overflow: 'hidden' }}>
        <h1 style={{ fontFamily: ARCAID.fontDisplay, fontSize: 28, margin: '0 0 4px' }}>
          <span style={{ color: ARCAID.cyan }}>🏆 </span>Global Scoreboard
        </h1>
        <p style={{ color: ARCAID.muted, fontSize: 12, margin: '2px 0 18px' }}>
          Dense view — scan fast, submit in one click.
        </p>

        <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          <div style={{ flex: 1, height: 34, borderRadius: 4, border: `1px solid ${ARCAID.border}`, background: ARCAID.surface, padding: '0 12px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: ARCAID.muted }}>🔍 Search…</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {['All', 'Physical', 'Virtual', 'Video'].map((p, i) => (
              <span key={p} style={{
                fontSize: 11, padding: '6px 12px', borderRadius: 999,
                background: i === 0 ? ARCAID.cyan + '22' : 'transparent',
                color: i === 0 ? ARCAID.cyan : ARCAID.muted,
                border: `1px solid ${i === 0 ? ARCAID.cyan + '55' : ARCAID.border}`,
              }}>{p}</span>
            ))}
          </div>
        </div>

        <div style={{
          border: `1px solid ${ARCAID.border}`, borderRadius: 8,
          background: ARCAID.surface, overflow: 'hidden',
        }}>
          {/* Column header */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '44px 1fr 1.4fr 120px 100px',
            gap: 14, padding: '8px 14px',
            fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase',
            color: ARCAID.faint, background: 'rgba(0,0,0,0.3)',
            borderBottom: `1px solid ${ARCAID.border}`,
          }}>
            <span></span>
            <span>Game</span>
            <span>Champion</span>
            <span>2nd / 3rd</span>
            <span style={{ textAlign: 'right' }}>Scores</span>
          </div>
          {MOCK_GAMES.map(g => <RowLeaderboard key={g.id} game={g} />)}
        </div>
      </div>
    </ArcAidFrame>
  );
}

window.DirC = DirC;
