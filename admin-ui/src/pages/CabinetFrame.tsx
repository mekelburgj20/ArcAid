import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useAwTheme } from '../lib/awTheme';
import {
    CABINET_FRAME_GLOBAL, CABINET_FRAME_READY_GLOBAL,
    type CabinetFrameInput, type CabinetFrameKind, type CabinetScreenKey,
} from '../lib/cabinetFrameTypes';
import { SAMPLE_SCREENS, sampleFor } from '../lib/cabinetFrameSamples';
import Backglass from '../components/cabinetFrame/Backglass';
import Dmd from '../components/cabinetFrame/Dmd';
import '../components/cabinetFrame/cabinetFrame.css';

/**
 * /cabinet-frame (W132.3, ADR 0046): one cabinet picture, drawn by the web
 * app's own Arcaid look so a headless browser can screenshot it.
 *
 * The renderer (src/services/CabinetFrameRenderer.ts) injects
 * `window.__CABINET_FRAME__ = { kind, screen, data }` before the page loads,
 * waits for `window.__cabinetFrameReady === true` and screenshots at exactly
 * 1920x1080 (backglass) or 1920x1200 (DMD). Without the global (a person
 * opening the URL) the page shows a sample of each screen, with a small
 * switcher (`?screen=&kind=`), so the look can be reviewed in a browser.
 *
 * Standalone like the kiosk: no layout, no auth, no data fetch. Every string
 * in the picture came from the server display-ready (names resolved), so the
 * page never sees an id.
 */

const SIZE: Record<CabinetFrameKind, { w: number; h: number; scale: number }> = {
    backglass: { w: 1920, h: 1080, scale: 0.82 },
    dmd: { w: 1920, h: 1200, scale: 1.45 },
};

const SCREEN_LABEL: Record<CabinetScreenKey, string> = {
    attract: 'Attract', card: 'Card', global: 'Global', standings: 'Standings', activity: 'Activity', event: 'Event', pair: 'Pair',
};

declare global {
    interface Window {
        __CABINET_FRAME__?: CabinetFrameInput;
        __cabinetFrameReady?: boolean;
    }
}

/** Every picture the frame draws: from the data (art paths) and from the DOM (the badge). */
function frameImageUrls(input: CabinetFrameInput): string[] {
    const urls: Array<string | null | undefined> = [];
    switch (input.screen) {
        case 'card': case 'global': case 'event': urls.push(input.data.artUrl); break;
        case 'activity': for (const i of input.data.items) urls.push(i.artUrl); break;
        default: break;
    }
    document.querySelectorAll('img').forEach(i => urls.push(i.currentSrc || i.src));
    return Array.from(new Set(urls.filter((u): u is string => !!u)));
}

function loadImage(url: string, settleMs: number): Promise<void> {
    return new Promise(resolve => {
        const im = new Image();
        const done = () => resolve();
        im.onload = done;
        im.onerror = done; // a picture that fails still lets the frame be drawn (without it)
        im.src = url;
        setTimeout(done, settleMs);
    });
}

function sheetsLoaded(settleMs: number): Promise<void> {
    const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet]'));
    return Promise.all(links.map(l => (l.sheet ? Promise.resolve() : new Promise<void>(res => {
        l.addEventListener('load', () => res());
        l.addEventListener('error', () => res());
        setTimeout(res, settleMs);
    })))).then(() => undefined);
}

const nextFrame = () => new Promise<void>(res => requestAnimationFrame(() => res()));

/**
 * `window.__cabinetFrameReady = true` once the kit stylesheets, the fonts and
 * every image have loaded (or failed). `settleMs` caps each wait; tests pass 0
 * because jsdom never fires a load event.
 */
function useFrameReady(input: CabinetFrameInput, settleMs: number): void {
    useEffect(() => {
        let live = true;
        const w = window as unknown as Record<string, unknown>;
        w[CABINET_FRAME_READY_GLOBAL] = false;
        (async () => {
            await sheetsLoaded(settleMs);
            // The faces are requested when the text is laid out: let it lay out, then name them.
            await nextFrame();
            await nextFrame();
            const fonts = document.fonts;
            if (fonts?.load) {
                await Promise.all(['900 40px Orbitron', '700 40px Orbitron', '400 40px Audiowide', '500 40px "Chakra Petch"', '700 40px "Chakra Petch"']
                    .map(f => fonts.load(f).catch(() => []))).catch(() => undefined);
            }
            await fonts?.ready;
            await Promise.all(frameImageUrls(input).map(u => loadImage(u, settleMs || 0)));
            await nextFrame();
            if (live) w[CABINET_FRAME_READY_GLOBAL] = true;
        })().catch(() => { if (live) w[CABINET_FRAME_READY_GLOBAL] = true; });
        return () => { live = false; };
    }, [input, settleMs]);
}

function readInjected(): CabinetFrameInput | null {
    const g = (window as unknown as Record<string, unknown>)[CABINET_FRAME_GLOBAL];
    if (g && typeof g === 'object' && 'screen' in g && 'kind' in g && 'data' in g) return g as CabinetFrameInput;
    return null;
}

function queryChoice(): { screen: CabinetScreenKey; kind: CabinetFrameKind } {
    const q = new URLSearchParams(window.location.search);
    const s = q.get('screen') as CabinetScreenKey | null;
    const k = q.get('kind');
    return {
        screen: s && SAMPLE_SCREENS.includes(s) ? s : 'card',
        kind: k === 'dmd' ? 'dmd' : 'backglass',
    };
}

function Frame({ input }: { input: CabinetFrameInput }) {
    const size = SIZE[input.kind] ?? SIZE.backglass;
    // The kit's sizes are resolved at :root, so its scale is set there.
    useLayoutEffect(() => {
        const root = document.documentElement;
        const prev = root.style.getPropertyValue('--aw-scale');
        root.style.setProperty('--aw-scale', String(size.scale));
        return () => { if (prev) root.style.setProperty('--aw-scale', prev); else root.style.removeProperty('--aw-scale'); };
    }, [size.scale]);
    return (
        <div
            className="cf-root aw-screen aw-screen--arcaid"
            data-testid="cabinet-frame"
            data-kind={input.kind}
            data-screen={input.screen}
            style={{ width: size.w, height: size.h }}
        >
            <div className="cf-stage">
                {input.kind === 'dmd' ? <Dmd input={input} /> : <Backglass input={input} />}
            </div>
        </div>
    );
}

export default function CabinetFrame({ settleMs = 10000 }: { settleMs?: number }) {
    useAwTheme();
    const [injected] = useState(readInjected);
    const [choice, setChoice] = useState(queryChoice);
    const input = useMemo(() => injected ?? sampleFor(choice.screen, choice.kind), [injected, choice]);
    const [fit, setFit] = useState(1);

    useEffect(() => {
        const prevTitle = document.title;
        document.title = 'Cabinet frame';
        const { overflow, margin } = document.body.style;
        document.body.style.margin = '0';
        if (injected) document.body.style.overflow = 'hidden';
        return () => { document.title = prevTitle; document.body.style.overflow = overflow; document.body.style.margin = margin; };
    }, [injected]);

    // A person's browser window is smaller than a cabinet screen: scale the picture down to fit.
    useEffect(() => {
        if (injected) return;
        const update = () => setFit(Math.min(1, window.innerWidth / SIZE[input.kind].w));
        update();
        window.addEventListener('resize', update);
        return () => window.removeEventListener('resize', update);
    }, [injected, input.kind]);

    useFrameReady(input, settleMs);

    const pick = (next: Partial<typeof choice>) => {
        const n = { ...choice, ...next };
        setChoice(n);
        const q = new URLSearchParams(window.location.search);
        q.set('screen', n.screen);
        q.set('kind', n.kind);
        window.history.replaceState(null, '', `${window.location.pathname}?${q.toString()}`);
    };

    if (injected) return <Frame input={input} />;

    const { w, h } = SIZE[input.kind];
    return (
        <div data-testid="cabinet-frame-sample">
            <div className="cf-sample-bar" role="toolbar" aria-label="Sample screens">
                <span>Sample data. Pick a screen:</span>
                {SAMPLE_SCREENS.map(s => (
                    <button key={s} type="button" aria-pressed={choice.screen === s} onClick={() => pick({ screen: s })}>{SCREEN_LABEL[s]}</button>
                ))}
                <span aria-hidden="true">|</span>
                {(['backglass', 'dmd'] as const).map(k => (
                    <button key={k} type="button" aria-pressed={choice.kind === k} onClick={() => pick({ kind: k })}>
                        {k === 'dmd' ? 'DMD' : 'Backglass'}
                    </button>
                ))}
            </div>
            <div style={{ paddingTop: 48, width: w * fit, height: h * fit + 48, overflow: 'hidden' }}>
                <div style={{ width: w, height: h, transform: `scale(${fit})`, transformOrigin: 'top left' }}>
                    <Frame input={input} />
                </div>
            </div>
        </div>
    );
}
