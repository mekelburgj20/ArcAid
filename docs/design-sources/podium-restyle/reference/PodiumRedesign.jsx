// Podium restyle options for the room "Showcase" card (ShowcasePodium.tsx).
// Replaces the solid gold/silver/bronze rectangles with sleeker treatments.
// Structure preserved: pyramid (1st centered 65%, 2nd/3rd below), avatar+name,
// mono score, expand affordance, empty-slot state.

const PODIUM_METALS = {
  1: { c: ARCAID.amber, label: '1ST' },
  2: { c: '#c0c0c0', label: '2ND' },
  3: { c: ARCAID.bronze, label: '3RD' },
};

const PODIUM_DATA = [
  { rank: 1, name: 'mekelburgj', score: 46255563, expandable: true },
  { rank: 2, name: 'RetroTec…', score: 17277285 },
  { rank: 3, name: null, score: null },
];

const PODIUM_DATA_FULL = [
  { rank: 1, name: 'mekelburgj', score: 46255563, expandable: true },
  { rank: 2, name: 'RetroTec…', score: 17277285 },
  { rank: 3, name: 'PinWizard', score: 9841002 },
];

const RUNNERS_UP = [
  { rank: 4, name: 'Krobs', score: 6220450 },
  { rank: 5, name: 'SlapShot', score: 4187930 },
];

const podiumKeyframes = `
@keyframes pr-glitch {
  0%, 91%, 100% { text-shadow: 0 0 8px currentColor; transform: translate(0,0); clip-path: none; }
  92% { text-shadow: -2px 0 oklch(74% 0.16 232.661), 2px 0 oklch(65% 0.241 354.308), 0 0 8px currentColor; transform: translate(1px,0); }
  94% { text-shadow: 2px 0 oklch(74% 0.16 232.661), -2px 0 oklch(65% 0.241 354.308), 0 0 8px currentColor; transform: translate(-1px,0); clip-path: inset(20% 0 55% 0); }
  95% { clip-path: none; transform: translate(0,0); }
  97% { text-shadow: -1.5px 0 oklch(74% 0.16 232.661), 1.5px 0 oklch(65% 0.241 354.308), 0 0 8px currentColor; clip-path: inset(60% 0 15% 0); }
  98% { clip-path: none; }
}
@keyframes pr-scan {
  0% { background-position: 0 -120%; }
  100% { background-position: 0 220%; }
}
@keyframes pr-led {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
@keyframes pr-breathe {
  0%, 100% { filter: brightness(1); box-shadow: 0 -1px 14px var(--pr-glow); }
  50% { filter: brightness(1.45); box-shadow: 0 -2px 30px var(--pr-glow-hi); }
}
`;

// Deliberately loud fake backglass — hot colors, stripes, starbursts — to stress-test podium legibility.
function BusyBackglass() {
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: 'linear-gradient(135deg, oklch(65% 0.26 25) 0%, oklch(75% 0.22 90) 30%, oklch(60% 0.25 330) 60%, oklch(70% 0.2 200) 100%)' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'repeating-conic-gradient(from 0deg at 50% 38%, rgba(255,255,60,0.55) 0deg 12deg, transparent 12deg 24deg)' }} />
      <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(45deg, rgba(255,0,80,0.35) 0 14px, transparent 14px 34px), repeating-linear-gradient(-45deg, rgba(0,220,255,0.3) 0 10px, transparent 10px 42px)' }} />
      {[[18,22,64],[72,30,44],[40,58,80],[85,72,52],[12,78,38]].map(([x,y,s],i) => (
        <div key={i} style={{ position: 'absolute', left: `${x}%`, top: `${y}%`, width: s, height: s, borderRadius: '50%', background: `radial-gradient(circle, rgba(255,255,255,0.9), rgba(255,200,0,0.5) 40%, transparent 70%)` }} />
      ))}
    </div>
  );
}

// ── Mobile room-card frame (matches the Showcase card screenshot) ──
function RoomCardFrame({ children, label, busy = false }) {
  return (
    <div style={{
      width: 330, borderRadius: 18, overflow: 'hidden', position: 'relative',
      background: ARCAID.deep, color: '#fff', fontFamily: ARCAID.fontBody,
      border: `1px solid ${ARCAID.border}`,
      display: 'flex', flexDirection: 'column',
    }}>
      {/* backglass art */}
      {busy ? <BusyBackglass /> : <BackglassPlaceholder hue={30} rounded={0} label={'\u00a0'} style={{ position: 'absolute', inset: 0 }} />}
      <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(180deg, rgba(10,12,18,0.88) 0%, rgba(10,12,18,${busy ? 0.4 : 0.55}) 30%, rgba(10,12,18,${busy ? 0.3 : 0.45}) 60%, rgba(10,12,18,0.85) 100%)` }} />

      <div style={{ position: 'relative', padding: '18px 16px 14px', textAlign: 'center' }}>
        <div style={{ fontFamily: ARCAID.fontDisplay, fontSize: 16, fontWeight: 700, lineHeight: 1.25, textWrap: 'pretty' }}>
          Brothers in Arms – Win the War Pinball
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <span style={{
            padding: '3px 12px', borderRadius: 4, background: `${ARCAID.magenta}26`,
            border: `1px solid ${ARCAID.magenta}66`, color: ARCAID.magenta,
            fontFamily: ARCAID.fontMono, fontSize: 10, fontWeight: 700, letterSpacing: 2,
          }}>DAILY GRIND</span>
          <span style={{ fontFamily: ARCAID.fontMono, fontSize: 10, color: 'rgba(255,255,255,0.65)' }}>6h 18m left</span>
        </div>
      </div>

      <div style={{ position: 'relative', flex: 1 }}>{children}</div>

      <div style={{
        position: 'relative', padding: '12px 16px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: 'rgba(0,0,0,0.45)',
      }}>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: 1 }}>FULL LEADERBOARD →</span>
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>2 players</span>
      </div>
      {label && (
        <div style={{
          position: 'absolute', top: 8, left: 8, zIndex: 5, padding: '2px 8px',
          background: ARCAID.cyan, color: ARCAID.deep, fontFamily: ARCAID.fontMono,
          fontSize: 9, fontWeight: 700, borderRadius: 3, letterSpacing: 0.5,
        }}>{label}</div>
      )}
    </div>
  );
}

function PodiumPyramid({ renderSlot }) {
  return (
    <div style={{ padding: '0 16px 16px' }}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
        <div style={{ width: '68%', minWidth: 170 }}>{renderSlot(PODIUM_DATA[0], true)}</div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>{renderSlot(PODIUM_DATA[1], false)}</div>
        <div style={{ flex: 1, minWidth: 0 }}>{renderSlot(PODIUM_DATA[2], false)}</div>
      </div>
    </div>
  );
}

function SlotName({ entry, large, color = '#fff' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, maxWidth: '100%', minWidth: 0 }}>
      <Avatar name={entry.name} size={large ? 24 : 20} />
      <span style={{ fontSize: large ? 14 : 12, fontWeight: 600, color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>
    </div>
  );
}

// ── A · Neon Rim — dark glass, hairline metal border + soft glow ──
function PodiumNeonRim() {
  const slot = (d, large) => {
    const m = PODIUM_METALS[d.rank];
    if (!d.name) return (
      <div style={{
        borderRadius: 12, minHeight: large ? 96 : 84, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 4,
        background: 'rgba(0,0,0,0.35)', border: `1px dashed ${m.c}44`,
      }}>
        <span style={{ fontFamily: ARCAID.fontMono, fontSize: 9, letterSpacing: 1.5, color: `${m.c}88` }}>{m.label}</span>
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>open</span>
      </div>
    );
    return (
      <div style={{
        borderRadius: 12, minHeight: large ? 96 : 84, padding: '10px 8px',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5,
        background: 'rgba(8,10,16,0.62)', backdropFilter: 'blur(10px)',
        border: `1px solid ${m.c}${large ? '99' : '66'}`,
        boxShadow: `0 0 ${large ? 22 : 12}px ${m.c}${large ? '40' : '26'}, inset 0 0 14px rgba(0,0,0,0.5)`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: m.c }}>
          {d.rank === 1 && <LucideTrophy size={11} />}
          <span style={{ fontFamily: ARCAID.fontMono, fontSize: 9, fontWeight: 700, letterSpacing: 1.5 }}>{m.label}</span>
        </div>
        <SlotName entry={d} large={large} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ fontFamily: ARCAID.fontMono, fontSize: large ? 15 : 12, fontWeight: 700, color: m.c, textShadow: `0 0 10px ${m.c}66` }}>
            {d.score.toLocaleString()}
          </span>
          {d.expandable && <LucidePlus size={11} color={m.c} />}
        </div>
      </div>
    );
  };
  return <RoomCardFrame label="A · NEON RIM"><PodiumPyramid renderSlot={slot} /></RoomCardFrame>;
}

// ── B · Glitch — no boxes; oversized glitching rank numeral + underline ──
function PodiumGlitch() {
  const slot = (d, large) => {
    const m = PODIUM_METALS[d.rank];
    if (!d.name) return (
      <div style={{ minHeight: large ? 96 : 84, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, opacity: 0.5 }}>
        <span style={{ fontFamily: ARCAID.fontDisplay, fontSize: 26, fontWeight: 800, color: 'transparent', WebkitTextStroke: `1px ${m.c}55` }}>{d.rank}</span>
        <div style={{ width: '55%', height: 1, background: `${m.c}33` }} />
        <span style={{ fontSize: 9, fontFamily: ARCAID.fontMono, color: 'rgba(255,255,255,0.3)', letterSpacing: 1 }}>OPEN SLOT</span>
      </div>
    );
    return (
      <div style={{ minHeight: large ? 96 : 84, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, padding: '6px 4px' }}>
        <span style={{
          fontFamily: ARCAID.fontDisplay, fontSize: large ? 34 : 26, fontWeight: 800, lineHeight: 1,
          color: m.c, animation: `pr-glitch ${3.2 + d.rank * 0.9}s infinite`,
        }}>{d.rank}</span>
        <SlotName entry={d} large={large} />
        <span style={{ fontFamily: ARCAID.fontMono, fontSize: large ? 15 : 12, fontWeight: 700, color: '#fff', textShadow: `0 0 12px ${m.c}` }}>
          {d.score.toLocaleString()}{d.expandable ? ' +' : ''}
        </span>
        <div style={{ width: '62%', height: 2, borderRadius: 1, background: `linear-gradient(90deg, transparent, ${m.c}, transparent)`, boxShadow: `0 0 8px ${m.c}` }} />
      </div>
    );
  };
  return <RoomCardFrame label="B · GLITCH"><PodiumPyramid renderSlot={slot} /></RoomCardFrame>;
}

// ── C · Edge-lit — dark slab, LED bar on the bottom edge, color bleeds up ──
function PodiumEdgeLit() {
  const slot = (d, large) => {
    const m = PODIUM_METALS[d.rank];
    const empty = !d.name;
    return (
      <div style={{
        borderRadius: 10, minHeight: large ? 96 : 84, padding: '10px 8px 12px',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5,
        position: 'relative', overflow: 'hidden',
        background: empty ? 'rgba(0,0,0,0.3)' : `linear-gradient(180deg, rgba(8,10,16,0.72) 30%, ${m.c}14 100%)`,
        backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,0.07)',
      }}>
        {!empty && <div style={{
          position: 'absolute', left: '12%', right: '12%', bottom: 0, height: 3, borderRadius: '2px 2px 0 0',
          background: m.c, boxShadow: `0 0 12px ${m.c}, 0 -4px 18px ${m.c}66`,
          animation: large ? 'pr-led 3s ease-in-out infinite' : 'none',
        }} />}
        <span style={{ fontFamily: ARCAID.fontMono, fontSize: 9, fontWeight: 700, letterSpacing: 2, color: empty ? 'rgba(255,255,255,0.25)' : m.c }}>
          {m.label}
        </span>
        {empty ? (
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>unclaimed</span>
        ) : (
          <>
            <SlotName entry={d} large={large} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ fontFamily: ARCAID.fontMono, fontSize: large ? 15 : 12, fontWeight: 700, color: '#fff' }}>
                {d.score.toLocaleString()}
              </span>
              {d.expandable && <LucidePlus size={11} color={m.c} />}
            </div>
          </>
        )}
      </div>
    );
  };
  return <RoomCardFrame label="C · EDGE-LIT"><PodiumPyramid renderSlot={slot} /></RoomCardFrame>;
}

// ── D · Holo Steps — real podium silhouette, translucent steps, neon rims ──
function PodiumHoloSteps({ filled = false, busyBg = false }) {
  const data = filled ? PODIUM_DATA_FULL : PODIUM_DATA;
  const step = (d, height, order) => {
    const m = PODIUM_METALS[d.rank];
    const empty = !d.name;
    return (
      <div key={d.rank} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', order }}>
        {!empty && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, marginBottom: 8 }}>
            <Avatar name={d.name} size={d.rank === 1 ? 30 : 24} />
            <span style={{ fontSize: d.rank === 1 ? 12.5 : 11, fontWeight: 600, maxWidth: '95%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>{d.name}</span>
            <span style={{ fontFamily: ARCAID.fontMono, fontSize: d.rank === 1 ? 13 : 11, fontWeight: 700, color: m.c, textShadow: `0 0 10px ${m.c}55, 0 1px 4px rgba(0,0,0,0.9)` }}>
              {d.score.toLocaleString()}{d.expandable ? ' +' : ''}
            </span>
          </div>
        )}
        <div style={{
          height, borderRadius: '6px 6px 0 0', position: 'relative', overflow: 'hidden',
          background: empty
            ? 'rgba(255,255,255,0.03)'
            : `linear-gradient(180deg, ${m.c}66 0%, ${m.c}3a 55%, ${m.c}18 100%), rgba(8,10,16,0.5)`,
          borderTop: `2px solid ${empty ? 'rgba(255,255,255,0.12)' : m.c}`,
          backdropFilter: 'blur(8px)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
          ...(empty ? {} : {
            '--pr-glow': `${m.c}44`, '--pr-glow-hi': `${m.c}99`,
            animation: `pr-breathe ${3.6 + d.rank * 0.6}s ease-in-out ${d.rank * 0.4}s infinite`,
          }),
        }}>
          {!empty && d.rank === 1 && <div style={{
            position: 'absolute', inset: 0,
            background: `repeating-linear-gradient(0deg, transparent 0 3px, rgba(255,255,255,0.045) 3px 4px)`,
            backgroundSize: '100% 300%', animation: 'pr-scan 7s linear infinite',
          }} />}
          <span style={{
            fontFamily: ARCAID.fontDisplay, fontSize: 22, fontWeight: 800, marginTop: 6,
            color: empty ? 'rgba(255,255,255,0.12)' : '#fff',
            textShadow: empty ? 'none' : `0 0 14px ${m.c}, 0 1px 3px rgba(0,0,0,0.8)`,
          }}>{d.rank}</span>
        </div>
      </div>
    );
  };
  return (
    <RoomCardFrame label={filled ? (busyBg ? 'D2 · BUSY BACKGROUND' : 'D2 · HOLO STEPS + LIST') : 'D · HOLO STEPS'} busy={busyBg}>
      <div style={{ padding: '4px 16px 12px', display: 'flex', gap: 6, alignItems: 'flex-end' }}>
        {step(data[1], 44, 1)}
        {step(data[0], 64, 2)}
        {step(data[2], 32, 3)}
      </div>
      {filled && (
        <div style={{ padding: '0 16px 14px', display: 'flex', flexDirection: 'column', gap: 3 }}>
          {RUNNERS_UP.map(r => (
            <div key={r.rank} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderRadius: 6,
              background: 'rgba(8,10,16,0.55)', backdropFilter: 'blur(6px)',
              border: '1px solid rgba(255,255,255,0.06)',
            }}>
              <span style={{ width: 16, textAlign: 'center', fontFamily: ARCAID.fontMono, fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.45)' }}>{r.rank}</span>
              <Avatar name={r.name} size={16} />
              <span style={{ flex: 1, fontSize: 11, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
              <span style={{ fontFamily: ARCAID.fontMono, fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.85)' }}>{r.score.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </RoomCardFrame>
  );
}

function PodiumRedesignRow() {
  return (
    <div style={{ display: 'flex', gap: 24, padding: 32, background: '#14161d', alignItems: 'flex-start' }}>
      <style>{podiumKeyframes}</style>
      <PodiumNeonRim />
      <PodiumGlitch />
      <PodiumEdgeLit />
      <PodiumHoloSteps />
      <PodiumHoloSteps filled />
      <PodiumHoloSteps filled busyBg />
    </div>
  );
}

Object.assign(window, { PodiumRedesignRow, PodiumNeonRim, PodiumGlitch, PodiumEdgeLit, PodiumHoloSteps });
