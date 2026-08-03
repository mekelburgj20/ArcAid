import { describe, it, expect } from 'vitest';
import { navSectionForPath, type NavSection } from '../navSections';

/**
 * Field report: "Stats loses its highlight on Stats → History". Five public
 * pages are URL *siblings* of their nav section head, so NavLink's built-in
 * descendant matching could never light them. `navSectionForPath` is the
 * explicit mapping that replaces it — this locks the whole table down.
 */

const SLUG = 'rtx-pinball';

const SECTIONS: NavSection[] = ['lobby', 'scores', 'picks', 'stats', 'players'];

/** Every route in the nav contract, with the ONE section it must light. */
const CASES: Array<[path: string, expected: NavSection]> = [
  // Scores
  [`/${SLUG}`, 'scores'],
  [`/${SLUG}/games/WHO%20dunnit`, 'scores'],
  [`/${SLUG}/games/Medieval Madness`, 'scores'],
  // Lobby
  [`/${SLUG}/lobby`, 'lobby'],
  // Picks
  [`/${SLUG}/picks`, 'picks'],
  [`/${SLUG}/mystery-award`, 'picks'],
  // Stats (the reported bug: /history is a sibling of /stats)
  [`/${SLUG}/stats`, 'stats'],
  [`/${SLUG}/history`, 'stats'],
  [`/${SLUG}/compare`, 'stats'],
  // Not routed yet — a follow-up pass adds /:slug/tournaments/:id under Stats.
  [`/${SLUG}/tournaments`, 'stats'],
  [`/${SLUG}/tournaments/abc-123`, 'stats'],
  // Players
  [`/${SLUG}/members`, 'players'],
  [`/${SLUG}/players/Krobs`, 'players'],
];

describe('navSectionForPath', () => {
  it.each(CASES)('%s lights the %s section and nothing else', (path, expected) => {
    const active = navSectionForPath(path, SLUG);
    expect(active).toBe(expected);
    // "and only that section" — every other nav item must read inactive.
    for (const other of SECTIONS.filter(s => s !== expected)) {
      expect(active === other).toBe(false);
    }
  });

  it.each(CASES)('%s matches identically with a trailing slash', (path, expected) => {
    expect(navSectionForPath(`${path}/`, SLUG)).toBe(expected);
  });

  it('leaves the Global (non-room) route unowned — the room nav unmounts there', () => {
    expect(navSectionForPath('/scoreboard', SLUG)).toBeNull();
    expect(navSectionForPath('/games/42', SLUG)).toBeNull();
    expect(navSectionForPath('/friends', SLUG)).toBeNull();
    expect(navSectionForPath('/', SLUG)).toBeNull();
  });

  it('does not light anything for another room’s paths', () => {
    expect(navSectionForPath('/some-other-room/stats', SLUG)).toBeNull();
    // Prefix collision: a slug that merely starts with ours is a different room.
    expect(navSectionForPath(`/${SLUG}-two/stats`, SLUG)).toBeNull();
  });

  it('returns null for unrecognised room sub-paths rather than guessing', () => {
    expect(navSectionForPath(`/${SLUG}/nope`, SLUG)).toBeNull();
    // /players/:name lights Players, but bare /players is not a route.
    expect(navSectionForPath(`/${SLUG}/players`, SLUG)).toBeNull();
  });

  it('returns null when the slug is undefined (route not yet resolved)', () => {
    expect(navSectionForPath(`/${SLUG}/stats`, undefined)).toBeNull();
  });
});
