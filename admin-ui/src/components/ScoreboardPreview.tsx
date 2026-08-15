import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Monitor, Smartphone } from 'lucide-react';
import type { GameLeaderboard, RankingGroupData } from './ScoreboardComponents';
import ScoreboardSurface from './scoreboard/ScoreboardSurface';
import DevicePreviewFrame from './DevicePreviewFrame';
import { getPortal } from '../lib/portal';

/**
 * Style-system revamp P1 — the Settings preview now renders THE surface.
 *
 * It used to be a second, weaker implementation: its own layout branches, its
 * own scale-to-fit maths, no header/title, no background image, no rankings,
 * no mobile behaviour. An admin tuned settings against a picture that was not
 * the page. `ScoreboardSurface` (v2.86.0) is the single renderer the public
 * page and the admin Leaderboard already share; pointing the preview at it
 * closes the last divergence (the S21 gap).
 *
 * The phone toggle renders the same surface inside `DevicePreviewFrame`, an
 * iframe with a genuine 390px viewport — see that file for why a narrow div
 * cannot do this honestly.
 */

/** Desktop preview viewport. Wide enough to show a multi-card row without
 *  scaling the frame so far down that type becomes unreadable. */
const DESKTOP_WIDTH = 1100;
/** iPhone 14/15 logical width — the narrowest mainstream phone we care about. */
const PHONE_WIDTH = 390;

const MOCK_LEADERBOARDS: GameLeaderboard[] = [
  {
    gameId: 'preview-1',
    gameName: 'Medieval Madness',
    tournamentName: 'Daily Grind',
    tournamentType: 'DG',
    imageUrl: null,
    gameStatus: 'ACTIVE',
    catalogueStyleId: 'iscored-1168',
    logoStyleId: null,
    bgStyleId: null,
    catHasBg: 1,
    catHasHeader: 1,
    styleHeaderDisabled: false,
    rankings: [
      { rank: 1, discord_user_id: '', iscored_username: 'DragonSlayer', score: 999_999_999_999 },
      { rank: 2, discord_user_id: '', iscored_username: 'PinWizard42', score: 456_123_789 },
      { rank: 3, discord_user_id: '', iscored_username: 'FlipperKing', score: 123_456_789 },
      { rank: 4, discord_user_id: '', iscored_username: 'SilverBallSam', score: 98_765_432 },
      { rank: 5, discord_user_id: '', iscored_username: 'NovicePlayer', score: 1_234_567 },
    ],
  },
  {
    gameId: 'preview-2',
    gameName: 'The Addams Family',
    tournamentName: 'Weekly Grind',
    tournamentType: 'WG-VPXS',
    imageUrl: null,
    gameStatus: 'ACTIVE',
    catalogueStyleId: 'iscored-5441',
    logoStyleId: null,
    bgStyleId: null,
    catHasBg: 1,
    catHasHeader: 1,
    styleHeaderDisabled: false,
    rankings: [
      { rank: 1, discord_user_id: '', iscored_username: 'BumperQueen', score: 876_543_210 },
      { rank: 2, discord_user_id: '', iscored_username: 'TiltMaster', score: 654_321_098 },
      { rank: 3, discord_user_id: '', iscored_username: 'MultiballMax', score: 432_109_876 },
    ],
  },
  {
    gameId: 'preview-3',
    gameName: 'Twilight Zone',
    tournamentName: 'Monthly Grind',
    tournamentType: 'MG',
    imageUrl: null,
    gameStatus: 'ACTIVE',
    catalogueStyleId: 'iscored-5469',
    logoStyleId: null,
    bgStyleId: null,
    catHasBg: 1,
    catHasHeader: 1,
    styleHeaderDisabled: false,
    rankings: [
      { rank: 1, discord_user_id: '', iscored_username: 'ZoneRunner', score: 543_210_987 },
      { rank: 2, discord_user_id: '', iscored_username: 'PowerBall99', score: 321_098_765 },
      { rank: 3, discord_user_id: '', iscored_username: 'RampChamp', score: 210_987_654 },
      { rank: 4, discord_user_id: '', iscored_username: 'SpinnerSue', score: 109_876_543 },
    ],
  },
];

/** One mock group so the rankings controls (position, sticky, ticker) have
 *  something to move around — the old preview rendered none, which is why
 *  those settings previewed as no-ops. */
const MOCK_RANKING_GROUPS: RankingGroupData[] = [
  {
    group: {
      id: 'preview-group',
      name: 'Season Standings',
      description: 'Best 3 of 5 tournaments',
      rank_method: 'points',
      best_n: 3,
      min_games: 1,
      tournaments: [
        { id: 'preview-t1', name: 'Daily Grind', type: 'DG' },
        { id: 'preview-t2', name: 'Weekly Grind', type: 'WG-VPXS' },
      ],
    },
    rankings: [
      { rank: 1, iscored_username: 'DragonSlayer', total_points: 240, games_played: 5 },
      { rank: 2, iscored_username: 'BumperQueen', total_points: 195, games_played: 5 },
      { rank: 3, iscored_username: 'TiltMaster', total_points: 160, games_played: 4 },
      { rank: 4, iscored_username: 'ZoneRunner', total_points: 120, games_played: 3 },
    ],
  },
];

interface ScoreboardPreviewProps {
  settings: Record<string, string>;
  /** Room slug — used only to resolve the room's PUBLIC theme, so the preview
   *  is coloured the way players see it rather than the way this admin's own
   *  theme preference happens to be set. */
  roomSlug?: string;
  roomName?: string;
}

export default function ScoreboardPreview({ settings, roomSlug, roomName }: ScoreboardPreviewProps) {
  const [device, setDevice] = useState<'desktop' | 'phone'>('desktop');
  const containerRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);

  // Same resolution the admin Leaderboard uses (Leaderboard.tsx) — `getPortal`
  // is a cached lookup, so this does not add a request per keystroke.
  const [roomTheme, setRoomTheme] = useState<string | null>(null);
  useEffect(() => {
    if (!roomSlug) return;
    let cancelled = false;
    getPortal(roomSlug)
      .then(p => { if (!cancelled) setRoomTheme(p.public_theme || p.ui_theme || 'dark'); })
      .catch(() => { if (!cancelled) setRoomTheme('dark'); });
    return () => { cancelled = true; };
  }, [roomSlug]);

  // `sb-theme-scope` restates the default dark tokens so the preview stays
  // dark even when this admin's own UI theme is light (see index.css).
  const themeClass = `sb-theme-scope${roomTheme && roomTheme !== 'dark' ? ` theme-${roomTheme}` : ''}`;

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setAvailable(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const frameWidth = device === 'phone' ? PHONE_WIDTH : DESKTOP_WIDTH;
  // Never scale UP — a phone frame in a wide panel should stay life-size.
  const scale = available > 0 ? Math.min(1, available / frameWidth) : 1;

  return (
    <div className="relative">
      <div className="flex items-center justify-between mb-2">
        <span className="px-2 py-0.5 bg-neon-cyan/20 border border-neon-cyan/40 rounded text-[10px] font-display font-bold text-neon-cyan uppercase tracking-wider">
          Live Preview
        </span>
        <div className="flex items-center gap-1 rounded border border-border bg-raised p-0.5">
          {([
            { id: 'desktop' as const, icon: Monitor, label: 'Desktop' },
            { id: 'phone' as const, icon: Smartphone, label: 'Phone' },
          ]).map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setDevice(id)}
              aria-pressed={device === id}
              className={`flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-display uppercase tracking-wider cursor-pointer border-none transition-colors ${
                device === id ? 'bg-neon-cyan/15 text-neon-cyan' : 'bg-transparent text-muted hover:text-primary'
              }`}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={containerRef}
        className="border-2 border-dashed border-border/50 rounded-lg p-2 overflow-hidden"
      >
        <div className={device === 'phone' ? 'flex justify-center' : undefined}>
          <DevicePreviewFrame width={frameWidth} scale={scale}>
            <ScoreboardSurface
              embedded
              forceMobile={device === 'phone'}
              themeClass={themeClass}
              config={settings}
              roomName={roomName}
              slug="preview"
              leaderboards={MOCK_LEADERBOARDS}
              rankingGroups={MOCK_RANKING_GROUPS}
            />
          </DevicePreviewFrame>
        </div>
      </div>

      <p className="mt-1.5 text-[10px] text-faint">
        Sample games and players — your real scoreboard uses the same layout.
      </p>
    </div>
  );
}
