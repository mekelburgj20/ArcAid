/**
 * Cabinet frames (W132, ADR 0046): the data one backglass or DMD picture is
 * drawn from. The server builds these (src/services/CabinetFrameService.ts);
 * the /cabinet-frame page draws them (admin-ui/src/pages/CabinetFrame.tsx).
 *
 * This file exists twice, identical below this header:
 *   src/services/cabinetFrameTypes.ts  ≡  admin-ui/src/lib/cabinetFrameTypes.ts
 * Change both. Every string is display-ready (names resolved, times formatted
 * in the room's zone); the page formats nothing but layout.
 */

export type CabinetFrameKind = 'backglass' | 'dmd';

export type CabinetScreenKey = 'attract' | 'card' | 'global' | 'standings' | 'activity' | 'event' | 'pair';

/** The screens a player can switch on or off (pair is never a choice). */
export const CABINET_SCREEN_CHOICES: readonly Exclude<CabinetScreenKey, 'pair'>[] =
    ['attract', 'card', 'global', 'standings', 'activity', 'event'];

/** Bumped whenever the page's look changes, so every picture is redrawn. */
export const CABINET_FRAME_STYLE_VERSION = 1;

/** The DMD's dot window (logical px on the 1920x1200 panel, right side up). */
export const CABINET_DMD_DOT_RECT = { x: 64, y: 318, w: 1792, h: 448 } as const;

export interface CabinetBoardRow {
    rank: string;         // "1", "14"
    name: string;         // resolved label, never an id ("A PLAYER" if none)
    score: string;        // grouped: "1,234,560"
    me: boolean;          // the current player's row
    region?: string;      // global boards only: "US TX", "GB" (empty when unknown)
}

export interface CabinetAttractData {
    player: string | null;          // "JUSTIN"; null = nobody resolvable
    sendingTo: string;              // "Mox Game Room + 2 rooms", "All my rooms", "Global only"
    lastScore: { table: string; value: string; rankText: string | null } | null; // rankText "3rd of 14"
    openCount: number;
}

export interface CabinetCardData {
    roomName: string;               // "MOX GAME ROOM" ("THROWDOWN" for a room-less one)
    kindLabel: string;              // tournament name or cadence: "WEEKLY", "SEASON 6"
    table: string;                  // "AC/DC"
    artUrl: string | null;          // same-origin path: "/api/catalogue-images/..." or "/api/styles/images/..."
    endsText: string | null;        // hour-bucketed: "ENDS IN 2D 4H", "ENDS TODAY 9:00 PM"
    attemptsText: string | null;    // "2 OF 3 ATTEMPTS LEFT", "PRESS START", "PRACTICE"; null when not limited
    practice: boolean;
    rows: CabinetBoardRow[];        // top 5, plus the player's row when below
    playersText: string;            // "14 PLAYERS"
    footerRight: string;            // "YOU NEED 210,450 FOR 2ND", "NO SCORE FROM YOU YET", "YOU LEAD BY 1.2 BILLION"
}

export interface CabinetGlobalData {
    table: string;
    artUrl: string | null;
    playersText: string;            // "212 PLAYERS, EVERY ROOM"
    rows: CabinetBoardRow[];        // top 4, plus the player's row when below
    footerRight: string;            // "YOU ARE #14 OF 212", "NO GLOBAL SCORE FROM YOU YET"
}

export interface CabinetStandingsData {
    roomName: string;
    title: string;                  // ranking group name: "SEASON 6"
    subtitle: string | null;        // "WEEK 3 OF 8"
    rows: CabinetBoardRow[];        // top 10 (two columns of 5), plus the player's row when below
    footerLeft: string;             // "POINTS FROM 7 TABLES"
    footerRight: string;            // "YOU: 2ND, 230 BEHIND MIKE"
}

export interface CabinetActivityItem {
    whenText: string;               // clock time in the room's zone: "8:12 PM", "YESTERDAY"
    text: string;                   // the feed item's own title
    roomName: string;
    artUrl: string | null;          // the table's art, for the thumbnail
    hot: boolean;                   // about the current player, or within the last 15 minutes
}

export interface CabinetActivityData {
    roomCountText: string;          // "3 ROOMS"
    items: CabinetActivityItem[];   // newest first, at most 6
}

export interface CabinetEventData {
    eventName: string;
    stateLabel: string;             // "LIVE", "CHECK-IN OPEN", "STARTS SOON"
    roundLabel: string;             // "ROUND 2"
    table: string;
    artUrl: string | null;
    startText: string;              // "8:30 PM" (room zone)
    endText: string;                // "9:00 PM"
    checkedIn: boolean;
    footerLeft: string;             // "AFTER ROUND 1: YOU ARE 4TH OF 11" or ""
    footerRight: string;            // "16 PLAYERS CHECKED IN" or ""
}

export interface CabinetPairData {
    code: string;                   // "K7Q4MX"
    url: string;                    // "https://arcaid.app/pair/K7Q4MX" (the QR's content)
}

export type CabinetFrameInput =
    | { kind: CabinetFrameKind; screen: 'attract'; data: CabinetAttractData }
    | { kind: CabinetFrameKind; screen: 'card'; data: CabinetCardData }
    | { kind: CabinetFrameKind; screen: 'global'; data: CabinetGlobalData }
    | { kind: CabinetFrameKind; screen: 'standings'; data: CabinetStandingsData }
    | { kind: CabinetFrameKind; screen: 'activity'; data: CabinetActivityData }
    | { kind: CabinetFrameKind; screen: 'event'; data: CabinetEventData }
    | { kind: CabinetFrameKind; screen: 'pair'; data: CabinetPairData };

/** The global the renderer injects before the page loads. */
export const CABINET_FRAME_GLOBAL = '__CABINET_FRAME__';
/** Set to true by the page once fonts and every image have loaded. */
export const CABINET_FRAME_READY_GLOBAL = '__cabinetFrameReady';
