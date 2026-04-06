import { Fragment, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../lib/api';
import { useRoom } from '../contexts/RoomContext';
import { useToast } from '../components/Toast';
import { useTheme, THEMES, type ThemeId } from '../components/ThemeProvider';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import ConfirmModal from '../components/ConfirmModal';
import LoadingState from '../components/LoadingState';
import { InfoTip } from '../components/Tooltip';
import PresetSelector from '../components/PresetSelector';
import type { PresetDefinition } from '../components/PresetSelector';
import StyleThemePicker from '../components/scoreboard/StyleThemePicker';
import ScoreboardPreview from '../components/ScoreboardPreview';
import ImageCropper from '../components/ImageCropper';
import { getTitleStyleClass, getTitleSizeClass } from '../components/ScoreboardComponents';

interface LocalAdmin {
  id: string;
  username: string;
  display_name: string;
  created_at: string;
}

interface DiscordAdmin {
  discord_user_id: string;
  role: string;
}

interface PendingInvite {
  id: string;
  token: string;
  display_name: string;
  discord_user_id: string | null;
  created_by: string | null;
  expires_at: string;
  created_at: string;
}

const SENSITIVE_KEYS = ['ISCORED_PASSWORD', 'ADMIN_PASSWORD_HASH'];

const CATEGORIES: Record<string, string[]> = {
  'Scoreboard Display': ['SCOREBOARD_LAYOUT', 'SCOREBOARD_GAME_COLUMNS', 'SCOREBOARD_CARD_SIZE', 'SCOREBOARD_CARD_LAYOUT', 'SCOREBOARD_WHEEL_SCALE', 'SCOREBOARD_BG_FILL', 'SCOREBOARD_BG_SIZE', 'SCOREBOARD_SCORE_STYLE', 'SCOREBOARD_GLASS_OPACITY', 'SCOREBOARD_GAME_TITLE_STYLE', 'SCOREBOARD_SCORE_COLUMNS', 'SCOREBOARD_MAX_SCORES', 'SCOREBOARD_RANKINGS_POSITION', 'SCOREBOARD_ZOOM', 'SCOREBOARD_CARD_OPACITY', 'SCOREBOARD_QR_MODE'],
  'Kiosk': ['KIOSK_REFRESH_SECONDS'],
  'Game Room': ['GAME_ROOM_NAME', 'GAME_ROOM_SLUG'],
  'Discord': ['DISCORD_GUILD_ID', 'DISCORD_ADMIN_ROLE_ID', 'DISCORD_ANNOUNCEMENT_CHANNEL_ID'],
  'iScored': ['ISCORED_USERNAME', 'ISCORED_PASSWORD', 'ISCORED_PUBLIC_URL'],
};

// Toggles that render inside the Scoreboard Display card
const SCOREBOARD_TOGGLES: Record<string, { label: string; description: string; defaultOn?: boolean }> = {
  'SCOREBOARD_HIDE_EMPTY': {
    label: 'Hide Empty Games',
    description: 'When enabled, game cards with no scores are hidden from the public scoreboard.',
  },
  'SCOREBOARD_TITLE_HIDDEN': {
    label: 'Hide Game Room Title',
    description: 'When enabled, the game room name/heading (e.g., "ArcAid_Demo") is hidden on the public scoreboard.',
  },
  'SCOREBOARD_GAME_TITLE_ENHANCE': {
    label: 'Enhance Game Title Visibility',
    description: 'When enabled, adds a dark backdrop behind game title text for readability on busy backgrounds.',
  },
  'SCOREBOARD_CARD_BG_FILL': {
    label: 'Card Background Fill',
    description: 'When enabled, game background images fill the entire card behind scores for an immersive look.',
  },
  'SCOREBOARD_RANKINGS_STICKY': {
    label: 'Always Visible Rankings',
    description: 'When enabled, the Overall Rankings card stays pinned on screen and does not scroll away.',
  },
  'REQUIRE_SCORE_PHOTO': {
    label: 'Require Photo with Score Submission',
    description: 'When enabled, players must include a photo when submitting scores from the scoreboard.',
  },
};

// Toggles that render inside the Kiosk card
const KIOSK_TOGGLES: Record<string, { label: string; description: string; defaultOn?: boolean }> = {
  'KIOSK_ENABLED': {
    label: 'Kiosk Mode',
    description: 'When enabled, the kiosk display page is available at /{slug}/kiosk. When disabled, the kiosk page returns a 404.',
    defaultOn: true,
  },
};

// Toggles that render inside the Global Card Styles card
const GLOBAL_CARD_TOGGLES: Record<string, { label: string; description: string; defaultOn?: boolean }> = {
  GLOBAL_CARD_STYLES_ENABLED: {
    label: 'Enable Global Card Styles',
    description: 'When enabled, the color settings below override individual game card styles on the scoreboard.',
  },
};

// Remaining feature toggles (Discord/iScored)
const TOGGLE_SETTINGS: Record<string, { label: string; description: string; defaultOn?: boolean }> = {
  'ISCORED_ENABLED': {
    label: 'iScored Integration',
    description: 'When enabled, games are created and managed on iScored. Disable to use ArcAid leaderboards only.',
    defaultOn: true,
  },
  'DISCORD_MENTIONS_ENABLED': {
    label: 'Discord @Mentions',
    description: 'When enabled, the bot @mentions users in announcements (winner picks, reminders, etc.). Disable to use display names instead.',
    defaultOn: true,
  },
  'ENABLE_CALLOUTS': {
    label: 'Callouts (Easter Egg)',
    description: 'When enabled, the bot responds to trigger words defined in data/callouts.json.',
  },
};

const SETTING_LABELS: Record<string, { label: string; description: string }> = {
  // Game Room
  GAME_ROOM_NAME: { label: 'Game Room Name', description: 'Display name shown on the public landing page and all public pages.' },
  GAME_ROOM_SLUG: { label: 'Game Room Slug', description: 'URL identifier for your room (e.g. "my_room" → /my_room/). Lowercase, no spaces.' },
  // Discord
  DISCORD_GUILD_ID: { label: 'Guild ID', description: 'Your Discord server ID. Right-click server name → Copy Server ID (requires Developer Mode).' },
  DISCORD_ADMIN_ROLE_ID: { label: 'Admin Role ID', description: 'Discord role that grants access to admin bot commands. Right-click role → Copy Role ID.' },
  DISCORD_ANNOUNCEMENT_CHANNEL_ID: { label: 'Default Announcement Channel ID', description: 'Default channel for tournament announcements. Used when a tournament doesn\'t have its own channel configured. Right-click channel → Copy Channel ID.' },
  // iScored
  ISCORED_USERNAME: { label: 'iScored Username', description: 'Login email or username for your room\'s iScored.info account.' },
  ISCORED_PASSWORD: { label: 'iScored Password', description: 'Password for the iScored account. Used for automated game creation and score scraping.' },
  ISCORED_PUBLIC_URL: { label: 'iScored Public URL', description: 'Public leaderboard URL for score scraping (e.g. https://iscored.info/your_account).' },
  // Scoreboard
  SCOREBOARD_MAX_SCORES: { label: 'Scores Per Card', description: 'Maximum number of scores displayed per game card on the public scoreboard. Default: 5.' },
  SCOREBOARD_ZOOM: { label: 'Zoom Level (%)', description: 'Scale the scoreboard for high-res monitors or TV displays. Range: 50-200. Default: 100.' },
  SCOREBOARD_TITLE: { label: 'Scoreboard Title', description: 'Custom title displayed on the public scoreboard. Leave empty to use the room name.' },
  SCOREBOARD_TITLE_STYLE: { label: 'Title Style', description: 'Visual style for the scoreboard title: default, glow, retro, or pixel.' },
  SCOREBOARD_TITLE_SIZE: { label: 'Title Size', description: 'Font size for the scoreboard title. Default: small.' },
  SCOREBOARD_CARD_OPACITY: { label: 'Card Transparency', description: 'Opacity of score cards and ranking cards. 100% = fully opaque (default), 0% = fully transparent.' },
  SCOREBOARD_LAYOUT: { label: 'Layout Mode', description: 'Score card layout: scroll (horizontal scrolling, default) or grid (CSS grid with rows and columns).' },
  SCOREBOARD_CARDS_PER_ROW: { label: 'Cards Per Row (Grid)', description: 'Number of score cards per row in grid mode. Range: 2-8. Default: 4. Only applies in grid layout.' },
  SCOREBOARD_CARD_SIZE: { label: 'Card Size', description: 'Card width preset: small (240px), medium (288px, default), or large (360px).' },
  SCOREBOARD_RANKINGS_POSITION: { label: 'Rankings Position', description: 'Where overall rankings are displayed: left (default), right, top, bottom, or hidden.' },
  SCOREBOARD_GAME_COLUMNS: { label: 'Game Columns (Grid)', description: 'Number of game cards per row in grid mode. Auto: fills based on card size. 2-Column: exactly 2 cards per row on desktop, 1 on mobile.' },
  SCOREBOARD_CARD_LAYOUT: { label: 'Card Layout', description: 'Controls the layout of game cards. Banner: full-width artwork header. Compact: small thumbnail with title. Wheel: image centered above card. Sidebar: image left of game title.' },
  SCOREBOARD_BG_FILL: { label: 'Card Background Fill', description: 'When enabled, the game background image fills the entire card behind the layout with glass-panel styling for readability.' },
  SCOREBOARD_BG_SIZE: { label: 'Card Background Sizing', description: 'How game background images are sized. Cover: fills area (may crop). Contain: fits entirely (no crop). Tile: repeats the image as a pattern.' },
  SCOREBOARD_WHEEL_SCALE: { label: 'Wheel Icon Size', description: 'Size of wheel icons in Wheel header mode. Default: 150. Only applies when Card Header Style is set to Wheel.' },
  SCOREBOARD_SCORE_STYLE: { label: 'Score Entry Style', description: 'How score entries are styled on cards. Glass: frosted panel behind scores. Shadow/Outlined/Glow: text effects with no panel, letting background images show through.' },
  SCOREBOARD_GLASS_OPACITY: { label: 'Glass Panel Opacity', description: 'Opacity of glass panels overlaying the background in Fill mode. 0 = transparent, 100 = fully opaque. Default: 60.' },
  SCOREBOARD_GAME_TITLE_STYLE: { label: 'Game Title Style', description: 'Visual style for game name text on score cards. Applies when game name is shown (no identifier image).' },
  SCOREBOARD_SCORE_COLUMNS: { label: 'Score Columns', description: 'Number of score columns within each card. 2 columns shows ranks side-by-side (e.g. 1-5 left, 6-10 right). Collapses to 1 on mobile.' },
  SCOREBOARD_QR_MODE: { label: 'QR Codes', description: 'Show QR codes on score cards linking to mobile score submission. Disabled: no QR codes. Kiosk Only: QR on kiosk display. All: QR on both scoreboard and kiosk.' },
  // Scoreboard Branding
  SCOREBOARD_BG_MODE: { label: 'Background Mode', description: 'How the background image is displayed: cover (fill screen), contain (fit), repeat (tile), or center.' },
  SCOREBOARD_BG_OPACITY: { label: 'Background Opacity', description: 'Opacity of the background image. 100% = fully visible (default), 0% = fully hidden. Lower values let the dark theme show through.' },
  LOGO_POSITION: { label: 'Logo Position', description: 'Where the logo appears relative to the scoreboard title: left, right, above, or below.' },
  LOGO_MAX_HEIGHT: { label: 'Logo Max Height (px)', description: 'Maximum height of the logo in pixels. Default: 64.' },
  // Kiosk
  KIOSK_REFRESH_SECONDS: { label: 'Kiosk Auto-Refresh (seconds)', description: 'How often the kiosk view refreshes data. Default: 60. Set to 0 to disable auto-refresh.' },
};

const SELECT_OPTIONS: Record<string, { value: string; label: string }[]> = {
  SCOREBOARD_TITLE_STYLE: [
    { value: 'default', label: 'Default' },
    { value: 'glow', label: 'Neon Cyan' },
    { value: 'neon-magenta', label: 'Neon Magenta' },
    { value: 'chrome', label: 'Chrome' },
    { value: 'fire', label: 'Fire' },
    { value: 'plasma', label: 'Plasma' },
    { value: 'backglass', label: 'Backglass' },
    { value: 'marquee', label: 'Marquee' },
    { value: 'retro', label: 'Retro' },
    { value: 'pixel', label: 'Pixel' },
    { value: 'shadow', label: 'Shadow' },
    { value: 'outlined', label: 'Outlined' },
  ],
  SCOREBOARD_TITLE_SIZE: [
    { value: 'xs', label: 'Extra Small' },
    { value: 'sm', label: 'Small (Default)' },
    { value: 'base', label: 'Medium' },
    { value: 'lg', label: 'Large' },
    { value: 'xl', label: 'Extra Large' },
    { value: '2xl', label: '2X Large' },
    { value: '3xl', label: '3X Large' },
    { value: '4xl', label: '4X Large' },
  ],
  SCOREBOARD_LAYOUT: [
    { value: 'scroll', label: 'Horizontal Scroll' },
    { value: 'grid', label: 'Grid' },
  ],
  SCOREBOARD_CARD_SIZE: [
    { value: 'small', label: 'Small (240px)' },
    { value: 'medium', label: 'Medium (288px)' },
    { value: 'large', label: 'Large (360px)' },
  ],
  SCOREBOARD_RANKINGS_POSITION: [
    { value: 'left', label: 'Left' },
    { value: 'right', label: 'Right' },
    { value: 'top', label: 'Top' },
    { value: 'bottom', label: 'Bottom' },
    { value: 'hidden', label: 'Hidden' },
  ],
  SCOREBOARD_GAME_COLUMNS: [
    { value: 'auto', label: 'Auto (fill by card size)' },
    { value: '2', label: '2-Column (desktop)' },
  ],
  SCOREBOARD_CARD_LAYOUT: [
    { value: 'banner', label: 'Banner' },
    { value: 'compact', label: 'Compact' },
    { value: 'wheel', label: 'Wheel Icon' },
    { value: 'sidebar', label: 'Sidebar (image left of title)' },
  ],
  SCOREBOARD_BG_FILL: [
    { value: 'off', label: 'Off (header area only)' },
    { value: 'fill', label: 'Fill (image fills entire card)' },
  ],
  SCOREBOARD_BG_SIZE: [
    { value: 'cover', label: 'Cover (stretch to fill)' },
    { value: 'contain', label: 'Contain (fit, no crop)' },
    { value: 'tile', label: 'Tile (repeat pattern)' },
  ],
  SCOREBOARD_WHEEL_SCALE: [
    { value: '100', label: 'Small (100%)' },
    { value: '125', label: 'Medium (125%)' },
    { value: '150', label: 'Large (150%) — Default' },
    { value: '175', label: 'X-Large (175%)' },
    { value: '200', label: 'XX-Large (200%)' },
  ],
  SCOREBOARD_SCORE_STYLE: [
    { value: 'glass', label: 'Glass Panel (Default)' },
    { value: 'shadow', label: 'Shadow (Drop Shadow)' },
    { value: 'outlined', label: 'Outlined (Stroke)' },
    { value: 'glow', label: 'Glow (Neon)' },
  ],
  SCOREBOARD_GAME_TITLE_STYLE: [
    { value: 'default', label: 'Default (Plain)' },
    { value: 'glow', label: 'Glow (Neon)' },
    { value: 'shadow', label: 'Shadow (Drop Shadow)' },
    { value: 'outlined', label: 'Outlined (Stroke)' },
    { value: 'backlit', label: 'Backlit (Dark Pill)' },
  ],
  SCOREBOARD_SCORE_COLUMNS: [
    { value: '1', label: '1 Column (Default)' },
    { value: '2', label: '2 Columns (Side-by-Side)' },
  ],
  SCOREBOARD_QR_MODE: [
    { value: 'disabled', label: 'Disabled' },
    { value: 'kiosk-only', label: 'Kiosk Only' },
    { value: 'all', label: 'All Scoreboards' },
  ],
  SCOREBOARD_BG_MODE: [
    { value: 'cover', label: 'Cover (Fill Screen)' },
    { value: 'contain', label: 'Contain (Fit)' },
    { value: 'repeat', label: 'Repeat (Tile)' },
    { value: 'center', label: 'Center' },
  ],
  LOGO_POSITION: [
    { value: 'left', label: 'Left of Title' },
    { value: 'right', label: 'Right of Title' },
    { value: 'above', label: 'Above Title' },
    { value: 'below', label: 'Below Title' },
  ],
};

const inputClass = "w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors";

function PlatformsEditor({ platforms, onChange, roomId, toast }: { platforms: string[]; onChange: (p: string[]) => void; roomId: string; toast: (msg: string, type?: 'success' | 'error') => void }) {
  const [newPlatform, setNewPlatform] = useState('');

  const handleAdd = () => {
    const name = newPlatform.trim();
    if (!name || platforms.includes(name)) return;
    onChange([...platforms, name]);
    setNewPlatform('');
  };

  const handleRemove = async (p: string) => {
    try {
      const usage = await api.get<{ inUse: boolean; tournaments: string[] }>(
        `/rooms/${roomId}/admin/platform-usage/${encodeURIComponent(p)}`
      );
      if (usage.inUse) {
        toast(`Platform "${p}" is in use by tournament(s): ${usage.tournaments.join(', ')}. Modify the tournament settings first.`, 'error');
        return;
      }
    } catch {
      // If the check fails, allow removal anyway
    }
    onChange(platforms.filter(x => x !== p));
  };

  const handleRename = (old: string, updated: string) => {
    onChange(platforms.map(x => x === old ? updated : x));
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-3">
        {platforms.map(p => (
          <div key={p} className="flex items-center gap-1 bg-raised border border-border rounded px-2 py-1">
            <input
              type="text"
              value={p}
              onChange={e => handleRename(p, e.target.value)}
              className="bg-transparent text-sm text-primary border-none outline-none w-24"
            />
            <button
              onClick={() => handleRemove(p)}
              className="text-faint hover:text-neon-magenta text-xs cursor-pointer bg-transparent border-none"
              title="Remove platform"
            >
              &times;
            </button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="New platform name"
          value={newPlatform}
          onChange={e => setNewPlatform(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
          className={`${inputClass} w-48`}
        />
        <NeonButton variant="secondary" onClick={handleAdd}>Add</NeonButton>
      </div>
    </div>
  );
}

export default function Settings() {
  const room = useRoom();
  const { toast } = useToast();
  const { publicTheme, setPublicTheme, adminTheme, setAdminTheme } = useTheme();
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [reloadingScheduler, setReloadingScheduler] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeFrom, setMergeFrom] = useState('');
  const [mergeTo, setMergeTo] = useState('');
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  // Users state
  const [localAdmins, setLocalAdmins] = useState<LocalAdmin[]>([]);
  const [discordAdmins, setDiscordAdmins] = useState<DiscordAdmin[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [showDiscordForm, setShowDiscordForm] = useState(false);
  const [inviteDisplayName, setInviteDisplayName] = useState('');
  const [inviteDiscordId, setInviteDiscordId] = useState('');
  const [inviting, setInviting] = useState(false);
  const [newDiscordUser, setNewDiscordUser] = useState('');
  const [addingDiscord, setAddingDiscord] = useState(false);
  const [deleteAdminTarget, setDeleteAdminTarget] = useState<LocalAdmin | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  // Branding upload state
  const [bgUrl, setBgUrl] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [uploadingBg, setUploadingBg] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  // Branding cropper state
  const [brandingCropSrc, setBrandingCropSrc] = useState<string | null>(null);
  const [brandingCropTarget, setBrandingCropTarget] = useState<'bg' | 'logo' | null>(null);

  const fetchAdmins = async () => {
    try {
      const data = await api.get<{ localAdmins: LocalAdmin[]; discordAdmins: DiscordAdmin[] }>(`/rooms/${room.roomId}/admins`);
      setLocalAdmins(data.localAdmins);
      setDiscordAdmins(data.discordAdmins);
    } catch {}
  };

  const fetchInvites = async () => {
    try {
      const data = await api.get<PendingInvite[]>(`/rooms/${room.roomId}/admins/invites`);
      setPendingInvites(data);
    } catch {}
  };

  const handleInvite = async () => {
    if (!inviteDisplayName.trim()) { toast('Display name required', 'error'); return; }
    setInviting(true);
    try {
      const result = await api.post<{ id: string; token: string; dmSent: boolean }>(`/rooms/${room.roomId}/admins/invites`, {
        display_name: inviteDisplayName.trim(),
        discord_user: inviteDiscordId.trim() || undefined,
      });
      const inviteUrl = `${window.location.origin}/invite/${result.token}`;
      if (result.dmSent) {
        toast('Invite sent via Discord DM', 'success');
      } else if (inviteDiscordId.trim()) {
        toast('Invite created but Discord DM could not be sent. Copy the link to share manually.', 'error');
      } else {
        toast('Invite created. Copy the link to share.', 'success');
      }
      // Auto-copy to clipboard
      try { await navigator.clipboard.writeText(inviteUrl); } catch {}
      setInviteDisplayName('');
      setInviteDiscordId('');
      setShowInviteForm(false);
      fetchInvites();
    } catch (err: any) {
      toast(err.message || 'Failed to create invite', 'error');
    } finally {
      setInviting(false);
    }
  };

  const handleDeleteAdmin = async () => {
    if (!deleteAdminTarget) return;
    try {
      await api.delete(`/rooms/${room.roomId}/admins/local/${deleteAdminTarget.id}`);
      toast(`Removed ${deleteAdminTarget.display_name || deleteAdminTarget.username}`, 'success');
      setDeleteAdminTarget(null);
      fetchAdmins();
    } catch {
      toast('Failed to remove admin', 'error');
    }
  };

  const handleCancelInvite = async (id: string) => {
    try {
      await api.delete(`/rooms/${room.roomId}/admins/invites/${id}`);
      toast('Invite cancelled', 'success');
      fetchInvites();
    } catch {
      toast('Failed to cancel invite', 'error');
    }
  };

  const handleAddDiscordAdmin = async () => {
    if (!newDiscordUser.trim()) return;
    setAddingDiscord(true);
    try {
      await api.post(`/rooms/${room.roomId}/admins/discord`, { discord_user: newDiscordUser.trim() });
      toast('Discord admin added. They can now log in via Discord OAuth.', 'success');
      setNewDiscordUser('');
      setShowDiscordForm(false);
      fetchAdmins();
    } catch (err: any) {
      toast(err.message || 'Failed to add Discord admin', 'error');
    } finally {
      setAddingDiscord(false);
    }
  };

  const handleRemoveDiscordAdmin = async (discordUserId: string) => {
    try {
      await api.delete(`/rooms/${room.roomId}/admins/discord/${discordUserId}`);
      toast('Discord admin removed', 'success');
      fetchAdmins();
    } catch {
      toast('Failed to remove Discord admin', 'error');
    }
  };

  const copyInviteLink = async (token: string) => {
    const url = `${window.location.origin}/invite/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(null), 2000);
    } catch {
      toast('Failed to copy link', 'error');
    }
  };

  useEffect(() => {
    api.get<Record<string, string>>(`/rooms/${room.roomId}/settings`)
      .then(data => {
        setSettings(data);
        // Sync global theme from settings
        if (data.UI_THEME && data.UI_THEME !== publicTheme) {
          setPublicTheme(data.UI_THEME as ThemeId);
        }
        if (data.ADMIN_THEME && data.ADMIN_THEME !== adminTheme) {
          setAdminTheme(data.ADMIN_THEME as ThemeId);
        }
        setBgUrl(data.SCOREBOARD_BG_URL || '');
        setLogoUrl(data.LOGO_URL || '');
        setLoading(false);
      })
      .catch(() => { toast('Failed to load settings', 'error'); setLoading(false); });
    fetchAdmins();
    fetchInvites();
  }, []);

  const handleChange = (key: string, value: string) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const handlePresetSelect = (preset: PresetDefinition) => {
    setSettings(prev => ({ ...prev, ...preset.settings }));
  };

  const handleBrandingCropConfirm = async (blob: Blob) => {
    const target = brandingCropTarget;
    setBrandingCropSrc(null);
    setBrandingCropTarget(null);
    if (!target) return;

    const endpoint = target === 'bg' ? 'background' : 'logo';
    const setUploading = target === 'bg' ? setUploadingBg : setUploadingLogo;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', new File([blob], `${endpoint}.png`, { type: 'image/png' }));
      const result = await api.upload<{ success: boolean; url: string }>(`/rooms/${room.roomId}/admin/upload/${endpoint}`, formData);
      if (target === 'bg') {
        setBgUrl(result.url);
        setSettings(prev => ({ ...prev, SCOREBOARD_BG_URL: result.url }));
      } else {
        setLogoUrl(result.url);
        setSettings(prev => ({ ...prev, LOGO_URL: result.url }));
      }
      toast(`${target === 'bg' ? 'Background' : 'Logo'} uploaded`, 'success');
    } catch (err: any) {
      toast(err.message || 'Upload failed', 'error');
    } finally {
      setUploading(false);
    }
  };

  const handleBrandingCropCancel = () => {
    if (brandingCropSrc) URL.revokeObjectURL(brandingCropSrc);
    setBrandingCropSrc(null);
    setBrandingCropTarget(null);
  };

  // Smart constraints: keys to hide based on current settings
  const hiddenKeys = new Set<string>();
  if ((settings.SCOREBOARD_CARD_LAYOUT || 'banner') !== 'wheel') {
    hiddenKeys.add('SCOREBOARD_WHEEL_SCALE');
  }
  if ((settings.SCOREBOARD_BG_FILL || 'off') === 'off' && (settings.SCOREBOARD_CARD_LAYOUT || 'banner') !== 'banner') {
    hiddenKeys.add('SCOREBOARD_BG_SIZE');
  }
  if ((settings.SCOREBOARD_BG_FILL || 'off') === 'off') {
    hiddenKeys.add('SCOREBOARD_GLASS_OPACITY');
  }

  const handleSave = async () => {
    setSaving(true);
    try {
      // Filter out ADMIN_PASSWORD_HASH — server rejects it via this endpoint
      const { ADMIN_PASSWORD_HASH: _, ...toSave } = settings;
      await api.post(`/rooms/${room.roomId}/settings`, toSave);
      toast('Settings saved', 'success');
    } catch {
      toast('Failed to save settings', 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggleReveal = (key: string) => {
    setRevealed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const isSensitive = (key: string) => SENSITIVE_KEYS.some(s => key.includes(s));

  // Group settings by category — always show all keys (default to empty string if not in DB)
  const categorized = Object.entries(CATEGORIES).map(([category, keys]) => ({
    category,
    entries: keys.map(k => [k, settings[k] ?? ''] as [string, string]),
  }));

  // Keys managed elsewhere (branding card, toggles, removed sections) — exclude from "Other"
  const managedKeys = new Set([
    ...Object.values(CATEGORIES).flat(),
    ...Object.keys(SCOREBOARD_TOGGLES),
    ...Object.keys(KIOSK_TOGGLES),
    ...Object.keys(TOGGLE_SETTINGS),
    // Scoreboard branding (managed in inline card)
    'SCOREBOARD_BG_URL', 'SCOREBOARD_BG_MODE', 'SCOREBOARD_BG_OPACITY',
    'LOGO_URL', 'LOGO_POSITION', 'LOGO_MAX_HEIGHT',
    'SCOREBOARD_TITLE', 'SCOREBOARD_TITLE_STYLE', 'SCOREBOARD_TITLE_SIZE',
    // Theme (managed in Theme card)
    'UI_THEME',
    // Platforms (managed in Platforms card)
    'PLATFORMS',
    // New style system advanced settings
    'SCOREBOARD_MIN_SCORES', 'SCOREBOARD_CARD_BG_FILL', 'SCOREBOARD_CARD_SPACING',
    'SCOREBOARD_TITLE_FONT_SIZE', 'SCOREBOARD_RANKINGS_STICKY',
    // New style system core keys
    'SCOREBOARD_STYLE', 'SCOREBOARD_THEME', 'SCOREBOARD_MAX_SCORES', 'SCOREBOARD_SHOW_TIMER',
    // Legacy/removed — no longer surfaced
    'SCOREBOARD_CARDS_PER_ROW',
  ]);
  const uncategorizedKeys = Object.keys(settings).filter(k => !managedKeys.has(k));

  if (loading) return <LoadingState message="Loading settings..." />;

  return (
    <div>
      <div className="sticky top-0 z-20 bg-deep/95 backdrop-blur-sm -mx-4 px-4 py-3 mb-4 border-b border-border/20">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-2xl font-bold">Settings</h1>
          <NeonButton onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save All Changes'}
          </NeonButton>
        </div>
      </div>

      <NeonCard title="Theme" className="mb-4">
        <div className="space-y-4">
          {/* Public Theme */}
          <div>
            <label className="text-xs text-faint block mb-1">Public Theme</label>
            <select
              value={settings.UI_THEME || publicTheme}
              onChange={e => {
                const newTheme = e.target.value as ThemeId;
                handleChange('UI_THEME', newTheme);
                setPublicTheme(newTheme);
              }}
              className={inputClass}
            >
              {Object.entries(THEMES).map(([id, { label, description }]) => (
                <option key={id} value={id}>{label} — {description}</option>
              ))}
            </select>
            <p className="text-xs text-muted mt-1">Applied to the public scoreboard, kiosk, and all public-facing pages.</p>
          </div>

          {/* Admin Theme (per-admin, saved to your preferences) */}
          <div>
            <label className="text-xs text-faint block mb-1">Admin Theme</label>
            <select
              value={adminTheme}
              onChange={e => {
                const newTheme = e.target.value as ThemeId;
                setAdminTheme(newTheme);
                api.post('/me/preferences', { ui_theme: newTheme }).catch(() => {
                  toast('Failed to save admin theme preference', 'error');
                });
              }}
              className={inputClass}
            >
              {Object.entries(THEMES).map(([id, { label, description }]) => (
                <option key={id} value={id}>{label} — {description}</option>
              ))}
            </select>
            <p className="text-xs text-muted mt-1">Your admin theme. Only affects your session — other admins see their own preference.</p>
          </div>
        </div>
      </NeonCard>

      <NeonCard title="Users" className="mb-4">
        <p className="text-muted text-sm mb-4">
          Manage admin accounts for this game room.
        </p>

        {/* Discord Admins */}
        <p className="text-xs font-display uppercase tracking-wider text-neon-cyan/70 mb-2 pl-2 border-l-2 border-neon-cyan/30">Discord Admins</p>
        <p className="text-xs text-faint mb-3">Log in via Discord OAuth — no password needed.</p>
        {discordAdmins.length > 0 ? (
          <div className="space-y-2 mb-3">
            {discordAdmins.map(admin => (
              <div key={admin.discord_user_id} className="flex items-center justify-between bg-raised border border-border rounded px-4 py-2">
                <div className="flex items-center gap-2">
                  <svg width="16" height="12" viewBox="0 0 71 55" fill="none" className="text-[#5865F2] flex-shrink-0">
                    <path d="M60.1045 4.8978C55.5792 2.8214 50.7265 1.2916 45.6527 0.41542C45.5603 0.39851 45.468 0.440769 45.4204 0.525289C44.7963 1.6353 44.105 3.0834 43.6209 4.2216C38.1637 3.4046 32.7345 3.4046 27.3892 4.2216C26.905 3.0581 26.1886 1.6353 25.5617 0.525289C25.5141 0.443589 25.4218 0.40133 25.3294 0.41542C20.2584 1.2888 15.4057 2.8186 10.8776 4.8978C10.8384 4.9147 10.8048 4.9429 10.7825 4.9795C1.57795 18.7309-0.943561 32.1443 0.293408 45.3914C0.299005 45.4562 0.335386 45.5182 0.385761 45.5576C6.45866 50.0174 12.3413 52.7249 18.1147 54.5195C18.2071 54.5477 18.305 54.5139 18.3638 54.4378C19.7295 52.5728 20.9469 50.6063 21.9907 48.5383C22.0523 48.4172 21.9935 48.2735 21.8676 48.2256C19.9366 47.4931 18.0979 46.6 16.3292 45.5858C16.1893 45.5041 16.1781 45.304 16.3068 45.2082C16.679 44.9293 17.0513 44.6391 17.4067 44.3461C17.471 44.2926 17.5606 44.2813 17.6362 44.3151C29.2558 49.6202 41.8354 49.6202 53.3179 44.3151C53.3935 44.2785 53.4831 44.2898 53.5502 44.3433C53.9057 44.6363 54.2779 44.9293 54.6529 45.2082C54.7816 45.304 54.7732 45.5041 54.6333 45.5858C52.8646 46.6197 51.0259 47.4931 49.0921 48.2228C48.9662 48.2707 48.9102 48.4172 48.9718 48.5383C50.038 50.6034 51.2554 52.5699 52.5959 54.435C52.6519 54.5139 52.7526 54.5477 52.845 54.5195C58.6464 52.7249 64.529 50.0174 70.6019 45.5576C70.6551 45.5182 70.6887 45.459 70.6943 45.3942C72.1747 30.0791 68.2147 16.7757 60.1968 4.9823C60.1772 4.9429 60.1437 4.9147 60.1045 4.8978ZM23.7259 37.3253C20.2276 37.3253 17.3451 34.1136 17.3451 30.1693C17.3451 26.225 20.1717 23.0133 23.7259 23.0133C27.308 23.0133 30.1626 26.2532 30.1099 30.1693C30.1099 34.1136 27.2802 37.3253 23.7259 37.3253ZM47.3178 37.3253C43.8196 37.3253 40.9371 34.1136 40.9371 30.1693C40.9371 26.225 43.7636 23.0133 47.3178 23.0133C50.9 23.0133 53.7545 26.2532 53.7018 30.1693C53.7018 34.1136 50.9 37.3253 47.3178 37.3253Z" fill="currentColor"/>
                  </svg>
                  <span className="font-mono text-sm text-primary">{admin.discord_user_id}</span>
                </div>
                <NeonButton
                  variant="ghost"
                  className="text-xs px-2 py-1 text-neon-magenta hover:text-neon-magenta"
                  onClick={() => handleRemoveDiscordAdmin(admin.discord_user_id)}
                >
                  Remove
                </NeonButton>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-faint text-sm mb-3">No Discord admins.</p>
        )}

        {showDiscordForm ? (
          <div className="border border-border rounded p-4 space-y-3 mb-6">
            <div>
              <label className="text-xs text-faint block mb-1">Discord Username *</label>
              <input
                type="text"
                placeholder="e.g. ChuckRibbits"
                value={newDiscordUser}
                onChange={e => setNewDiscordUser(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddDiscordAdmin()}
                className={inputClass}
                autoFocus
              />
              <p className="text-xs text-faint mt-1">Username or numeric ID. They'll be able to log in via Discord immediately.</p>
            </div>
            <div className="flex gap-2">
              <NeonButton onClick={handleAddDiscordAdmin} disabled={addingDiscord || !newDiscordUser.trim()}>
                {addingDiscord ? 'Adding...' : 'Add Discord Admin'}
              </NeonButton>
              <NeonButton variant="ghost" onClick={() => setShowDiscordForm(false)} disabled={addingDiscord}>
                Cancel
              </NeonButton>
            </div>
          </div>
        ) : (
          <div className="mb-6">
            <NeonButton onClick={() => setShowDiscordForm(true)}>Add Discord Admin</NeonButton>
          </div>
        )}

        {/* Local Admins (username/password) */}
        <p className="text-xs font-display uppercase tracking-wider text-neon-cyan/70 mb-2 pl-2 border-l-2 border-neon-cyan/30">Local Admins</p>
        <p className="text-xs text-faint mb-3">Username/password accounts for users without Discord.</p>
        {localAdmins.length > 0 ? (
          <div className="space-y-2 mb-3">
            {localAdmins.map(admin => (
              <div key={admin.id} className="flex items-center justify-between bg-raised border border-border rounded px-4 py-2">
                <div>
                  <span className="text-sm font-medium text-primary">{admin.display_name || admin.username}</span>
                  <span className="text-xs text-faint ml-2">@{admin.username}</span>
                </div>
                <NeonButton
                  variant="ghost"
                  className="text-xs px-2 py-1 text-neon-magenta hover:text-neon-magenta"
                  onClick={() => setDeleteAdminTarget(admin)}
                >
                  Remove
                </NeonButton>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-faint text-sm mb-3">No local admin accounts.</p>
        )}

        {/* Pending invites */}
        {pendingInvites.length > 0 && (
          <div className="mb-3">
            <p className="text-xs font-display uppercase tracking-wider text-neon-cyan/70 mb-2 pl-2 border-l-2 border-neon-cyan/30">Pending Invites</p>
            <div className="space-y-2">
              {pendingInvites.map(inv => (
                <div key={inv.id} className="flex items-center justify-between bg-raised border border-neon-amber/20 rounded px-4 py-2">
                  <div>
                    <span className="text-sm text-primary">{inv.display_name}</span>
                    <span className="text-xs text-faint ml-2">
                      expires {new Date(inv.expires_at).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex gap-1">
                    <NeonButton
                      variant="ghost"
                      className="text-xs px-2 py-1"
                      onClick={() => copyInviteLink(inv.token)}
                    >
                      {copiedToken === inv.token ? 'Copied!' : 'Copy Link'}
                    </NeonButton>
                    <NeonButton
                      variant="ghost"
                      className="text-xs px-2 py-1 text-neon-magenta hover:text-neon-magenta"
                      onClick={() => handleCancelInvite(inv.id)}
                    >
                      Cancel
                    </NeonButton>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Invite form for local admin */}
        {showInviteForm ? (
          <div className="border border-border rounded p-4 space-y-3">
            <div>
              <label className="text-xs text-faint block mb-1">Display Name *</label>
              <input
                type="text"
                placeholder="e.g. John Smith"
                value={inviteDisplayName}
                onChange={e => setInviteDisplayName(e.target.value)}
                className={inputClass}
                autoFocus
              />
            </div>
            <div>
              <label className="text-xs text-faint block mb-1">Discord Username (optional)</label>
              <input
                type="text"
                placeholder="e.g. ChuckRibbits"
                value={inviteDiscordId}
                onChange={e => setInviteDiscordId(e.target.value)}
                className={inputClass}
              />
              <p className="text-xs text-faint mt-1">If provided, the invite link will be sent via Discord DM.</p>
            </div>
            <div className="flex gap-2">
              <NeonButton onClick={handleInvite} disabled={inviting || !inviteDisplayName.trim()}>
                {inviting ? 'Sending...' : 'Send Invite'}
              </NeonButton>
              <NeonButton variant="ghost" onClick={() => setShowInviteForm(false)} disabled={inviting}>
                Cancel
              </NeonButton>
            </div>
          </div>
        ) : (
          <NeonButton variant="secondary" onClick={() => setShowInviteForm(true)}>Invite Local User</NeonButton>
        )}
      </NeonCard>

      <NeonCard title="Platforms" className="mb-4">
        <p className="text-muted text-sm mb-3">
          Master list of platforms available for game library entries and tournament platform rules.
        </p>
        <PlatformsEditor
          platforms={(() => { try { return JSON.parse(settings.PLATFORMS || '[]'); } catch { return []; } })()}
          onChange={p => handleChange('PLATFORMS', JSON.stringify(p))}
          roomId={room.roomId}
          toast={toast}
        />
      </NeonCard>

      <NeonCard title="Integrations" className="mb-4">
        <div className="space-y-4">
          {Object.entries(TOGGLE_SETTINGS).map(([key, { label, description, defaultOn }]) => {
            const isOn = settings[key] !== undefined ? settings[key] === 'true' : !!defaultOn;
            return (
              <div key={key} className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-primary">{label}</p>
                  <p className="text-xs text-muted">{description}</p>
                </div>
                <button
                  onClick={() => handleChange(key, isOn ? 'false' : 'true')}
                  className={`relative w-12 h-6 rounded-full transition-colors cursor-pointer border-none ${
                    isOn ? 'bg-neon-cyan' : 'bg-raised border border-border'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-primary transition-transform ${
                      isOn ? 'translate-x-6' : ''
                    }`}
                  />
                </button>
              </div>
            );
          })}
        </div>
      </NeonCard>

      {categorized.map(({ category, entries }) => entries.length > 0 && (
        <Fragment key={category}>
        {category === 'Scoreboard Display' ? (
          /* ── Scoreboard Display with Preview Sidebar ── */
          <div className="flex flex-col lg:flex-row gap-4 mb-4">
            <NeonCard title={category} className="lg:w-1/2 min-w-0">
              {settings.SCOREBOARD_STYLE ? (
                /* ── New Style/Theme picker ── */
                <>
                  <StyleThemePicker settings={settings} onChange={handleChange} />

                  {/* Inline toggles */}
                  <div className="pt-3 mt-3 border-t border-border/30 space-y-4">
                    {Object.entries(SCOREBOARD_TOGGLES).map(([key, { label, description, defaultOn }]) => {
                      const isOn = settings[key] !== undefined ? settings[key] === 'true' : !!defaultOn;
                      return (
                        <div key={key} className="flex items-center justify-between gap-4">
                          <div>
                            <p className="text-sm font-medium text-primary">{label}</p>
                            <p className="text-xs text-muted">{description}</p>
                          </div>
                          <button
                            onClick={() => handleChange(key, isOn ? 'false' : 'true')}
                            className={`relative w-12 h-6 rounded-full transition-colors cursor-pointer border-none ${
                              isOn ? 'bg-neon-cyan' : 'bg-raised border border-border'
                            }`}
                          >
                            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-primary transition-transform ${isOn ? 'translate-x-6' : ''}`} />
                          </button>
                        </div>
                      );
                    })}
                  </div>

                  {/* Advanced numeric settings */}
                  <div className="pt-3 mt-3 border-t border-border/30 space-y-3">
                    <p className="text-xs font-display uppercase tracking-wider text-muted">Advanced</p>
                    {[
                      { key: 'SCOREBOARD_MAX_SCORES', label: 'Scores Per Card', defaultVal: '5', description: 'Maximum visible scores per game card' },
                      { key: 'SCOREBOARD_MIN_SCORES', label: 'Min Card Height (scores)', defaultVal: '20', description: 'Minimum card height expressed as score rows' },
                      { key: 'SCOREBOARD_CARD_SPACING', label: 'Card Spacing (px)', defaultVal: '24', description: 'Gap between game cards in pixels' },
                      { key: 'SCOREBOARD_TITLE_FONT_SIZE', label: 'Title Font Size (px)', defaultVal: '0', description: '0 = style default. Override game title font size.' },
                    ].map(({ key, label, defaultVal, description }) => (
                      <div key={key} className="flex items-center justify-between gap-4">
                        <div>
                          <p className="text-sm font-medium text-primary">{label}</p>
                          <p className="text-xs text-muted">{description}</p>
                        </div>
                        <input
                          type="number"
                          value={settings[key] ?? defaultVal}
                          onChange={e => handleChange(key, e.target.value)}
                          className="w-20 text-sm text-center rounded border border-border bg-raised px-2 py-1 text-primary"
                        />
                      </div>
                    ))}
                  </div>

                  {/* Switch back to legacy */}
                  <div className="pt-3 mt-3 border-t border-border/30">
                    <button
                      onClick={() => {
                        const { SCOREBOARD_STYLE: _, SCOREBOARD_THEME: __, ...rest } = settings;
                        setSettings(rest);
                      }}
                      className="text-[11px] text-faint hover:text-muted cursor-pointer bg-transparent border-none"
                    >
                      Switch to legacy card settings
                    </button>
                  </div>
                </>
              ) : (
                /* ── Legacy preset selector ── */
                <>
                  {/* Upgrade banner */}
                  <div className="mb-3 p-3 rounded-lg border border-neon-cyan/20 bg-neon-cyan/5">
                    <p className="text-xs text-muted mb-2">New card styles available — Showcase, Banner, and Minimal with theme support.</p>
                    <button
                      onClick={() => handleChange('SCOREBOARD_STYLE', 'banner')}
                      className="text-xs font-bold text-neon-cyan hover:text-neon-cyan/80 cursor-pointer bg-transparent border-none"
                    >
                      Try new card styles &rarr;
                    </button>
                  </div>

                  <PresetSelector settings={settings} onPresetSelect={handlePresetSelect} />

                  {/* Customize toggle */}
                  <button
                    onClick={() => setCustomizeOpen(!customizeOpen)}
                    className="flex items-center gap-2 mt-4 mb-2 text-sm text-muted hover:text-primary cursor-pointer bg-transparent border-none"
                  >
                    {customizeOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span className="font-display text-xs uppercase tracking-wider">Customize</span>
                  </button>

                  {customizeOpen && (
                    <div className="space-y-3 pt-2 border-t border-border/30">
                      <p className="text-[11px] text-neon-amber/70">Changing individual settings switches to Custom mode.</p>
                      {entries.map(([key, value]) => {
                        if (hiddenKeys.has(key)) return null;
                        const meta = SETTING_LABELS[key];
                        return (
                          <div key={key}>
                            <div className="flex items-center gap-3">
                              <label className="w-64 shrink-0 text-sm font-mono text-muted flex items-center">
                                {meta?.label || key}
                                {meta?.description && <InfoTip text={meta.description} />}
                              </label>
                              {(key === 'SCOREBOARD_CARD_OPACITY' || key === 'SCOREBOARD_BG_OPACITY' || key === 'SCOREBOARD_GLASS_OPACITY') ? (
                                <div className="flex items-center gap-3 flex-1">
                                  {key === 'SCOREBOARD_GLASS_OPACITY' ? (
                                    <>
                                      <input type="range" min="0" max="100" step="5"
                                        value={parseInt(value || '60', 10)}
                                        onChange={e => handleChange(key, e.target.value)}
                                        className="flex-1 accent-neon-cyan cursor-pointer"
                                      />
                                      <span className="text-sm text-muted w-12 text-right">{parseInt(value || '60', 10)}%</span>
                                    </>
                                  ) : (
                                    <>
                                      <input type="range" min="0" max="100" step="5"
                                        value={Math.round((parseFloat(value || '1') * 100))}
                                        onChange={e => handleChange(key, String(parseInt(e.target.value, 10) / 100))}
                                        className="flex-1 accent-neon-cyan cursor-pointer"
                                      />
                                      <span className="text-sm text-muted w-12 text-right">{Math.round((parseFloat(value || '1') * 100))}%</span>
                                    </>
                                  )}
                                </div>
                              ) : SELECT_OPTIONS[key] ? (
                                <select
                                  value={value || SELECT_OPTIONS[key][0].value}
                                  onChange={e => handleChange(key, e.target.value)}
                                  className={`${inputClass} flex-1`}
                                >
                                  {SELECT_OPTIONS[key].map(opt => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                  ))}
                                </select>
                              ) : (
                                <input type="text" value={value}
                                  onChange={e => handleChange(key, e.target.value)}
                                  className={`${inputClass} flex-1`}
                                />
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Inline toggles for Scoreboard Display */}
                  <div className="pt-3 mt-3 border-t border-border/30 space-y-4">
                    {Object.entries(SCOREBOARD_TOGGLES).map(([key, { label, description, defaultOn }]) => {
                      const isOn = settings[key] !== undefined ? settings[key] === 'true' : !!defaultOn;
                      return (
                        <div key={key} className="flex items-center justify-between gap-4">
                          <div>
                            <p className="text-sm font-medium text-primary">{label}</p>
                            <p className="text-xs text-muted">{description}</p>
                          </div>
                          <button
                            onClick={() => handleChange(key, isOn ? 'false' : 'true')}
                            className={`relative w-12 h-6 rounded-full transition-colors cursor-pointer border-none ${
                              isOn ? 'bg-neon-cyan' : 'bg-raised border border-border'
                            }`}
                          >
                            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-primary transition-transform ${isOn ? 'translate-x-6' : ''}`} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </NeonCard>

            {/* Preview sidebar — sticky on desktop */}
            <div className="lg:w-1/2 lg:sticky lg:top-16 lg:self-start shrink-0">
              <ScoreboardPreview settings={settings} />
            </div>
          </div>
        ) : (
          /* ── All other categories ── */
          <NeonCard title={category} className="mb-4">
            <div className="space-y-3">
              {entries.map(([key, value]) => {
                const meta = SETTING_LABELS[key];
                return (
                  <div key={key}>
                    <div className="flex items-center gap-3">
                      <label className="w-64 shrink-0 text-sm font-mono text-muted flex items-center">
                        {meta?.label || key}
                        {meta?.description && <InfoTip text={meta.description} />}
                      </label>
                      {(key === 'SCOREBOARD_CARD_OPACITY' || key === 'SCOREBOARD_BG_OPACITY' || key === 'SCOREBOARD_GLASS_OPACITY') ? (
                        <div className="flex items-center gap-3 flex-1">
                          <input type="range" min="0" max="100" step="5"
                            value={Math.round((parseFloat(value || '1') * 100))}
                            onChange={e => handleChange(key, String(parseInt(e.target.value, 10) / 100))}
                            className="flex-1 accent-neon-cyan cursor-pointer"
                          />
                          <span className="text-sm text-muted w-12 text-right">{Math.round((parseFloat(value || '1') * 100))}%</span>
                        </div>
                      ) : SELECT_OPTIONS[key] ? (
                        <select
                          value={value || SELECT_OPTIONS[key][0].value}
                          onChange={e => handleChange(key, e.target.value)}
                          className={`${inputClass} flex-1`}
                        >
                          {SELECT_OPTIONS[key].map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      ) : key.startsWith('GLOBAL_CARD_CSS_') || key === 'GLOBAL_CARD_BG_COLOR' ? (
                        <div className="flex items-center gap-2 flex-1">
                          <input type="color" value={value || '#000000'}
                            onChange={e => handleChange(key, e.target.value)}
                            className="w-10 h-9 rounded border border-border cursor-pointer bg-transparent p-0.5"
                          />
                          <input type="text" value={value}
                            onChange={e => handleChange(key, e.target.value)}
                            placeholder="#000000" className={`${inputClass} flex-1`}
                          />
                          {value && (
                            <button onClick={() => handleChange(key, '')}
                              className="text-xs text-faint hover:text-neon-magenta cursor-pointer bg-transparent border-none whitespace-nowrap"
                            >Clear</button>
                          )}
                        </div>
                      ) : (
                        <input
                          type={isSensitive(key) && !revealed.has(key) ? 'password' : 'text'}
                          value={value}
                          onChange={e => handleChange(key, e.target.value)}
                          className={`${inputClass} flex-1`}
                        />
                      )}
                      {isSensitive(key) && (
                        <button onClick={() => toggleReveal(key)}
                          className="text-xs text-faint hover:text-muted cursor-pointer bg-transparent border-none"
                        >{revealed.has(key) ? 'Hide' : 'Show'}</button>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Inline toggle for Global Card Styles */}
              {category === 'Global Card Styles' && (
                <div className="pt-3 mt-3 border-t border-border/30 space-y-4">
                  {Object.entries(GLOBAL_CARD_TOGGLES).map(([key, { label, description, defaultOn }]) => {
                    const isOn = settings[key] !== undefined ? settings[key] === 'true' : !!defaultOn;
                    return (
                      <div key={key} className="flex items-center justify-between gap-4">
                        <div>
                          <p className="text-sm font-medium text-primary">{label}</p>
                          <p className="text-xs text-muted">{description}</p>
                        </div>
                        <button
                          onClick={() => handleChange(key, isOn ? 'false' : 'true')}
                          className={`relative w-12 h-6 rounded-full transition-colors cursor-pointer border-none ${
                            isOn ? 'bg-neon-cyan' : 'bg-raised border border-border'
                          }`}
                        >
                          <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-primary transition-transform ${isOn ? 'translate-x-6' : ''}`} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Inline toggles for Kiosk */}
              {category === 'Kiosk' && (
                <div className="pt-3 mt-3 border-t border-border/30 space-y-4">
                  {Object.entries(KIOSK_TOGGLES).map(([key, { label, description, defaultOn }]) => {
                    const isOn = settings[key] !== undefined ? settings[key] === 'true' : !!defaultOn;
                    return (
                      <div key={key} className="flex items-center justify-between gap-4">
                        <div>
                          <p className="text-sm font-medium text-primary">{label}</p>
                          <p className="text-xs text-muted">{description}</p>
                        </div>
                        <button
                          onClick={() => handleChange(key, isOn ? 'false' : 'true')}
                          className={`relative w-12 h-6 rounded-full transition-colors cursor-pointer border-none ${
                            isOn ? 'bg-neon-cyan' : 'bg-raised border border-border'
                          }`}
                        >
                          <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-primary transition-transform ${isOn ? 'translate-x-6' : ''}`} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </NeonCard>
        )}

        {/* Scoreboard Branding — renders right after Scoreboard Display */}
        {category === 'Scoreboard Display' && (
          <NeonCard title="Scoreboard Branding" className="mb-4">
            <div className="space-y-6">
              {/* Background Image */}
              <div>
                <p className="text-xs font-display uppercase tracking-wider text-neon-cyan/70 mb-2 pl-2 border-l-2 border-neon-cyan/30">Background Image</p>
                {bgUrl && (
                  <div className="mb-3">
                    <img src={bgUrl} alt="Background preview" className="max-h-32 rounded border border-border object-cover" />
                  </div>
                )}
                <div className="flex items-center gap-3">
                  <input
                    id="bg-upload"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    disabled={uploadingBg}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      e.target.value = '';
                      const url = URL.createObjectURL(file);
                      setBrandingCropSrc(url);
                      setBrandingCropTarget('bg');
                    }}
                    className="hidden"
                  />
                  <NeonButton
                    variant="secondary"
                    className="text-xs"
                    disabled={uploadingBg}
                    onClick={() => document.getElementById('bg-upload')?.click()}
                  >
                    {uploadingBg ? 'Uploading...' : bgUrl ? 'Replace Image' : 'Upload Image'}
                  </NeonButton>
                  {bgUrl && (
                    <NeonButton
                      variant="ghost"
                      className="text-xs text-neon-magenta"
                      disabled={uploadingBg}
                      onClick={async () => {
                        setUploadingBg(true);
                        try {
                          await api.delete(`/rooms/${room.roomId}/admin/upload/background`);
                          setBgUrl('');
                          setSettings(prev => {
                            const next = { ...prev };
                            delete next.SCOREBOARD_BG_URL;
                            return next;
                          });
                          toast('Background removed', 'success');
                        } catch {
                          toast('Failed to remove background', 'error');
                        } finally {
                          setUploadingBg(false);
                        }
                      }}
                    >
                      Remove
                    </NeonButton>
                  )}
                </div>
                <p className="text-xs text-faint mt-2">PNG, JPEG, or WebP. Max 5 MB. Displayed behind the scoreboard.</p>
                <div className="mt-3">
                  <label className="text-xs text-faint block mb-1">Background Mode</label>
                  <select
                    value={settings.SCOREBOARD_BG_MODE || 'cover'}
                    onChange={e => handleChange('SCOREBOARD_BG_MODE', e.target.value)}
                    className={inputClass}
                  >
                    <option value="cover">Cover (fill screen)</option>
                    <option value="contain">Contain (fit)</option>
                    <option value="repeat">Repeat (tile)</option>
                    <option value="center">Center</option>
                  </select>
                </div>
                <div className="mt-3">
                  <label className="text-xs text-faint block mb-1">Background Opacity</label>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="5"
                      value={Math.round((parseFloat(settings.SCOREBOARD_BG_OPACITY || '1') * 100))}
                      onChange={e => handleChange('SCOREBOARD_BG_OPACITY', String(parseInt(e.target.value, 10) / 100))}
                      className="flex-1 accent-neon-cyan cursor-pointer"
                    />
                    <span className="text-sm text-muted w-12 text-right">{Math.round((parseFloat(settings.SCOREBOARD_BG_OPACITY || '1') * 100))}%</span>
                  </div>
                </div>
              </div>
              {/* Logo Image */}
              <div>
                <p className="text-xs font-display uppercase tracking-wider text-neon-cyan/70 mb-2 pl-2 border-l-2 border-neon-cyan/30">Logo</p>
                {logoUrl && (
                  <div className="mb-3">
                    <img src={logoUrl} alt="Logo preview" className="max-h-16 rounded border border-border object-contain" />
                  </div>
                )}
                <div className="flex items-center gap-3">
                  <input
                    id="logo-upload"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    disabled={uploadingLogo}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      e.target.value = '';
                      const url = URL.createObjectURL(file);
                      setBrandingCropSrc(url);
                      setBrandingCropTarget('logo');
                    }}
                    className="hidden"
                  />
                  <NeonButton
                    variant="secondary"
                    className="text-xs"
                    disabled={uploadingLogo}
                    onClick={() => document.getElementById('logo-upload')?.click()}
                  >
                    {uploadingLogo ? 'Uploading...' : logoUrl ? 'Replace Logo' : 'Upload Logo'}
                  </NeonButton>
                  {logoUrl && (
                    <NeonButton
                      variant="ghost"
                      className="text-xs text-neon-magenta"
                      disabled={uploadingLogo}
                      onClick={async () => {
                        setUploadingLogo(true);
                        try {
                          await api.delete(`/rooms/${room.roomId}/admin/upload/logo`);
                          setLogoUrl('');
                          setSettings(prev => {
                            const next = { ...prev };
                            delete next.LOGO_URL;
                            return next;
                          });
                          toast('Logo removed', 'success');
                        } catch {
                          toast('Failed to remove logo', 'error');
                        } finally {
                          setUploadingLogo(false);
                        }
                      }}
                    >
                      Remove
                    </NeonButton>
                  )}
                </div>
                <p className="text-xs text-faint mt-2">PNG, JPEG, or WebP. Max 5 MB. Shown alongside the scoreboard title.</p>
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <div>
                    <label className="text-xs text-faint block mb-1">Logo Position</label>
                    <select
                      value={settings.LOGO_POSITION || 'left'}
                      onChange={e => handleChange('LOGO_POSITION', e.target.value)}
                      className={inputClass}
                    >
                      <option value="left">Left of title</option>
                      <option value="right">Right of title</option>
                      <option value="above">Above title</option>
                      <option value="below">Below title</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-faint block mb-1">Logo Max Height (px)</label>
                    <input
                      type="number"
                      value={settings.LOGO_MAX_HEIGHT || '64'}
                      onChange={e => handleChange('LOGO_MAX_HEIGHT', e.target.value)}
                      className={inputClass}
                      min="16"
                      max="256"
                    />
                  </div>
                </div>
                {/* Scoreboard Title */}
                <div className="mt-3">
                  <label className="text-xs text-faint block mb-1">Scoreboard Title</label>
                  <input
                    type="text"
                    value={settings.SCOREBOARD_TITLE || ''}
                    onChange={e => handleChange('SCOREBOARD_TITLE', e.target.value)}
                    placeholder="Leave empty to use room name"
                    className={inputClass}
                  />
                </div>
                {/* Live title preview */}
                <div className="mt-3 p-3 bg-surface rounded border border-border/50">
                  <div className={`flex items-center justify-center gap-3 py-2 ${
                    (settings.LOGO_POSITION || 'left') === 'above' || (settings.LOGO_POSITION || 'left') === 'below' ? 'flex-col' : 'flex-row'
                  }`}>
                    {settings.LOGO_URL && ((settings.LOGO_POSITION || 'left') === 'left' || (settings.LOGO_POSITION || 'left') === 'above') && (
                      <img src={settings.LOGO_URL} alt="" style={{ maxHeight: Number(settings.LOGO_MAX_HEIGHT || 64), objectFit: 'contain' }} />
                    )}
                    <p className={`font-display text-muted ${getTitleSizeClass(settings.SCOREBOARD_TITLE_SIZE || 'sm')} uppercase tracking-widest ${getTitleStyleClass(settings.SCOREBOARD_TITLE_STYLE || 'default')}`}>
                      {settings.SCOREBOARD_TITLE || room.roomName || 'Scoreboard Title'}
                    </p>
                    {settings.LOGO_URL && ((settings.LOGO_POSITION || 'left') === 'right' || (settings.LOGO_POSITION || 'left') === 'below') && (
                      <img src={settings.LOGO_URL} alt="" style={{ maxHeight: Number(settings.LOGO_MAX_HEIGHT || 64), objectFit: 'contain' }} />
                    )}
                  </div>
                </div>

                {/* Title Style picker */}
                <div className="mt-3">
                  <label className="text-xs text-faint block mb-1.5">Title Style</label>
                  <div className="grid grid-cols-3 gap-2">
                    {SELECT_OPTIONS.SCOREBOARD_TITLE_STYLE.map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => handleChange('SCOREBOARD_TITLE_STYLE', opt.value)}
                        className={`p-2 rounded border text-center transition-colors ${
                          (settings.SCOREBOARD_TITLE_STYLE || 'default') === opt.value
                            ? 'border-neon-cyan bg-neon-cyan/10'
                            : 'border-border/50 bg-raised hover:border-border'
                        }`}
                      >
                        <span className={`font-display text-sm uppercase tracking-wider block ${getTitleStyleClass(opt.value)}`}>
                          {opt.label}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Title Size */}
                <div className="mt-3">
                  <label className="text-xs text-faint block mb-1">Title Size</label>
                  <select
                    value={settings.SCOREBOARD_TITLE_SIZE || 'sm'}
                    onChange={e => handleChange('SCOREBOARD_TITLE_SIZE', e.target.value)}
                    className={inputClass}
                  >
                    {SELECT_OPTIONS.SCOREBOARD_TITLE_SIZE.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </NeonCard>
        )}

        {/* Branding image cropper overlay */}
        {brandingCropSrc && brandingCropTarget && (
          <ImageCropper
            imageSrc={brandingCropSrc}
            aspectRatio={brandingCropTarget === 'bg' ? 16 / 9 : 1}
            maxOutputWidth={brandingCropTarget === 'bg' ? 1920 : 600}
            onConfirm={handleBrandingCropConfirm}
            onCancel={handleBrandingCropCancel}
          />
        )}
        </Fragment>
      ))}

      {uncategorizedKeys.length > 0 && (
        <NeonCard title="Other" className="mb-4">
          <div className="space-y-3">
            {uncategorizedKeys.map(key => (
              <div key={key} className="flex items-center gap-3">
                <label className="w-64 shrink-0 text-sm font-mono text-muted">{key}</label>
                <input
                  type={isSensitive(key) && !revealed.has(key) ? 'password' : 'text'}
                  value={settings[key]}
                  onChange={e => handleChange(key, e.target.value)}
                  className={`${inputClass} flex-1`}
                />
              </div>
            ))}
          </div>
        </NeonCard>
      )}

      <NeonCard title="System Actions" className="mb-4">
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <p className="text-sm text-muted">
              Refresh tournament schedules after changing cron settings, timezones, or activating/deactivating tournaments.
              This happens automatically when you save tournament changes, but you can trigger it manually here if schedules seem out of sync.
            </p>
          </div>
          <NeonButton
            variant="secondary"
            onClick={async () => {
              setReloadingScheduler(true);
              try {
                await api.post(`/rooms/${room.roomId}/scheduler/reload`, {});
                toast('Schedules refreshed', 'success');
              } catch {
                toast('Failed to refresh schedules', 'error');
              } finally {
                setReloadingScheduler(false);
              }
            }}
            disabled={reloadingScheduler}
          >
            {reloadingScheduler ? 'Refreshing...' : 'Refresh Schedules'}
          </NeonButton>
        </div>
      </NeonCard>

      <NeonCard title="Merge / Rename Player" className="mb-4">
        <p className="text-sm text-muted mb-3">
          Rename a player or merge two usernames into one. Updates all submissions, scores, and user mappings.
          If the name was also wrong on iScored, fix it there first to prevent re-importing the old name on next sync.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="text-xs text-faint block mb-1">From (old/wrong name)</label>
            <input
              type="text"
              placeholder="mekelburj"
              value={mergeFrom}
              onChange={e => setMergeFrom(e.target.value)}
              className={`${inputClass} w-48`}
            />
          </div>
          <div>
            <label className="text-xs text-faint block mb-1">To (correct name)</label>
            <input
              type="text"
              placeholder="mekelburgj"
              value={mergeTo}
              onChange={e => setMergeTo(e.target.value)}
              className={`${inputClass} w-48`}
            />
          </div>
          <NeonButton
            variant="secondary"
            disabled={merging || !mergeFrom.trim() || !mergeTo.trim()}
            onClick={async () => {
              if (!confirm(`Rename all records from "${mergeFrom}" to "${mergeTo}"? This cannot be undone.`)) return;
              setMerging(true);
              try {
                const result = await api.post<{ submissionsUpdated: number; scoresUpdated: number }>(`/rooms/${room.roomId}/admin/merge-player`, {
                  fromUsername: mergeFrom.trim(),
                  toUsername: mergeTo.trim(),
                });
                toast(`Merged: ${result.submissionsUpdated} submissions, ${result.scoresUpdated} scores updated`, 'success');
                setMergeFrom('');
                setMergeTo('');
              } catch {
                toast('Failed to merge player', 'error');
              } finally {
                setMerging(false);
              }
            }}
          >
            {merging ? 'Merging...' : 'Merge'}
          </NeonButton>
        </div>
      </NeonCard>


      {deleteAdminTarget && (
        <ConfirmModal
          title="Remove Admin"
          message={`Are you sure you want to remove ${deleteAdminTarget.display_name || deleteAdminTarget.username}? They will no longer be able to log in.`}
          confirmLabel="Remove"
          onConfirm={handleDeleteAdmin}
          onCancel={() => setDeleteAdminTarget(null)}
        />
      )}
    </div>
  );
}
