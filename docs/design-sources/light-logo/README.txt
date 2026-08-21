ARCAID — LIGHT THEME LOGO
Delta × House Chrome, purple backdrop plate
=========================================================

FILES
  arcaid-light-transparent-1x.png    700 × 330    transparent
  arcaid-light-transparent-2x.png   1400 × 660    transparent  ← use this one
  arcaid-light-transparent-3x.png   2100 × 990    transparent
  arcaid-light-e8eaf0-2x.png        1400 × 660    baked on #E8EAF0
  arcaid-light-white-2x.png         1400 × 660    baked on #FFFFFF
  ../../share/arcaid-light-src.html               live HTML source (animated glitch)

The transparent PNGs are the ones to import. The plate is part of the artwork,
so they sit on any light surface. Aspect ratio 70:33 — set width and let height
follow. Recommended minimum display width: 180px (below that use the wordmark
without the delta).


BACKGROUND
  Designed against          #E8EAF0
  Also verified on          #FFFFFF, #F7F6F3
  Avoid                     anything darker than ~#D0D4DE (plate stops separating)


ARTWORK SPEC  (all values at 1x, sign canvas 620 × 560)

Backdrop plate
  size            556 × 138, border-radius 10px
  transform       skewX(-10deg)
  fill            linear-gradient(180deg,
                    #4A1D82  0%,
                    #2A0C52 46%,
                    #1B0638 62%,
                    #3A1468 100%)
  shadow          0 12px 34px rgba(42,12,82,.40)
  inner highlight inset 0 1px 0 rgba(214,164,255,.22)

Neon delta  (inverted triangle, rotate(-15deg), double outline)
  bloom           stroke #FF2E63, width 9,   opacity .30, blur(5px)
  core            stroke #FF1B57, width 3.6, drop-shadow 0 0 3px rgba(255,46,99,.75)
  filament        stroke #FFE3EC, width 1.1
  geometry        outer polygon 14,40 206,40 110,150
                  inner polygon 32,48 188,48 110,138
                  viewBox -48 -47 316 284, rendered 620 × 560

Wordmark  "ARCAıD"  (dotless ı U+0131 — the pinball replaces the tittle)
  font            Orbitron 900, italic, 100px, line-height 1
  chrome fill     linear-gradient(180deg,
                    #F6FCFF  0%,
                    #CBE7F8 36%,
                    #7FB2D9 47%,
                    #142E4B 51%,   ← horizon
                    #9FCBEA 55%,
                    #FFFFFF 64%,
                    #6FA5CF 100%)
                  via background-clip:text + text-fill-color:transparent
  cast shadow     drop-shadow(0 2px 2px rgba(10,16,25,.45))
  glyph shadows   two blurred #0A1017 copies behind, opacity .45
                    blur(22px) at top+2px, blur(9px) at top+1px
  glitch fringe   #FF2E63 at (-3, +2), opacity .55
                  #0F9BD1 at (+3, -2), opacity .55

Pinball  (the dot of the i)
  size            22 × 22, translateX(calc(-50% + 19px)) from the ı, top 9px
  fill            radial-gradient(circle at 30% 25%, #FFF 0%, #FFF 7%, transparent 20%),
                  radial-gradient(circle at 70% 82%, rgba(159,233,250,.55) 0%, transparent 34%),
                  radial-gradient(circle at 35% 30%,
                    #F4FBFF 0%, #C9E0F0 18%, #8FB4D2 38%, #3E6688 58%,
                    #0C2136 80%, #55839F 90%, #DCEFFB 100%)
  shading         inset -2px -3px 5px rgba(0,0,0,.55)
                  inset  1px  2px 3px rgba(255,255,255,.65)
                  inset  0 0 0 1px rgba(12,33,54,.50)   ← rim, light-theme only
                  0 2px 6px rgba(16,38,62,.45)          ← contact shadow
  fringe          #FF2E63 at (-3,+2) .60, #0F9BD1 at (+3,-2) .55


DIFFERENCES FROM THE DARK-THEME LOGO
  1. Purple backdrop plate added (dark theme has none).
  2. Cyan neon halo behind the wordmark removed; replaced with dark glyph
     shadows + a tight cast shadow.
  3. Delta rebuilt as a three-layer glass tube (bloom / core / filament)
     instead of a single pale-pink stroke with glow.
  4. Glitch cyan darkened #5BC8F5 → #0F9BD1 so it holds on light surfaces.
  5. Pinball gained a dark rim and a contact shadow.
  6. Chrome gradient is UNCHANGED — identical to the dark-theme mark.


COLOR REFERENCE
  Plate violet      #4A1D82
  Plate deep        #1B0638
  Neon core         #FF1B57
  Neon bloom        #FF2E63
  Filament          #FFE3EC
  Chrome high       #F6FCFF
  Chrome horizon    #142E4B
  Chrome low        #6FA5CF
  Glitch cyan       #0F9BD1
  Shadow            #0A1017
  Canvas            #E8EAF0

Font: Orbitron 900 — https://fonts.google.com/specimen/Orbitron (OFL)
