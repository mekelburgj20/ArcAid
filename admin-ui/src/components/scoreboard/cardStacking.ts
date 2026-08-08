/**
 * Paint order inside a scoreboard card slot.
 *
 * v2.85.1 — bug: on the room-admin Leaderboard, a bottom-anchored QR code hung
 * down over the admin controls strip and covered the Name/Style buttons. It
 * did not merely LOOK wrong: hit-testing follows paint order, so the QR canvas
 * also swallowed the clicks meant for those buttons.
 *
 * WHY IT HAPPENED. Nothing between the QR and the strip creates a stacking
 * context, so the two compete directly:
 *
 *   div.scoreboard-card-slot              position:relative, z-index:auto  ─┐
 *     div.flex.flex-col                   static                            │ one shared
 *       BannerCard root                   position:relative, z-index:auto   │ stacking
 *         …card…                                                            │ context
 *         div (bottom-center QR)          position:absolute, z-index:15     │
 *       AdminControlsStrip                position:relative, z-index:10    ─┘
 *
 * `position: relative` with `z-index: auto` does NOT create a stacking
 * context, so the card root is transparent to z-ordering and the QR's 15
 * simply beat the strip's 10.
 *
 * THE FIX is ordering, not geometry. The owner wants the QR to stay VISIBLE
 * behind the strip (an admin needs to see what the card looks like WITH a QR)
 * but never needs to scan or click it there — so the strip just has to out-rank
 * it. Geometry already composes correctly: the bottom-center QR is absolutely
 * positioned, so it does not push the strip down, and the slot's
 * `cardMarginBottom` reservation keeps the row spacing that the QR's tail needs
 * BELOW the strip. Nothing about the public page changes: it has no strip.
 *
 * These constants exist so the relationship is greppable from both ends rather
 * than being two unexplained magic numbers in different files. Their ORDER is
 * locked by a test that reads the rendered z-indexes off both elements
 * (`LeaderboardAdminControls.test.tsx`), so raising the QR without raising the
 * chrome fails CI rather than silently re-burying the buttons.
 */

/**
 * The z-index each card's bottom-anchored QR overlay paints at.
 *
 * Mirrors the literal in `BannerCard.tsx`, `MinimalCard.tsx` and
 * `ShowcaseCard.tsx` (the `bottom-right` and `bottom-center` blocks). Those
 * are public rendering code and are deliberately left untouched here — this
 * is a readable restatement for the comparison below, not their source.
 */
export const CARD_QR_Z_INDEX = 15;

/**
 * The z-index for ADMIN-ONLY chrome that must stay usable on top of a card,
 * currently just the controls strip. Above the QR so the buttons are both
 * visible and clickable, with headroom so a future card overlay landing
 * between the two does not silently re-bury them.
 */
export const ADMIN_CARD_CHROME_Z_INDEX = CARD_QR_Z_INDEX + 5;
