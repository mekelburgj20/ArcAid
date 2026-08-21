// Interactive card with My Score / Top 6 toggle

// Extended mock leaderboard for toggle demo
const MOCK_LB_FULL = [
  { rank: 1, name: 'Krobs', score: 9525852588 },
  { rank: 2, name: 'UnknownP2', score: 4844125789 },
  { rank: 3, name: 'UnknownP4', score: 4578965412 },
  { rank: 4, name: 'DingDong', score: 2100456789 },
  { rank: 5, name: 'Slap Shot', score: 1500000000 },
  { rank: 6, name: 'Jolene', score: 1200456000 },
  { rank: 7, name: 'PinnyW', score: 1100000000 },
  { rank: 8, name: 'mekeburgj', score: 999464323, you: true },
  { rank: 9, name: 'Cal', score: 789456123 },
  { rank: 10, name: 'UnknownP6', score: 567321098 },
];

function ToggleCard({ game, defaultMode = 'top', mode: modeProp }) {
  const mode = modeProp ?? defaultMode;
  const youIdx = MOCK_LB_FULL.findIndex(p => p.you);
  const you = MOCK_LB_FULL[youIdx];

  const rows = mode === 'top'
    ? MOCK_LB_FULL.slice(0, 6)
    : (() => {
        const top3 = MOCK_LB_FULL.slice(0, 3);
        const near = MOCK_LB_FULL.slice(Math.max(3, youIdx - 1), youIdx + 2);
        return { top3, near };
      })();

  return (
    <div style={{
      width: 300, borderRadius: 10, overflow: 'hidden',
      border: `1px solid ${ARCAID.border}`,
      background: ARCAID.surface,
      display: 'flex', flexDirection: 'column',
    }}>
      {/* art */}
      <div style={{ position: 'relative', height: 100 }}>
        <BackglassPlaceholder hue={game.hue} rounded={0} style={{ position: 'absolute', inset: 0 }} />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0.05) 40%, rgba(16,18,26,0.95) 100%)' }} />
        <div style={{ position: 'absolute', top: 6, right: 6 }}>
          <PlatformPill accent={ARCAID.cyan}>{game.platforms[0]}</PlatformPill>
        </div>
        <div style={{ position: 'absolute', left: 10, right: 10, bottom: 6 }}>
          <div style={{
            fontFamily: ARCAID.fontDisplay, fontSize: 13, fontWeight: 700, lineHeight: 1.15,
            textShadow: '0 1px 4px rgba(0,0,0,0.8)',
          }}>{game.name}</div>
          <div style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.55)', marginTop: 1 }}>
            {game.manufacturer} · {game.year} · {game.scoreCount} scores
          </div>
        </div>
      </div>

      {/* rows */}
      <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 2, minHeight: 180 }}>
        {mode === 'top' ? (
          MOCK_LB_FULL.slice(0, 6).map((p, i) => <LBRow key={p.rank} {...p} highlight={i === 0} you={p.you} />)
        ) : (
          <>
            {rows.top3.map((p, i) => <LBRow key={p.rank} {...p} highlight={i === 0} />)}
            <div style={{
              borderTop: `1px dashed ${ARCAID.border}`,
              margin: '3px 8px', padding: '3px 0 0',
              fontSize: 8, color: ARCAID.faint, textAlign: 'center', letterSpacing: 0.5,
            }}>· · ·</div>
            {rows.near.map(p => <LBRow key={p.rank} {...p} you={p.you} next={p.rank === you.rank - 1} />)}
          </>
        )}
      </div>

      {/* footer */}
      <div style={{
        padding: '7px 10px',
        borderTop: `1px solid ${ARCAID.border}50`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{ fontSize: 10, color: ARCAID.muted }}>View full →</span>
        <button style={{
          fontSize: 10, padding: '4px 10px', borderRadius: 4,
          background: ARCAID.cyan, color: ARCAID.deep,
          border: 'none', fontWeight: 700, cursor: 'pointer',
        }}>Submit</button>
      </div>
    </div>
  );
}

// Grid demo — several cards, some defaulting to top, some to mine, plus a page-level default toggle
function ToggleCardGrid() {
  const [globalDefault, setGlobalDefault] = React.useState('top');
  return (
    <div style={{ padding: 32, background: ARCAID.deep, minHeight: 600, fontFamily: ARCAID.fontBody, color: ARCAID.primary }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 24, flexWrap: 'wrap', gap: 12,
      }}>
        <div>
          <div style={{ fontFamily: ARCAID.fontDisplay, fontSize: 18, fontWeight: 700 }}>
            Interactive prototype — click the toggle at the top
          </div>
          <div style={{ fontSize: 12, color: ARCAID.muted, marginTop: 4 }}>
            One toggle flips every card at once. Preference remembered per user in real implementation.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', gap: 2, background: ARCAID.surface, border: `1px solid ${ARCAID.border}`, borderRadius: 5, padding: 2 }}>
            <button onClick={() => setGlobalDefault('top')} style={{
              fontSize: 11, padding: '6px 14px', borderRadius: 3,
              background: globalDefault === 'top' ? ARCAID.cyan + '22' : 'transparent',
              color: globalDefault === 'top' ? ARCAID.cyan : ARCAID.muted,
              border: 'none', fontWeight: 700, cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}><LucideTrophy size={12} />Top 6</button>
            <button onClick={() => setGlobalDefault('mine')} style={{
              fontSize: 11, padding: '6px 14px', borderRadius: 3,
              background: globalDefault === 'mine' ? ARCAID.cyan + '22' : 'transparent',
              color: globalDefault === 'mine' ? ARCAID.cyan : ARCAID.muted,
              border: 'none', fontWeight: 700, cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}><LucideMapPin size={12} />My Score</button>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        <ToggleCard key={'a-' + globalDefault} game={MOCK_GAMES[0]} mode={globalDefault} />
        <ToggleCard key={'b-' + globalDefault} game={MOCK_GAMES[3]} mode={globalDefault} />
        <ToggleCard key={'c-' + globalDefault} game={MOCK_GAMES[4]} mode={globalDefault} />
        <ToggleCard key={'d-' + globalDefault} game={MOCK_GAMES[6]} mode={globalDefault} />
      </div>
    </div>
  );
}

Object.assign(window, { ToggleCard, ToggleCardGrid });
