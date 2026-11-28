import type { CabinetFrameInput, CabinetFrameKind, CabinetScreenKey } from './cabinetFrameTypes';

/**
 * Sample data for /cabinet-frame when a person opens the URL (no renderer
 * injected the real frame). Shaped by the contract, same words as the Display
 * Lab's studio so the look can be reviewed in a browser. No art URLs: the
 * pictures are the catalogue's, which a bare page does not know.
 */

export const SAMPLE_SCREENS: readonly CabinetScreenKey[] =
    ['attract', 'card', 'global', 'standings', 'activity', 'event', 'pair'];

type Sample = (kind: CabinetFrameKind) => CabinetFrameInput;

const row = (rank: string, name: string, score: string, me = false, region?: string) => ({ rank, name, score, me, ...(region ? { region } : {}) });

const SAMPLES: Record<CabinetScreenKey, Sample> = {
    attract: kind => ({
        kind, screen: 'attract',
        data: { player: 'JUSTIN', sendingTo: 'Mox Game Room + 2 rooms', lastScore: { table: 'AC/DC', value: '1,234,560', rankText: '3rd of 14' }, openCount: 7 },
    }),
    card: kind => ({
        kind, screen: 'card',
        data: {
            roomName: 'MOX GAME ROOM', kindLabel: 'WEEKLY', table: 'AC/DC', artUrl: null,
            endsText: 'ENDS IN 2D 4H', attemptsText: '2 OF 3 ATTEMPTS LEFT', practice: false,
            rows: [row('1', 'MIKE', '2,940,110'), row('2', 'SAM', '1,445,010'), row('3', 'JUSTIN', '1,234,560', true), row('4', 'KEVIN', '1,102,300'), row('5', 'DANA', '987,420')],
            playersText: '14 PLAYERS', footerRight: 'YOU NEED 210,450 FOR 2ND',
        },
    }),
    global: kind => ({
        kind, screen: 'global',
        data: {
            table: 'AC/DC', artUrl: null, playersText: '212 PLAYERS, EVERY ROOM',
            rows: [row('1', 'PINWIZARD', '48,220,940', false, 'US TX'), row('2', 'TILTMASTER', '41,005,300', false, 'CA ON'), row('3', 'MIKE', '39,880,120', false, 'US MN'),
                row('4', 'LOOPSHOT', '35,412,770', false, 'GB'), row('14', 'JUSTIN', '18,402,660', true, 'US MN')],
            footerRight: 'YOU ARE #14 OF 212',
        },
    }),
    standings: kind => ({
        kind, screen: 'standings',
        data: {
            roomName: 'MOX GAME ROOM', title: 'SEASON 6', subtitle: 'WEEK 3 OF 8',
            rows: [row('1', 'MIKE', '2,410'), row('2', 'JUSTIN', '2,180', true), row('3', 'SAM', '2,040'), row('4', 'KEVIN', '1,870'), row('5', 'DANA', '1,640'),
                row('6', 'RHYS', '1,520'), row('7', 'ALEX', '1,330'), row('8', 'PRIYA', '1,105'), row('9', 'TOM', '980'), row('10', 'LEE', '760')],
            footerLeft: 'POINTS FROM 7 TABLES', footerRight: 'YOU: 2ND, 230 BEHIND MIKE',
        },
    }),
    activity: kind => ({
        kind, screen: 'activity',
        data: {
            roomCountText: '3 ROOMS',
            items: [
                { whenText: 'NOW', text: 'Mike took 1st on Medieval Madness', roomName: 'MOX', artUrl: null, hot: true },
                { whenText: '4 MIN', text: 'Sam passed you on AC/DC: you are 3rd', roomName: 'MOX', artUrl: null, hot: true },
                { whenText: '22 MIN', text: 'Twilight Zone is the new Weekly table', roomName: 'MOX', artUrl: null, hot: false },
                { whenText: '1 HR', text: 'Dana checked in for the Throwdown', roomName: 'FNT', artUrl: null, hot: false },
                { whenText: '3 HR', text: 'Kevin posted 88,410,200 on Attack from Mars', roomName: 'PINHEADS', artUrl: null, hot: false },
            ],
        },
    }),
    event: kind => ({
        kind, screen: 'event',
        data: {
            eventName: 'FRIDAY NIGHT THROWDOWN', stateLabel: 'STARTS SOON', roundLabel: 'ROUND 2', table: 'TWILIGHT ZONE', artUrl: null,
            startText: '8:30 PM', endText: '9:00 PM', checkedIn: true,
            footerLeft: 'AFTER ROUND 1: YOU ARE 4TH OF 11', footerRight: '16 PLAYERS CHECKED IN',
        },
    }),
    pair: kind => ({ kind, screen: 'pair', data: { code: 'K7Q4MX', url: 'https://arcaid.app/pair/K7Q4MX' } }),
};

export function sampleFor(screen: CabinetScreenKey, kind: CabinetFrameKind): CabinetFrameInput {
    return SAMPLES[screen](kind);
}
