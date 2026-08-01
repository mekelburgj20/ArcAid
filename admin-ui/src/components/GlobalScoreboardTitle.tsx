import type { ReactNode } from 'react';
import { useTheme } from './ThemeProvider';

/**
 * GlobalScoreboardTitle — the "neon trophy + House Chrome wordmark" lockup
 * (v2.60.0).
 *
 * Port of `tmp/Arcaid Global Scoreboard- Redesign Directions/assets/scoreboard/`
 * (global-scoreboard.css + the two markup snippets). The pack's CSS is the
 * spec; this file reproduces it verbatim apart from the four deliberate
 * deviations documented below. It follows `ArcaidLogoAnimated`'s pattern: a
 * component-local <style> block, self-hosted Orbitron, and container-query
 * scaling — no global stylesheet edits, no Google Fonts request.
 *
 * DEVIATIONS FROM THE PACK
 *
 * 1. No `@import url(fonts.googleapis.com…)`. Orbitron 900 (the wordmark) and
 *    400 (the subtitle) are self-hosted under `public/fonts/`, same as
 *    ArcaidLogoAnimated does for 900. A third-party font request on the
 *    highest-traffic public page is not worth the two glyph sets.
 *
 * 2. Everything is expressed in `em` off a single scaled root font-size
 *    instead of the pack's fixed px. See RESPONSIVE below.
 *
 * 3. The wordmark is an <h1>, not a <span>. The pack's seven duplicate text
 *    layers are all `aria-hidden`; the heading's accessible name comes from
 *    one visually-hidden copy, so a screen reader announces exactly one
 *    heading reading "Global Scoreboard" rather than seven.
 *
 * 4. The subtitle's font-size is clamped rather than scaled all the way down.
 *    In the pack it is art (17px, fixed); here it is live functional text
 *    carrying a login control, and 0.25 x the phone-scaled root would render
 *    it at ~5px. Its indent still scales, so it stays aligned to the wordmark.
 *
 * RESPONSIVE
 *
 * The design is 158px of left padding + a 712px word + 30px of right padding =
 * 902px native, which no phone can hold. `.gs-fit` is a container-query
 * containment box; `.gs-title`'s font-size is `min(68px, 100cqw / 13.2647)`
 * where 13.2647em == 902px, and every dimension in the treatment is a multiple
 * of that em. So the whole lockup shrinks as one piece — never wrapping, never
 * overflowing — and pins to the design's native 68px the moment the container
 * can hold it. `.gs-fit` also caps at 902px so a page-level `mx-auto` centres
 * the block on desktop while a phone gets the full width, left-aligned.
 *
 * Why em rather than ArcaidLogoAnimated's `transform: scale()`: that component
 * wraps a fixed-size art canvas whose height is known up front. This lockup's
 * height is not — the caller's subtitle is live text that wraps — so a
 * transform plus an `aspect-ratio` reservation would mis-reserve. Em scaling
 * keeps everything in normal flow.
 */

/** The pack's design values are all relative to the 68px wordmark. */
const ROOT_PX = 68;
/** 158px pad + 712.03px measured word (Orbitron 900 italic 68px) + 30px pad. */
const NATIVE_W = 902;
const NATIVE_EM = NATIVE_W / ROOT_PX;

/** Design px -> em against the scaled root. Keeps the pack's numbers readable. */
const u = (px: number) => `${+(px / ROOT_PX).toFixed(4)}em`;

const WORD = 'Global Scoreboard';

/** viewBox 0 0 100 100. Identical geometry in all three stroke layers. */
const TROPHY_PATHS = (
  <>
    <path d="M29 16 H71 L67 42 C65 54.5 58.5 61 50 61 C41.5 61 35 54.5 33 42 Z" />
    <path d="M29 20 C16.5 20 11.5 32.5 19.5 39.5 C23.5 43 27.5 44.5 31.5 45" />
    <path d="M71 20 C83.5 20 88.5 32.5 80.5 39.5 C76.5 43 72.5 44.5 68.5 45" />
    <path d="M50 61 V79 M43 79 L40 87 M57 79 L60 87 M32 87 H68" />
  </>
);

interface GlobalScoreboardTitleProps {
  /**
   * Rendered under the lockup, indented to the wordmark's left edge (the
   * pack's 158px, scaled). The page passes its live status line and its
   * subtitle paragraph here — the copy stays owned by the page because it
   * carries interactive bits.
   */
  children?: ReactNode;
  className?: string;
}

export default function GlobalScoreboardTitle({ children, className = '' }: GlobalScoreboardTitleProps) {
  const { globalPageTheme } = useTheme();
  const themeClass = globalPageTheme === 'light' ? 'gs-light' : 'gs-dark';

  return (
    <div className={`gs-fit ${className}`.trim()}>
      <div className={`gs-title ${themeClass}`}>
        <div className="gs-lockup">
          {/* Light theme only — the pack hides it under .gs-dark. */}
          <span className="gs-plate" aria-hidden="true" />

          <svg className="gs-trophy" viewBox="0 0 100 100" fill="none" aria-hidden="true">
            <g className="gs-t-bloom">{TROPHY_PATHS}</g>
            <g className="gs-t-core">{TROPHY_PATHS}</g>
            <g className="gs-t-fil">{TROPHY_PATHS}</g>
          </svg>

          <h1 className="gs-word">
            {/* The one accessible copy. Everything below it is decoration. */}
            <span className="gs-sr">{WORD}</span>
            <span className="gs-sh1" aria-hidden="true">{WORD}</span>
            <span className="gs-sh2" aria-hidden="true">{WORD}</span>
            <span className="gs-fringe-a" aria-hidden="true">{WORD}</span>
            <span className="gs-fringe-b" aria-hidden="true">{WORD}</span>
            <span className="gs-chrome" aria-hidden="true">{WORD}</span>
            <span className="gs-slice-a" aria-hidden="true">{WORD}</span>
            <span className="gs-slice-b" aria-hidden="true">{WORD}</span>
          </h1>
        </div>

        {children && <div className="gs-body">{children}</div>}
      </div>

      <style>{`
        @font-face {
          font-family: 'ArcaidOrbitron900';
          font-style: normal;
          font-weight: 900;
          font-display: swap;
          src: url('/fonts/orbitron-900.woff2') format('woff2');
          unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
        }

        @font-face {
          font-family: 'ArcaidOrbitron400';
          font-style: normal;
          font-weight: 400;
          font-display: swap;
          src: url('/fonts/orbitron-400.woff2') format('woff2');
          unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
        }

        /* Containment box + the single scale knob. Everything else is em. */
        .gs-fit {
          container-type: inline-size;
          width: 100%;
          max-width: ${NATIVE_W}px;
        }

        .gs-title {
          --gs-fringe: .55;
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: ${u(18)};
          font-size: min(${ROOT_PX}px, 7.5vw); /* fallback: no container-query units */
          font-size: min(${ROOT_PX}px, calc(100cqw / ${+NATIVE_EM.toFixed(4)}));
        }

        .gs-lockup {
          position: relative;
          display: flex;
          align-items: center;
          padding: ${u(22)} ${u(30)} ${u(24)} ${u(158)};
        }

        /* Caller content, aligned to the wordmark's left edge. */
        .gs-body { padding-left: ${u(158)}; }

        /* purple backdrop plate (light theme only) */
        .gs-plate {
          display: none;
          position: absolute;
          left: ${u(2)};
          right: ${u(2)};
          top: ${u(6)};
          bottom: ${u(8)};
          transform: skewX(-10deg);
          border-radius: ${u(12)};
        }

        /* neon trophy */
        .gs-trophy {
          position: absolute;
          left: ${u(30)};
          top: 50%;
          margin-top: ${u(-52)};
          width: ${u(104)};
          height: ${u(104)};
          overflow: visible;
          animation: gsNeonFlash 4.2s steps(1) infinite;
        }

        .gs-t-bloom, .gs-t-core, .gs-t-fil { fill: none; stroke-linecap: round; stroke-linejoin: round; }
        .gs-t-bloom { stroke: #FF2E63; stroke-width: 8.5; opacity: .34; filter: blur(${u(4)}); }
        .gs-t-core { stroke: #FF2E63; stroke-width: 4; filter: drop-shadow(0 0 ${u(4)} #FF2E63) drop-shadow(0 0 ${u(13)} rgba(255,46,99,.6)); }
        .gs-t-fil { stroke: #FFE3EC; stroke-width: 1.3; animation: gsFlicker 6.2s steps(1) infinite; }

        /* wordmark */
        .gs-word {
          position: relative;
          margin: 0;
          font-family: 'ArcaidOrbitron900', 'Orbitron', sans-serif;
          font-weight: 900;
          font-style: italic;
          font-size: 1em;
          line-height: 1.14;
          white-space: nowrap;
        }

        .gs-word > span { display: block; }

        /* The accessible copy — named, never seen. */
        .gs-word > .gs-sr {
          position: absolute;
          width: 1px;
          height: 1px;
          margin: -1px;
          padding: 0;
          overflow: hidden;
          clip-path: inset(50%);
          white-space: nowrap;
          border: 0;
        }

        .gs-sh1, .gs-sh2, .gs-fringe-a, .gs-fringe-b, .gs-slice-a, .gs-slice-b {
          position: absolute;
          left: 0;
          top: 0;
        }

        .gs-chrome, .gs-slice-a, .gs-slice-b {
          background: linear-gradient(180deg, #F6FCFF 0%, #CBE7F8 36%, #7FB2D9 47%, #142E4B 51%, #9FCBEA 55%, #FFFFFF 64%, #6FA5CF 100%);
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
        }

        .gs-chrome { position: relative; padding-right: .06em; margin-right: -.06em; }
        .gs-fringe-a { left: ${u(-3)}; top: ${u(2)}; color: #FF2E63; opacity: var(--gs-fringe); animation: gsShift 4.2s steps(1) infinite; }
        .gs-fringe-b { left: ${u(3)}; top: ${u(-2)}; color: #5BC8F5; opacity: var(--gs-fringe); animation: gsShift 4.2s steps(1) infinite reverse; }
        .gs-slice-a { animation: gsSliceA 4.2s steps(1) infinite; }
        .gs-slice-b { animation: gsSliceB 5.6s steps(1) infinite; }

        /* Subtitle. Deviation 4: clamped, not fully scaled — it is live text.
           The .07em tracking rides its own final size, as the pack intends. */
        .gs-sub {
          margin: 0;
          font-family: 'ArcaidOrbitron400', 'Orbitron', sans-serif;
          font-weight: 400;
          font-size: clamp(12.5px, .25em, 17px);
          letter-spacing: .07em;
        }

        /* ---- dark theme ---- */
        .gs-dark .gs-sh1, .gs-dark .gs-sh2 { display: none; }
        .gs-dark .gs-word { filter: drop-shadow(0 0 ${u(10)} rgba(53,214,232,.75)) drop-shadow(0 0 ${u(34)} rgba(53,214,232,.34)); }
        .gs-dark .gs-sub { color: #8992A4; }

        /* ---- light theme ---- */
        .gs-light .gs-plate {
          display: block;
          background: linear-gradient(180deg, #4A1D82 0%, #2A0C52 46%, #1B0638 62%, #3A1468 100%);
          box-shadow: 0 ${u(12)} ${u(34)} rgba(42,12,82,.4), inset 0 ${u(1)} 0 rgba(214,164,255,.22);
        }
        .gs-light .gs-word { filter: drop-shadow(0 ${u(2)} ${u(2)} rgba(10,16,25,.45)); }
        .gs-light .gs-sh1 { top: ${u(2)}; color: #0A1017; opacity: .45; filter: blur(${u(20)}); }
        .gs-light .gs-sh2 { top: ${u(1)}; color: #0A1017; opacity: .45; filter: blur(${u(8)}); }
        .gs-light .gs-fringe-b { color: #0F9BD1; }
        .gs-light .gs-t-bloom { stroke-width: 9; opacity: .32; }
        .gs-light .gs-t-core { stroke: #FF1B57; filter: drop-shadow(0 0 ${u(3)} rgba(255,46,99,.8)); }
        .gs-light .gs-sub { color: #5A6270; }

        /* ---- glitch ----
           Offsets are em so a shrunken lockup tears proportionally rather than
           being torn apart. The cycles (4.2s / 5.6s / 6.2s) are the pack's. */
        @keyframes gsShift {
          0%, 86%, 100% { transform: translate(0, 0) }
          88% { transform: translate(${u(4)}, ${u(-2)}) }
          92% { transform: translate(${u(-4)}, ${u(2)}) }
          96% { transform: translate(${u(2)}, ${u(1)}) }
        }

        @keyframes gsSliceA {
          0%, 88%, 100% { clip-path: inset(0 0 100% 0); transform: translate(0, 0) }
          89% { clip-path: inset(24% 0 58% 0); transform: translate(${u(-11)}, 0) }
          91% { clip-path: inset(0 0 100% 0); transform: translate(0, 0) }
          94% { clip-path: inset(64% 0 18% 0); transform: translate(${u(8)}, 0) }
          96% { clip-path: inset(0 0 100% 0); transform: translate(0, 0) }
        }

        @keyframes gsSliceB {
          0%, 80%, 100% { clip-path: inset(0 0 100% 0); transform: translate(0, 0) }
          82% { clip-path: inset(44% 0 40% 0); transform: translate(${u(13)}, 0) }
          84% { clip-path: inset(0 0 100% 0); transform: translate(0, 0) }
          97% { clip-path: inset(8% 0 76% 0); transform: translate(${u(-7)}, 0) }
          99% { clip-path: inset(0 0 100% 0); transform: translate(0, 0) }
        }

        @keyframes gsFlicker {
          0%, 74%, 100% { opacity: 1 }
          75% { opacity: .35 }
          76% { opacity: 1 }
          90% { opacity: .55 }
          91% { opacity: 1 }
        }

        @keyframes gsNeonFlash {
          0%, 86%, 100% { opacity: 1 }
          87% { opacity: .16 }
          88% { opacity: 1 }
          90% { opacity: .4 }
          91% { opacity: 1 }
          94% { opacity: .1 }
          95% { opacity: 1 }
          96% { opacity: .62 }
          97% { opacity: 1 }
        }

        @media (prefers-reduced-motion: reduce) {
          .gs-trophy, .gs-t-fil, .gs-fringe-a, .gs-fringe-b, .gs-slice-a, .gs-slice-b { animation: none; }
          .gs-slice-a, .gs-slice-b { clip-path: inset(0 0 100% 0); }
        }
      `}</style>
    </div>
  );
}
