import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from './Toast';
import NeonCard from './NeonCard';
import NeonButton from './NeonButton';
import ConfirmModal from './ConfirmModal';
import { parseServerDate } from '../lib/format';

const inputClass =
  'w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors';

export type SigningKey = {
  id: number;
  source: string;
  algorithm: string;
  publicKey: string;
  validFrom: string;
  validUntil: string | null;
  note: string | null;
  createdAt: string;
  active: boolean;
};

/** The only source today: the Legends Unchained ScoreServer that signs VPX score records on the cabinet. */
const SOURCE_LABEL: Record<string, string> = {
  'lu-scoreserver': 'Legends Unchained launcher',
};

function when(stamp: string | null): string {
  if (!stamp) return '';
  const d = parseServerDate(stamp);
  return d ? d.toLocaleString() : stamp;
}

/**
 * Super-admin signing keys (W72, v2.205.0) - the public keys a forwarded score
 * record may be signed with. Today that is the Legends Unchained launcher: its
 * ScoreServer signs each VPX game record on the cabinet, the Witness forwards
 * the record with the score, and a record that verifies and matches the score
 * earns the "Launcher-signed" badge.
 *
 * Paste the key exactly as LU publishes it (base64 of the raw 32-byte Ed25519
 * public key). To rotate: add the new key, then retire the old one. A retired
 * key stops verifying from that moment; keys are never edited or deleted.
 */
export default function SigningKeysCard() {
  const { toast } = useToast();
  const [keys, setKeys] = useState<SigningKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [note, setNote] = useState('');
  const [retiring, setRetiring] = useState<SigningKey | null>(null);

  // Bumped after every write; the effect below re-reads the list.
  const [reloadTick, setReloadTick] = useState(0);
  const load = () => setReloadTick(t => t + 1);

  useEffect(() => {
    let cancelled = false;
    api.get<{ keys: SigningKey[] }>('/admin/signing-keys')
      .then(data => { if (!cancelled) setKeys(data.keys); })
      .catch(() => { if (!cancelled) toast('Failed to load signing keys', 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reloadTick, toast]);

  const add = async () => {
    if (!newKey.trim()) return;
    setBusy(true);
    try {
      await api.post('/admin/signing-keys', {
        source: 'lu-scoreserver',
        public_key: newKey.trim(),
        note: note.trim() || null,
      });
      toast('Signing key added', 'success');
      setNewKey('');
      setNote('');
      load();
    } catch (err) {
      toast((err as Error).message || 'Could not add the key', 'error');
    } finally {
      setBusy(false);
    }
  };

  const retire = async (key: SigningKey) => {
    setRetiring(null);
    setBusy(true);
    try {
      await api.post(`/admin/signing-keys/${key.id}/retire`, {});
      toast('Signing key retired', 'success');
      load();
    } catch (err) {
      toast((err as Error).message || 'Could not retire the key', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <NeonCard title="Signing keys" className="mb-4">
      <p className="text-muted text-sm mb-4">
        The Legends Unchained launcher signs its own record of every VPX game on the cabinet. When the
        Witness sends that record with a score and the signature checks out against a key here, the score
        shows a "Launcher-signed" badge. Paste the public key exactly as Legends Unchained publishes it.
        To change keys, add the new one first, then retire the old one.
      </p>

      {loading ? (
        <p className="text-faint text-sm mb-4">Loading...</p>
      ) : keys.length > 0 ? (
        <div className="space-y-2 mb-4" data-testid="signing-key-list">
          {keys.map(k => (
            <div key={k.id} className="bg-raised border border-border rounded px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 min-w-0">
                  <span className="text-sm text-primary">{SOURCE_LABEL[k.source] ?? k.source}</span>
                  <span
                    className={`text-[11px] px-1.5 py-0.5 rounded ${k.active ? 'bg-neon-green/10 text-neon-green' : 'bg-deep text-faint'}`}
                    data-testid={`signing-key-state-${k.id}`}
                  >
                    {k.active ? 'Active' : k.validUntil ? 'Retired' : 'Not active yet'}
                  </span>
                </div>
                {k.active && (
                  <button
                    onClick={() => setRetiring(k)}
                    disabled={busy}
                    className="text-xs text-faint hover:text-neon-magenta cursor-pointer bg-transparent border-none"
                  >
                    Retire
                  </button>
                )}
              </div>
              <p className="font-mono text-xs text-muted break-all mt-1">{k.publicKey}</p>
              <p className="text-[11px] text-faint mt-1">
                From {when(k.validFrom)}
                {k.validUntil ? ` until ${when(k.validUntil)}` : ''}
                {k.note ? ` - ${k.note}` : ''}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-faint text-sm mb-4">No signing keys yet. Until one is added, no score is badged as launcher-signed.</p>
      )}

      <div className="space-y-2">
        <input
          type="text"
          placeholder="Public key (base64)"
          value={newKey}
          onChange={e => setNewKey(e.target.value)}
          className={`${inputClass} font-mono`}
          aria-label="Public key"
        />
        <input
          type="text"
          placeholder="Note (optional), e.g. where it was published"
          value={note}
          onChange={e => setNote(e.target.value)}
          className={inputClass}
          aria-label="Note"
        />
        <NeonButton variant="secondary" onClick={add} disabled={busy || !newKey.trim()}>
          {busy ? 'Saving...' : 'Add key'}
        </NeonButton>
      </div>

      {retiring && (
        <ConfirmModal
          title="Retire this key?"
          message="Scores signed with this key will no longer be badged as launcher-signed from now on. This cannot be undone."
          confirmLabel="Retire"
          onConfirm={() => retire(retiring)}
          onCancel={() => setRetiring(null)}
        />
      )}
    </NeonCard>
  );
}
