import { useContext, useId, useState, type ReactNode } from 'react';
import { ChevronRight, Moon, Sun, SunMoon } from 'lucide-react';
import Button from '../parts/Button';
import { THEMES, type Appearance } from '../ThemeProvider';
import { THEME_IDS, type ThemeId } from '../../lib/themeIds';
import { SettingRow, Segmented, Switch, Stepper, Slider, SelectWell, Section } from './controls';
import {
  ART_CHOICES, ART_KEYS, DESKTOP_LAYOUT_CHOICES, MOBILE_LAYOUT_CHOICES, ON_OFF_CHOICES, QR_POSITION_CHOICES,
  RANGES, RANKINGS_POSITION_CHOICES, RANKINGS_STYLE_CHOICES, SHOWCASE_CHOICES, SHOWN_CHOICES, STYLE_CHOICES,
  TITLE_STYLE_CHOICES, CardSetContext, artOf, artWrite, labelOf, logoShown, moreSummary, percent, qrOn, rowChanged,
    type CardModel, type Choice,
} from './model';

/**
 * G34a - the Display settings panel's three sections: Colours (every device),
 * Cards (this device, every room) and More (the rarely used card settings).
 * The panel (`DisplaySettingsPanel.tsx`) owns the state and the saving; these
 * draw it.
 */

const APPEARANCE_CHOICES: readonly Choice[] = [
    { value: 'dark', label: 'Dark' },
    { value: 'light', label: 'Light' },
    { value: 'auto', label: 'Auto' },
];
const APPEARANCE_ICONS = {
    dark: <Moon aria-hidden="true" />,
    light: <Sun aria-hidden="true" />,
    auto: <SunMoon aria-hidden="true" />,
};

/** The no-class default is `dark`; every other id is a `.theme-<id>` class (as on the style guide). */
function themeScopeClass(id: ThemeId): string {
    return `sb-theme-scope${id !== 'dark' ? ` theme-${id}` : ''}`;
}

function ThemeTile({ id, name, pressed, onPick }: { id: ThemeId; name: string; pressed: boolean; onPick: () => void }) {
    return (
        <button type="button" className="dset-tile" aria-pressed={pressed} onClick={onPick} data-theme={id}>
            <span className={`dset-swatch ${themeScopeClass(id)}`} aria-hidden="true"><i /><i /><i /><i /></span>
            <span className="dset-tile__name">{name}</span>
        </button>
    );
}

export interface ColoursProps {
    headingId: string;
    appearance: Appearance;
    onAppearance: (next: Appearance) => void;
    /** Set when picking a theme switched Appearance to Auto: the line under Appearance names it. */
    switchedFor: ThemeId | null;
    /** On a room page: the room's own theme, for its tile's colours. */
    roomTheme: ThemeId;
    roomScoped: boolean;
    roomName?: string;
    /** "Use it": `room` = only in this room. Null hides the row (off room pages, or the room not known yet). */
    scope: 'everywhere' | 'room' | null;
    onScope: (next: 'everywhere' | 'room') => void;
    /** The selected tile for the scope: a theme, or null for the room's own. */
    selected: ThemeId | null;
    onPick: (theme: ThemeId | null) => void;
    /** On a global page: themes do not show here, only Appearance. */
    globalPage: boolean;
    floorOn: boolean;
    highContrast: boolean;
    onFloor: (on: boolean) => void;
}

export function ColoursSection(p: ColoursProps) {
    const roomOwnLabel = p.roomScoped ? "Room's own" : "Each room's own";
    return (
        <Section title="Colours" caption="all my devices" id={p.headingId}>
            <SettingRow label="Appearance" help={p.switchedFor ? `Switched to Auto so ${THEMES[p.switchedFor].label} can show.` : undefined}>
                <Segmented
                    label="Appearance"
                    value={p.appearance}
                    choices={APPEARANCE_CHOICES}
                    icons={APPEARANCE_ICONS}
                    onChange={v => p.onAppearance(v as Appearance)}
                />
            </SettingRow>
            <SettingRow label="Theme" kind="wide">
                <div className="dset-tiles dset-tiles--3" role="group" aria-label="Theme" data-testid="theme-tiles">
                    <ThemeTile id={p.roomTheme} name={roomOwnLabel} pressed={p.selected === null} onPick={() => p.onPick(null)} />
                    {THEME_IDS.map(id => (
                        <ThemeTile key={id} id={id} name={THEMES[id].label} pressed={p.selected === id} onPick={() => p.onPick(id)} />
                    ))}
                </div>
                {p.globalPage && (
                    <p className="dset-note dset-note--faint">Shows in game rooms and admin pages. This page follows Appearance only.</p>
                )}
            </SettingRow>
            {p.scope && (
                <SettingRow label="Use it">
                    <Segmented
                        label="Use it"
                        value={p.scope}
                        choices={[
                            { value: 'everywhere', label: 'Everywhere' },
                            { value: 'room', label: `Only in ${p.roomName ?? 'this room'}` },
                        ]}
                        onChange={v => p.onScope(v as 'everywhere' | 'room')}
                    />
                </SettingRow>
            )}
            <SettingRow
                label="Carpet floor"
                kind="switch"
                help={`A faint arcade-carpet pattern behind the page.${p.highContrast ? ' High contrast never shows it.' : ''}`}
            >
                <Switch label="Carpet floor" checked={p.floorOn} onChange={p.onFloor} />
            </SettingRow>
        </Section>
    );
}

/** A row for one choice the viewer may set, with the room's value beside it. */
function ChoiceRow({ model, label, keys, mine, room, choices, onChange, select = false, help }: {
    model: CardModel;
    label: string;
    keys: readonly string[];
    mine: string;
    room: string;
    choices: readonly Choice[];
    onChange: (value: string) => void;
    select?: boolean;
    help?: ReactNode;
}) {
    const set = useContext(CardSetContext);
    const changed = rowChanged(model.prefs, keys, mine, room);
    const reset = () => set(Object.fromEntries(keys.map(k => [k, null])));
    return (
        <SettingRow label={label} help={help} changed={changed} roomText={labelOf(choices, room)} onReset={reset}>
            {select
                ? <SelectWell label={label} value={mine} choices={choices} onChange={onChange} />
                : <Segmented label={label} value={mine} choices={choices} onChange={onChange} />}
        </SettingRow>
    );
}

function SwitchRow({ model, label, keyName, mine, room, help }: {
    model: CardModel;
    label: string;
    keyName: string;
    mine: boolean;
    room: boolean;
    help?: ReactNode;
}) {
    const set = useContext(CardSetContext);
    const changed = rowChanged(model.prefs, [keyName], String(mine), String(room));
    return (
        <SettingRow
            label={label}
            kind="switch"
            help={help}
            changed={changed}
            roomText={room ? 'On' : 'Off'}
            onReset={() => set({ [keyName]: null })}
        >
            <Switch label={label} checked={mine} onChange={next => set({ [keyName]: next ? 'true' : 'false' })} />
        </SettingRow>
    );
}

function StepperRow({ model, label, keyName, mine, room, range, format = String }: {
    model: CardModel;
    label: string;
    keyName: string;
    mine: number;
    room: number;
    range: { min: number; max: number; step: number };
    format?: (n: number) => string;
}) {
    const set = useContext(CardSetContext);
    const changed = rowChanged(model.prefs, [keyName], String(mine), String(room));
    return (
        <SettingRow label={label} changed={changed} roomText={format(room)} onReset={() => set({ [keyName]: null })}>
            <Stepper
                label={label}
                value={mine}
                min={range.min}
                max={range.max}
                step={range.step}
                format={format}
                onChange={n => set({ [keyName]: String(n) })}
            />
        </SettingRow>
    );
}

function SliderRow({ model, label, keyName, mine, room, range, format, toStored = String }: {
    model: CardModel;
    label: string;
    keyName: string;
    mine: number;
    room: number;
    range: { min: number; max: number; step: number };
    format: (n: number) => string;
    toStored?: (n: number) => string;
}) {
    const set = useContext(CardSetContext);
    const changed = rowChanged(model.prefs, [keyName], format(mine), format(room));
    return (
        <SettingRow label={label} changed={changed} roomText={format(room)} onReset={() => set({ [keyName]: null })}>
            <Slider
                label={label}
                value={mine}
                min={range.min}
                max={range.max}
                step={range.step}
                format={format}
                onChange={n => set({ [keyName]: toStored(n) })}
            />
        </SettingRow>
    );
}

const px = (n: number) => `${n} px`;
const rows = (n: number) => `${n} rows`;
const fontSize = (n: number) => (n === 0 ? 'Auto' : `${n} px`);

/** The card settings everyone reaches for: style, art, scores, layout and size. */
export function CardsSection({ model, headingId, showHead = true, notOnScoreboard, onOpenScoreboard }: {
    model: CardModel;
    headingId: string;
    showHead?: boolean;
    /** On another room page: a first row says where these show, with a way there. */
    notOnScoreboard: boolean;
    onOpenScoreboard: () => void;
}) {
    const set = useContext(CardSetContext);
    const { mine, room, device } = model;
    const body = (
        <>
            {notOnScoreboard && (
                <div className="dset-row dset-row--switch" data-testid="not-on-scoreboard">
                    <p className="dset-note">These show on the Scoreboard.</p>
                    <Button variant="secondary" size="sm" className="min-h-11 px-3" onClick={onOpenScoreboard}>Open the Scoreboard</Button>
                </div>
            )}
            <SettingRow
                label="Card style"
                kind="wide"
                changed={rowChanged(model.prefs, ['SCOREBOARD_STYLE'], mine.style, room.style)}
                roomText={labelOf(STYLE_CHOICES, room.style)}
                onReset={() => set({ SCOREBOARD_STYLE: null })}
            >
                <div className="dset-tiles dset-tiles--2" role="group" aria-label="Card style">
                    {STYLE_CHOICES.map(s => (
                        <button
                            key={s.value}
                            type="button"
                            className="dset-tile dset-tile--style"
                            aria-pressed={mine.style === s.value}
                            onClick={() => { if (mine.style !== s.value) set({ SCOREBOARD_STYLE: s.value }); }}
                        >
                            <span className="dset-tile__name">{s.label}</span>
                            <span className="dset-tile__cap">{s.caption}</span>
                        </button>
                    ))}
                </div>
            </SettingRow>
            {mine.style === 'showcase' && (
                <SettingRow
                    label="Showcase colours"
                    kind="wide"
                    changed={rowChanged(model.prefs, ['SCOREBOARD_THEME'], mine.theme, room.theme)}
                    roomText={labelOf(SHOWCASE_CHOICES, room.theme)}
                    onReset={() => set({ SCOREBOARD_THEME: null })}
                >
                    <div className="dset-tiles dset-tiles--2" role="group" aria-label="Showcase colours">
                        {SHOWCASE_CHOICES.map(t => (
                            <button
                                key={t.value}
                                type="button"
                                className="dset-tile dset-tile--style"
                                aria-pressed={mine.theme === t.value}
                                onClick={() => { if (mine.theme !== t.value) set({ SCOREBOARD_THEME: t.value }); }}
                            >
                                <span className="dset-tile__name">{t.label}</span>
                                {t.caption && <span className="dset-tile__cap">{t.caption}</span>}
                            </button>
                        ))}
                    </div>
                </SettingRow>
            )}
            <ChoiceRow
                model={model}
                label="Game art"
                keys={ART_KEYS}
                mine={artOf(mine)}
                room={artOf(room)}
                choices={ART_CHOICES}
                onChange={v => set(artWrite(v))}
            />
            <StepperRow model={model} label="Scores per card" keyName="SCOREBOARD_MAX_SCORES" mine={mine.maxScores} room={room.maxScores} range={RANGES.maxScores} />
            {device === 'desktop' ? (
                <>
                    <ChoiceRow
                        model={model}
                        label="Layout"
                        keys={['SCOREBOARD_LAYOUT']}
                        mine={mine.layout}
                        room={room.layout}
                        choices={DESKTOP_LAYOUT_CHOICES}
                        onChange={v => set({ SCOREBOARD_LAYOUT: v })}
                    />
                    <SliderRow
                        model={model}
                        label="Zoom"
                        keyName="SCOREBOARD_ZOOM"
                        mine={mine.zoom}
                        room={room.zoom}
                        range={RANGES.zoom}
                        format={percent}
                    />
                </>
            ) : (
                <>
                    <ChoiceRow
                        model={model}
                        label="Layout"
                        keys={['SCOREBOARD_MOBILE_VERTICAL']}
                        mine={String(mine.mobileVertical)}
                        room={String(room.mobileVertical)}
                        choices={MOBILE_LAYOUT_CHOICES}
                        onChange={v => set({ SCOREBOARD_MOBILE_VERTICAL: v })}
                    />
                    <SliderRow
                        model={model}
                        label="Card size"
                        keyName="SCOREBOARD_MOBILE_SCALE"
                        mine={mine.mobileScale}
                        room={room.mobileScale}
                        range={RANGES.mobileScale}
                        format={n => percent(n * 100)}
                        toStored={n => String(Math.round(n * 100) / 100)}
                    />
                </>
            )}
        </>
    );
    if (!showHead) return <div className="dset-sec">{body}</div>;
    return (
        <Section title="Cards" caption={device === 'desktop' ? 'this computer, every room' : 'this phone, every room'} id={headingId}>
            {body}
        </Section>
    );
}

/** The rarely used card settings. */
export function MoreRows({ model }: { model: CardModel }) {
    const set = useContext(CardSetContext);
    const { mine, room, mineRaw, roomRaw, device } = model;
    const ticker = mine.rankingsStyle === 'ticker';
    const qr = qrOn(mine);
    return (
        <>
            <h4 className="dset-sub">Cards and header</h4>
            <ChoiceRow
                model={model}
                label="Room title"
                keys={['SCOREBOARD_TITLE_HIDDEN']}
                mine={mine.titleHidden ? 'hidden' : 'shown'}
                room={room.titleHidden ? 'hidden' : 'shown'}
                choices={SHOWN_CHOICES}
                onChange={v => set({ SCOREBOARD_TITLE_HIDDEN: v === 'hidden' ? 'true' : 'false' })}
            />
            <ChoiceRow
                model={model}
                label="Room logo"
                keys={['SCOREBOARD_LOGO_ENABLED']}
                mine={logoShown(mineRaw) ? 'shown' : 'hidden'}
                room={logoShown(roomRaw) ? 'shown' : 'hidden'}
                choices={SHOWN_CHOICES}
                onChange={v => set({ SCOREBOARD_LOGO_ENABLED: v === 'shown' ? 'true' : 'false' })}
            />
            <SwitchRow model={model} label="Hide empty games" keyName="SCOREBOARD_HIDE_EMPTY" mine={mine.hideEmpty} room={room.hideEmpty} help="Leave out tables nobody has played yet." />
            <SwitchRow model={model} label="Countdown timer" keyName="SCOREBOARD_SHOW_TIMER" mine={mine.showTimer} room={room.showTimer} help="The time left on each card." />
            <ChoiceRow
                model={model}
                label="Game title style"
                keys={['SCOREBOARD_GAME_TITLE_STYLE']}
                mine={mine.gameTitleStyle}
                room={room.gameTitleStyle}
                choices={TITLE_STYLE_CHOICES}
                onChange={v => set({ SCOREBOARD_GAME_TITLE_STYLE: v })}
                select
            />
            <StepperRow model={model} label="Card spacing" keyName="SCOREBOARD_CARD_SPACING" mine={mine.cardSpacing} room={room.cardSpacing} range={RANGES.cardSpacing} format={px} />
            <StepperRow model={model} label="Min card height" keyName="SCOREBOARD_MIN_SCORES" mine={mine.minScores} room={room.minScores} range={RANGES.minScores} format={rows} />
            <StepperRow model={model} label="Title font size" keyName="SCOREBOARD_TITLE_FONT_SIZE" mine={mine.titleFontSize} room={room.titleFontSize} range={RANGES.titleFontSize} format={fontSize} />

            <h4 className="dset-sub">Rankings</h4>
            {ticker ? (
                <p className="dset-note dset-note--faint">Ticker pins to the top, so position doesn't apply.</p>
            ) : (
                <ChoiceRow
                    model={model}
                    label="Position"
                    keys={['SCOREBOARD_RANKINGS_POSITION']}
                    mine={mine.rankingsPosition}
                    room={room.rankingsPosition}
                    choices={RANKINGS_POSITION_CHOICES}
                    onChange={v => set({ SCOREBOARD_RANKINGS_POSITION: v })}
                    select
                />
            )}
            <ChoiceRow
                model={model}
                label="Rankings style"
                keys={['SCOREBOARD_RANKINGS_STYLE']}
                mine={mine.rankingsStyle}
                room={room.rankingsStyle}
                choices={RANKINGS_STYLE_CHOICES}
                onChange={v => set({ SCOREBOARD_RANKINGS_STYLE: v })}
                select
            />
            <SwitchRow
                model={model}
                label="Always visible"
                keyName="SCOREBOARD_RANKINGS_STICKY"
                mine={mine.rankingsSticky}
                room={room.rankingsSticky}
                help="Keep the rankings beside the cards instead of among them."
            />

            {device === 'desktop' && (
                <>
                    <h4 className="dset-sub">QR codes</h4>
                    <ChoiceRow
                        model={model}
                        label="QR codes"
                        keys={['SCOREBOARD_QR_MODE']}
                        mine={qr ? 'on' : 'off'}
                        room={qrOn(room) ? 'on' : 'off'}
                        choices={ON_OFF_CHOICES}
                        onChange={v => set({ SCOREBOARD_QR_MODE: v === 'on' ? 'all' : 'disabled' })}
                        help="A code on each card to open it on a phone."
                    />
                    {qr && (
                        <>
                            <StepperRow model={model} label="QR size" keyName="SCOREBOARD_QR_SIZE" mine={mine.qrSize} room={room.qrSize} range={RANGES.qrSize} format={px} />
                            <ChoiceRow
                                model={model}
                                label="QR position"
                                keys={['SCOREBOARD_QR_POSITION']}
                                mine={mine.qrPosition}
                                room={room.qrPosition}
                                choices={QR_POSITION_CHOICES}
                                onChange={v => set({ SCOREBOARD_QR_POSITION: v })}
                            />
                            <StepperRow model={model} label="QR offset" keyName="SCOREBOARD_QR_OFFSET_PX" mine={mine.qrOffsetPx} room={room.qrOffsetPx} range={RANGES.qrOffset} format={px} />
                        </>
                    )}
                </>
            )}
        </>
    );
}

/** More as a collapsed row (on a computer): its summary lists what is inside; it opens in place. */
export function MoreSection({ model }: { model: CardModel }) {
    const [open, setOpen] = useState(false);
    const id = useId();
    return (
        <div className="dset-more">
            <button
                type="button"
                className="dset-more__btn"
                aria-expanded={open}
                aria-controls={open ? `${id}-body` : undefined}
                aria-labelledby={`${id}-title`}
                aria-describedby={`${id}-list`}
                onClick={() => setOpen(o => !o)}
            >
                <span className="dset-sec__title" id={`${id}-title`}>More</span>
                <ChevronRight aria-hidden="true" />
                <span className="dset-more__list" id={`${id}-list`}>{moreSummary(model.device)}</span>
            </button>
            {open && <div className="dset-more__body" id={`${id}-body`}><MoreRows model={model} /></div>}
        </div>
    );
}
