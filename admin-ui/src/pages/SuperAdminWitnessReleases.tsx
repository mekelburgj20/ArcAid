import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

/**
 * Super-admin -> Witness releases (W100): the signed Arcaid Witness cabinet
 * builds the server can offer, which channel each is on, and how many
 * cabinets run each version. A new release starts as Draft (offered to nobody).
 */

type Channel = 'draft' | 'beta' | 'stable';
type Release = {
  version: string; channel: Channel; size: number; sha256: string;
  notes: string | null; uploadedAt: string;
};
type ReleasesResponse = {
  releases: Release[];
  devicesByVersion: { version: string; count: number }[];
};

const CHANNEL_LABEL: Record<Channel, string> = { draft: 'Draft', beta: 'Test builds', stable: 'Everyone' };

const UPLOAD_ERRORS: Record<string, string> = {
  VERSION_INVALID: 'The version must be dotted numbers such as 1.1.0.',
  VERSION_EXISTS: 'That version is already uploaded. Delete it first or pick a new version.',
  NOT_ELF: 'That file is not an ELF program.',
  SIGNATURE_INVALID: 'The signature does not match this file and version. Sign the build again.',
  TOO_LARGE: 'That file is larger than 16 MB.',
};

function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export default function SuperAdminWitnessReleases() {
  const [data, setData] = useState<ReleasesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [version, setVersion] = useState('');
  const [sig, setSig] = useState('');
  const [notes, setNotes] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<ReleasesResponse>('/admin/witness/releases'));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const changeChannel = async (r: Release, channel: Channel) => {
    if (channel === r.channel) return;
    if (channel === 'stable' && !window.confirm(`Offer ${r.version} to every cabinet with automatic updates on?`)) return;
    try {
      await api.patch(`/admin/witness/releases/${encodeURIComponent(r.version)}`, { channel });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (r: Release) => {
    if (!window.confirm(`Delete release ${r.version}? Its file is removed from the server.`)) return;
    try {
      await api.delete(`/admin/witness/releases/${encodeURIComponent(r.version)}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const upload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setUploading(true); setUploadError(null);
    try {
      const fd = new FormData();
      fd.append('version', version.trim());
      fd.append('sig', sig.trim());
      if (notes.trim()) fd.append('notes', notes.trim());
      fd.append('file', file);
      await api.upload('/admin/witness/releases', fd);
      setFile(null); setVersion(''); setSig(''); setNotes('');
      await load();
    } catch (err) {
      const msg = (err as Error).message;
      const code = err instanceof ApiError ? String((err.body as { code?: string }).code ?? '') : '';
      // api.upload keeps only the server's message, so also look for a code inside it.
      const inMsg = Object.keys(UPLOAD_ERRORS).find(k => msg.includes(k));
      setUploadError(UPLOAD_ERRORS[code] ?? (inMsg ? UPLOAD_ERRORS[inMsg] : msg));
    } finally {
      setUploading(false);
    }
  };

  const releases = [...(data?.releases ?? [])].sort((a, b) => cmpVersion(a.version, b.version));
  const inputCls = 'bg-raised border border-border rounded px-2 py-1 text-sm text-primary w-full';

  return (
    <div>
      <h1 className="font-display text-2xl font-bold text-primary mb-2">Witness releases</h1>
      <p className="text-sm text-muted mb-6">
        Signed Arcaid Witness builds for AtGames cabinets, and who is offered each one.
      </p>
      {error && <p className="text-sm text-rose-400 mb-4">{error}</p>}

      <div className="overflow-x-auto mb-8">
        <table className="w-full text-sm text-left">
          <thead>
            <tr className="text-xs text-muted border-b border-border">
              <th className="py-2 pr-3">Version</th>
              <th className="py-2 pr-3">Channel</th>
              <th className="py-2 pr-3">Size</th>
              <th className="py-2 pr-3">SHA-256</th>
              <th className="py-2 pr-3">Uploaded</th>
              <th className="py-2 pr-3">Notes</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {releases.map(r => (
              <tr key={r.version} className="border-b border-border align-top">
                <td className="py-2 pr-3 font-mono text-primary">{r.version}</td>
                <td className="py-2 pr-3">
                  <select
                    aria-label={`Channel for ${r.version}`}
                    value={r.channel}
                    onChange={e => void changeChannel(r, e.target.value as Channel)}
                    className="bg-raised border border-border rounded px-2 py-1 text-xs text-primary cursor-pointer"
                  >
                    {(Object.keys(CHANNEL_LABEL) as Channel[]).map(c => (
                      <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>
                    ))}
                  </select>
                </td>
                <td className="py-2 pr-3 text-muted">{formatSize(r.size)}</td>
                <td className="py-2 pr-3 font-mono text-xs text-muted">{r.sha256.slice(0, 12)}</td>
                <td className="py-2 pr-3 text-muted">{new Date(r.uploadedAt).toLocaleDateString()}</td>
                <td className="py-2 pr-3 text-muted break-words max-w-xs">{r.notes}</td>
                <td className="py-2">
                  <button
                    type="button"
                    aria-label={`Delete ${r.version}`}
                    onClick={() => void remove(r)}
                    className="px-2 py-1 rounded border border-border text-xs text-muted hover:text-rose-400 hover:border-rose-500/40 cursor-pointer"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {data && releases.length === 0 && (
              <tr><td colSpan={7} className="py-3 text-muted">No releases uploaded yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <h2 className="text-sm font-medium text-primary mb-2">Cabinets by version</h2>
      <ul className="mb-8 space-y-1 text-sm text-muted">
        {(data?.devicesByVersion ?? []).map(d => (
          <li key={d.version || 'none'}>
            <span className="font-mono text-primary">{d.version || 'never reported'}</span>: {d.count}
          </li>
        ))}
        {data && data.devicesByVersion.length === 0 && <li>No cabinets paired.</li>}
      </ul>

      <h2 className="text-sm font-medium text-primary mb-2">Upload a release</h2>
      <form onSubmit={upload} className="max-w-lg space-y-3">
        <label className="block text-xs text-muted">
          Program file (ELF)
          <input
            type="file"
            onChange={e => setFile(e.target.files?.[0] ?? null)}
            className="block mt-1 text-sm text-primary"
          />
        </label>
        <label className="block text-xs text-muted">
          Version
          <input value={version} onChange={e => setVersion(e.target.value)} placeholder="1.1.0" className={`${inputCls} mt-1`} />
        </label>
        <label className="block text-xs text-muted">
          Signature (base64)
          <textarea value={sig} onChange={e => setSig(e.target.value)} rows={3} className={`${inputCls} mt-1 font-mono`} />
        </label>
        <label className="block text-xs text-muted">
          Notes (optional)
          <input value={notes} onChange={e => setNotes(e.target.value)} className={`${inputCls} mt-1`} />
        </label>
        {uploadError && <p className="text-sm text-rose-400">{uploadError}</p>}
        <button
          type="submit"
          disabled={uploading || !file || !version.trim() || !sig.trim()}
          className="px-3 py-1.5 rounded border border-border text-sm text-primary hover:border-neon-cyan/50 cursor-pointer disabled:opacity-50"
        >
          {uploading ? 'Uploading…' : 'Upload release'}
        </button>
        <p className="text-xs text-faint">
          Sign a build first: npm run witness-release -- sign --elf &lt;path&gt; --version &lt;x.y.z&gt;. A new release starts as Draft and is offered to nobody.
        </p>
      </form>
    </div>
  );
}
