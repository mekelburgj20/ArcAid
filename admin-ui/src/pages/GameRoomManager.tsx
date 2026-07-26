import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import DataTable from '../components/DataTable';
import ConfirmModal from '../components/ConfirmModal';
import LoadingState from '../components/LoadingState';
import { Copy, Check, ExternalLink, ShieldAlert, ShieldCheck } from 'lucide-react';

interface Room {
  id: string;
  slug: string;
  name: string;
  description: string;
  is_public: boolean;
  short_tag: string | null;
  /** S22 Phase 2 (v2.44.0) — super-admin room suspension. */
  suspended_at?: string | null;
  suspended_by?: string | null;
  suspended_reason?: string | null;
}

const inputClass = "w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors";

export default function GameRoomManager() {
  const { toast } = useToast();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editTarget, setEditTarget] = useState<Room | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Room | null>(null);
  // S22 Phase 2 (v2.44.0) — suspend/unsuspend
  const [suspendTarget, setSuspendTarget] = useState<Room | null>(null);
  const [unsuspendTarget, setUnsuspendTarget] = useState<Room | null>(null);
  const [suspendReason, setSuspendReason] = useState('');
  const [suspending, setSuspending] = useState(false);

  // Form state
  const [formName, setFormName] = useState('');
  const [formSlug, setFormSlug] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formIsPublic, setFormIsPublic] = useState(true);
  const [formShortTag, setFormShortTag] = useState('');
  // Standalone-room Phase 1 (v2.32.0) — Connected/Standalone choice, create-only.
  const [formMode, setFormMode] = useState<'connected' | 'standalone'>('connected');
  // Rooms created as standalone THIS session, so the onboarding-message copy
  // can branch even though GET /admin/rooms doesn't return game_room_settings.
  const [standaloneRoomIds, setStandaloneRoomIds] = useState<Set<string>>(new Set());

  const loadRooms = () => {
    setLoading(true);
    api.get<Room[]>('/admin/rooms')
      .then(setRooms)
      .catch(() => toast('Failed to load rooms', 'error'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadRooms(); }, []);

  const resetForm = () => {
    setFormName('');
    setFormSlug('');
    setFormDescription('');
    setFormIsPublic(true);
    setFormShortTag('');
    setFormMode('connected');
    setShowCreate(false);
    setEditTarget(null);
  };

  const handleCreate = async () => {
    if (!formName.trim() || !formSlug.trim()) return;
    setSaving(true);
    try {
      const result = await api.post<{ success: boolean; room: Room }>('/admin/rooms', {
        name: formName.trim(),
        slug: formSlug.trim().toLowerCase(),
        description: formDescription.trim(),
        is_public: formIsPublic,
        short_tag: formShortTag.trim() || null,
        mode: formMode,
      });
      if (formMode === 'standalone' && result?.room?.id) {
        setStandaloneRoomIds(prev => new Set(prev).add(result.room.id));
      }
      toast('Room created', 'success');
      resetForm();
      loadRooms();
    } catch (err: any) {
      toast(err.message || 'Failed to create room', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = async () => {
    if (!editTarget || !formName.trim() || !formSlug.trim()) return;
    setSaving(true);
    try {
      await api.put(`/admin/rooms/${editTarget.id}`, {
        name: formName.trim(),
        slug: formSlug.trim().toLowerCase(),
        description: formDescription.trim(),
        is_public: formIsPublic,
        short_tag: formShortTag.trim() || null,
      });
      toast('Room updated', 'success');
      resetForm();
      loadRooms();
    } catch (err: any) {
      toast(err.message || 'Failed to update room', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.delete(`/admin/rooms/${deleteTarget.id}`);
      toast('Room deleted', 'success');
      setDeleteTarget(null);
      loadRooms();
    } catch (err: any) {
      toast(err.message || 'Failed to delete room', 'error');
    }
  };

  const startEdit = (room: Room) => {
    setEditTarget(room);
    setFormName(room.name);
    setFormSlug(room.slug);
    setFormDescription(room.description);
    setFormIsPublic(room.is_public);
    setFormShortTag(room.short_tag || '');
    setShowCreate(false);
  };

  const [copiedRoomId, setCopiedRoomId] = useState<string | null>(null);

  const copyOnboardingMessage = async (room: Room) => {
    const origin = window.location.origin;
    // Standalone-room Phase 1 (v2.32.0) — this list only knows about a room's
    // mode if it was created standalone THIS session (GET /admin/rooms doesn't
    // return game_room_settings). Falls back to the connected steps otherwise,
    // which matches today's back-compat behavior for every pre-existing room.
    const isStandalone = standaloneRoomIds.has(room.id);
    const quickSetup = isStandalone
      ? [
          `QUICK SETUP`,
          `1. Log in and go to Settings`,
          `2. Set your theme and branding (logo, background, colors)`,
          `3. Set your timezone in Tournament Defaults`,
          `4. Go to Game Library and import games (VPS or VPXS Wizard)`,
          `5. Go to Tournaments and create your first tournament`,
          `6. Share your public scoreboard link with your community: ${origin}/${room.slug}/`,
        ]
      : [
          `QUICK SETUP`,
          `1. Log in and go to Settings`,
          `2. Enter your Discord Guild ID, default Announcement Channel ID, and Admin Role ID`,
          `3. Enter your iScored credentials and Public URL`,
          `4. Set your timezone in Tournament Defaults`,
          `5. Go to Game Library and import games (VPS or VPXS Wizard)`,
          `6. Go to Tournaments and create your first tournament`,
        ];
    const message = [
      `Welcome to ArcAid! Here's everything you need to get started with your game room "${room.name}".`,
      ``,
      `LOGIN`,
      `URL: ${origin}/${room.slug}/login`,
      `(Your username and password have been provided separately.)`,
      ``,
      `PUBLIC SCOREBOARD`,
      `Share this with your community: ${origin}/${room.slug}/`,
      ``,
      ...quickSetup,
      ``,
      `HELP`,
      `Your admin panel has a Help page in the sidebar with a complete setup guide and Discord command reference.`,
      ``,
      `Picks: ${origin}/${room.slug}/picks`,
      `Player Stats: ${origin}/${room.slug}/players`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(message);
      setCopiedRoomId(room.id);
      setTimeout(() => setCopiedRoomId(null), 2000);
    } catch {
      toast('Failed to copy', 'error');
    }
  };

  // S22 Phase 2 (v2.44.0) — suspend/unsuspend. Idempotent on the server;
  // re-fetches the list afterward so the badge/button reflect the new state.
  const handleSuspend = async () => {
    if (!suspendTarget) return;
    setSuspending(true);
    try {
      await api.post(`/admin/rooms/${suspendTarget.id}/suspend`, {
        reason: suspendReason.trim() || undefined,
      });
      toast(`${suspendTarget.name} suspended`, 'success');
      setSuspendTarget(null);
      setSuspendReason('');
      loadRooms();
    } catch (err: any) {
      toast(err.message || 'Failed to suspend room', 'error');
    } finally {
      setSuspending(false);
    }
  };

  const handleUnsuspend = async () => {
    if (!unsuspendTarget) return;
    try {
      await api.post(`/admin/rooms/${unsuspendTarget.id}/unsuspend`, {});
      toast(`${unsuspendTarget.name} unsuspended`, 'success');
      setUnsuspendTarget(null);
      loadRooms();
    } catch (err: any) {
      toast(err.message || 'Failed to unsuspend room', 'error');
    }
  };

  const autoSlug = (name: string) => {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '');
  };

  const columns = [
    {
      key: 'name',
      header: 'Name',
      render: (item: Room) => (
        <a href={`/${item.slug}/admin/`} className="font-medium text-primary hover:text-neon-cyan no-underline transition-colors">
          {item.name}
        </a>
      ),
    },
    {
      key: 'scoreboard',
      header: 'Leaderboard',
      render: (item: Room) => (
        <a
          href={`/${item.slug}/`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm text-muted hover:text-neon-cyan no-underline transition-colors"
        >
          /{item.slug} <ExternalLink size={12} />
        </a>
      ),
    },
    {
      key: 'is_public',
      header: 'Visibility',
      render: (item: Room) => (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`text-xs px-2 py-0.5 rounded ${item.is_public ? 'bg-neon-green/10 text-neon-green border border-neon-green/30' : 'bg-raised text-faint border border-border'}`}>
            {item.is_public ? 'Public' : 'Private'}
          </span>
          {item.suspended_at && (
            <span
              className="text-xs px-2 py-0.5 rounded bg-neon-magenta/10 text-neon-magenta border border-neon-magenta/30 inline-flex items-center gap-1"
              title={item.suspended_reason || 'Suspended pending review'}
            >
              <ShieldAlert size={12} /> SUSPENDED
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (item: Room) => (
        <div className="flex gap-2 justify-end">
          <NeonButton
            variant="ghost"
            onClick={() => copyOnboardingMessage(item)}
            className="text-xs px-2 py-1"
            title="Copy onboarding message to clipboard"
          >
            {copiedRoomId === item.id ? <><Check size={14} className="text-neon-green" /> Copied</> : <><Copy size={14} /> Onboard</>}
          </NeonButton>
          <NeonButton variant="ghost" onClick={() => startEdit(item)}>Edit</NeonButton>
          {item.suspended_at ? (
            <NeonButton
              variant="ghost"
              className="text-xs px-2 py-1"
              onClick={() => setUnsuspendTarget(item)}
              title="Restore public/admin access to this room"
            >
              <ShieldCheck size={14} className="inline -mt-0.5 mr-1" /> Unsuspend
            </NeonButton>
          ) : (
            <NeonButton
              variant="danger"
              className="text-xs px-2 py-1"
              onClick={() => setSuspendTarget(item)}
              title="Hide this room and block access pending review"
            >
              <ShieldAlert size={14} className="inline -mt-0.5 mr-1" /> Suspend
            </NeonButton>
          )}
          <NeonButton variant="danger" onClick={() => setDeleteTarget(item)}>Delete</NeonButton>
        </div>
      ),
    },
  ];

  const showForm = showCreate || editTarget;

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <h1 className="font-display text-2xl font-bold">Game Rooms</h1>
        {!showForm && (
          <NeonButton onClick={() => { resetForm(); setShowCreate(true); }}>
            Create Room
          </NeonButton>
        )}
      </div>

      {showForm && (
        <NeonCard glowColor="cyan" className="mb-6" title={editTarget ? 'Edit Room' : 'Create Room'}>
          <div className="space-y-4">
            {!editTarget && (
              <div>
                <label className="text-xs text-faint block mb-1">Room Type</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setFormMode('connected')}
                    className={`text-left px-3 py-2 rounded border cursor-pointer transition-colors ${
                      formMode === 'connected'
                        ? 'border-neon-cyan bg-neon-cyan/10'
                        : 'border-border bg-raised hover:border-border/80'
                    }`}
                  >
                    <p className="text-sm font-medium text-primary">Connected</p>
                    <p className="text-xs text-muted">Discord + iScored integrations</p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormMode('standalone')}
                    className={`text-left px-3 py-2 rounded border cursor-pointer transition-colors ${
                      formMode === 'standalone'
                        ? 'border-neon-cyan bg-neon-cyan/10'
                        : 'border-border bg-raised hover:border-border/80'
                    }`}
                  >
                    <p className="text-sm font-medium text-primary">Standalone</p>
                    <p className="text-xs text-muted">Web-only — no Discord server or iScored board needed</p>
                  </button>
                </div>
              </div>
            )}
            <div>
              <label className="text-xs text-faint block mb-1">Room Name</label>
              <input
                type="text"
                value={formName}
                onChange={e => {
                  setFormName(e.target.value);
                  if (!editTarget) setFormSlug(autoSlug(e.target.value));
                }}
                placeholder="My Game Room"
                className={inputClass}
                autoFocus
              />
            </div>
            <div>
              <label className="text-xs text-faint block mb-1">Slug (URL path)</label>
              <input
                type="text"
                value={formSlug}
                onChange={e => setFormSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                placeholder="my_game_room"
                className={inputClass}
              />
              <p className="text-xs text-muted mt-1">URL: /{formSlug || 'slug'}</p>
            </div>
            <div>
              <label className="text-xs text-faint block mb-1">Description</label>
              <textarea
                value={formDescription}
                onChange={e => setFormDescription(e.target.value)}
                placeholder="A brief description of this game room"
                className={`${inputClass} min-h-[60px] resize-y`}
              />
            </div>
            <div>
              <label className="text-xs text-faint block mb-1">
                Short tag <span className="text-faint">(optional, ≤6 chars)</span>
              </label>
              <input
                type="text"
                value={formShortTag}
                onChange={e => setFormShortTag(e.target.value.toUpperCase().slice(0, 6))}
                placeholder={formSlug ? formSlug.slice(0, 6).toUpperCase() : 'e.g. RTX'}
                maxLength={6}
                className={inputClass}
              />
              <p className="text-xs text-muted mt-1">
                Shown on Global Scoreboard badges. Falls back to the slug if left blank.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <label className="text-xs text-faint">Public</label>
              <button
                onClick={() => setFormIsPublic(!formIsPublic)}
                className={`relative w-12 h-6 rounded-full transition-colors cursor-pointer border-none ${
                  formIsPublic ? 'bg-neon-cyan' : 'bg-raised border border-border'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-primary transition-transform ${
                    formIsPublic ? 'translate-x-6' : ''
                  }`}
                />
              </button>
            </div>
            <div className="flex gap-2 pt-2">
              <NeonButton onClick={editTarget ? handleEdit : handleCreate} disabled={saving || !formName.trim() || !formSlug.trim()}>
                {saving ? 'Saving...' : editTarget ? 'Save Changes' : 'Create'}
              </NeonButton>
              <NeonButton variant="ghost" onClick={resetForm}>Cancel</NeonButton>
            </div>
          </div>
        </NeonCard>
      )}

      <NeonCard>
        {loading ? (
          <LoadingState message="Loading rooms..." />
        ) : (
          <DataTable
            columns={columns}
            data={rooms}
            emptyMessage="No game rooms found. Create one to get started."
            keyExtractor={(item) => item.id}
          />
        )}
      </NeonCard>

      {deleteTarget && (
        <ConfirmModal
          title="Delete Room"
          message={`Are you sure you want to delete "${deleteTarget.name}"? This will remove all tournaments, games, and scores in this room. This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* S22 Phase 2 (v2.44.0) — suspend, with an optional reason (super-admin
          moderation context, not shown to the public — just to other admins
          reviewing this list and to the room's own admins when they hit the
          403). Custom modal (not ConfirmModal) since it needs the reason field. */}
      {suspendTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm"
          onClick={() => { setSuspendTarget(null); setSuspendReason(''); }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Suspend room"
            className="bg-surface border border-border rounded-lg p-6 w-full max-w-md shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-display text-lg font-bold text-primary mb-2">Suspend "{suspendTarget.name}"?</h3>
            <p className="text-muted mb-4 text-sm">
              This hides the room from the public listing and blocks ALL access — including the room's own admins —
              until you unsuspend it.
            </p>
            <label className="block text-xs text-faint mb-1">Reason (optional, internal)</label>
            <input
              type="text"
              value={suspendReason}
              onChange={(e) => setSuspendReason(e.target.value)}
              placeholder="Why is this room being suspended?"
              maxLength={500}
              className="w-full bg-raised border border-border rounded px-3 py-2 text-sm text-primary placeholder-faint focus:outline-none focus:border-neon-cyan/50 mb-4"
            />
            <div className="flex justify-end gap-3">
              <NeonButton variant="ghost" onClick={() => { setSuspendTarget(null); setSuspendReason(''); }}>Cancel</NeonButton>
              <NeonButton variant="danger" onClick={handleSuspend} disabled={suspending}>
                {suspending ? 'Suspending...' : 'Suspend Room'}
              </NeonButton>
            </div>
          </div>
        </div>
      )}

      {unsuspendTarget && (
        <ConfirmModal
          title="Unsuspend Room"
          message={`Restore access to "${unsuspendTarget.name}"? It will reappear in the public listing and become accessible again.`}
          confirmLabel="Unsuspend"
          onConfirm={handleUnsuspend}
          onCancel={() => setUnsuspendTarget(null)}
        />
      )}
    </div>
  );
}
