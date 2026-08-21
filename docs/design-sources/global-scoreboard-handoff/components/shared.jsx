// Shared atoms used across all mocks. Mirrors the real ArcAid tokens.

const ARCAID = {
  deep: 'oklch(21.15% 0.012 254.09)',
  surface: 'oklch(23.26% 0.014 253.1)',
  raised: 'oklch(25.33% 0.016 252.42)',
  border: 'oklch(35% 0.02 255)',
  cyan: 'oklch(74% 0.16 232.661)',
  magenta: 'oklch(65% 0.241 354.308)',
  green: 'oklch(76% 0.177 163.223)',
  amber: 'oklch(82% 0.189 84.429)',
  purple: 'oklch(58% 0.233 277.117)',
  coral: 'oklch(71% 0.194 13.428)',
  bronze: '#cd7f32',
  bronzeBg: 'rgba(205, 127, 50, 0.12)',
  bronzeBorder: 'rgba(205, 127, 50, 0.35)',
  primary: 'oklch(97.807% 0.029 256.847)',
  muted: 'oklch(70% 0.02 255)',
  faint: 'oklch(45% 0.015 255)',
  fontDisplay: '"Orbitron", sans-serif',
  fontPixel: '"Press Start 2P", cursive',
  fontBody: '"Inter", sans-serif',
  fontMono: '"JetBrains Mono", monospace',
};

// ── Mock game data — based on the screenshot ──
const MOCK_GAMES = [
  {
    id: 'haunted-house', name: 'Haunted House', manufacturer: 'Gottlieb', year: 1982,
    scoreCount: 6, platforms: ['VPX'], rating: 0,
    hue: 280, // backglass hue for placeholder
    top: [
      { name: 'Krobs', score: 9525852588, color: 'cyan' },
      { name: 'mekeburgj', score: 999464323, color: 'amber' },
      null,
    ],
    more: [],
  },
  {
    id: 'tmnt', name: 'Teenage Mutant Ninja Turtles (Stern / Data East remix)',
    manufacturer: 'Original', year: 2024, scoreCount: 7,
    platforms: ['VPX'], rating: 0,
    hue: 150,
    top: [
      { name: 'UnknownPlayer2', score: 4844125789, color: 'green' },
      { name: 'UnknownPlayer4', score: 4578965412, color: 'magenta' },
      { name: 'UnknownPlayer6', score: 107454321, color: 'amber' },
    ],
    more: [
      { rank: 4, name: 'UnknownPlayer3', score: 789456123 },
      { rank: 5, name: 'UnknownPlayer5', score: 567321 },
      { rank: 6, name: 'UnknownPlayer1', score: 123456321 },
      { rank: 7, name: 'mekeburgj', score: 100100 },
    ],
  },
  {
    id: 'living-dead', name: 'The Return Of The Living Dead',
    manufacturer: 'Original', year: 2024, scoreCount: 3,
    platforms: ['VPX'], rating: 0,
    hue: 5,
    top: [
      { name: 'Krobs', score: 107107107, color: 'cyan' },
      { name: 'Krobs', score: 200400500, color: 'amber' },
      null,
    ],
    more: [],
  },
  {
    id: 'dirty-harry', name: 'Dirty Harry', manufacturer: 'Williams', year: 1995,
    scoreCount: 4, platforms: ['VPX'], rating: 3,
    hue: 260,
    top: [
      { name: 'Krobs', score: 585323765, color: 'cyan' },
      { name: 'Krobs', score: 454789123, color: 'amber' },
      null,
    ],
    more: [],
  },
  {
    id: 'theatre-of-magic', name: 'Theatre of Magic', manufacturer: 'Bally', year: 1995,
    scoreCount: 3, platforms: ['Physical FX3', 'Virtual FX3', 'VPX'], rating: 0,
    hue: 310,
    top: [
      { name: 'Krobs', score: 1826186527, color: 'cyan' },
      { name: 'mekeburgj', score: 123456, color: 'amber' },
      null,
    ],
    more: [],
  },
  {
    id: 'tenacious-d', name: 'Tenacious D', manufacturer: 'Original', year: 2025,
    scoreCount: 2, platforms: ['VPX'], rating: 0,
    hue: 25,
    top: [
      { name: 'Krobs', score: 25000, color: 'green' },
      null, null,
    ],
    more: [],
  },
  {
    id: 'attack-from-mars', name: 'Attack from Mars', manufacturer: 'Bally', year: 1995,
    scoreCount: 3, platforms: ['Physical FX3', 'Virtual FX3', 'VPX'], rating: 1.5,
    hue: 340,
    top: [
      { name: 'Krobs', score: 189947342, color: 'cyan' },
      { name: 'Cal', score: 151, color: 'amber' },
      null,
    ],
    more: [],
  },
  {
    id: 'batman', name: 'Batman', manufacturer: 'Stern', year: 2008,
    scoreCount: 2, platforms: ['VPX'], rating: 0,
    hue: 220,
    top: [
      { name: 'Krobs', score: 85858524, color: 'cyan' },
      null, null,
    ],
    more: [],
  },
];

// ── Utils ──
function formatScore(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1e12) return (n / 1e12).toFixed(1) + 'T';
  return n.toLocaleString();
}

function rankColor(rank) {
  if (rank === 1) return { text: ARCAID.amber, bg: 'rgba(250, 190, 80, 0.12)', border: 'rgba(250, 190, 80, 0.35)' };
  if (rank === 2) return { text: '#d4d4d4', bg: 'rgba(220, 220, 220, 0.08)', border: 'rgba(220, 220, 220, 0.25)' };
  if (rank === 3) return { text: ARCAID.bronze, bg: ARCAID.bronzeBg, border: ARCAID.bronzeBorder };
  return { text: ARCAID.muted, bg: 'transparent', border: 'rgba(120, 120, 140, 0.2)' };
}

// ── Placeholder backglass art (striped hue by game) ──
function BackglassPlaceholder({ hue = 200, label = '', style = {}, rounded = 8 }) {
  return (
    <div style={{
      position: 'relative',
      overflow: 'hidden',
      borderRadius: rounded,
      background: `linear-gradient(135deg,
        oklch(35% 0.15 ${hue}) 0%,
        oklch(25% 0.12 ${hue + 30}) 50%,
        oklch(30% 0.18 ${hue - 20}) 100%)`,
      ...style,
    }}>
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: `repeating-linear-gradient(
          135deg,
          transparent 0 8px,
          rgba(255,255,255,0.04) 8px 16px
        )`,
      }} />
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: ARCAID.fontMono, fontSize: 10,
        color: 'rgba(255,255,255,0.4)', letterSpacing: 0.5,
        textAlign: 'center', padding: 8,
      }}>
        {label || 'backglass art'}
      </div>
    </div>
  );
}

// ── Avatar — simple colored circle with initial ──
function Avatar({ name, size = 20, color }) {
  const ch = (name || '?').charAt(0).toUpperCase();
  const hue = (name || '').charCodeAt(0) * 7 % 360;
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: color || `oklch(55% 0.12 ${hue})`,
      border: '1px solid rgba(255,255,255,0.15)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: ARCAID.fontBody, fontSize: Math.max(8, size * 0.5),
      fontWeight: 700, color: '#fff', flexShrink: 0,
    }}>
      {ch}
    </div>
  );
}

// ── Platform pill ──
function PlatformPill({ children, accent = ARCAID.muted }) {
  return (
    <span style={{
      padding: '2px 7px',
      fontSize: 9,
      fontFamily: ARCAID.fontBody,
      fontWeight: 600,
      letterSpacing: 0.4,
      textTransform: 'uppercase',
      color: accent,
      background: 'rgba(255,255,255,0.03)',
      border: `1px solid ${accent}33`,
      borderRadius: 3,
    }}>{children}</span>
  );
}

// ── App shell that wraps a design so it looks like the ArcAid page ──
function ArcAidFrame({ children, width = 1100, height = 900, label, showNav = true }) {
  return (
    <div style={{
      width, height,
      background: ARCAID.deep,
      color: ARCAID.primary,
      fontFamily: ARCAID.fontBody,
      overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
      position: 'relative',
    }}>
      {showNav && (
        <div style={{
          borderBottom: `1px solid ${ARCAID.border}`,
          background: 'rgba(0,0,0,0.25)',
          padding: '12px 24px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 24, height: 24, borderRadius: 4,
              background: `linear-gradient(135deg, ${ARCAID.cyan}, ${ARCAID.magenta})`,
            }} />
            <span style={{
              fontFamily: ARCAID.fontPixel, fontSize: 10,
              color: ARCAID.cyan, letterSpacing: 2,
            }}>ARCAID</span>
          </div>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', fontSize: 11, color: ARCAID.muted }}>
            <span>Rooms</span><span>Admin</span>
            <Avatar name="m" size={20} />
            <span>mekeburgj</span>
          </div>
        </div>
      )}
      {children}
    </div>
  );
}

Object.assign(window, {
  ARCAID, MOCK_GAMES, formatScore, rankColor,
  BackglassPlaceholder, Avatar, PlatformPill, ArcAidFrame,
});
