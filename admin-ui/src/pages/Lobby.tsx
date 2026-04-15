import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MessageSquare, RefreshCw } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { getSocket } from '../lib/websocket';
import SocialLinksBar from '../components/lobby/SocialLinksBar';
import PinnedMessage from '../components/lobby/PinnedMessage';
import AnnouncementsRail from '../components/lobby/AnnouncementsRail';
import FeedItem from '../components/lobby/FeedItem';
import CommunityShelf from '../components/lobby/CommunityShelf';

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
  const [roomId, setRoomId] = useState<string | null>(null);

  // Feed state
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const seenIds = useRef(new Set<number>());

  // Content zones
  const [config, setConfig] = useState<LobbyConfig | null>(null);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [shelfItems, setShelfItems] = useState<ShelfItem[]>([]);

  // Resolve roomId from slug
  useEffect(() => {
    if (!slug) return;
    fetch(`/api/portal?slug=${encodeURIComponent(slug)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.roomId) setRoomId(data.roomId); })
      .catch(() => {});
  }, [slug]);

  // Fetch lobby content (config, announcements, shelf)
  useEffect(() => {
    if (!roomId) return;
    Promise.all([
      fetch(`/api/rooms/${roomId}/lobby/config`).then(r => r.ok ? r.json() : null),
      fetch(`/api/rooms/${roomId}/lobby/announcements`).then(r => r.ok ? r.json() : []),
      fetch(`/api/rooms/${roomId}/lobby/shelf`).then(r => r.ok ? r.json() : []),
    ]).then(([cfg, ann, shelf]) => {
      if (cfg) setConfig(cfg);
      setAnnouncements(ann || []);
      setShelfItems(shelf || []);
    }).catch(() => {});
  }, [roomId]);

  // Fetch feed
  const fetchFeed = useCallback(async (before?: string) => {
    if (!roomId) return;
    const params = new URLSearchParams({ limit: '20' });
    if (before) params.set('before', before);
    const headers: Record<string, string> = {};
    if (playerToken) headers['Authorization'] = `Bearer ${playerToken}`;

    const res = await fetch(`/api/rooms/${roomId}/lobby/feed?${params}`, { headers });
    if (!res.ok) return [];
    return res.json() as Promise<FeedEvent[]>;
  }, [roomId, playerToken]);

  // Initial feed load
  useEffect(() => {
    if (!roomId) return;
    setLoading(true);
    fetchFeed().then(data => {
      if (data) {
        setEvents(data);
        seenIds.current = new Set(data.map(e => e.id));
        setHasMore(data.length >= 20);
      }
    }).catch(() => {}).finally(() => setLoading(false));
  }, [roomId, fetchFeed]);

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
    } catch { /* ignore */ }
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

      {/* Page Header */}
      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <MessageSquare size={20} className="text-neon-cyan" />
          <h2 className="font-display text-xl font-bold">Lobby</h2>
        </div>
        <p className="text-xs text-muted mt-1">Recent activity and competitive moments</p>
      </div>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-4 space-y-6">
        {/* Zone 2: Announcements Rail */}
        {announcements.length > 0 && (
          <AnnouncementsRail announcements={announcements} />
        )}

        {/* Zone 3: Activity Stream */}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
          </div>
        ) : visibleEvents.length === 0 ? (
          <div className="text-center py-12">
            <MessageSquare size={40} className="text-muted/30 mx-auto mb-3" />
            <p className="text-muted mb-2">No activity yet</p>
            <p className="text-xs text-faint">
              Be the first to post a score!{' '}
              {slug && (
                <Link to={`/${slug}/freeplay`} className="text-neon-cyan hover:underline">
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
