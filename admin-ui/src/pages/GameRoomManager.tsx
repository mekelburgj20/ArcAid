import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import DataTable from '../components/DataTable';
import ConfirmModal from '../components/ConfirmModal';
import LoadingState from '../components/LoadingState';

interface Room {
  id: string;
  slug: string;
  name: string;
  description: string;
  is_public: boolean;
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

  // Form state
  const [formName, setFormName] = useState('');
  const [formSlug, setFormSlug] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formIsPublic, setFormIsPublic] = useState(true);

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
    setShowCreate(false);
    setEditTarget(null);
  };

  const handleCreate = async () => {
    if (!formName.trim() || !formSlug.trim()) return;
    setSaving(true);
    try {
      await api.post('/admin/rooms', {
        name: formName.trim(),
        slug: formSlug.trim().toLowerCase(),
        description: formDescription.trim(),
        is_public: formIsPublic,
      });
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
    setShowCreate(false);
  };

  const autoSlug = (name: string) => {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  };

  const columns = [
    {
      key: 'name',
      header: 'Name',
      render: (item: Room) => <span className="font-medium">{item.name}</span>,
    },
    {
      key: 'slug',
      header: 'Slug',
      render: (item: Room) => <span className="font-mono text-sm text-muted">/{item.slug}</span>,
    },
    {
      key: 'is_public',
      header: 'Visibility',
      render: (item: Room) => (
        <span className={`text-xs px-2 py-0.5 rounded ${item.is_public ? 'bg-neon-green/10 text-neon-green border border-neon-green/30' : 'bg-raised text-faint border border-border'}`}>
          {item.is_public ? 'Public' : 'Private'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (item: Room) => (
        <div className="flex gap-2 justify-end">
          <NeonButton variant="ghost" onClick={() => startEdit(item)}>Edit</NeonButton>
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
                onChange={e => setFormSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                placeholder="my-game-room"
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
    </div>
  );
}
