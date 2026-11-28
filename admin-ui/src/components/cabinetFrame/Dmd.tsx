import type { CSSProperties, ReactNode } from 'react';
import { CABINET_DMD_DOT_RECT, type CabinetFrameInput } from '../../lib/cabinetFrameTypes';
import { FitTitle } from './shared';
import { artStyle, nameOf } from './helpers';

/**
 * The DMD pictures (1920x1200), ported from the Display Lab's studio.html. The
 * dot window is an empty framed box at CABINET_DMD_DOT_RECT: the cabinet draws
 * the live dots there (countdowns, tickers, the dot logo). `pair` has none.
 */

const BADGE_SVG = '/aw-theme/assets/logo/arcaid-witness-badge.svg';

const R = CABINET_DMD_DOT_RECT;
const DotsBox = () => (
    <div className="cf-dots" data-testid="cf-dots" style={{ left: R.x, top: R.y, width: R.w, height: R.h }} />
);

function Head({ label, title, titleStyle }: { label: string; title: string; titleStyle?: CSSProperties }) {
    return (
        <div className="cf-dmd-head">
            <div className="aw-label">{label}</div>
            <FitTitle className="aw-title cf-glass cf-dmd-title" base="calc(88 * var(--u))" style={titleStyle}>{title}</FitTitle>
        </div>
    );
}

const Foot = ({ children }: { children: ReactNode }) => <div className="cf-dmd-foot">{children}</div>;

function ArtBack({ artUrl }: { artUrl: string | null }) {
    return (
        <>
            <div className="cf-art" style={artStyle(artUrl)} />
            <div className="cf-scrim cf-scrim--dmd" />
        </>
    );
}

export default function Dmd({ input }: { input: CabinetFrameInput }) {
    switch (input.screen) {
        case 'card': {
            const d = input.data;
            const attempts = d.practice ? (d.attemptsText || 'PRACTICE') : d.attemptsText;
            return (
                <>
                    <ArtBack artUrl={d.artUrl} />
                    <Head label={`${d.roomName} · ${d.kindLabel}`} title={d.table} />
                    <DotsBox />
                    <Foot>
                        {attempts && <span className={`aw-chip aw-chip--attention${d.practice ? ' cf-chip--loud' : ''}`}>{attempts}</span>}
                        {d.endsText && <span className="aw-chip aw-chip--neutral">{d.endsText}</span>}
                    </Foot>
                </>
            );
        }
        case 'global': {
            const d = input.data;
            return (
                <>
                    <ArtBack artUrl={d.artUrl} />
                    <Head label="GLOBAL SCOREBOARD" title={d.table} />
                    <DotsBox />
                    <Foot><span className="aw-chip">{d.playersText}</span></Foot>
                </>
            );
        }
        case 'event': {
            const d = input.data;
            return (
                <>
                    <ArtBack artUrl={d.artUrl} />
                    <Head label={d.eventName} title={d.roundLabel} titleStyle={{ color: 'var(--aw-pink)' }} />
                    <DotsBox />
                    <Foot>
                        <span className="aw-chip">{d.table}</span>
                        {d.checkedIn && <span className="aw-chip aw-chip--neutral">YOU ARE CHECKED IN</span>}
                    </Foot>
                </>
            );
        }
        case 'standings': {
            const d = input.data;
            return (
                <>
                    <Head label={d.roomName} title={d.title} />
                    <DotsBox />
                    <Foot>
                        <span className="aw-chip">{d.footerRight}</span>
                        {d.subtitle && <span className="aw-chip aw-chip--neutral">{d.subtitle}</span>}
                    </Foot>
                </>
            );
        }
        case 'activity': {
            const d = input.data;
            const first = d.items[0];
            return (
                <>
                    <Head label={d.roomCountText} title="LATELY" />
                    <DotsBox />
                    <Foot>{first && <span className="aw-chip aw-chip--attention">{first.whenText}</span>}</Foot>
                </>
            );
        }
        case 'attract': {
            const d = input.data;
            return (
                <>
                    <div style={{ position: 'absolute', left: 0, right: 0, top: 40, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 36 }}>
                        <img src={BADGE_SVG} alt="" style={{ width: 230, height: 230 }} />
                        <div className="aw-brand" style={{ fontSize: 'calc(96 * var(--u))' }}>ARCAID<span className="aw-brand__sub">WITNESS</span></div>
                    </div>
                    <DotsBox />
                    <Foot>
                        <span className="aw-chip">WITNESS ON</span>
                        {d.player && <span className="aw-chip aw-chip--neutral">PLAYING AS {nameOf(d.player)}</span>}
                    </Foot>
                </>
            );
        }
        case 'pair': {
            const d = input.data;
            return (
                <div className="cf-center">
                    <div className="aw-label">PAIR THIS CABINET</div>
                    <div className="aw-score cf-pink" style={{ fontSize: 'calc(230 * var(--u))', lineHeight: 1.05, letterSpacing: '.06em' }}>{d.code}</div>
                    <div className="aw-body" style={{ marginTop: 24 }}>Type it at <b className="cf-cyan">arcaid.app/pair</b>, or scan the code above</div>
                </div>
            );
        }
        default: return null;
    }
}
