import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MessageSquare, RefreshCw } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { useRoom } from '../contexts/RoomContext';
import { getSocket } from '../lib/websocket';
import { useLiveRefresh } from '../hooks/useLiveRefresh';
import SeasonPollCards from '../components/SeasonPollCard';
import SocialLinksBar from '../components/lobby/SocialLinksBar';
import PinnedMessage from '../components/lobby/PinnedMessage';
import AnnouncementsRail from '../components/lobby/AnnouncementsRail';
import FeedItem from '../components/lobby/FeedItem';
import CommunityShelf from '../components/lobby/CommunityShelf';
import { roomFetch } from '../lib/roomFetch';
import { useRetryingLoad } from '../hooks/useRetryingLoad';
import { isTransientStatus } from '../lib/loadRetry';
import LoadFailedNotice from '../components/LoadFailedNotice';
import RoomNoticeSlot from '../components/RoomNoticeSlot';

interface FeedEvent {
  id: number;
  type: string;
  source: 'system' | 'admin';
  icon: string | null;
  title: string;
  subtitle: string | null;
  player_id: string | null;
  game_name: string | null;
  tournament_id: string | null;
  metadata: Record<string, any>;
  created_at: string;
}

interface LobbyConfig {
  socialLinks: Array<{ type: string; url: string; label?: string }>;
  pinnedMessage: { content: string; enabled: boolean } | null;
}

interface Announcement {
  id: string;
  title: string;
  body: string | null;
  image_url: string | null;
  cta_url: string | null;
  cta_label: string | null;
  type: string;
  event_datetime: string | null;
}

interface ShelfItem {
  id: string;
  type: string;
  url: string;
  title: string;
  thumbnail: string | null;
  description: string | null;
}

export default function Lobby() {
  const { slug } = useParams<{ slug: string }>();
  const { playerToken, discordUser } = useViewerAuth();
  const { roomId } = useRoom();

  // Feed state
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const seenIds = useRef(new Set<number>());
  // The room the feed's first answer was for: the first answer sets the list,
  // a later one (a quiet reload) merges into it.
  const answeredRoom = useRef<string | null>(null);

  // Content zones (optional decoration: a quiet retry, no failure state, and a
  // failed try never clears a zone that is already shown)
  const [config, setConfig] = useState<LobbyConfig | null>(null);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [shelfItems, setShelfItems] = useState<ShelfItem[]>([]);

  const { load: loadConfig } = useRetryingLoad(
    () => roomFetch(`/api/rooms/${roomId}/lobby/config`),
    async res => { const cfg = await res.json(); if (cfg) setConfig(cfg); },
    roomId,
  );
  const { load: loadAnnouncements } = useRetryingLoad(
    () => roomFetch(`/api/rooms/${roomId}/lobby/announcements`),
    async res => { setAnnouncements((await res.json()) || []); },
    roomId,
  );
  const { load: loadShelf } = useRetryingLoad(
    () => roomFetch(`/api/rooms/${roomId}/lobby/shelf`),
    async res => { setShelfItems((await res.json()) || []); },
    roomId,
  );
  useEffect(() => {
    if (!roomId) return;
    loadConfig();
    loadAnnouncements();
    loadShelf();
  }, [roomId, loadConfig, loadAnnouncements, loadShelf]);

  // Fetch a further feed page. A refusal or failure throws, so "no more" ([])
  // and "failed" are never the same thing.
  const fetchFeed = useCallback(async (before?: string) => {
    const params = new URLSearchParams({ limit: '20' });
    if (before) params.set('before', before);
    const headers: Record<string, string> = {};
    if (playerToken) headers['Authorization'] = `Bearer ${playerToken}`;

    const res = await fetch(`/api/rooms/${roomId}/lobby/feed?${params}`, { headers });
    if (!res.ok) throw new Error(`Feed ${res.status}`);
    return res.json() as Promise<FeedEvent[]>;
  }, [roomId, playerToken]);

  // Feed first page, on the retrying loader
  const { load: loadFeed, phase: feedPhase } = useRetryingLoad(
    () => {
      const headers: Record<string, string> = {};
      if (playerToken) headers['Authorization'] = `Bearer ${playerToken}`;
      return fetch(`/api/rooms/${roomId}/lobby/feed?limit=20`, { headers }).then(r => {
        // A definite refusal is an answer with nothing in it. Without this a
        // move to a room that refuses the feed kept the last room's events.
        if (!r.ok && !isTransientStatus(r.status)) {
          answeredRoom.current = roomId ?? null;
          seenIds.current = new Set();
          setEvents([]);
          setHasMore(false);
        }
        return r;
      });
    },
    async res => {
      const data = (await res.json()) as FeedEvent[];
      if (!Array.isArray(data)) throw new Error('Bad feed');
      if (answeredRoom.current !== roomId) {
        answeredRoom.current = roomId ?? null;
        setEvents(data);
        seenIds.current = new Set(data.map(e => e.id));
        setHasMore(data.length >= 20);
        return;
      }
      // A quiet reload: add what is new in front, keep every page already loaded.
      const fresh = data.filter(e => !seenIds.current.has(e.id));
      if (fresh.length === 0) return;
      fresh.forEach(e => seenIds.current.add(e.id));
      setEvents(prev => [...fresh, ...prev]);
    },
    roomId,
  );
  useEffect(() => {
    if (!roomId) return;
    loadFeed();
  }, [roomId, playerToken, loadFeed]);

  // Load more (cursor pagination)
  const loadMore = useCallback(async () => {
    if (!events.length || loadingMore) return;
    setLoadingMore(true);
    try {
      const cursor = events[events.length - 1].created_at;
      const data = await fetchFeed(cursor);
      if (data && data.length > 0) {
        const newEvents = data.filter(e => !seenIds.current.has(e.id));
        newEvents.forEach(e => seenIds.current.add(e.id));
        setEvents(prev => [...prev, ...newEvents]);
        setHasMore(data.length >= 20);
      } else {
        setHasMore(false);
      }
    } catch { /* failed for now: keep the button so it can be tried again */ }
    setLoadingMore(false);
  }, [events, loadingMore, fetchFeed]);

  // WebSocket live updates
  useEffect(() => {
    if (!roomId) return;
    const socket = getSocket();
    socket.emit('join:lobby', roomId);

    const handler = (event: FeedEvent) => {
      if (seenIds.current.has(event.id)) return;
      seenIds.current.add(event.id);
      setEvents(prev => [event, ...prev]);
    };
    socket.on('lobby:event', handler);

    return () => {
      socket.emit('leave:lobby', roomId);
      socket.off('lobby:event', handler);
    };
  }, [roomId]);

  // Season format — the table poll card lives here (owner ruling 2026-10-18).
  // `season:poll` is emitted to `room:<id>`, not `lobby:<id>`, so this page
  // joins the room channel too, re-joining on every (re)connect since
  // socket.io room membership is per-connection.
  const [seasonRefreshKey, setSeasonRefreshKey] = useState(0);
  const bumpSeason = useCallback(() => setSeasonRefreshKey(k => k + 1), []);
  useEffect(() => {
    if (!roomId) return;
    const socket = getSocket();
    socket.emit('join:room', roomId);
    const onConnect = () => socket.emit('join:room', roomId);
    socket.on('connect', onConnect);
    socket.on('season:poll', bumpSeason);
    return () => {
      socket.emit('leave:room', roomId);
      // Handler refs: the socket is a shared singleton.
      socket.off('connect', onConnect);
      socket.off('season:poll', bumpSeason);
    };
  }, [roomId, bumpSeason]);
  // Any page that joins `room:<id>` needs this (CLAUDE.md, v2.154.0): covers
  // reconnect gaps, a backgrounded tab and iOS bfcache.
  useLiveRefresh(() => { bumpSeason(); loadFeed(); }, { enabled: !!roomId });

  // Filter out self-activity (keep friend_score, tournament events, admin messages, etc.)
  const SELF_EVENT_TYPES = new Set(['score_posted', 'new_high_score', 'rank_change', 'player_milestone']);
  const myId = discordUser?.discordId;
  const visibleEvents = myId
    ? events.filter(e => !(e.player_id === myId && SELF_EVENT_TYPES.has(e.type)))
    : events;

  const hasSocialLinks = config?.socialLinks && config.socialLinks.length > 0;
  const hasPinnedMessage = config?.pinnedMessage?.enabled && config.pinnedMessage.content;

  return (
    <div>
      {/* Zone 1: Header — Social Links + Pinned Message */}
      {(hasSocialLinks || hasPinnedMessage) && (
        <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-4 space-y-2">
          {hasSocialLinks && <SocialLinksBar links={config!.socialLinks} />}
          {hasPinnedMessage && roomId && (
            <PinnedMessage content={config!.pinnedMessage!.content} roomId={roomId} />
          )}
        </div>
      )}

      {/* Season table poll — renders nothing when the room has no open poll. */}
      {roomId && (
        <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-4 empty:hidden">
          <SeasonPollCards roomId={roomId} roomSlug={slug || ''} refreshKey={seasonRefreshKey} />
        </div>
      )}

      {/* Page Header */}
      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <MessageSquare size={20} className="text-neon-cyan" />
          <h2 className="font-display text-xl font-bold">Lobby</h2>
        </div>
        <p className="text-xs text-muted mt-1">Recent activity and competitive moments</p>
        <RoomNoticeSlot className="[&:has([data-testid=room-notices]:not(:empty))]:mt-3" />
      </div>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-4 space-y-6">
        {/* Zone 2: Announcements Rail */}
        {announcements.length > 0 && (
          <AnnouncementsRail announcements={announcements} />
        )}

        {/* Zone 3: Activity Stream */}
        {feedPhase === 'loading' ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
          </div>
        ) : feedPhase === 'retrying' ? (
          <LoadFailedNotice what="the activity" onRetry={loadFeed} testId="lobby-load-failed" className="py-12" />
        ) : visibleEvents.length === 0 ? (
          <div className="text-center py-12">
            <MessageSquare size={40} className="text-muted/30 mx-auto mb-3" />
            <p className="text-muted mb-2">No activity yet</p>
            <p className="text-xs text-faint">
              Be the first to post a score!{' '}
              {slug && (
                <Link to={`/${slug}?tab=all-games`} className="text-neon-cyan hover:underline">
                  Play a game
                </Link>
              )}
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {visibleEvents.map(event => (
              <FeedItem key={event.id} event={event} slug={slug || ''} />
            ))}

            {hasMore && (
              <div className="flex justify-center pt-4 pb-2">
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="flex items-center gap-2 px-4 py-2 text-xs text-muted hover:text-neon-cyan border border-border/50 rounded-lg hover:border-neon-cyan/30 transition-colors cursor-pointer disabled:opacity-50"
                >
                  {loadingMore ? (
                    <RefreshCw size={14} className="animate-spin" />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                  Load more
                </button>
              </div>
            )}
          </div>
        )}

        {/* Zone 4: Community Shelf */}
        {shelfItems.length > 0 && (
          <CommunityShelf items={shelfItems} />
        )}
      </main>
    </div>
  );
}
