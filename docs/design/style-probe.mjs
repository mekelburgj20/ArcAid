// Style probe: what a page is actually built from (fonts, colours, radii, borders, glows).
// Tallies computed styles of every visible element, so two sites can be compared by numbers.
// From the repo root: node docs/design/style-probe.mjs <url> [outPng]
// (G21, docs/style-guide-plan.md)
import { chromium } from 'playwright';

const [url, out] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(e => console.log('goto:', e.message));
await page.waitForTimeout(1500);
if (out) await page.screenshot({ path: out, fullPage: false });

const report = await page.evaluate(() => {
    const tally = new Map();
    const bump = (k, v) => { const key = `${k} | ${v}`; tally.set(key, (tally.get(key) || 0) + 1); };
    const els = Array.from(document.querySelectorAll('body *')).filter(e => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    });
    for (const e of els) {
        const cs = getComputedStyle(e);
        const hasText = Array.from(e.childNodes).some(n => n.nodeType === 3 && n.textContent.trim());
        if (hasText) {
            bump('font', cs.fontFamily.split(',')[0].trim());
            bump('color', cs.color);
            if (cs.textTransform !== 'none') bump('transform', `${cs.textTransform} ls=${cs.letterSpacing} ${cs.fontFamily.split(',')[0].trim()}`);
        }
        if (cs.borderTopWidth !== '0px' && cs.borderTopStyle !== 'none') {
            bump('border', `${cs.borderTopWidth} ${cs.borderTopColor}`);
            bump('radius', cs.borderTopLeftRadius);
        }
        if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)') bump('bg', cs.backgroundColor);
        if (cs.boxShadow !== 'none') bump('shadow', cs.boxShadow.slice(0, 90));
        if (cs.textShadow !== 'none') bump('text-shadow', cs.textShadow.slice(0, 90));
    }
    const top = prefix => Array.from(tally.entries()).filter(([k]) => k.startsWith(prefix + ' |'))
        .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${n}x ${k.slice(prefix.length + 3)}`);
    const one = sel => {
        const e = document.querySelector(sel); if (!e) return null;
        const cs = getComputedStyle(e);
        return `${cs.fontFamily.split(',')[0]} ${cs.fontWeight} ${cs.fontSize} ls=${cs.letterSpacing} tt=${cs.textTransform} color=${cs.color}`;
    };
    return {
        title: document.title,
        generator: document.querySelector('meta[name=generator]')?.content ?? null,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        bodyBgImage: getComputedStyle(document.body).backgroundImage.slice(0, 300),
        h1: one('h1'), h2: one('h2'), p: one('p'), button: one('button, a[class*=btn], a[class*=button]'),
        fonts: top('font'), colors: top('color'), transforms: top('transform'),
        borders: top('border'), radii: top('radius'), bgs: top('bg'), shadows: top('shadow'), textShadows: top('text-shadow'),
        stylesheets: Array.from(document.styleSheets).map(s => s.href).filter(Boolean),
        fontLinks: Array.from(document.querySelectorAll('link[href*=font]')).map(l => l.href),
    };
});
console.log(JSON.stringify(report, null, 2));
await browser.close();
