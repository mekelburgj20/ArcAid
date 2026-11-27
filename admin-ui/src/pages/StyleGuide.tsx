import { useRef, useState, type MouseEvent, type ReactNode } from 'react';
import ArcaidPage from '../components/parts/ArcaidPage';
import PageShell from '../components/parts/PageShell';
import PageTitle from '../components/parts/PageTitle';
import Panel, { PanelGroup } from '../components/parts/Panel';
import JumpList, { type JumpItem } from '../components/parts/JumpList';
import Button, { ButtonLink } from '../components/parts/Button';
import { TextInput, TextArea, Select, SearchInput } from '../components/parts/Field';
import { SkeletonRows, SkeletonTiles } from '../components/parts/Skeleton';
import EmptyState from '../components/parts/EmptyState';
import { RailTabs } from '../components/parts/Tabs';
import { tabPanelProps } from '../components/parts/tabPanel';
import StatTiles from '../components/parts/StatTiles';
import { ListRows, ListRow } from '../components/parts/ListRow';
import { ConfirmDialog, Dialog } from '../components/parts/Dialog';
import type { PartTone } from '../components/parts/skin';
import RoomSwitcher, { type SwitcherCurrentRoom } from '../components/RoomSwitcher';
import { THEMES } from '../components/ThemeProvider';
import { THEME_IDS, type ThemeId } from '../lib/themeIds';
import type { MemberRoom } from '../lib/landingRooms';

/**
 * G21 - the live style guide (super admin). Every shared part, shown in the
 * fixed dark Arcaid look and in each room theme, so the look cannot drift.
 * It is built from the parts, and it iterates THEME_IDS so a new theme shows
 * up here without an edit. Nothing on it does anything: no network calls.
 */

const PAGE_JUMP: JumpItem[] = [
    { id: 'sg-looks', title: 'The two looks', tone: 'cyan' },
    { id: 'sg-arcaid', title: 'Arcaid look', tone: 'pink' },
    { id: 'sg-theme', title: "Room's theme", tone: 'violet' },
    { id: 'sg-widths', title: 'Page widths', tone: 'ice' },
    { id: 'sg-rules', title: 'Rules', tone: 'cyan' },
];

const SAMPLE_TONES: Array<{ key: string; tone: PartTone; title: string; sub: string }> = [
    { key: 'cyan', tone: 'cyan', title: 'Cyan', sub: 'The default tone.' },
    { key: 'pink', tone: 'pink', title: 'Pink', sub: 'Scores and attention.' },
    { key: 'violet', tone: 'violet', title: 'Violet', sub: 'Accounts and devices.' },
    { key: 'ice', tone: 'ice', title: 'Ice', sub: 'Quiet groups such as notifications.' },
    { key: 'red', tone: 'red', title: 'Red', sub: 'Only for what can do harm.' },
];

const THEME_TILE_TONES: PartTone[] = ['cyan', 'pink', 'violet', 'ice'];

/** Made-up rooms for the menu sample (the logos are the site's own public images). */
const SAMPLE_ROOM: SwitcherCurrentRoom = {
    slug: 'neon_alley_pinball', name: 'Neon Alley Pinball', title: 'NEON ALLEY PINBALL',
    logoUrl: '/arcaid-icon-192-v3.png', roomId: 'sg-room-1',
};
const sampleRoom = (roomId: string, name: string, slug: string, logoUrl: string | null, lastActivityAt: string | null): MemberRoom => ({
    roomId, name, slug, logoUrl, lastActivityAt, joinedAt: '2026-01-01 12:00:00', source: 'self_join',
});
const SAMPLE_ROOMS: MemberRoom[] = [
    sampleRoom('sg-room-1', 'Neon Alley Pinball', 'neon_alley_pinball', '/arcaid-icon-192-v3.png', '2026-11-20 18:00:00'),
    sampleRoom('sg-room-2', 'Flipper Cove', 'flipper_cove', '/carpet/arcaid-carpet-motifs-a-v1.svg', '2026-11-19 21:00:00'),
    sampleRoom('sg-room-3', 'Tilt Club After Dark', 'tilt_club_after_dark', null, '2026-11-12 20:30:00'),
    sampleRoom('sg-room-4', 'The Saturday Night Silverball Society of Greater Springfield', 'saturday_silverball_society', null, null),
];

/** The sample's rooms are made up: picking one closes the menu and stays on this page. */
function stayOnPage(e: MouseEvent) {
    if ((e.target as Element).closest('a')) e.preventDefault();
}

/** The no-class dark default is `dark`; every other id is a `.theme-<id>` class (as in Leaderboard.tsx). */
function themeScopeClass(id: ThemeId): string {
    return `sb-theme-scope${id !== 'dark' ? ` theme-${id}` : ''}`;
}

function sampleJump(idPrefix: string): JumpItem[] {
    return SAMPLE_TONES.map(t => ({ id: `${idPrefix}-${t.key}`, title: t.title, tone: t.tone }));
}

function Row({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="mb-3 last:mb-0">
            <p className="text-xs text-muted mb-1.5">{label}</p>
            <div className="flex flex-wrap items-center gap-2">{children}</div>
        </div>
    );
}

function ButtonRow({ label, size, disabled }: { label: string; size: 'md' | 'sm' | 'xs'; disabled?: boolean }) {
    return (
        <Row label={label}>
            <Button variant="primary" size={size} disabled={disabled}>Primary</Button>
            <Button variant="secondary" size={size} disabled={disabled}>Secondary</Button>
            <Button variant="danger" size={size} disabled={disabled}>Danger</Button>
        </Row>
    );
}

const FIELD = 'w-full bg-surface border border-border rounded px-3 py-2 text-sm text-primary placeholder-faint focus:border-neon-cyan focus:outline-none';

/**
 * G23 - the pop-ups: the two confirms (pink for attention, red for harm) and a
 * form, a bottom sheet on a phone. They are the Arcaid look whatever is behind
 * them; nothing they offer does anything here.
 */
function PopupSamples({ idPrefix }: { idPrefix: string }) {
    const [open, setOpen] = useState<'pink' | 'red' | 'form' | 'panel' | null>(null);
    const firstField = useRef<HTMLSelectElement>(null);
    const close = () => setOpen(null);
    const id = (k: string) => `${idPrefix}-pop-${k}`;
    return (
        <Panel title="Pop-ups" wide>
            <p className="text-sm text-primary mb-2">
                The Arcaid look on every theme. Focus starts on Cancel; Escape, a press outside and the × cancel.
                On a phone a form rises from the bottom: drag its handle down to close it. A panel is not a
                modal: the page beside it stays usable, and only the × or Escape inside it closes it.
            </p>
            <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => setOpen('pink')}>Open the pink confirm</Button>
                <Button variant="secondary" onClick={() => setOpen('red')}>Open the red confirm</Button>
                <Button variant="secondary" onClick={() => setOpen('form')}>Open the form sheet</Button>
                <Button variant="secondary" onClick={() => setOpen(o => (o === 'panel' ? null : 'panel'))}>Open a panel</Button>
            </div>
            {open === 'panel' && (
                <Dialog
                    open
                    onOpenChange={next => { if (!next) close(); }}
                    panel
                    label="Panel"
                    title="Room lights"
                    description="Changes show on the page as you make them."
                    footer={<Button variant="secondary" onClick={close}>Done</Button>}
                >
                    <p className="text-sm mb-3">
                        Docked to the right on a computer, with the page beside it still bright and usable. On a phone it
                        is a sheet that rests at half height: drag its handle up for more, or down past the lowest to close it.
                    </p>
                    <label htmlFor={id('glow')} className="block text-sm font-medium mb-1.5">Glow</label>
                    <select id={id('glow')} defaultValue="soft" className={FIELD}>
                        <option value="soft">Soft</option>
                        <option value="bright">Bright</option>
                    </select>
                </Dialog>
            )}
            <ConfirmDialog
                open={open === 'pink'}
                tone="pink"
                title="Leave Neon Alley Pinball?"
                message="You can rejoin any time. Your scores stay on its boards."
                confirmLabel="Leave room"
                onCancel={close}
                onConfirm={close}
            />
            <ConfirmDialog
                open={open === 'red'}
                tone="red"
                title="Delete 12,450,330 on Attack from Mars?"
                message="The score comes off every board. This can't be undone."
                confirmLabel="Delete score"
                onCancel={close}
                onConfirm={close}
            />
            <Dialog
                open={open === 'form'}
                onOpenChange={next => { if (!next) close(); }}
                sheet
                size="md"
                label="Submit a score"
                title="Attack from Mars"
                initialFocusRef={firstField}
                footer={(
                    <>
                        <Button variant="secondary" onClick={close}>Cancel</Button>
                        <Button onClick={close}>Submit score</Button>
                    </>
                )}
            >
                <label htmlFor={id('table')} className="block text-sm font-medium mb-1.5">Table</label>
                <select ref={firstField} id={id('table')} defaultValue="afm" className={`${FIELD} mb-4`}>
                    <option value="afm">Attack from Mars</option>
                    <option value="mm">Medieval Madness</option>
                </select>
                <label htmlFor={id('score')} className="block text-sm font-medium mb-1.5">Score</label>
                <input id={id('score')} type="text" inputMode="numeric" defaultValue="12,450,330" className={`${FIELD} mb-4`} />
                <label htmlFor={id('note')} className="block text-sm font-medium mb-1.5">Note (optional)</label>
                <textarea
                    id={id('note')}
                    rows={3}
                    placeholder="Anything the room should know, like a stuck ball on the left ramp"
                    className={FIELD}
                />
            </Dialog>
        </Panel>
    );
}

function StatusWord({ dot, text, label }: { dot: string; text: string; label: string }) {
    return (
        <li className={`flex items-center gap-2 text-sm ${text}`}>
            <span className={`inline-block w-2 h-2 rounded-full ${dot}`} aria-hidden="true" />
            {label}
        </li>
    );
}

const SAMPLE_TABS = [
    { id: 'scores', label: 'Scores' },
    { id: 'tables', label: 'Tables' },
    { id: 'friends', label: 'Friends' },
    { id: 'achievements', label: 'Long tab name, all achievements' },
];

/** G23 sample: the five field kinds. */
function FieldSamples({ idPrefix }: { idPrefix: string }) {
    const id = (k: string) => `${idPrefix}-f-${k}`;
    return (
        <div className="grid gap-5">
            <TextInput id={id('name')} label="Display name" hint="Shown on every board you play." defaultValue="Sample player" />
            <TextInput id={id('score')} label="Score" size="score" defaultValue="12,450,330" />
            <TextArea id={id('note')} label="Note" optional placeholder="Anything the room should know" />
            <Select id={id('table')} label="Table" defaultValue="afm">
                <option value="afm">Attack from Mars</option>
                <option value="tz">Twilight Zone</option>
            </Select>
            <SearchInput id={id('search')} label="Search" placeholder="Search the catalogue" defaultValue="Medieval" />
            <TextInput id={id('err')} label="Room address" defaultValue="joes arcade" error="Use letters, numbers and _ only." />
            <TextInput id={id('off')} label="Room code" defaultValue="Locked" disabled />
        </div>
    );
}

function TabsSample({ idPrefix }: { idPrefix: string }) {
    const [tab, setTab] = useState('scores');
    return (
        <>
            <RailTabs label="Sample tabs" idPrefix={idPrefix} tabs={SAMPLE_TABS} value={tab} onChange={setTab} />
            <p className="text-sm text-muted mt-3" {...tabPanelProps(idPrefix, tab)}>
                The {SAMPLE_TABS.find(t => t.id === tab)!.label} tab. Arrow keys, Home and End move between tabs.
            </p>
        </>
    );
}

/** Two small pressed/unpressed chips, for the ListRow `below` sample. */
function ChipsSample() {
    const [on, setOn] = useState<string[]>(['VPX']);
    const chip = (label: string) => {
        const pressed = on.includes(label);
        return (
            <button
                key={label}
                type="button"
                aria-pressed={pressed}
                onClick={() => setOn(cur => (pressed ? cur.filter(x => x !== label) : [...cur, label]))}
                className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors cursor-pointer ${pressed ? 'border-neon-cyan/60 bg-neon-cyan/15 text-neon-cyan' : 'border-border text-muted'}`}
            >
                {label}
            </button>
        );
    };
    return <div className="flex flex-wrap items-center gap-1.5"><span className="text-xs text-muted">Owned on:</span>{chip('VPX')}{chip('AtGames')}</div>;
}

/** One component shown in both looks, so the two previews show the same thing. */
function SampleGroups({ idPrefix }: { idPrefix: string }) {
    const id = (k: string) => `${idPrefix}-${k}`;
    const t = (k: string) => SAMPLE_TONES.find(x => x.key === k)!;
    return (
        <>
            <PanelGroup id={id('cyan')} tone="cyan" title={t('cyan').title} sub={t('cyan').sub}>
                <Panel title="Panel">
                    <p className="text-sm text-primary mb-2">Primary text says what this panel is for.</p>
                    <p className="text-xs text-muted">Muted helper text explains the detail under it.</p>
                </Panel>
                <Panel title="Buttons">
                    <ButtonRow label="Medium" size="md" />
                    <ButtonRow label="Small" size="sm" />
                    <ButtonRow label="Extra small" size="xs" />
                    <ButtonRow label="Disabled" size="md" disabled />
                    <Row label="Link">
                        <ButtonLink to="/admin/style-guide">Primary link</ButtonLink>
                        <ButtonLink to="/admin/style-guide" variant="secondary" size="xs">Secondary link</ButtonLink>
                    </Row>
                </Panel>
                <Panel title="Tabs">
                    <TabsSample idPrefix={`${idPrefix}-tabs`} />
                </Panel>
                <Panel title="Stat tiles" wide>
                    <StatTiles tiles={[{ label: 'Plays', value: '128' }, { label: 'Best rank', value: '3rd' }, { label: 'Points', value: '12,450' }]} />
                </Panel>
                <PopupSamples idPrefix={idPrefix} />
            </PanelGroup>

            <PanelGroup id={id('pink')} tone="pink" title={t('pink').title} sub={t('pink').sub}>
                <Panel title="Form fields">
                    <label htmlFor={id('name')} className="block text-sm font-medium mb-1.5">Display name</label>
                    <input
                        id={id('name')}
                        type="text"
                        defaultValue="Sample player"
                        className="w-full bg-surface border border-border rounded px-3 py-2 text-sm text-primary placeholder-faint focus:border-neon-cyan focus:outline-none mb-3"
                    />
                    <label htmlFor={id('hours')} className="block text-xs text-muted mb-1">Remind me after</label>
                    <select
                        id={id('hours')}
                        defaultValue="24"
                        className="bg-surface border border-border rounded px-2 py-1 text-sm text-primary mb-3"
                    >
                        <option value="12">12 hours</option>
                        <option value="24">24 hours</option>
                        <option value="48">48 hours</option>
                    </select>
                    <label htmlFor={id('check')} className="flex items-center gap-2 text-sm text-primary">
                        <input id={id('check')} type="checkbox" defaultChecked />
                        Share my scores to the Global Scoreboard
                    </label>
                </Panel>
                <Panel title="Fields" wide>
                    <FieldSamples idPrefix={idPrefix} />
                </Panel>
                <Panel title="Status">
                    <ul className="m-0 p-0 list-none space-y-2">
                        <StatusWord dot="bg-neon-green" text="text-neon-green" label="Fine" />
                        <StatusWord dot="bg-neon-magenta" text="text-neon-magenta" label="Attention" />
                        <StatusWord dot="bg-neon-coral" text="text-neon-coral" label="Problem" />
                    </ul>
                </Panel>
            </PanelGroup>

            <PanelGroup id={id('violet')} tone="violet" title={t('violet').title} sub={t('violet').sub}>
                <Panel title="A long value">
                    <p className="min-w-0 break-words text-sm text-primary mb-1">WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW</p>
                    <p className="min-w-0 break-words text-sm font-mono text-muted">9,876,543,210,123</p>
                </Panel>
            </PanelGroup>

            <PanelGroup id={id('ice')} tone="ice" title={t('ice').title} sub={t('ice').sub}>
                <Panel title="A wide panel" wide>
                    <p className="text-sm text-primary">A wide panel spans both columns of its group.</p>
                </Panel>
                <Panel title="Loading">
                    <SkeletonRows count={2} />
                    <SkeletonTiles count={3} />
                </Panel>
                <Panel title="Empty state">
                    <EmptyState title="No tables yet" action={<Button variant="secondary" size="sm">Add a table</Button>}>
                        Tables you add show up here, ready to pick for a tournament.
                    </EmptyState>
                </Panel>
                <Panel title="List rows" wide>
                    <ListRows label="Sample rooms">
                        <ListRow tile="NA" name="Neon Alley Pinball" caption="Last played today" href="/admin/style-guide" trailing={<Button variant="secondary" size="xs">Leave</Button>} />
                        <ListRow tile="TC" name="The Saturday Night Silverball Society of Greater Springfield Pinball" caption="Member" href="/admin/style-guide" />
                        <ListRow tile="MM" name="Medieval Madness" caption="Williams 1997" href="/admin/style-guide" trailing={<Button variant="secondary" size="xs">Remove</Button>} below={<ChipsSample />} />
                    </ListRows>
                </Panel>
            </PanelGroup>

            <PanelGroup id={id('red')} tone="red" title={t('red').title} sub={t('red').sub}>
                <Panel title="Danger zone">
                    <p className="text-sm text-muted mb-3">This removes something and cannot be undone.</p>
                    <Button variant="danger">Delete something</Button>
                </Panel>
            </PanelGroup>
        </>
    );
}

function BulletList({ items }: { items: string[] }) {
    return (
        <ul className="m-0 pl-5 list-disc space-y-1.5 text-sm text-primary">
            {items.map(i => <li key={i}>{i}</li>)}
        </ul>
    );
}

const NEVER = [
    "A library's default look on any part",
    "The rejected sketch's pieces (purple title plate, slanted buttons, dot-matrix scores)",
    'Raw colour values instead of tokens',
    'Green or yellow status colours on the Arcaid look',
    'A box inside a box inside a panel',
    'Cutting a game title off with "…" (wrap it)',
];

const ALWAYS = [
    'Text 12 px or larger',
    'Name the property in a transition (never "all")',
    'A visible focus ring',
    'A skeleton while loading',
    'An empty state that says what to do next',
    '16 px inputs on touch screens',
];

export default function StyleGuide() {
    const [selected, setSelected] = useState<ThemeId>(THEME_IDS[0]);

    return (
        <PageShell width="wide" jump={PAGE_JUMP}>
            {/* Inside the shell, so the title lines up with the groups beside the jump list. */}
            <PageTitle title="Style Guide" sub="Every shared part, in the Arcaid look and in each room theme." />

            <PanelGroup id="sg-looks" tone="cyan" title="The two looks" sub="Which pages wear which look, and why.">
                <Panel title="Who the pages are for">
                    <p className="text-sm text-primary">
                        Players on a phone at a cabinet, often one-handed and in low light. Room admins and mods,
                        also mostly on phones. Unattended kiosk TVs. A desktop gets the width.
                    </p>
                </Panel>
                <Panel title="Which look goes where">
                    <p className="text-sm text-primary mb-2">
                        The Arcaid look (fixed dark, arcade carpet) is for personal and global pages: the landing page,
                        Account Settings, My Tables, My Stats, Friends, Create Room.
                    </p>
                    <p className="text-sm text-primary mb-2">
                        Room pages and admin pages keep the room&apos;s theme (11 themes) and get the same parts in
                        that theme&apos;s colours. Each theme has a lead colour (the primary button, the active nav
                        item and tab) and a second beside it; first place stays gold.
                    </p>
                    <p className="text-xs text-muted">
                        Protected, never re-skinned: the room Scoreboard cards, the Global Scoreboard, the kiosk and the title styles.
                    </p>
                </Panel>
            </PanelGroup>

            <PanelGroup id="sg-arcaid" tone="pink" title="Arcaid look" sub="Fixed dark kit on the arcade carpet.">
                <Panel title="Personal and global pages" wide>
                    <div className="rounded-lg overflow-hidden border border-border" data-testid="arcaid-preview">
                        <ArcaidPage
                            embedded
                            title="Sample page"
                            jump={sampleJump('sg-a')}
                            actions={null}
                            footer={<span>ARCAID.APP</span>}
                        >
                            <SampleGroups idPrefix="sg-a" />
                        </ArcaidPage>
                    </div>
                </Panel>
            </PanelGroup>

            <PanelGroup id="sg-theme" tone="violet" title="Room's theme" sub="The same parts, drawn in each theme's colours.">
                <Panel title="Pick a theme" wide>
                    <div className="flex flex-wrap gap-2 mb-4" role="group" aria-label="Theme">
                        {THEME_IDS.map(id => (
                            <Button
                                key={id}
                                size="xs"
                                variant={id === selected ? 'primary' : 'secondary'}
                                aria-pressed={id === selected}
                                onClick={() => setSelected(id)}
                            >
                                {THEMES[id].label}
                            </Button>
                        ))}
                    </div>
                    <div
                        className={`${themeScopeClass(selected)} bg-deep text-primary rounded-lg border border-border p-4 sm:p-6`}
                        data-testid="theme-preview"
                        data-theme={selected}
                    >
                        <PageTitle
                            title="Weekly Rotation"
                            sub="A sample room page in this theme."
                            actions={<Button variant="secondary">Action</Button>}
                        />
                        <div className="part-jumplayout mt-6">
                            <JumpList items={sampleJump('sg-t')} />
                            <div className="part-jumplayout__body">
                                <SampleGroups idPrefix="sg-t" />
                            </div>
                        </div>
                    </div>
                </Panel>
                <Panel title="Every theme at a glance" wide>
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                        {THEME_IDS.map((id, i) => (
                            <div
                                key={id}
                                className={`${themeScopeClass(id)} bg-deep text-primary rounded-lg border border-border p-3 min-w-0`}
                                data-testid="theme-tile"
                                data-theme={id}
                            >
                                <h4 className="text-sm font-semibold mb-1">{THEMES[id].label}</h4>
                                <div className="flex flex-wrap items-center gap-3 mb-2 text-xs" data-testid="theme-roles">
                                    <span className="inline-flex items-center gap-1.5 ink-lead">
                                        <span className="inline-block w-3 h-3 rounded-full bg-lead" aria-hidden="true" />
                                        Lead
                                    </span>
                                    <span className="inline-flex items-center gap-1.5 text-second">
                                        <span className="inline-block w-3 h-3 rounded-full bg-second" aria-hidden="true" />
                                        Second
                                    </span>
                                </div>
                                <PanelGroup id={`sg-tile-${id}`} tone={THEME_TILE_TONES[i % THEME_TILE_TONES.length]!} title="Group">
                                    <Panel title="Panel" wide>
                                        <p className="text-sm text-primary">Primary text</p>
                                        <p className="text-xs text-muted mb-2">Muted text</p>
                                        <div className="flex flex-wrap gap-2">
                                            <Button variant="primary" size="sm">Primary</Button>
                                            <Button variant="secondary" size="sm">Secondary</Button>
                                            <Button variant="danger" size="sm">Danger</Button>
                                        </div>
                                    </Panel>
                                </PanelGroup>
                            </div>
                        ))}
                    </div>
                </Panel>
                <Panel title="Menu" wide>
                    <p className="text-sm text-primary mb-2">
                        The room switcher in the room nav. The button takes the theme picked above; the menu is the
                        Arcaid look on every theme. Arrow keys move the pinball, Escape closes.
                    </p>
                    <p className="text-xs text-muted mb-3">Made-up rooms: picking one closes the menu and stays here.</p>
                    {/* onClickCapture: React events cross the portal, so this sees the menu's links too. */}
                    <div
                        className={`${themeScopeClass(selected)} bg-deep text-primary rounded-lg border border-border p-4 sm:p-6`}
                        data-testid="menu-preview"
                        onClickCapture={stayOnPage}
                    >
                        <RoomSwitcher variant="inline" current={SAMPLE_ROOM} rooms={SAMPLE_ROOMS} loading={false} signedIn />
                    </div>
                </Panel>
            </PanelGroup>

            <PanelGroup id="sg-widths" tone="ice" title="Page widths" sub="A page's outer width is one of two.">
                <Panel title="The two widths" wide>
                    <div className="space-y-4 mb-4">
                        <div>
                            <p className="text-xs text-muted mb-1.5">wide: 1600 px (lists, boards, settings)</p>
                            <div className="h-4 rounded bg-neon-cyan/30 border border-neon-cyan/50" style={{ maxWidth: '1600px', width: '100%' }} />
                        </div>
                        <div>
                            <p className="text-xs text-muted mb-1.5">column: 52rem (one form, a page of prose)</p>
                            <div className="h-4 rounded bg-neon-magenta/30 border border-neon-magenta/50" style={{ maxWidth: '52rem' }} />
                        </div>
                    </div>
                    <p className="text-sm text-primary">
                        A page&apos;s outer width is one of these two, set on ArcaidPage or PageShell.
                    </p>
                </Panel>
            </PanelGroup>

            <PanelGroup id="sg-rules" tone="cyan" title="Rules" sub="What to avoid and what to keep.">
                <Panel title="Never"><BulletList items={NEVER} /></Panel>
                <Panel title="Always"><BulletList items={ALWAYS} /></Panel>
                <p className="lg:col-span-2 m-0 text-xs text-muted">
                    The full rules are in .claude/rules/admin-ui.md; change them together with this page.
                </p>
            </PanelGroup>
        </PageShell>
    );
}
