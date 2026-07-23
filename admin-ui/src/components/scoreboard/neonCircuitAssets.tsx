/**
 * Inline SVG assets for the Neon Circuit showcase theme.
 * These are decorative background elements — circuit traces, glow nodes,
 * scanline overlay, and chip podium SVG.
 */

/** Full-card circuit board background with traces, vias, SMD components */
export function CircuitBoardBackground() {
  return (
    <svg
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      viewBox="0 0 380 1200"
      preserveAspectRatio="xMidYMid slice"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <filter id="gl" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id="gw" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="4" />
        </filter>
      </defs>

      {/* Faint grid */}
      <g opacity="0.04" stroke="#6030a0" fill="none" strokeWidth="0.5">
        <line x1="0" y1="50" x2="380" y2="50" /><line x1="0" y1="120" x2="380" y2="120" />
        <line x1="0" y1="200" x2="380" y2="200" /><line x1="0" y1="310" x2="380" y2="310" />
        <line x1="0" y1="420" x2="380" y2="420" /><line x1="0" y1="530" x2="380" y2="530" />
        <line x1="0" y1="650" x2="380" y2="650" /><line x1="0" y1="780" x2="380" y2="780" />
        <line x1="0" y1="900" x2="380" y2="900" /><line x1="0" y1="1020" x2="380" y2="1020" />
        <line x1="0" y1="1120" x2="380" y2="1120" />
        <line x1="40" y1="0" x2="40" y2="1200" /><line x1="95" y1="0" x2="95" y2="1200" />
        <line x1="190" y1="0" x2="190" y2="1200" /><line x1="285" y1="0" x2="285" y2="1200" />
        <line x1="340" y1="0" x2="340" y2="1200" />
      </g>

      {/* Cyan traces */}
      <g stroke="#00e0ff" fill="none" strokeWidth="1.2" opacity="0.14" strokeLinecap="round" strokeLinejoin="round" filter="url(#gl)">
        <polyline points="0,80 30,80 30,140 75,140 75,260 40,260 40,370" />
        <polyline points="355,0 355,60 310,60 310,135 345,135 345,230 285,230 285,400" />
        <polyline points="125,0 125,50 165,50 165,105 125,105 125,190" />
        <polyline points="0,610 55,610 55,555 105,555 105,690 55,690 55,760" />
        <polyline points="380,710 325,710 325,770 360,770 360,860 295,860 295,960" />
        <polyline points="190,510 190,590 145,590 145,660 205,660 205,730" />
        <polyline points="75,910 75,970 135,970 135,1060 85,1060 85,1160" />
        <polyline points="255,860 255,930 305,930 305,1010 255,1010 255,1110" />
      </g>

      {/* Pink traces */}
      <g stroke="#ff00c8" fill="none" strokeWidth="1" opacity="0.1" strokeLinecap="round" strokeLinejoin="round" filter="url(#gl)">
        <polyline points="380,45 315,45 315,100 255,100 255,175 305,175 305,290" />
        <polyline points="0,165 65,165 65,215 115,215 115,300 75,300 75,410" />
        <polyline points="245,0 245,75 195,75 195,155 255,155 255,245" />
        <polyline points="380,460 335,460 335,530 275,530 275,615 325,615 325,710" />
        <polyline points="0,810 45,810 45,880 105,880 105,950 55,950 55,1060" />
        <polyline points="205,760 205,840 155,840 155,910 215,910 215,1010" />
        <polyline points="380,1060 325,1060 325,1110 265,1110 265,1190" />
      </g>

      {/* Purple traces */}
      <g stroke="#8a2be2" fill="none" strokeWidth="0.8" opacity="0.08" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="65,0 65,35 105,35 105,95 45,95 45,170" />
        <polyline points="305,155 305,205 345,205 345,290 305,290 305,370" />
        <polyline points="155,310 155,370 195,370 195,450 135,450 135,530" />
        <polyline points="225,560 225,630 265,630 265,710 225,710 225,810" />
        <polyline points="105,760 105,820 145,820 145,890 105,890 105,980" />
        <polyline points="335,910 335,960 365,960 365,1030 315,1030 315,1110" />
      </g>

      {/* Via pads (hollow rings) */}
      <g fill="none" strokeWidth="1.5" opacity="0.18">
        <circle cx="30" cy="80" r="3" stroke="#00e0ff" /><circle cx="75" cy="140" r="2.5" stroke="#00e0ff" />
        <circle cx="310" cy="60" r="3" stroke="#00e0ff" /><circle cx="345" cy="230" r="2.5" stroke="#00e0ff" />
        <circle cx="165" cy="50" r="2.5" stroke="#00e0ff" /><circle cx="105" cy="555" r="3" stroke="#00e0ff" />
        <circle cx="190" cy="590" r="3" stroke="#00e0ff" /><circle cx="295" cy="860" r="2.5" stroke="#00e0ff" />
        <circle cx="135" cy="970" r="3" stroke="#00e0ff" />
        <circle cx="315" cy="45" r="3" stroke="#ff00c8" /><circle cx="255" cy="100" r="2.5" stroke="#ff00c8" />
        <circle cx="115" cy="215" r="3" stroke="#ff00c8" /><circle cx="195" cy="75" r="2.5" stroke="#ff00c8" />
        <circle cx="335" cy="530" r="3" stroke="#ff00c8" /><circle cx="105" cy="880" r="3" stroke="#ff00c8" />
        <circle cx="155" cy="840" r="2.5" stroke="#ff00c8" /><circle cx="325" cy="1060" r="3" stroke="#ff00c8" />
      </g>

      {/* Filled via dots */}
      <g opacity="0.25">
        <circle cx="30" cy="80" r="1.5" fill="#00e0ff" /><circle cx="310" cy="60" r="1.5" fill="#00e0ff" />
        <circle cx="105" cy="555" r="1.5" fill="#00e0ff" /><circle cx="190" cy="590" r="1.5" fill="#00e0ff" />
        <circle cx="135" cy="970" r="1.5" fill="#00e0ff" />
        <circle cx="315" cy="45" r="1.5" fill="#ff00c8" /><circle cx="115" cy="215" r="1.5" fill="#ff00c8" />
        <circle cx="335" cy="530" r="1.5" fill="#ff00c8" /><circle cx="105" cy="880" r="1.5" fill="#ff00c8" />
      </g>

      {/* SMD components */}
      <g stroke="#6030a0" fill="none" strokeWidth="0.6" opacity="0.06">
        <rect x="12" y="348" width="14" height="5" rx="1" /><rect x="352" y="388" width="14" height="5" rx="1" />
        <rect x="148" y="490" width="14" height="5" rx="1" /><rect x="50" y="730" width="14" height="5" rx="1" />
        <rect x="308" y="810" width="14" height="5" rx="1" /><rect x="178" y="1060" width="14" height="5" rx="1" />
        <rect x="278" y="450" width="7" height="9" rx="1" /><rect x="68" y="570" width="7" height="9" rx="1" />
        <rect x="328" y="670" width="7" height="9" rx="1" /><rect x="118" y="1110" width="7" height="9" rx="1" />
      </g>

      {/* Glow halos */}
      <g filter="url(#gw)" opacity="0.6">
        <circle cx="30" cy="80" r="5" fill="#00e0ff" opacity="0.08" />
        <circle cx="310" cy="60" r="4" fill="#ff00c8" opacity="0.06" />
        <circle cx="190" cy="590" r="5" fill="#00e0ff" opacity="0.06" />
        <circle cx="335" cy="530" r="4" fill="#ff00c8" opacity="0.06" />
        <circle cx="105" cy="880" r="5" fill="#ff00c8" opacity="0.06" />
        <circle cx="135" cy="970" r="4" fill="#00e0ff" opacity="0.06" />
      </g>
    </svg>
  );
}

/** Animated glow nodes that pulse around the card */
export function GlowNodes() {
  const nodes = [
    { size: 4, top: '5%', right: '9%', color: '#ff00c8', delay: '0.6s' },
    { size: 4, top: '50%', right: '6%', color: '#00e0ff', delay: '0.3s' },
    { size: 4, top: '55%', left: '12%', color: '#ff00c8', delay: '1.8s' },
    { size: 4, top: '72%', left: '50%', color: '#00e0ff', delay: '0.9s' },
    { size: 5, top: '78%', right: '10%', color: '#ff00c8', delay: '2.1s' },
    { size: 4, top: '90%', left: '20%', color: '#7b2ff7', delay: '1.5s' },
  ];

  return (
    <>
      <style>{`
        @keyframes glow-pulse {
          0%, 100% { opacity: 0.3; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.4); }
        }
        @media (prefers-reduced-motion: reduce) {
          /* !important needed: the animation is set via inline style below,
             which normal cascade order can't override. */
          .scoreboard-glow-node {
            animation: none !important;
          }
        }
      `}</style>
      {nodes.map((n, i) => (
        <div
          key={i}
          className="scoreboard-glow-node"
          style={{
            position: 'absolute',
            borderRadius: '50%',
            zIndex: 2,
            pointerEvents: 'none',
            width: n.size,
            height: n.size,
            top: n.top,
            left: n.left,
            right: n.right,
            background: n.color,
            boxShadow: `0 0 ${n.size === 5 ? 10 : 8}px ${n.color}`,
            animation: `glow-pulse 3s ease-in-out infinite`,
            animationDelay: n.delay,
          }}
        />
      ))}
    </>
  );
}

/** Scanline overlay for CRT effect */
export function ScanlineOverlay() {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 3,
        opacity: 0.03,
        backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.4) 2px, rgba(255,255,255,0.4) 4px)',
        borderRadius: 'inherit',
      }}
    />
  );
}

/** SVG background for the chip podium area (behind the text overlays in ShowcasePodium) */
export function PodiumBackground() {
  return (
    <svg
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      viewBox="0 0 340 280"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <filter id="pg" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.5" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id="chipglow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="6" />
        </filter>
        <linearGradient id="goldg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ffd700" stopOpacity="0.12" />
          <stop offset="100%" stopColor="#ff8c00" stopOpacity="0.04" />
        </linearGradient>
        <linearGradient id="silverg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#c0c0c0" stopOpacity="0.1" />
          <stop offset="100%" stopColor="#808890" stopOpacity="0.03" />
        </linearGradient>
        <linearGradient id="bronzeg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#cd7f32" stopOpacity="0.1" />
          <stop offset="100%" stopColor="#8b5a2b" stopOpacity="0.03" />
        </linearGradient>
        <linearGradient id="chipsurface1" x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0%" stopColor="rgba(255,255,255,0.04)" />
          <stop offset="50%" stopColor="rgba(0,0,0,0)" />
          <stop offset="100%" stopColor="rgba(0,0,0,0.15)" />
        </linearGradient>
      </defs>

      {/* ═══ CHIP 1: 1st place — large BGA ═══ */}
      <rect x="25" y="5" width="175" height="88" rx="4" fill="#ffd700" opacity="0.04" filter="url(#chipglow)" />
      <rect x="30" y="8" width="165" height="82" rx="3" fill="url(#goldg)" stroke="#ffd700" strokeWidth="0.8" strokeOpacity="0.3" />
      <rect x="30" y="8" width="165" height="82" rx="3" fill="url(#chipsurface1)" />
      <rect x="42" y="18" width="141" height="62" rx="2" fill="none" stroke="#ffd700" strokeWidth="0.4" strokeOpacity="0.15" />
      {/* Die markings */}
      <rect x="50" y="26" width="4" height="12" rx="0.5" fill="#ffd700" fillOpacity="0.06" />
      <rect x="50" y="42" width="4" height="12" rx="0.5" fill="#ffd700" fillOpacity="0.06" />
      <rect x="50" y="58" width="4" height="12" rx="0.5" fill="#ffd700" fillOpacity="0.06" />
      <rect x="168" y="26" width="8" height="4" rx="0.5" fill="#ffd700" fillOpacity="0.06" />
      <rect x="168" y="34" width="8" height="4" rx="0.5" fill="#ffd700" fillOpacity="0.06" />
      <rect x="168" y="42" width="8" height="4" rx="0.5" fill="#ffd700" fillOpacity="0.06" />
      <rect x="168" y="50" width="8" height="4" rx="0.5" fill="#ffd700" fillOpacity="0.06" />
      <circle cx="37" cy="15" r="2.5" fill="none" stroke="#ffd700" strokeWidth="0.5" strokeOpacity="0.2" />
      {/* Top pins */}
      <g fill="#ffd700" fillOpacity="0.2">
        {[48,58,68,78,88,98,108,118,128,138,148,158,168,178].map(x => (
          <rect key={`t${x}`} x={x} y="2" width="2.5" height="7" rx="0.5" />
        ))}
      </g>
      {/* Bottom pins */}
      <g fill="#ffd700" fillOpacity="0.2">
        {[48,58,68,78,88,98,108,118,128,138,148,158,168,178].map(x => (
          <rect key={`b${x}`} x={x} y="89" width="2.5" height="7" rx="0.5" />
        ))}
      </g>
      {/* Left pins */}
      <g fill="#ffd700" fillOpacity="0.2">
        {[22,32,42,52,62,72].map(y => (
          <rect key={`l${y}`} x="23" y={y} width="8" height="2.5" rx="0.5" />
        ))}
      </g>
      {/* Right pins */}
      <g fill="#ffd700" fillOpacity="0.2">
        {[22,32,42,52,62,72].map(y => (
          <rect key={`r${y}`} x="194" y={y} width="8" height="2.5" rx="0.5" />
        ))}
      </g>

      {/* ═══ TRACE: 1st → 2nd ═══ */}
      <g stroke="#00e0ff" fill="none" strokeWidth="1.2" opacity="0.3" strokeLinecap="round" strokeLinejoin="round" filter="url(#pg)">
        <polyline points="112,96 112,115 80,115 80,135" />
      </g>
      <circle cx="112" cy="96" r="2.5" fill="none" stroke="#00e0ff" strokeWidth="1" opacity="0.3" />
      <circle cx="112" cy="96" r="1" fill="#00e0ff" opacity="0.5" />
      <circle cx="80" cy="115" r="2" fill="none" stroke="#00e0ff" strokeWidth="0.8" opacity="0.25" />
      <circle cx="80" cy="115" r="0.8" fill="#00e0ff" opacity="0.4" />

      {/* ═══ CHIP 2: 2nd place — medium SOIC ═══ */}
      <rect x="10" y="130" width="140" height="65" rx="3" fill="#c0c0c0" opacity="0.03" filter="url(#chipglow)" />
      <rect x="15" y="133" width="130" height="60" rx="2.5" fill="url(#silverg)" stroke="#c0c0c0" strokeWidth="0.7" strokeOpacity="0.25" />
      <rect x="15" y="133" width="130" height="60" rx="2.5" fill="url(#chipsurface1)" />
      <rect x="25" y="141" width="110" height="44" rx="1.5" fill="none" stroke="#c0c0c0" strokeWidth="0.35" strokeOpacity="0.12" />
      <circle cx="21" cy="139" r="2" fill="none" stroke="#c0c0c0" strokeWidth="0.4" strokeOpacity="0.15" />
      {/* Top pins */}
      <g fill="#c0c0c0" fillOpacity="0.15">
        {[30,40,50,60,70,80,90,100,110,120,130].map(x => (
          <rect key={`2t${x}`} x={x} y="127" width="2" height="7" rx="0.5" />
        ))}
      </g>
      {/* Bottom pins */}
      <g fill="#c0c0c0" fillOpacity="0.15">
        {[30,40,50,60,70,80,90,100,110,120,130].map(x => (
          <rect key={`2b${x}`} x={x} y="192" width="2" height="7" rx="0.5" />
        ))}
      </g>
      {/* Left pins */}
      <g fill="#c0c0c0" fillOpacity="0.15">
        {[143,153,163,173,183].map(y => (
          <rect key={`2l${y}`} x="8" y={y} width="8" height="2" rx="0.5" />
        ))}
      </g>

      {/* ═══ TRACE: 2nd → 3rd ═══ */}
      <g stroke="#ff00c8" fill="none" strokeWidth="1.2" opacity="0.25" strokeLinecap="round" strokeLinejoin="round" filter="url(#pg)">
        <polyline points="145,163 175,163 175,215 200,215" />
      </g>
      <circle cx="145" cy="163" r="2.5" fill="none" stroke="#ff00c8" strokeWidth="1" opacity="0.25" />
      <circle cx="145" cy="163" r="1" fill="#ff00c8" opacity="0.4" />
      <circle cx="175" cy="163" r="2" fill="none" stroke="#ff00c8" strokeWidth="0.8" opacity="0.2" />
      <circle cx="175" cy="163" r="0.8" fill="#ff00c8" opacity="0.35" />
      <circle cx="175" cy="215" r="2" fill="none" stroke="#ff00c8" strokeWidth="0.8" opacity="0.2" />
      <circle cx="175" cy="215" r="0.8" fill="#ff00c8" opacity="0.35" />

      {/* ═══ CHIP 3: 3rd place — smallest, offset right ═══ */}
      <rect x="195" y="195" width="120" height="55" rx="2.5" fill="#cd7f32" opacity="0.025" filter="url(#chipglow)" />
      <rect x="200" y="198" width="110" height="50" rx="2" fill="url(#bronzeg)" stroke="#cd7f32" strokeWidth="0.6" strokeOpacity="0.2" />
      <rect x="200" y="198" width="110" height="50" rx="2" fill="url(#chipsurface1)" />
      <rect x="208" y="205" width="94" height="36" rx="1.5" fill="none" stroke="#cd7f32" strokeWidth="0.3" strokeOpacity="0.1" />
      <circle cx="205" cy="203" r="1.8" fill="none" stroke="#cd7f32" strokeWidth="0.4" strokeOpacity="0.12" />
      {/* Top pins */}
      <g fill="#cd7f32" fillOpacity="0.12">
        {[215,225,235,245,255,265,275,285,295].map(x => (
          <rect key={`3t${x}`} x={x} y="192" width="2" height="7" rx="0.5" />
        ))}
      </g>
      {/* Bottom pins */}
      <g fill="#cd7f32" fillOpacity="0.12">
        {[215,225,235,245,255,265,275,285,295].map(x => (
          <rect key={`3b${x}`} x={x} y="247" width="2" height="7" rx="0.5" />
        ))}
      </g>
      {/* Right pins */}
      <g fill="#cd7f32" fillOpacity="0.12">
        {[208,218,228,238].map(y => (
          <rect key={`3r${y}`} x="310" y={y} width="8" height="2" rx="0.5" />
        ))}
      </g>
    </svg>
  );
}
