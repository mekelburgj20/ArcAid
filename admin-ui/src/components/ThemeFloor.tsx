/**
 * The carpet floor (G29, v2.264.0; owner 2026-11-23): a faint arcade-carpet
 * pattern behind a themed page, drawn in the theme's own colours.
 *
 * Mounted as the FIRST child of PublicLayout, RoomAdminLayout and
 * SuperAdminLayout, and nowhere else: not the kiosk, the Global Scoreboard,
 * the landing page, the Witness pages or an `ArcaidPage` (Account Settings
 * and its family keep their own fixed carpet, which this switch never
 * touches). Whether it shows is `ThemeProvider`'s `floor` (the viewer's
 * choice, else the room's on its pages, else on); High contrast never shows
 * it.
 *
 * The layer is one fixed, full-viewport element that takes no clicks, never
 * scrolls and does not print (the "Carpet floor" block in index.css, which
 * also sets each theme's strength and the colours). It paints behind the
 * page because the layout content that follows it is positioned. The tiles
 * are decoration and the biggest thing on the page, so they arrive as their
 * own chunk (`themeFloorTiles.generated.ts`, written by
 * scripts/arcadeCarpet.mjs): nothing renders until it has loaded, and a
 * viewer with the floor off never downloads it.
 */
import { useEffect, useState } from 'react';
import { useTheme } from './ThemeProvider';

/** The loaded markup, kept so a remount (moving between layouts) paints at once. */
let floorSvg: string | null = null;

export default function ThemeFloor() {
  const { floor, theme } = useTheme();
  const show = !!floor && theme !== 'contrast';
  const [svg, setSvg] = useState<string | null>(floorSvg);

  useEffect(() => {
    if (!show || svg) return;
    let cancelled = false;
    import('./themeFloorTiles.generated')
      .then(m => {
        floorSvg = m.THEME_FLOOR_SVG;
        if (!cancelled) setSvg(floorSvg);
      })
      .catch(() => { /* decoration: a failed load leaves the plain page */ });
    return () => { cancelled = true; };
  }, [show, svg]);

  if (!show || !svg) return null;
  return (
    <div
      className="carpet-floor"
      aria-hidden="true"
      data-testid="carpet-floor"
      // Static markup generated from our own script, never user content.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
