/**
 * ArcaidLogoAnimated — "Delta House Chrome" animated wordmark (v2.45.0).
 *
 * Faithful port of docs/design-sources/arcaid-delta-house-chrome-final.html (an
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
 * The `dark` variant assumes a near-black backdrop (#0C0C13) for the glow/
 * drop-shadow layers to read correctly. The `light` variant (v2.60.0) is the
 * same composition re-lit for a #E8EAF0 canvas — see LIGHT VARIANT below.
 *
 * ─── LIGHT VARIANT (v2.60.0) ───
 *
 * Port of `docs/design-sources/light-logo/README.txt`.
 * Same 620x560 sign canvas, same crop, same glitch keyframes and cadence — the
 * artwork differences are exactly the five the pack lists:
 *
 *   1. A purple backdrop plate is added behind the wordmark (dark has none).
 *   2. The cyan neon halo behind the wordmark is replaced by a tight cast
 *      shadow plus two blurred #0A1017 glyph copies.
 *   3. The delta is rebuilt as a three-layer glass tube (bloom / core /
 *      filament) instead of one pale-pink stroke with a glow.
 *   4. Glitch cyan darkens #5BC8F5 -> #0F9BD1 so it holds on a light surface.
 *   5. The pinball gains a dark rim and a contact shadow.
 *
 * The chrome gradient is byte-identical across variants, by design.
 *
 * Fringe opacities differ per variant (.75 dark vs .55/.60 light). Rather than
 * fork the keyframes — which would fork the CADENCE, the thing that must stay
 * identical — the four opacity stops are read from custom properties whose
 * fallbacks are the dark values, so the dark render is provably unchanged.
 */

const SIGN_WIDTH = 620;
const SIGN_HEIGHT = 560;

/**
 * Backdrop plate geometry, in 1x sign-canvas coordinates.
 *
 * The pack gives the size (556 x 138, radius 10, skewX(-10deg)) but not the
 * origin. Derived by measuring `arcaid-light-e8eaf0-2x.png`: the plate's
 * un-skewed centre row spans x 114..1224 and the box spans y 234..507 at 2x,
 * and the reference export is a 1:1 crop of this canvas offset by (-39.7,
 * +93.7) — established by matching the neon delta's bounding box, whose canvas
 * geometry is known exactly. That lands the plate at (17, 210), i.e. centred
 * on the wordmark's own anchor (47.5% / 50% => centre 294.5, 280 vs the
 * plate's 295, 279). Screenshot-verified against the reference.
 */
const PLATE_W = 556;
const PLATE_H = 138;
const PLATE_LEFT = 17;
const PLATE_TOP = 210;

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

/** The delta's two nested triangles, reused by every stroke layer. */
function DeltaPaths() {
  return (
    <g transform="rotate(-15 110 95)">
      <polygon points="14,40 206,40 110,150" />
      <polygon points="32,48 188,48 110,138" />
    </g>
  );
}

interface ArcaidLogoAnimatedProps {
  /** Widest the rendered mark should ever get, in px. Narrower viewports
   * scale down proportionally (see `.arcaid-logo-sign` transform) so it
   * never overflows horizontally. Default suits a prominent hero use. */
  maxWidth?: number;
  /** Backdrop polarity the mark is being placed on. `dark` (default) is the
   * original near-black composition; `light` adds the purple plate and swaps
   * the neon/halo treatment for the #E8EAF0 canvas. */
  variant?: 'dark' | 'light';
  className?: string;
}

export default function ArcaidLogoAnimated({
  maxWidth = 720,
  variant = 'dark',
  className = '',
}: ArcaidLogoAnimatedProps) {
  const isLight = variant === 'light';
  const glitchCyan = isLight ? '#0F9BD1' : '#5BC8F5';

  return (
    <div
      className={`arcaid-logo-wrap arcaid-logo-${variant} ${className}`.trim()}
      style={{ maxWidth }}
    >
      <div className="arcaid-logo-sign">
        {/* Purple backdrop plate — light variant only. First child so it
            paints under both the delta and the wordmark. */}
        {isLight && <div className="arcaid-logo-plate" aria-hidden="true" />}

        <svg
          className="arcaid-logo-triangle"
          width={SIGN_WIDTH}
          height={SIGN_HEIGHT}
          viewBox="-48 -47 316 284"
          fill="none"
          aria-hidden="true"
        >
          {/* Glitch split-copies of the delta — invisible at rest, flash as
              offset chromatic ghosts during their burst windows. Their
              animation runs on a DIFFERENT period than the wordmark's
              (5.7s vs 7.4s) so the two never sync. Outer <g> carries the
              CSS animation; the inner rotate stays an attribute so the CSS
              transform doesn't clobber it. */}
          <g className="arcaid-logo-tri-p" stroke="#FF2E63" strokeWidth="3.5" strokeLinejoin="round">
            <DeltaPaths />
          </g>
          <g className="arcaid-logo-tri-c" stroke={glitchCyan} strokeWidth="3.5" strokeLinejoin="round">
            <DeltaPaths />
          </g>
          {isLight ? (
            /* Three-layer glass tube: bloom / core / filament. Same build the
               Global Scoreboard trophy uses. */
            <>
              <g className="arcaid-logo-tube-bloom" stroke="#FF2E63" strokeWidth="9" strokeLinejoin="round">
                <DeltaPaths />
              </g>
              <g className="arcaid-logo-tube-core" stroke="#FF1B57" strokeWidth="3.6" strokeLinejoin="round">
                <DeltaPaths />
              </g>
              <g className="arcaid-logo-tube-fil" stroke="#FFE3EC" strokeWidth="1.1" strokeLinejoin="round">
                <DeltaPaths />
              </g>
            </>
          ) : (
            <g
              stroke="#FFA8BE"
              strokeWidth="3.5"
              strokeLinejoin="round"
              style={{ filter: 'drop-shadow(0 0 4px #FF2E63) drop-shadow(0 0 14px rgba(255,46,99,.55))' }}
            >
              <DeltaPaths />
            </g>
          )}
        </svg>

        <div className="arcaid-logo-word" role="img" aria-label="Arcaid">
          {/* Light only: two blurred #0A1017 glyph copies seating the chrome
              on the plate, in place of the dark variant's cyan halo. */}
          {isLight && (
            <>
              <div className="arcaid-logo-sh1" aria-hidden="true">ARCAıD</div>
              <div className="arcaid-logo-sh2" aria-hidden="true">ARCAıD</div>
            </>
          )}
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

        /* v2.45.4 glitch rework (user: "more glitchy, not so syncopated").
           The old single 4s cycle fired one tidy burst at the same point
           every loop — a metronome. These keyframes cluster multiple rapid
           jumps (steps(1) holds ≈ 60-110ms each) at IRREGULAR offsets, with
           opacity flicker inside each burst. The wordmark runs 7.4s, the
           delta 5.7s, with negative delays staggering every layer — the
           periods are co-prime enough that text and triangle bursts drift
           against each other and never lock into sync. */
        /* v2.45.6 cadence tune (user: sporadic feel is right, but too
           frequent). Cycles stretched 7.4s→18s and 5.7s→26s with TWO burst
           clusters each (was 4 and 3) — plus each cluster's mirror from the
           reversed color layer, that's a glitch moment roughly every 4-6s
           per system at uneven offsets, with genuine multi-second quiet
           stretches. Burst-internal character (rapid ~70-120ms multi-jumps
           + opacity flicker) is unchanged. */
        /* v2.60.0 — the four opacity stops read from custom properties so the
           light variant can dial the fringe back (.55/.60 vs .75) WITHOUT
           forking the keyframes, which would fork the cadence. Fallbacks are
           the dark values, so the dark render is unchanged by construction. */
        @keyframes arcaidGlitchText {
          0%, 11.1%, 13.2%, 61.4%, 63.6%, 100% { transform: translate(0, 0); opacity: var(--arcaid-gl-rest, .75); }
          11.4% { transform: translate(5px, -2px); opacity: var(--arcaid-gl-hi, .95); }
          11.9% { transform: translate(-6px, 3px); opacity: var(--arcaid-gl-lo, .5); }
          12.6% { transform: translate(3px, 1px); opacity: var(--arcaid-gl-mid, .9); }
          61.7% { transform: translate(6px, -1px); opacity: var(--arcaid-gl-hi, .95); }
          62.3% { transform: translate(-5px, -2px); opacity: var(--arcaid-gl-lo2, .55); }
          63.1% { transform: translate(2px, 3px); opacity: var(--arcaid-gl-mid, .9); }
        }

        @keyframes arcaidGlitchTri {
          0%, 23.3%, 24.9%, 71.0%, 72.8%, 100% { transform: translate(0, 0); opacity: 0; }
          23.6% { transform: translate(4px, -2px); opacity: .8; }
          24.0% { transform: translate(-5px, 2px); opacity: .35; }
          24.5% { transform: translate(2px, 1px); opacity: .7; }
          71.3% { transform: translate(-4px, 3px); opacity: .8; }
          71.9% { transform: translate(5px, -1px); opacity: .4; }
          72.4% { transform: translate(3px, 2px); opacity: .65; }
        }

        .arcaid-logo-tri-p {
          opacity: 0;
          animation: arcaidGlitchTri 26s steps(1) infinite;
          animation-delay: -3.1s;
        }

        .arcaid-logo-tri-c {
          opacity: 0;
          animation: arcaidGlitchTri 26s steps(1) infinite reverse;
          animation-delay: -12.4s;
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
          animation: arcaidGlitchText 18s steps(1) infinite;
        }

        .arcaid-logo-word .arcaid-logo-cyan {
          position: absolute;
          left: 3px;
          top: -2px;
          color: #5BC8F5;
          opacity: .75;
          animation: arcaidGlitchText 18s steps(1) infinite reverse;
          animation-delay: -7.7s;
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
          animation: arcaidGlitchText 18s steps(1) infinite;
        }

        .arcaid-logo-word .arcaid-logo-ghost .arcaid-logo-ball .arcaid-logo-ball-c {
          background: #5BC8F5;
          opacity: .75;
          transform: translate(3px, -2px);
          animation: arcaidGlitchText 18s steps(1) infinite reverse;
          animation-delay: -7.7s;
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

        /* ─────────────── light variant (v2.60.0) ─────────────── */

        /* Fringe strength. Dark values live as the keyframe fallbacks above;
           these are the same curve scaled to the pack's .55 (text / ball cyan)
           and .60 (ball pink) rest opacities. */
        .arcaid-logo-light .arcaid-logo-word .arcaid-logo-pink,
        .arcaid-logo-light .arcaid-logo-word .arcaid-logo-cyan,
        .arcaid-logo-light .arcaid-logo-word .arcaid-logo-ghost .arcaid-logo-ball .arcaid-logo-ball-c {
          --arcaid-gl-rest: .55;
          --arcaid-gl-hi: .70;
          --arcaid-gl-lo: .37;
          --arcaid-gl-mid: .66;
          --arcaid-gl-lo2: .40;
          opacity: .55;
        }

        .arcaid-logo-light .arcaid-logo-word .arcaid-logo-ghost .arcaid-logo-ball .arcaid-logo-ball-p {
          --arcaid-gl-rest: .60;
          --arcaid-gl-hi: .76;
          --arcaid-gl-lo: .40;
          --arcaid-gl-mid: .72;
          --arcaid-gl-lo2: .44;
          opacity: .60;
        }

        /* Backdrop plate. z-index:-1 puts it under the (inline, unpositioned)
           delta SVG — without it, a positioned sibling paints ABOVE inline
           content and the plate would cover the neon. The sign's own
           transform is the stacking context it sits inside. */
        .arcaid-logo-light .arcaid-logo-plate {
          position: absolute;
          z-index: -1;
          left: ${PLATE_LEFT}px;
          top: ${PLATE_TOP}px;
          width: ${PLATE_W}px;
          height: ${PLATE_H}px;
          border-radius: 10px;
          transform: skewX(-10deg);
          background: linear-gradient(180deg, #4A1D82 0%, #2A0C52 46%, #1B0638 62%, #3A1468 100%);
          box-shadow: 0 12px 34px rgba(42,12,82,.40), inset 0 1px 0 rgba(214,164,255,.22);
        }

        /* Delta as a glass tube. The filament layer sits on top. */
        .arcaid-logo-light .arcaid-logo-tube-bloom { opacity: .30; filter: blur(5px); }
        .arcaid-logo-light .arcaid-logo-tube-core { filter: drop-shadow(0 0 3px rgba(255,46,99,.75)); }

        /* Wordmark: cyan halo out, tight cast shadow in. */
        .arcaid-logo-light .arcaid-logo-word {
          filter: drop-shadow(0 2px 2px rgba(10,16,25,.45));
        }

        .arcaid-logo-light .arcaid-logo-word .arcaid-logo-sh1,
        .arcaid-logo-light .arcaid-logo-word .arcaid-logo-sh2 {
          position: absolute;
          left: 0;
          color: #0A1017;
          opacity: .45;
        }

        .arcaid-logo-light .arcaid-logo-word .arcaid-logo-sh1 { top: 2px; filter: blur(22px); }
        .arcaid-logo-light .arcaid-logo-word .arcaid-logo-sh2 { top: 1px; filter: blur(9px); }

        .arcaid-logo-light .arcaid-logo-word .arcaid-logo-cyan { color: #0F9BD1; }

        .arcaid-logo-light .arcaid-logo-word .arcaid-logo-ghost .arcaid-logo-ball .arcaid-logo-ball-c {
          background: #0F9BD1;
        }

        /* Pinball: + dark rim and a contact shadow so it sits on the plate. */
        .arcaid-logo-light .arcaid-logo-word .arcaid-logo-ghost .arcaid-logo-ball .arcaid-logo-ball-s {
          box-shadow:
            inset -2px -3px 5px rgba(0,0,0,.55),
            inset 1px 2px 3px rgba(255,255,255,.65),
            inset 0 0 0 1px rgba(12,33,54,.50),
            0 2px 6px rgba(16,38,62,.45);
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
          .arcaid-logo-word .arcaid-logo-ghost .arcaid-logo-ball-c,
          .arcaid-logo-tri-p,
          .arcaid-logo-tri-c {
            animation: none;
          }
          /* Delta split-copies rest at opacity 0 — under reduced motion they
             simply never appear. */
        }
      `}</style>
    </div>
  );
}
