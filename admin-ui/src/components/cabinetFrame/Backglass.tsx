import type {
    CabinetActivityData, CabinetAttractData, CabinetCardData, CabinetEventData,
    CabinetFrameInput, CabinetGlobalData, CabinetPairData, CabinetStandingsData,
} from '../../lib/cabinetFrameTypes';
import { ArtCard, BoardRows, FitTitle, QrCode } from './shared';
import { artStyle, nameOf } from './helpers';

/**
 * The backglass pictures (1920x1080), ported from the Display Lab's
 * frames-src/studio.html. Every string is display-ready from the server: this
 * file only lays them out (ADR 0046).
 */

const BADGE_SVG = '/aw-theme/assets/logo/arcaid-witness-badge.svg';

function CardFace({ d }: { d: CabinetCardData }) {
    // PRACTICE is said loudly (attempts.md): a bigger attention chip.
    const attemptsChip = d.practice ? (d.attemptsText || 'PRACTICE') : d.attemptsText;
    return (
        <ArtCard artUrl={d.artUrl}>
            <div className="cf-head">
                <span className="aw-chip">{d.roomName}</span>
                <span className="aw-chip aw-chip--neutral">{d.kindLabel}</span>
                {attemptsChip && (
                    <span className={`aw-chip aw-chip--attention cf-push${d.practice ? ' cf-chip--loud' : ''}`}>{attemptsChip}</span>
                )}
                {d.endsText && <span className={`aw-chip aw-chip--neutral${attemptsChip ? '' : ' cf-push'}`}>{d.endsText}</span>}
            </div>
            <FitTitle className="aw-title cf-title">{d.table}</FitTitle>
            <div className="cf-board"><BoardRows rows={d.rows} /></div>
            <div className="aw-footer"><span>{d.playersText}</span><span>{d.footerRight}</span></div>
        </ArtCard>
    );
}

function GlobalFace({ d }: { d: CabinetGlobalData }) {
    return (
        <ArtCard artUrl={d.artUrl}>
            <div className="cf-head">
                <span className="aw-chip">GLOBAL SCOREBOARD</span>
                <span className="aw-chip aw-chip--neutral cf-push">{d.playersText}</span>
            </div>
            <FitTitle className="aw-title cf-title">{d.table}</FitTitle>
            <div className="cf-board cf-board--where"><BoardRows rows={d.rows} where /></div>
            <div className="aw-footer"><span>ARCAID.APP/SCOREBOARD</span><span>{d.footerRight}</span></div>
        </ArtCard>
    );
}

function EventFace({ d }: { d: CabinetEventData }) {
    const live = d.stateLabel.toUpperCase() === 'LIVE';
    // No running clock in a picture: the round's own start (or end, while live) as a clock time.
    const verb = live ? 'ENDS' : 'STARTS';
    const big = live ? d.endText : d.startText;
    return (
        <ArtCard artUrl={d.artUrl}>
            <div className="cf-head">
                {live
                    ? <span className="aw-live" style={{ marginLeft: 0 }}>LIVE</span>
                    : <span className="aw-chip aw-chip--attention">{d.stateLabel}</span>}
                <span className="aw-chip aw-chip--neutral">{d.eventName}</span>
            </div>
            <div className="cf-center cf-center--flow">
                <div className="aw-label" style={{ fontSize: 'calc(58 * var(--u))' }}>{d.roundLabel} {verb}</div>
                <div className="aw-score" style={{ fontSize: 'calc(300 * var(--u))', lineHeight: 1 }}>{big}</div>
                <FitTitle className="aw-title cf-glass cf-cyan" style={{ marginTop: 'calc(30 * var(--u))' }}>{d.table}</FitTitle>
                <div style={{ display: 'flex', gap: 24, marginTop: 'calc(10 * var(--u))' }}>
                    <span className="aw-chip aw-chip--neutral">START {d.startText}</span>
                    <span className="aw-chip aw-chip--neutral">END {d.endText}</span>
                    {d.checkedIn && <span className="aw-chip">YOU ARE CHECKED IN</span>}
                </div>
            </div>
            <div className="aw-footer"><span>{d.footerLeft}</span><span>{d.footerRight}</span></div>
        </ArtCard>
    );
}

function AttractFace({ d }: { d: CabinetAttractData }) {
    return (
        <div className="cf-attract">
            <img className="cf-badge" src={BADGE_SVG} alt="" />
            <div className="aw-panel" style={{ flex: 1 }}>
                <div className="aw-label">{d.player ? 'PLAYING AS' : 'WAITING FOR A PLAYER'}</div>
                {d.player && <div className="aw-name cf-glass" style={{ fontSize: 'calc(150 * var(--u))', lineHeight: 1 }}>{nameOf(d.player)}</div>}
                <div className="aw-chip">WITNESS ON</div>
                <hr className="aw-divider" />
                <div className="aw-body">Sending to <b>{d.sendingTo}</b></div>
                {d.lastScore && (
                    <div className="aw-body cf-mt-sm">
                        Last score <b>{d.lastScore.value}</b> on {d.lastScore.table}
                        {d.lastScore.rankText && <>, <b className="cf-cyan">{d.lastScore.rankText}</b></>}
                    </div>
                )}
                <div className="aw-body cf-mt-sm"><b>{d.openCount}</b> {d.openCount === 1 ? 'table' : 'tables'} you can post to now</div>
            </div>
        </div>
    );
}

function PairFace({ d }: { d: CabinetPairData }) {
    return (
        <div className="cf-attract" style={{ gap: 90, padding: '0 130px' }}>
            <div style={{ textAlign: 'center' }}>
                <QrCode text={d.url} size={560} />
                <div className="aw-label" style={{ marginTop: 28 }}>SCAN WITH YOUR PHONE</div>
            </div>
            <div className="aw-panel" style={{ flex: 1 }}>
                <div className="aw-title cf-glass">PAIR THIS<br />CABINET</div>
                <hr className="aw-divider" />
                <div className="aw-body">1. Scan the code, or open <b className="cf-cyan">arcaid.app/pair</b></div>
                <div className="aw-body" style={{ marginTop: 14 }}>2. Sign in to Arcaid</div>
                <div className="aw-body" style={{ marginTop: 14 }}>3. This screen switches to your rooms</div>
                <div className="aw-label" style={{ marginTop: 44 }}>OR TYPE THIS CODE</div>
                <div className="aw-score cf-pink" style={{ letterSpacing: '.08em' }}>{d.code}</div>
            </div>
        </div>
    );
}

function StandingsFace({ d }: { d: CabinetStandingsData }) {
    const left = d.rows.slice(0, 5);
    const right = d.rows.slice(5);
    return (
        <div className="cf-panel-wrap">
            <div className="aw-panel cf-panel-fill">
                <div className="cf-head">
                    <span className="aw-chip">{d.roomName}</span>
                    <span className="aw-chip aw-chip--neutral">STANDINGS</span>
                    {d.subtitle && <span className="aw-chip aw-chip--neutral cf-push">{d.subtitle}</span>}
                </div>
                <FitTitle className="aw-title cf-title" style={{ marginTop: 'calc(30 * var(--u))' }}>{d.title}</FitTitle>
                <div className="cf-board cf-cols">
                    <div><BoardRows rows={left} /></div>
                    <div><BoardRows rows={right} /></div>
                </div>
                <div className="aw-footer"><span>{d.footerLeft}</span><span>{d.footerRight}</span></div>
            </div>
        </div>
    );
}

function ActivityFace({ d }: { d: CabinetActivityData }) {
    return (
        <div className="cf-panel-wrap">
            <div className="aw-panel cf-panel-fill">
                <div className="cf-head">
                    <span className="aw-chip aw-chip--attention">LATELY IN YOUR ROOMS</span>
                    <span className="aw-chip aw-chip--neutral cf-push">{d.roomCountText}</span>
                </div>
                <div style={{ marginTop: 24 }}>
                    {d.items.map((it, i) => (
                        <div key={i} className="cf-feed-row">
                            <div className="cf-thumb" style={artStyle(it.artUrl)} />
                            <span className={`cf-when${it.hot ? ' cf-when--hot' : ''}`}>{it.whenText}</span>
                            <span className="cf-feed-text">{it.text}</span>
                            <span className="cf-feed-room">{it.roomName}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

export default function Backglass({ input }: { input: CabinetFrameInput }) {
    switch (input.screen) {
        case 'card': return <CardFace d={input.data} />;
        case 'global': return <GlobalFace d={input.data} />;
        case 'event': return <EventFace d={input.data} />;
        case 'attract': return <AttractFace d={input.data} />;
        case 'pair': return <PairFace d={input.data} />;
        case 'standings': return <StandingsFace d={input.data} />;
        case 'activity': return <ActivityFace d={input.data} />;
        default: return null;
    }
}
