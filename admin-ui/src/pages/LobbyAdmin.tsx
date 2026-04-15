import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, GripVertical, ExternalLink, X } from 'lucide-react';
import { api } from '../lib/api';
import { useRoom } from '../contexts/RoomContext';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';

// ── Types ──

interface Announcement {
  id: string;
  title: string;
  body: string | null;
  image_url: string | null;
  cta_url: string | null;
  cta_label: string | null;
  type: string;
  event_datetime: string | null;
  display_from: string;
  display_until: string | null;
  sort_order: number;
  created_at: string;
}

interface ShelfItem {
  id: string;
  type: string;
  url: string;
  title: string;
  thumbnail: string | null;
  description: string | null;
  sort_order: number;
}

interface SocialLink {
  type: string;
  url: string;
  label?: string;
}

interface PinnedMessage {
  content: string;
  enabled: boolean;
}

interface FeedSettings {
  enabledTypes: string[];
  stalenessThresholdDays: number;
  roomStatsFrequency: 'daily' | 'weekly' | 'disabled';
}

const ALL_FEED_TYPES = [
  'new_high_score', 'rank_change', 'score_posted',
  'tournament_active', 'tournament_ending', 'tournament_results',
  'player_milestone', 'room_stats', 'staleness_challenge',
  'new_game', 'player_joined', 'admin_message', 'admin_shoutout',
];

const SOCIAL_PLATFORMS = ['youtube', 'twitch', 'twitter', 'discord', 'instagram', 'custom'];

function detectPlatform(url: string): string {
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (h.includes('youtube.com') || h.includes('youtu.be')) return 'youtube';
    if (h.includes('twitch.tv')) return 'twitch';
    if (h.includes('twitter.com') || h.includes('x.com')) return 'twitter';
    if (h.includes('discord.gg') || h.includes('discord.com')) return 'discord';
    if (h.includes('instagram.com')) return 'instagram';
  } catch {}
  return 'custom';
}

function announcementStatus(a: Announcement): { label: string; color: string } {
  const now = new Date();
  if (a.display_until && new Date(a.display_until) < now) return { label: 'Expired', color: 'text-faint' };
  if (new Date(a.display_from) > now) return { label: 'Scheduled', color: 'text-neon-blue' };
  return { label: 'Active', color: 'text-neon-green' };
}

// ── Component ──

export default function LobbyAdmin() {
  const { roomId } = useRoom();

  // Social links
  const [socialLinks, setSocialLinks] = useState<SocialLink[]>([]);
  // Pinned message
  const [pinned, setPinned] = useState<PinnedMessage>({ content: '', enabled: false });
  // Announcements
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [annForm, setAnnForm] = useState<Partial<Announcement> | null>(null);
  // Shelf
  const [shelf, setShelf] = useState<ShelfItem[]>([]);
  const [shelfForm, setShelfForm] = useState<{ url: string; title: string; description: string } | null>(null);
  // Feed settings
  const [feedSettings, setFeedSettings] = useState<FeedSettings>({
    enabledTypes: [...ALL_FEED_TYPES],
    stalenessThresholdDays: 14,
    roomStatsFrequency: 'weekly',
  });

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // ── Load all data ──
  const loadData = useCallback(async () => {
    try {
      const [configRes, annRes, shelfRes] = await Promise.all([
        api.get<any>(`/rooms/${roomId}/lobby/config`),
        api.get<Announcement[]>(`/rooms/${roomId}/lobby/announcements/all`),
        api.get<ShelfItem[]>(`/rooms/${roomId}/lobby/shelf`),
      ]);
      setSocialLinks(configRes.socialLinks || []);
      if (configRes.pinnedMessage) setPinned(configRes.pinnedMessage);
      if (configRes.feedSettings) setFeedSettings({ ...feedSettings, ...configRes.feedSettings });
      setAnnouncements(annRes);
      setShelf(shelfRes);
    } catch {}
    setLoading(false);
  }, [roomId]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Save config (social links, pinned, feed settings) ──
  const saveConfig = async (partial: Record<string, any>) => {
    setSaving(true);
    try {
      await api.put(`/rooms/${roomId}/lobby/config`, partial);
    } catch {}
    setSaving(false);
  };

  // ── Social Links ──
  const addSocialLink = () => {
    setSocialLinks([...socialLinks, { type: 'custom', url: '', label: '' }]);
  };
  const removeSocialLink = (i: number) => {
    const next = socialLinks.filter((_, idx) => idx !== i);
    setSocialLinks(next);
    saveConfig({ socialLinks: next });
  };
  const updateSocialLink = (i: number, field: string, value: string) => {
    const next = [...socialLinks];
    (next[i] as any)[field] = value;
    if (field === 'url') next[i].type = detectPlatform(value);
    setSocialLinks(next);
  };
  const saveSocialLinks = () => saveConfig({ socialLinks });

  // ── Pinned Message ──
  const savePinned = () => saveConfig({ pinnedMessage: pinned });

  // ── Announcements ──
  const saveAnnouncement = async () => {
    if (!annForm?.title) return;
    setSaving(true);
    try {
      if (annForm.id) {
        await api.put(`/rooms/${roomId}/lobby/announcements/${annForm.id}`, annForm);
      } else {
        await api.post(`/rooms/${roomId}/lobby/announcements`, annForm);
      }
      setAnnForm(null);
      loadData();
    } catch {}
    setSaving(false);
  };
  const deleteAnnouncement = async (id: string) => {
    if (!confirm('Delete this announcement?')) return;
    await api.delete(`/rooms/${roomId}/lobby/announcements/${id}`);
    loadData();
  };

  // ── Shelf ──
  const saveShelfItem = async () => {
    if (!shelfForm?.url || !shelfForm?.title) return;
    setSaving(true);
    try {
      await api.post(`/rooms/${roomId}/lobby/shelf`, shelfForm);
      setShelfForm(null);
      loadData();
    } catch {}
    setSaving(false);
  };
  const deleteShelfItem = async (id: string) => {
    if (!confirm('Remove this item?')) return;
    await api.delete(`/rooms/${roomId}/lobby/shelf/${id}`);
    loadData();
  };

  // ── Feed Settings ──
  const toggleFeedType = (type: string) => {
    const next = { ...feedSettings };
    if (next.enabledTypes.includes(type)) {
      next.enabledTypes = next.enabledTypes.filter(t => t !== type);
    } else {
      next.enabledTypes = [...next.enabledTypes, type];
    }
    setFeedSettings(next);
  };
  const saveFeedSettings = () => saveConfig({ feedSettings });

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
      <h1 className="font-display text-2xl font-bold">Lobby Settings</h1>

      {/* ── 1. Social Links ── */}
      <NeonCard title="Social Links">
        <div className="space-y-2">
          {socialLinks.map((link, i) => (
            <div key={i} className="flex items-center gap-2">
              <select
                value={link.type}
                onChange={e => updateSocialLink(i, 'type', e.target.value)}
                className="bg-raised border border-border rounded px-2 py-1.5 text-xs text-primary w-24 flex-shrink-0"
              >
                {SOCIAL_PLATFORMS.map(p => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              <input
                value={link.url}
                onChange={e => updateSocialLink(i, 'url', e.target.value)}
                placeholder="https://..."
                className="flex-1 bg-raised border border-border rounded px-2 py-1.5 text-xs text-primary min-w-0"
              />
              <input
                value={link.label || ''}
                onChange={e => updateSocialLink(i, 'label', e.target.value)}
                placeholder="Label (optional)"
                className="w-28 bg-raised border border-border rounded px-2 py-1.5 text-xs text-primary"
              />
              <button onClick={() => removeSocialLink(i)} className="text-neon-magenta/60 hover:text-neon-magenta cursor-pointer bg-transparent border-0 p-1">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 mt-3">
          <NeonButton variant="ghost" onClick={addSocialLink}>
            <Plus size={14} className="mr-1" /> Add Link
          </NeonButton>
          <NeonButton onClick={saveSocialLinks} disabled={saving}>Save</NeonButton>
        </div>
      </NeonCard>

      {/* ── 2. Pinned Message ── */}
      <NeonCard title="Pinned Message">
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={pinned.enabled}
              onChange={e => setPinned({ ...pinned, enabled: e.target.checked })}
              className="accent-neon-cyan"
            />
            <span className="text-muted">Show pinned message in lobby</span>
          </label>
          <textarea
            value={pinned.content}
            onChange={e => setPinned({ ...pinned, content: e.target.value })}
            placeholder="Write a message for the lobby banner..."
            rows={3}
            className="w-full bg-raised border border-border rounded px-3 py-2 text-sm text-primary resize-none"
          />
          {pinned.enabled && pinned.content && (
            <div className="bg-neon-cyan/5 border border-neon-cyan/20 rounded-lg px-3 py-2 text-sm text-primary">
              <span className="text-[10px] uppercase text-faint block mb-1">Preview</span>
              {pinned.content}
            </div>
          )}
          <NeonButton onClick={savePinned} disabled={saving}>Save</NeonButton>
        </div>
      </NeonCard>

      {/* ── 3. Announcements ── */}
      <NeonCard title="Announcements">
        {/* List */}
        {announcements.length === 0 && !annForm && (
          <p className="text-xs text-muted mb-3">No announcements yet.</p>
        )}
        {announcements.map(a => {
          const status = announcementStatus(a);
          return (
            <div key={a.id} className="flex items-start gap-3 py-2 border-b border-border/30 last:border-0">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-primary truncate">{a.title}</span>
                  <span className={`text-[10px] ${status.color}`}>{status.label}</span>
                  <span className="text-[10px] text-faint bg-raised px-1.5 py-0.5 rounded">{a.type}</span>
                </div>
                {a.body && <p className="text-xs text-muted mt-0.5 truncate">{a.body}</p>}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => setAnnForm(a)}
                  className="text-xs text-muted hover:text-neon-cyan cursor-pointer bg-transparent border-0 px-1"
                >
                  Edit
                </button>
                <button
                  onClick={() => deleteAnnouncement(a.id)}
                  className="text-neon-magenta/60 hover:text-neon-magenta cursor-pointer bg-transparent border-0 p-1"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          );
        })}

        {/* Form */}
        {annForm ? (
          <div className="mt-3 space-y-2 bg-raised/50 border border-border/30 rounded-lg p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted">{annForm.id ? 'Edit' : 'New'} Announcement</span>
              <button onClick={() => setAnnForm(null)} className="text-muted hover:text-primary cursor-pointer bg-transparent border-0 p-0.5">
                <X size={14} />
              </button>
            </div>
            <input
              value={annForm.title || ''}
              onChange={e => setAnnForm({ ...annForm, title: e.target.value })}
              placeholder="Title *"
              className="w-full bg-raised border border-border rounded px-2 py-1.5 text-xs text-primary"
            />
            <textarea
              value={annForm.body || ''}
              onChange={e => setAnnForm({ ...annForm, body: e.target.value })}
              placeholder="Body (optional)"
              rows={2}
              className="w-full bg-raised border border-border rounded px-2 py-1.5 text-xs text-primary resize-none"
            />
            <div className="grid grid-cols-2 gap-2">
              <select
                value={annForm.type || 'announcement'}
                onChange={e => setAnnForm({ ...annForm, type: e.target.value })}
                className="bg-raised border border-border rounded px-2 py-1.5 text-xs text-primary"
              >
                <option value="announcement">Announcement</option>
                <option value="tournament">Tournament</option>
                <option value="new_table">New Table</option>
                <option value="event">Event</option>
              </select>
              <input
                value={annForm.cta_url || ''}
                onChange={e => setAnnForm({ ...annForm, cta_url: e.target.value })}
                placeholder="CTA URL (optional)"
                className="bg-raised border border-border rounded px-2 py-1.5 text-xs text-primary"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={annForm.cta_label || ''}
                onChange={e => setAnnForm({ ...annForm, cta_label: e.target.value })}
                placeholder="CTA Label"
                className="bg-raised border border-border rounded px-2 py-1.5 text-xs text-primary"
              />
              <input
                type="datetime-local"
                value={annForm.event_datetime?.slice(0, 16) || ''}
                onChange={e => setAnnForm({ ...annForm, event_datetime: e.target.value ? new Date(e.target.value).toISOString() : null })}
                className="bg-raised border border-border rounded px-2 py-1.5 text-xs text-primary"
                title="Event date (for countdown)"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-faint block mb-0.5">Show from</label>
                <input
                  type="datetime-local"
                  value={annForm.display_from?.slice(0, 16) || ''}
                  onChange={e => setAnnForm({ ...annForm, display_from: e.target.value ? new Date(e.target.value).toISOString() : undefined })}
                  className="w-full bg-raised border border-border rounded px-2 py-1.5 text-xs text-primary"
                />
              </div>
              <div>
                <label className="text-[10px] text-faint block mb-0.5">Hide after (optional)</label>
                <input
                  type="datetime-local"
                  value={annForm.display_until?.slice(0, 16) || ''}
                  onChange={e => setAnnForm({ ...annForm, display_until: e.target.value ? new Date(e.target.value).toISOString() : null })}
                  className="w-full bg-raised border border-border rounded px-2 py-1.5 text-xs text-primary"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <NeonButton variant="ghost" onClick={() => setAnnForm(null)}>Cancel</NeonButton>
              <NeonButton onClick={saveAnnouncement} disabled={saving || !annForm.title}>Save</NeonButton>
            </div>
          </div>
        ) : (
          <div className="mt-3">
            <NeonButton variant="ghost" onClick={() => setAnnForm({ type: 'announcement' })}>
              <Plus size={14} className="mr-1" /> New Announcement
            </NeonButton>
          </div>
        )}
      </NeonCard>

      {/* ── 4. Community Shelf ── */}
      <NeonCard title="Community Shelf">
        <p className="text-xs text-muted mb-3">Add YouTube videos, Twitch clips, articles, or links for your community.</p>
        {shelf.map(item => (
          <div key={item.id} className="flex items-center gap-2 py-1.5 border-b border-border/30 last:border-0">
            <GripVertical size={14} className="text-faint flex-shrink-0" />
            <span className="text-[10px] text-faint bg-raised px-1.5 py-0.5 rounded flex-shrink-0">{item.type}</span>
            <span className="text-sm text-primary truncate flex-1 min-w-0">{item.title}</span>
            <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-muted hover:text-neon-cyan flex-shrink-0">
              <ExternalLink size={13} />
            </a>
            <button
              onClick={() => deleteShelfItem(item.id)}
              className="text-neon-magenta/60 hover:text-neon-magenta cursor-pointer bg-transparent border-0 p-1 flex-shrink-0"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}

        {shelfForm ? (
          <div className="mt-3 space-y-2 bg-raised/50 border border-border/30 rounded-lg p-3">
            <input
              value={shelfForm.url}
              onChange={e => setShelfForm({ ...shelfForm, url: e.target.value })}
              placeholder="URL *"
              className="w-full bg-raised border border-border rounded px-2 py-1.5 text-xs text-primary"
            />
            <input
              value={shelfForm.title}
              onChange={e => setShelfForm({ ...shelfForm, title: e.target.value })}
              placeholder="Title *"
              className="w-full bg-raised border border-border rounded px-2 py-1.5 text-xs text-primary"
            />
            <input
              value={shelfForm.description}
              onChange={e => setShelfForm({ ...shelfForm, description: e.target.value })}
              placeholder="Description (optional)"
              className="w-full bg-raised border border-border rounded px-2 py-1.5 text-xs text-primary"
            />
            <div className="flex justify-end gap-2">
              <NeonButton variant="ghost" onClick={() => setShelfForm(null)}>Cancel</NeonButton>
              <NeonButton onClick={saveShelfItem} disabled={saving || !shelfForm.url || !shelfForm.title}>Add</NeonButton>
            </div>
          </div>
        ) : (
          <div className="mt-3">
            <NeonButton variant="ghost" onClick={() => setShelfForm({ url: '', title: '', description: '' })}>
              <Plus size={14} className="mr-1" /> Add Item
            </NeonButton>
          </div>
        )}
      </NeonCard>

      {/* ── 5. Feed Settings ── */}
      <NeonCard title="Feed Settings">
        <div className="space-y-4">
          {/* Enabled event types */}
          <div>
            <label className="text-xs font-semibold text-muted block mb-2">Enabled Event Types</label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {ALL_FEED_TYPES.map(type => (
                <label key={type} className="flex items-center gap-1.5 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={feedSettings.enabledTypes.includes(type)}
                    onChange={() => toggleFeedType(type)}
                    className="accent-neon-cyan"
                  />
                  <span className="text-muted">{type.replace(/_/g, ' ')}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Staleness threshold */}
          <div className="flex items-center gap-3">
            <label className="text-xs text-muted flex-shrink-0">Staleness challenge after</label>
            <input
              type="number"
              value={feedSettings.stalenessThresholdDays}
              onChange={e => setFeedSettings({ ...feedSettings, stalenessThresholdDays: parseInt(e.target.value) || 14 })}
              min={1}
              max={90}
              className="w-16 bg-raised border border-border rounded px-2 py-1 text-xs text-primary text-center"
            />
            <span className="text-xs text-muted">days of no scores</span>
          </div>

          {/* Room stats frequency */}
          <div className="flex items-center gap-3">
            <label className="text-xs text-muted flex-shrink-0">Room stats summary</label>
            <select
              value={feedSettings.roomStatsFrequency}
              onChange={e => setFeedSettings({ ...feedSettings, roomStatsFrequency: e.target.value as any })}
              className="bg-raised border border-border rounded px-2 py-1 text-xs text-primary"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>

          <NeonButton onClick={saveFeedSettings} disabled={saving}>Save Feed Settings</NeonButton>
        </div>
      </NeonCard>
    </div>
  );
}
