// Card density variants — how much leaderboard on each tile?
// Shown as a comparison grid so you can eyeball tradeoffs.

// Shared row renderer
function LBRow({ rank, name, score, highlight, you, next, avatar = true }) {
  const rc = rankColor(rank);
  const bg = you ? 'rgba(100,200,240,0.12)'
    : next ? 'rgba(250,190,80,0.08)'
    : highlight ? 'rgba(255,255,255,0.03)' : 'transparent';
  const border = you ? `1px solid ${ARCAID.cyan}55`
    : next ? `1px solid ${ARCAID.amber}44`
    : '1px solid transparent';

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '5px 8px', borderRadius: 5,
      background: bg, border,
    }}>
      <div style={{
        width: 20, textAlign: 'center', fontSize: 10, fontWeight: 700,
        color: rc.text, fontFamily: ARCAID.fontMono,
      }}>
        {rank === 1 ? <LucideMedal size={12} color={ARCAID.amber} /> : rank === 2 ? <LucideMedal size={12} color="#c0c0c0" /> : rank === 3 ? <LucideMedal size={12} color={ARCAID.bronze} /> : `#${rank}`}
      </div>
      {avatar && <Avatar name={name} size={18} />}
      <div style={{
        flex: 1, fontSize: 11, fontWeight: you ? 700 : 500,
        color: you ? ARCAID.cyan : next ? ARCAID.amber : ARCAID.primary,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {name}
        {you && <span style={{ fontSize: 8, marginLeft: 5, padding: '1px 4px', background: ARCAID.cyan + '33', borderRadius: 2, letterSpacing: 0.5 }}>YOU</span>}
        {next && <span style={{ fontSize: 8, marginLeft: 5, padding: '1px 4px', background: ARCAID.amber + '22', color: ARCAID.amber, borderRadius: 2, letterSpacing: 0.5 }}>NEXT</span>}
      </div>
      <div style={{
        fontFamily: ARCAID.fontMono, fontSize: 11,
        fontWeight: 700, color: rank === 1 ? ARCAID.amber : ARCAID.primary,
      }}>
        {formatScore(score)}
      </div>
    </div>
  );
}

// Card shell shared by variants
function D3CardShell({ game, label, badge, children, height = 340 }) {
  return (
    <div style={{
      width: 280, height,
      borderRadius: 10, overflow: 'hidden',
      border: `1px solid ${ARCAID.border}`,
      background: ARCAID.surface,
      display: 'flex', flexDirection: 'column',
      position: 'relative',
    }}>
      {label && (
        <div style={{
          position: 'absolute', top: -12, left: 10, zIndex: 5,
          padding: '2px 8px', fontSize: 9, fontFamily: ARCAID.fontMono,
          color: ARCAID.deep, background: ARCAID.amber,
          borderRadius: 3, fontWeight: 700, letterSpacing: 0.5,
        }}>{label}</div>
      )}
      <div style={{ position: 'relative', height: 100 }}>
        <BackglassPlaceholder hue={game.hue} rounded={0} style={{ position: 'absolute', inset: 0 }} />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0.05) 40%, rgba(16,18,26,0.95) 100%)' }} />
        <div style={{ position: 'absolute', top: 6, right: 6 }}>
          <PlatformPill accent={ARCAID.cyan}>{game.platforms[0]}</PlatformPill>
        </div>
        {badge && (
          <div style={{
            position: 'absolute', top: 6, left: 6,
            padding: '2px 7px', fontSize: 9, fontWeight: 700,
            background: 'rgba(0,0,0,0.6)', color: ARCAID.amber, borderRadius: 3,
            letterSpacing: 0.4,
          }}>{badge}</div>
        )}
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
      <div style={{ padding: 8, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {children}
      </div>
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

// Mock leaderboard — rich enough to show ranks 1–12 + "you" at various positions
const MOCK_LEADERBOARD = [
  { rank: 1, name: 'Krobs', score: 9525852588 },
  { rank: 2, name: 'UnknownP2', score: 4844125789 },
  { rank: 3, name: 'UnknownP4', score: 4578965412 },
  { rank: 4, name: 'DingDong', score: 2100456789 },
  { rank: 5, name: 'mekeburgj', score: 999464323, you: true },
  { rank: 6, name: 'Cal', score: 789456123 },
  { rank: 7, name: 'UnknownP6', score: 567321098 },
  { rank: 8, name: 'Pixel', score: 345678901 },
];

function Variant1_Top3() {
  return (
    <D3CardShell game={MOCK_GAMES[0]} label="A — Top 3 only" height={300}>
      <LBRow {...MOCK_LEADERBOARD[0]} highlight />
      <LBRow {...MOCK_LEADERBOARD[1]} />
      <LBRow {...MOCK_LEADERBOARD[2]} />
      <div style={{ flex: 1 }} />
      <div style={{ textAlign: 'center', fontSize: 9, color: ARCAID.faint, padding: 4 }}>
        +5 more · not showing you (#5)
      </div>
    </D3CardShell>
  );
}

function Variant2_Top5() {
  return (
    <D3CardShell game={MOCK_GAMES[0]} label="B — Top 5" height={340}>
      <LBRow {...MOCK_LEADERBOARD[0]} highlight />
      <LBRow {...MOCK_LEADERBOARD[1]} />
      <LBRow {...MOCK_LEADERBOARD[2]} />
      <LBRow {...MOCK_LEADERBOARD[3]} />
      <LBRow {...MOCK_LEADERBOARD[4]} you />
    </D3CardShell>
  );
}

function Variant3_Top3PlusYouPlusMinus() {
  return (
    <D3CardShell game={MOCK_GAMES[0]} label="C — Top 3 + You ±1" height={360}>
      <LBRow {...MOCK_LEADERBOARD[0]} highlight />
      <LBRow {...MOCK_LEADERBOARD[1]} />
      <LBRow {...MOCK_LEADERBOARD[2]} />
      <div style={{
        borderTop: `1px dashed ${ARCAID.border}`,
        margin: '3px 8px', padding: '4px 0 0',
        fontSize: 8, color: ARCAID.faint, textAlign: 'center', letterSpacing: 0.5,
      }}>· · ·</div>
      <LBRow {...MOCK_LEADERBOARD[3]} next />
      <LBRow {...MOCK_LEADERBOARD[4]} you />
      <LBRow {...MOCK_LEADERBOARD[5]} />
    </D3CardShell>
  );
}

function Variant4_Top3PlusNextToBeat() {
  return (
    <D3CardShell game={MOCK_GAMES[0]} label="D — Top 3 + Next to beat" height={340}>
      <LBRow {...MOCK_LEADERBOARD[0]} highlight />
      <LBRow {...MOCK_LEADERBOARD[1]} />
      <LBRow {...MOCK_LEADERBOARD[2]} />
      <div style={{
        borderTop: `1px dashed ${ARCAID.border}`,
        margin: '3px 8px', padding: '4px 0 0',
        fontSize: 8, color: ARCAID.faint, textAlign: 'center', letterSpacing: 0.5,
      }}><LucideChevronRight size={9} style={{verticalAlign: '-1px'}} /> your zone</div>
      <LBRow {...MOCK_LEADERBOARD[3]} next />
      <LBRow {...MOCK_LEADERBOARD[4]} you />
    </D3CardShell>
  );
}

// Variant 5 — not-yet-scored state
function Variant5_NotPlayed() {
  return (
    <D3CardShell game={MOCK_GAMES[0]} label="E — You haven't played yet" height={340}>
      <LBRow {...MOCK_LEADERBOARD[0]} highlight />
      <LBRow {...MOCK_LEADERBOARD[1]} />
      <LBRow {...MOCK_LEADERBOARD[2]} />
      <div style={{ flex: 1 }} />
      <div style={{
        margin: '6px 6px 0',
        padding: '10px 8px', textAlign: 'center',
        border: `1px dashed ${ARCAID.cyan}44`, borderRadius: 6,
        background: `${ARCAID.cyan}08`,
      }}>
        <div style={{ fontSize: 10, color: ARCAID.cyan, fontWeight: 700, letterSpacing: 0.5 }}>
          NO SCORE YET
        </div>
        <div style={{ fontSize: 10, color: ARCAID.muted, marginTop: 2 }}>
          #8 needs {formatScore(345678901)} to qualify
        </div>
      </div>
    </D3CardShell>
  );
}

// Hero card version — with expanded leaderboard
function Variant_HeroTop6PlusYou() {
  const g = MOCK_GAMES[1];
  const first = MOCK_LEADERBOARD[0];

  return (
    <div style={{
      width: 600, height: 420,
      position: 'relative', borderRadius: 14, overflow: 'hidden',
      border: `1px solid ${ARCAID.cyan}66`,
      boxShadow: `0 0 40px ${ARCAID.cyan}22`,
    }}>
      <BackglassPlaceholder hue={g.hue} rounded={0} style={{ position: 'absolute', inset: 0 }} />
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, rgba(16,18,26,0.97) 40%, rgba(16,18,26,0.5) 75%, transparent 100%)' }} />

      <div style={{ position: 'absolute', top: 14, left: 14, display: 'flex', gap: 6 }}>
        <span style={{
          padding: '3px 10px', borderRadius: 3, background: ARCAID.magenta, color: '#fff',
          fontSize: 9, fontWeight: 800, letterSpacing: 1,
        }}><LucideFlame size={10} style={{marginRight: 3, verticalAlign: '-2px'}} />HOT</span>
        <span style={{
          padding: '3px 10px', borderRadius: 3, background: 'rgba(0,0,0,0.5)', color: ARCAID.primary,
          fontSize: 9, fontWeight: 600,
        }}>+42 scores this week</span>
      </div>

      <div style={{ position: 'absolute', inset: 0, padding: 22, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
        <div style={{ fontSize: 10, color: ARCAID.cyan, fontFamily: ARCAID.fontMono, letterSpacing: 1 }}>
          {g.manufacturer.toUpperCase()} · {g.year}
        </div>
        <h2 style={{ fontFamily: ARCAID.fontDisplay, fontSize: 26, fontWeight: 800, margin: '4px 0 14px', lineHeight: 1 }}>{g.name}</h2>

        <div style={{ display: 'flex', gap: 18 }}>
          <div style={{ width: 200 }}>
            <div style={{ fontSize: 9, color: ARCAID.amber, fontWeight: 700, letterSpacing: 1, display: 'flex', alignItems: 'center', gap: 4 }}><LucideCrown size={11} />CHAMPION</div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 4 }}>
              <Avatar name={first.name} size={40} />
              <div>
                <div style={{ fontFamily: ARCAID.fontDisplay, fontSize: 13, fontWeight: 700 }}>{first.name}</div>
                <div style={{ fontFamily: ARCAID.fontMono, fontSize: 18, fontWeight: 700, color: ARCAID.amber }}>
                  {formatScore(first.score)}
                </div>
              </div>
            </div>
            <button style={{
              marginTop: 12, fontSize: 11, padding: '8px 14px', borderRadius: 5,
              background: ARCAID.cyan, color: ARCAID.deep, border: 'none', fontWeight: 700,
              cursor: 'pointer', width: '100%',
            }}><LucideArrowUp size={12} style={{marginRight: 5, verticalAlign: '-2px'}} />Submit your score</button>
          </div>

          <div style={{
            flex: 1, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(8px)',
            border: `1px solid ${ARCAID.border}`, borderRadius: 8,
            padding: 8, display: 'flex', flexDirection: 'column', gap: 2,
          }}>
            <div style={{ fontSize: 9, color: ARCAID.faint, padding: '2px 8px 4px', letterSpacing: 0.5 }}>LEADERBOARD</div>
            {MOCK_LEADERBOARD.slice(0, 6).map(p => <LBRow key={p.rank} {...p} avatar={false} />)}
            <div style={{
              borderTop: `1px dashed ${ARCAID.border}`, margin: '3px 4px',
              padding: '3px 0 0', fontSize: 8, color: ARCAID.faint, textAlign: 'center',
            }}>· · ·</div>
            <LBRow {...MOCK_LEADERBOARD[4]} avatar={false} />
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  Variant1_Top3, Variant2_Top5, Variant3_Top3PlusYouPlusMinus,
  Variant4_Top3PlusNextToBeat, Variant5_NotPlayed, Variant_HeroTop6PlusYou,
});
