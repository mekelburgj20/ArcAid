/**
 * ArcaidLogoAnimated — "Delta House Chrome" animated wordmark (v2.45.0).
 *
 * Faithful port of tmp/Arcaid Delta House Chrome - Final.html (an
 * artifact-bundler export). The original is a fixed 620x560 composition:
 * a neon-pink double-triangle SVG rotated -15deg behind a chrome "ARCAıD"
 * wordmark, with pink/cyan "glitch-ghost" duplicate layers that nudge out
 * of registration on a 4s cycle, and a chrome pinball sphere standing in
 * for the tittle (dot) of the lowercase dotless-i.
 *
 * Responsive scaling is CSS-only (no JS/ResizeObserver): the outer
 * `.arcaid-logo-wrap` is a container-query containment box sized by the
 * `maxWidth` prop; the inner `.arcaid-logo-sign` keeps its original fixed
 * 620x560 design and is scaled via `transform: scale(100cqw / 620px)` —
 * so the composition is pixel-faithful to the source at every size, it's
 * just uniformly larger or smaller. `aspect-ratio` on the wrap reserves
 * the correct layout box since the scaled child is `position: absolute`
 * (removed from flow).
 *
 * The design assumes a near-black backdrop (#0C0C13) for the glow/drop-
 * shadow layers to read correctly — callers should place this on a dark
 * section (see LandingPage's hero backdrop).
 */

const SIGN_WIDTH = 620;
const SIGN_HEIGHT = 560;

/**
 * v2.45.2 — the source 620x560 design box carries large empty margins: the
 * visible triangle+wordmark composition only spans roughly y=120..440. At
 * hero scale that dead space rendered as ~300px of empty page background
 * above/below the mark, which read as "the logo has its own black section"
 * (user report, 2026-07-26). Crop the LAYOUT box to the visible bounds and
 * shift the (absolutely-positioned) sign up correspondingly — the glow
 * halos still paint outside the layout box (overflow is visible, they're
 * translucent), but the hero no longer reserves empty page height.
 */
const CROP_TOP = 95;
const CROP_BOTTOM = 85;
const CROPPED_HEIGHT = SIGN_HEIGHT - CROP_TOP - CROP_BOTTOM;

interface ArcaidLogoAnimatedProps {
  /** Widest the rendered mark should ever get, in px. Narrower viewports
   * scale down proportionally (see `.arcaid-logo-sign` transform) so it
   * never overflows horizontally. Default suits a prominent hero use. */
  maxWidth?: number;
  className?: string;
}

export default function ArcaidLogoAnimated({ maxWidth = 720, className = '' }: ArcaidLogoAnimatedProps) {
  return (
    <div
      className={`arcaid-logo-wrap ${className}`.trim()}
      style={{ maxWidth }}
    >
      <div className="arcaid-logo-sign">
        <svg
          className="arcaid-logo-triangle"
          width={SIGN_WIDTH}
          height={SIGN_HEIGHT}
          viewBox="-48 -47 316 284"
          fill="none"
          aria-hidden="true"
        >
          <g
            stroke="#FFA8BE"
            strokeWidth="3.5"
            strokeLinejoin="round"
            style={{ filter: 'drop-shadow(0 0 4px #FF2E63) drop-shadow(0 0 14px rgba(255,46,99,.55))' }}
          >
            <g transform="rotate(-15 110 95)">
              <polygon points="14,40 206,40 110,150" />
              <polygon points="32,48 188,48 110,138" />
            </g>
          </g>
        </svg>

        <div className="arcaid-logo-word" role="img" aria-label="ArcAid">
          <div className="arcaid-logo-pink" aria-hidden="true">ARCAıD</div>
          <div className="arcaid-logo-cyan" aria-hidden="true">ARCAıD</div>
          <div className="arcaid-logo-chrome" aria-hidden="true">ARCAıD</div>
          <div className="arcaid-logo-ghost" aria-hidden="true">
            ARCA
            <span className="arcaid-logo-tittle">
              {'ı'}
              <span className="arcaid-logo-ball">
                <span className="arcaid-logo-ball-p" />
                <span className="arcaid-logo-ball-c" />
                <span className="arcaid-logo-ball-s" />
              </span>
            </span>
            D
          </div>
        </div>
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

        @keyframes arcaidLogoGlitchShift {
          0%, 86%, 100% { transform: translate(0, 0); }
          88% { transform: translate(4px, -2px); }
          92% { transform: translate(-4px, 2px); }
          96% { transform: translate(2px, 1px); }
        }

        .arcaid-logo-wrap {
          container-type: inline-size;
          position: relative;
          width: 100%;
          aspect-ratio: ${SIGN_WIDTH} / ${CROPPED_HEIGHT};
          margin: 0 auto;
        }

        .arcaid-logo-sign {
          position: absolute;
          left: 0;
          top: ${-CROP_TOP * 0.5}px; /* fallback pairs with the scale(0.5) fallback below */
          top: calc(${CROP_TOP} / ${SIGN_WIDTH} * -100cqw);
          width: ${SIGN_WIDTH}px;
          height: ${SIGN_HEIGHT}px;
          transform: scale(0.5); /* fallback for browsers without container query units */
          transform: scale(calc(100cqw / ${SIGN_WIDTH}px));
          transform-origin: top left;
        }

        .arcaid-logo-word {
          position: absolute;
          left: 47.5%;
          top: 50%;
          transform: translate(-50%, -50%);
          font-family: 'ArcaidOrbitron900', 'Orbitron', sans-serif;
          font-weight: 900;
          font-style: italic;
          font-size: 100px;
          line-height: 1;
          white-space: nowrap;
          filter: drop-shadow(0 0 10px rgba(53, 214, 232, .8)) drop-shadow(0 0 32px rgba(53, 214, 232, .4));
        }

        .arcaid-logo-word .arcaid-logo-pink {
          position: absolute;
          left: -3px;
          top: 2px;
          color: #FF2E63;
          opacity: .75;
          animation: arcaidLogoGlitchShift 4s steps(1) infinite;
        }

        .arcaid-logo-word .arcaid-logo-cyan {
          position: absolute;
          left: 3px;
          top: -2px;
          color: #5BC8F5;
          opacity: .75;
          animation: arcaidLogoGlitchShift 4s steps(1) infinite reverse;
        }

        .arcaid-logo-word .arcaid-logo-ghost {
          position: absolute;
          left: 0;
          top: 0;
          color: transparent;
        }

        .arcaid-logo-word .arcaid-logo-ghost .arcaid-logo-tittle {
          position: relative;
        }

        .arcaid-logo-word .arcaid-logo-ghost .arcaid-logo-ball {
          position: absolute;
          left: 50%;
          top: 9px;
          width: 22px;
          height: 22px;
          transform: translateX(calc(-50% + 19px));
        }

        .arcaid-logo-word .arcaid-logo-ghost .arcaid-logo-ball span {
          position: absolute;
          inset: 0;
          border-radius: 50%;
        }

        .arcaid-logo-word .arcaid-logo-ghost .arcaid-logo-ball .arcaid-logo-ball-p {
          background: #FF2E63;
          opacity: .75;
          transform: translate(-3px, 2px);
          animation: arcaidLogoGlitchShift 4s steps(1) infinite;
        }

        .arcaid-logo-word .arcaid-logo-ghost .arcaid-logo-ball .arcaid-logo-ball-c {
          background: #5BC8F5;
          opacity: .75;
          transform: translate(3px, -2px);
          animation: arcaidLogoGlitchShift 4s steps(1) infinite reverse;
        }

        .arcaid-logo-word .arcaid-logo-ghost .arcaid-logo-ball .arcaid-logo-ball-s {
          background:
            radial-gradient(circle at 30% 25%, #FFFFFF 0%, #FFFFFF 7%, rgba(255,255,255,0) 20%),
            radial-gradient(circle at 70% 82%, rgba(159,233,250,.55) 0%, rgba(159,233,250,0) 34%),
            radial-gradient(circle at 35% 30%, #F4FBFF 0%, #C9E0F0 18%, #8FB4D2 38%, #3E6688 58%, #0C2136 80%, #55839F 90%, #DCEFFB 100%);
          box-shadow: inset -2px -3px 5px rgba(0,0,0,.5), inset 1px 2px 3px rgba(255,255,255,.6), 0 2px 8px rgba(0,0,0,.6);
        }

        .arcaid-logo-word .arcaid-logo-chrome {
          position: relative;
          background: linear-gradient(180deg, #F6FCFF 0%, #CBE7F8 36%, #7FB2D9 47%, #142E4B 51%, #9FCBEA 55%, #FFFFFF 64%, #6FA5CF 100%);
          padding-right: .09em;
          margin-right: -.09em;
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
        }

        /* S20 already freezes a fixed named-class list of app-wide animations
           (see index.css) but doesn't know about this component's classes —
           freeze here too. Per-layer "animation: none" reverts each layer to
           its plain (non-keyframed) transform/position, which is the same
           resting look the 4s cycle already shows ~86% of the time — a
           static chrome render, not a vanished one. */
        @media (prefers-reduced-motion: reduce) {
          .arcaid-logo-word .arcaid-logo-pink,
          .arcaid-logo-word .arcaid-logo-cyan,
          .arcaid-logo-word .arcaid-logo-ghost .arcaid-logo-ball-p,
          .arcaid-logo-word .arcaid-logo-ghost .arcaid-logo-ball-c {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
}
