import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ConfirmDialog, Dialog } from '../parts/Dialog';
import { useToast } from '../Toast';
import Button from '../parts/Button';
import { RailTabs } from '../parts/Tabs';
import { tabPanelProps } from '../parts/tabPanel';
import { SkeletonRows } from '../parts/Skeleton';
import { useTheme, THEME_POLARITY, type Appearance } from '../ThemeProvider';
import type { ThemeId } from '../../lib/themeIds';
import { saveRoomTheme } from '../../lib/roomThemes';
import { isGlobalPath } from '../../lib/routeClass';
import { useIsWideViewport } from '../../lib/useIsWideViewport';
import { useRetryingLoad } from '../../hooks/useRetryingLoad';
import { decodeJwtPayload, isExpiredOrInvalid } from '../../lib/adminSlotSeed';
import {
  DISPLAY_SETTINGS_SAVED_EVENT, dispatchDisplaySettingsLive, prefsDevice, readGuestPrefs, writeGuestPrefs, type DisplayPrefsDevice,
} from '../../lib/displaySettingsLive';
import {
  CardSetContext, applyChanges, buildPayload, cardModel, copyOver, hasCardSettings, samePrefs, withoutCardSettings, type Prefs,
} from './model';
import { CardsSection, ColoursSection, MoreRows, MoreSection } from './sections';

/**
 * G34a - Display settings, a live panel (owner decisions 2026-11-26).
 *
 * The Arcaid dialog in `panel` mode: docked right on a computer with the page
 * still bright and usable beside it, a three-height bottom sheet on a phone.
 * Only the device in hand is edited (one footer line says the other keeps its
 * own card settings). Every change shows on the page at once and saves itself:
 *
 * - Card settings (this device, every room): each change goes to the page as
 *   `display-settings-live` at once and is POSTed 500 ms after the last one
 *   (every key, null for unset, as the old Save did). Footer status: Saving...,
 *   Saved, or Couldn't save with Try again. Closing with a save pending sends
 *   it at once, then fires `display-settings-saved`.
 * - Colours (every device): Appearance, theme and floor save through their
 *   `ThemeProvider` setters, which already apply live; the room-only theme
 *   PUTs itself as before.
 * - Undo changes: back to how everything was when the panel opened (the card
 *   settings, Appearance, the personal theme, each room theme it touched, the
 *   floor). Room defaults: clears this device's card settings only.
 *
 * Mounted by `DisplaySettingsHost` (app-wide, so it stays open across pages)
 * and loaded as its own chunk on first open.
 */

export interface DisplaySettingsPanelProps {
  onClose: () => void;
  /** The signed-in viewer's token; null is guest mode (G34c): card settings are kept in this browser. */
  playerToken: string | null;
  /** The room page's slug, or null off room pages. */
  slug: string | null;
  roomId?: string;
  roomName?: string;
  /** The room's own settings (`/scoreboard-config`); null while they load. */
  roomConfig: Record<string, string> | null;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';
type Scope = 'everywhere' | 'room';
type TabId = 'colours' | 'cards' | 'more';

const SAVE_DELAY_MS = 500;

/** Whether the signed-in viewer runs this room (read from the tokens this browser already holds). */
function administersRoom(roomId: string | undefined, playerToken: string | null): boolean {
  if (!roomId) return false;
  let adminSlot: string | null = null;
  try { adminSlot = localStorage.getItem('arcaid_token'); } catch { /* private mode */ }
  const tokens = [playerToken, isExpiredOrInvalid(adminSlot) ? null : adminSlot];
  return tokens.some(token => {
    const claims = token ? decodeJwtPayload(token) : null;
    if (!claims) return false;
    if (claims.role === 'super_admin') return true;
    return claims.role === 'room_admin' && Array.isArray(claims.gameRoomIds) && (claims.gameRoomIds as unknown[]).includes(roomId);
  });
}

export default function DisplaySettingsPanel({ onClose, playerToken, slug, roomId, roomName, roomConfig }: DisplaySettingsPanelProps) {
  const {
    appearance, setAppearance, personalTheme, setPersonalTheme, roomThemeOverride, setRoomThemeOverride,
    floorChoice, setFloorChoice, floor, theme, publicTheme,
  } = useTheme();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const wide = useIsWideViewport();
  const roomScoped = !!slug;
  const onScoreboard = !!slug && pathname.replace(/\/+$/, '').toLowerCase() === `/${slug}`.toLowerCase();
  const ids = useId();

  // ── The card settings of the device in hand ────────────────────────────
  const [device] = useState<DisplayPrefsDevice>(prefsDevice);
  // A guest (no token) reads and writes this browser's copy, which is there at once.
  const [guest] = useState(() => !playerToken);
  const [guestStart] = useState<Prefs | null>(() => (guest ? readGuestPrefs(device) : null));
  const [prefs, setPrefs] = useState<Prefs>(guestStart ?? {});
  const [loaded, setLoaded] = useState(guest);
  const [snapPrefs, setSnapPrefs] = useState<Prefs | null>(guestStart);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const prefsRef = useRef<Prefs>(guestStart ?? {});
  const loadedRef = useRef(guest);
  const statusRef = useRef<SaveStatus>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const seqRef = useRef(0);
  const postedRef = useRef(false);
  const closedRef = useRef(false);
  const guestSavedRef = useRef(true);
  const tokenRef = useRef(playerToken);
  useEffect(() => { tokenRef.current = playerToken; }, [playerToken]);

  const showStatus = useCallback((next: SaveStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  // Read once, the first time the panel is on a room page (off-room there
  // is nothing of them to show, and nothing is ever posted before they load:
  // a save from an unloaded state would clear every stored setting).
  const { load: loadPrefs, phase: prefsPhase } = useRetryingLoad(
    () => fetch(`/api/me/scoreboard-preferences?device=${device}`, { headers: { Authorization: `Bearer ${tokenRef.current}` } }),
    async res => {
      const data = await res.json();
      const map: Prefs = data && typeof data === 'object' ? data : {};
      if (loadedRef.current) return;
      loadedRef.current = true;
      prefsRef.current = map;
      setPrefs(map);
      setSnapPrefs(map);
      setLoaded(true);
    },
    device,
  );
  useEffect(() => {
    if (roomScoped && !guest && !loadedRef.current) loadPrefs();
  }, [roomScoped, guest, loadPrefs]);

  /** POST this map, after any POST still on its way (so the last change is the one stored). */
  const post = useCallback((source: Prefs): Promise<void> => {
    const seq = ++seqRef.current;
    postedRef.current = true;
    if (guest) {
      // This browser's copy: written at once, no request. Blocked storage keeps the change for the session.
      const ok = writeGuestPrefs(device, source);
      guestSavedRef.current = ok;
      showStatus(ok ? 'saved' : 'failed');
      return Promise.resolve();
    }
    const run = async () => {
      try {
        const res = await fetch(`/api/me/scoreboard-preferences?device=${device}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenRef.current}` },
          body: JSON.stringify(buildPayload(source)),
        });
        if (!res.ok) throw new Error(`save refused (${res.status})`);
        if (seq === seqRef.current && timerRef.current === null) showStatus('saved');
      } catch {
        if (seq === seqRef.current) showStatus('failed');
      }
    };
    const next = chainRef.current.then(run);
    chainRef.current = next;
    return next;
  }, [device, guest, showStatus]);

  /** A change: on the page at once, saved once the changes stop for a moment. */
  const commit = useCallback((next: Prefs) => {
    if (!loadedRef.current) return;
    prefsRef.current = next;
    setPrefs(next);
    dispatchDisplaySettingsLive({ device, prefs: next });
    if (guest) {
      void post(next);
      return;
    }
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    showStatus('saving');
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void post(prefsRef.current);
    }, SAVE_DELAY_MS);
  }, [device, guest, post, showStatus]);

  const setCards = useCallback((changes: Record<string, string | null>) => {
    commit(applyChanges(prefsRef.current, changes));
  }, [commit]);

  const retry = () => {
    if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
    showStatus('saving');
    void post(prefsRef.current);
  };

  /** Never lose a change: a pending (or failed) save goes now, then the page reads what is stored. */
  const flush = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    if (guest) {
      // Nothing waits: the page already has every change. Re-read only what is really stored.
      if (postedRef.current && guestSavedRef.current) window.dispatchEvent(new Event(DISPLAY_SETTINGS_SAVED_EVENT));
      return;
    }
    const pending = timerRef.current !== null || statusRef.current === 'failed';
    if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
    const done = pending && loadedRef.current ? post(prefsRef.current) : chainRef.current;
    if (pending || postedRef.current) {
      void done.then(() => window.dispatchEvent(new Event(DISPLAY_SETTINGS_SAVED_EVENT)));
    }
  }, [post, guest]);
  useEffect(() => {
    closedRef.current = false;
    return () => flush();
  }, [flush]);

  const close = () => {
    flush();
    onClose();
  };

  // ── Colours ───────────────────────────────────────────────────────────
  // How they were when the panel opened. A room's own theme is remembered
  // just before this panel first changes it, so Undo can put back every room
  // it touched, even after moving between rooms.
  const [snapColours] = useState(() => ({ appearance, personalTheme, floorChoice }));
  const [roomSnaps, setRoomSnaps] = useState<Record<string, { snap: ThemeId | null; last: ThemeId | null }>>({});
  const [switchedFor, setSwitchedFor] = useState<ThemeId | null>(null);
  // "Use it": the viewer's choice in this room, else where the room's theme already is.
  const [scopeChoice, setScopeChoice] = useState<{ roomId: string; scope: Scope } | null>(null);
  const scope: Scope = !roomId || !roomScoped
    ? 'everywhere'
    : scopeChoice?.roomId === roomId ? scopeChoice.scope : (roomThemeOverride ? 'room' : 'everywhere');

  /** Picking `picked` while Appearance would hide it: the setter switches to Auto, and the panel says so. */
  const noteSwitch = (picked: ThemeId | null) => {
    if (picked && appearance !== 'auto' && THEME_POLARITY[picked] !== appearance) setSwitchedFor(picked);
  };
  // The colour setters save at once (localStorage now, the account after).
  const colourChanged = () => {
    if (statusRef.current === 'idle') showStatus('saved');
  };
  const writeRoomTheme = (next: ThemeId | null) => {
    if (!roomId) return;
    // The first change in a room remembers what it was (a null "none of its own" included).
    setRoomSnaps(prev => ({ ...prev, [roomId]: { snap: prev[roomId] ? prev[roomId].snap : roomThemeOverride, last: next } }));
    noteSwitch(next);
    setRoomThemeOverride(next);
    void saveRoomTheme(roomId, next);
  };
  const pinScope = (s: Scope) => { if (roomId) setScopeChoice({ roomId, scope: s }); };

  const pickTheme = (next: ThemeId | null) => {
    pinScope(scope);
    if (scope === 'room' && roomId) writeRoomTheme(next);
    else {
      noteSwitch(next);
      setPersonalTheme(next);
    }
    colourChanged();
  };
  const changeScope = (next: Scope) => {
    if (!roomId || next === scope) return;
    pinScope(next);
    if (next === 'everywhere') {
      // The tile picked for this room becomes the theme everywhere; the room stops having its own.
      const moving = roomThemeOverride;
      noteSwitch(moving);
      setPersonalTheme(moving);
      writeRoomTheme(null);
    } else {
      // This room keeps the tile picked everywhere; the theme everywhere stays.
      writeRoomTheme(personalTheme);
    }
    colourChanged();
  };
  const changeAppearance = (next: Appearance) => {
    setAppearance(next);
    if (next !== 'auto') setSwitchedFor(null);
    colourChanged();
  };
  const changeFloor = (on: boolean) => {
    setFloorChoice(on ? 'on' : 'off');
    colourChanged();
  };

  // ── Undo and Room defaults ────────────────────────────────────────────
  const roomDirty = Object.entries(roomSnaps).some(([rid, r]) => (rid === roomId ? roomThemeOverride : r.last) !== r.snap);
  const prefsDirty = loaded && snapPrefs !== null && !samePrefs(prefs, snapPrefs);
  const dirty = prefsDirty || roomDirty
    || appearance !== snapColours.appearance
    || personalTheme !== snapColours.personalTheme
    || floorChoice !== snapColours.floorChoice;

  const undo = () => {
    if (prefsDirty && snapPrefs) commit(snapPrefs);
    let themeSet = false;
    if (personalTheme !== snapColours.personalTheme) {
      setPersonalTheme(snapColours.personalTheme);
      themeSet = true;
    }
    for (const [rid, r] of Object.entries(roomSnaps)) {
      if (rid === roomId) {
        if (roomThemeOverride !== r.snap) {
          setRoomThemeOverride(r.snap);
          void saveRoomTheme(rid, r.snap);
          themeSet = true;
        }
      } else if (r.last !== r.snap) {
        void saveRoomTheme(rid, r.snap);
      }
    }
    setRoomSnaps(prev => Object.fromEntries(Object.entries(prev).map(([rid, r]) => [rid, { snap: r.snap, last: r.snap }])));
    if (floorChoice !== snapColours.floorChoice) setFloorChoice(snapColours.floorChoice);
    // Last: a theme setter above may have switched Appearance to Auto.
    if (themeSet || appearance !== snapColours.appearance) setAppearance(snapColours.appearance);
    setSwitchedFor(null);
    setScopeChoice(null);
    colourChanged();
  };

  const roomDefaults = () => commit(withoutCardSettings(prefsRef.current));

  // ── Copy to my other device (G34b) ─────────────────────────────────────
  // The keys both device sets show go to the other set; nothing on this page
  // changes (it is the other device's set), so there is no live event.
  const { toast } = useToast();
  const [copyAsk, setCopyAsk] = useState(false);
  const [copying, setCopying] = useState(false);
  const other: DisplayPrefsDevice = device === 'desktop' ? 'mobile' : 'desktop';
  const otherName = device === 'desktop' ? 'phone' : 'computer';
  const copyToOther = async () => {
    if (copying) return;
    setCopying(true);
    if (guest) return;
    const headers = { Authorization: `Bearer ${tokenRef.current}` };
    try {
      const got = await fetch(`/api/me/scoreboard-preferences?device=${other}`, { headers });
      if (!got.ok) throw new Error(`read refused (${got.status})`);
      const data = await got.json();
      const theirs: Prefs = data && typeof data === 'object' ? data : {};
      const res = await fetch(`/api/me/scoreboard-preferences?device=${other}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(copyOver(prefsRef.current, theirs)),
      });
      if (!res.ok) throw new Error(`copy refused (${res.status})`);
      setCopyAsk(false);
      toast(`Copied to your ${otherName}`, 'success');
    } catch {
      setCopyAsk(false);
      toast("Couldn't copy. Try again.", 'error');
    } finally {
      setCopying(false);
    }
  };

  // ── Drawing ───────────────────────────────────────────────────────────
  const model = useMemo(
    () => (roomConfig ? cardModel(device, prefs, roomConfig) : null),
    [device, prefs, roomConfig],
  );
  const cardsReady = roomScoped && loaded && model !== null;
  const openScoreboard = () => { if (slug) navigate(`/${slug}`); };

  const colours = (
    <ColoursSection
      headingId={`${ids}-colours`}
      appearance={appearance}
      onAppearance={changeAppearance}
      switchedFor={appearance === 'auto' ? switchedFor : null}
      roomTheme={roomScoped ? publicTheme : 'dark'}
      roomScoped={roomScoped}
      roomName={roomName}
      scope={roomScoped && roomId ? scope : null}
      onScope={changeScope}
      selected={scope === 'room' ? roomThemeOverride : personalTheme}
      onPick={pickTheme}
      globalPage={!roomScoped && isGlobalPath(pathname)}
      floorOn={floor}
      highContrast={theme === 'contrast'}
      onFloor={changeFloor}
    />
  );
  const copyRow = (
    <div className="dset-row dset-row--wide" data-testid="copy-row">
      <p className="dset-note">{device === 'desktop' ? 'Your phone keeps its own card settings.' : 'Your computer keeps its own card settings.'}</p>
      <div className="dset-row__c">
        <Button variant="secondary" className="dset-copy" onClick={() => setCopyAsk(true)} disabled={!loaded}>
          {device === 'desktop' ? 'Copy to my phone' : 'Copy to my computer'}
        </Button>
      </div>
    </div>
  );
  const cardsWaiting = prefsPhase === 'ready' && !loaded
    ? <p className="dset-note" role="status">Couldn't load your card settings. <button type="button" className="dset-reset" onClick={() => loadPrefs()}>Try again</button></p>
    : <SkeletonRows count={4} label="Loading your card settings" />;
  const cards = cardsReady
    ? <CardsSection model={model} headingId={`${ids}-cards`} showHead notOnScoreboard={!onScoreboard} onOpenScoreboard={openScoreboard} slug={slug} copyRow={guest ? undefined : copyRow} />
    : cardsWaiting;

  // A phone gets the sections as tabs: Cards first on the scoreboard, else Colours.
  const [tab, setTab] = useState<TabId>(() => (onScoreboard ? 'cards' : 'colours'));
  const tabs = !wide && roomScoped;
  const tabPrefix = `${ids}-tabs`;
  const bar = tabs ? (
    <RailTabs
      label="Display settings"
      idPrefix={tabPrefix}
      tabs={[{ id: 'colours', label: 'Colours' }, { id: 'cards', label: 'Cards' }, { id: 'more', label: 'More' }]}
      value={tab}
      onChange={id => setTab(id as TabId)}
    />
  ) : undefined;

  let body;
  if (!roomScoped) body = colours;
  else if (tabs) {
    body = (
      <div {...tabPanelProps(tabPrefix, tab)}>
        {tab === 'colours' && colours}
        {tab === 'cards' && cards}
        {tab === 'more' && (cardsReady
          ? <div className="dset-sec"><MoreRows model={model} /></div>
          : cardsWaiting)}
      </div>
    );
  } else {
    body = (
      <>
        {colours}
        {cards}
        {cardsReady && <MoreSection model={model} />}
      </>
    );
  }

  const statusText = status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved ✓' : status === 'failed' ? "Couldn't save" : '';
  const footer = (
    <>
      <span className="dset-status" role="status" aria-live="polite" data-state={status} data-testid="display-save-status">
        {status === 'failed'
          ? <><span className="ink-danger">{statusText}</span><button type="button" className="dset-status__retry" onClick={retry}>Try again</button></>
          : statusText}
      </span>
      <Button variant="secondary" onClick={undo} disabled={!dirty}>Undo changes</Button>
      {roomScoped && (
        <Button variant="secondary" onClick={roomDefaults} disabled={!loaded || !hasCardSettings(prefs)}>Room defaults</Button>
      )}
    </>
  );

  const admin = roomScoped && roomId && administersRoom(roomId, playerToken);
  const description = (
    <>
      {guest ? 'Saved in this browser only.' : 'Only you see these.'}
      {admin && (
        <span className="dset-admin">
          <Link to={`/${slug}/admin/leaderboard`} onClick={close}>Room admin? Change it for everyone &#8594;</Link>
        </span>
      )}
    </>
  );

  return (
    <Dialog
      open
      onOpenChange={next => { if (!next) close(); }}
      panel
      tone="cyan"
      label="Display"
      title="Display settings"
      description={description}
      bar={bar}
      footer={footer}
    >
      <CardSetContext.Provider value={setCards}>
        <div className="dset">{body}</div>
        <ConfirmDialog
          open={copyAsk}
          onCancel={() => setCopyAsk(false)}
          onConfirm={() => { void copyToOther(); }}
          title={`Copy to your ${otherName}?`}
          message={`Your card style, game art, scores per card and the More settings replace the ones on your ${otherName}. Zoom, layout and QR codes stay as they are.`}
          confirmLabel="Copy"
          tone="cyan"
          busy={copying}
        />
      </CardSetContext.Provider>
    </Dialog>
  );
}
