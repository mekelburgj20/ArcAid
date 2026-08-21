ARCAID — GLOBAL SCOREBOARD TITLE
Neon trophy + House Chrome wordmark, dark & light
=========================================================

THE GLITCH NEEDS CSS. Use the CSS + markup pair for the real
thing; the PNGs are static one-frame fallbacks.

FILES
  global-scoreboard.css              the whole treatment incl. all glitch animation
  global-scoreboard-dark.html        markup snippet, dark theme
  global-scoreboard-light.html       markup snippet, light theme

  gs-dark-full-1x.png     1008 × 255   transparent  (trophy + title + subtitle)
  gs-dark-full-2x.png     2016 × 510   transparent
  gs-dark-lockup-2x.png   2016 × 432   transparent  (trophy + title, no subtitle)
  gs-light-full-1x.png    1008 × 255   transparent
  gs-light-full-2x.png    2016 × 510   transparent
  gs-light-lockup-2x.png  2016 × 432   transparent
  gs-dark-baked-2x.png    2016 × 510   baked on #0F1117
  gs-light-baked-2x.png   2016 × 510   baked on #E8EAF0

  ../../share/global-scoreboard-dark-src.html    standalone animated page
  ../../share/global-scoreboard-light-src.html   standalone animated page


HOW TO USE (recommended — animated)
  1. Copy global-scoreboard.css into your styles. It @imports Orbitron
     400 + 900 itself; drop that line if you already load the font.
  2. Paste the markup from global-scoreboard-dark.html (or -light.html).
  3. Theme switch = swap the class on .gs-title:  gs-dark  ⇄  gs-light

     <div class="gs-title gs-dark"> … </div>

  Scale it by changing one value — .gs-word font-size (68px default).
  The trophy is fixed at 104px; to rescale it together with the text,
  change .gs-trophy width/height/left and .gs-lockup padding-left
  (and .gs-sub padding-left) in the same proportion.

  Fringe strength is a custom property:  .gs-title { --gs-fringe:.55 }
  0 = clean chrome, 1 = heavy pink/cyan separation.

  prefers-reduced-motion: reduce is already honoured — all glitch and
  flicker animation stops, artwork stays intact.


WHAT ANIMATES  (4 keyframe sets, all in the CSS)
  gsShift      pink + cyan fringe copies jump on a 4.2s cycle
  gsSliceA/B   horizontal tear bands displace the chrome lettering
               (the tears are chrome-gradient copies of the letters, so
               they never stain the mark with flat colour)
  gsNeonFlash  trophy flashes/drops out like a failing tube, 4.2s,
               synced to the text glitch
  gsFlicker    trophy filament flickers on its own 6.2s cycle

  The trophy never moves — it only flashes. Position jitter belongs to
  the text only.


ARTWORK SPEC

Wordmark  "Global Scoreboard"
  font          Orbitron 900, italic, 68px, line-height 1.14
  chrome fill   linear-gradient(180deg,
                  #F6FCFF  0%, #CBE7F8 36%, #7FB2D9 47%,
                  #142E4B 51%,   ← horizon
                  #9FCBEA 55%, #FFFFFF 64%, #6FA5CF 100%)
                via background-clip:text
  fringe        #FF2E63 at (-3,+2)  |  #5BC8F5 dark / #0F9BD1 light at (+3,-2)
  dark glow     drop-shadow(0 0 10px rgba(53,214,232,.75))
                drop-shadow(0 0 34px rgba(53,214,232,.34))
  light seat    drop-shadow(0 2px 2px rgba(10,16,25,.45)) plus two blurred
                #0A1017 glyph copies at opacity .45 (blur 20px / 8px)

Neon trophy  (viewBox 0 0 100 100, rendered 104 × 104, three stroke layers)
  bloom         #FF2E63, width 8.5 (light 9), opacity .34 (light .32), blur(4px)
  core          #FF2E63 dark / #FF1B57 light, width 4
                dark:  drop-shadow(0 0 4px #FF2E63) drop-shadow(0 0 13px rgba(255,46,99,.6))
                light: drop-shadow(0 0 3px rgba(255,46,99,.8))
  filament      #FFE3EC, width 1.3
  Same three-layer glass-tube build as the logo's delta.

Purple plate  (light theme only)
  inset 2px/6px/2px/8px of the lockup, radius 12px, skewX(-10deg)
  fill          linear-gradient(180deg,#4A1D82 0%,#2A0C52 46%,#1B0638 62%,#3A1468 100%)
  shadow        0 12px 34px rgba(42,12,82,.4)
  highlight     inset 0 1px 0 rgba(214,164,255,.22)

Subtitle
  Orbitron 400, 17px, letter-spacing .07em
  #8992A4 on dark  |  #5A6270 on light
  Left-aligned to the wordmark (padding-left 158px).
  Keep this as live text in the app — the PNGs include it only as a fallback.


BACKGROUNDS
  dark   designed on #0F1117; safe on anything below ~#1E2130
  light  designed on #E8EAF0; safe on #FFFFFF – #DEE3EC


COLOR REFERENCE
  Neon bloom / fringe   #FF2E63
  Neon core (light)     #FF1B57
  Filament              #FFE3EC
  Chrome high           #F6FCFF
  Chrome horizon        #142E4B
  Chrome low            #6FA5CF
  Glitch cyan           #5BC8F5 (dark) / #0F9BD1 (light)
  Plate violet          #4A1D82
  Plate deep            #1B0638
  Subtitle              #8992A4 / #5A6270

Font: Orbitron 400 + 900 — https://fonts.google.com/specimen/Orbitron (OFL)
