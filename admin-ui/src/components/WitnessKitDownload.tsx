import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download } from 'lucide-react';
import { KIT_INSTALL_HREF, kitSize, useWitnessGuide, useWitnessKit } from '../lib/witnessKit';

/**
 * W102 - "Get Arcaid Witness": the cabinet kit (a zip holding the arcaid-witness
 * folder). `GET /api/me/witness/kit` says whether a stable release exists;
 * `/kit/download` is the zip, fetched as a blob with the player token (the same
 * technique as the log download). Renders nothing when no kit is available.
 */

export function KitDownloadButton({ playerToken }: { playerToken: string }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const download = async () => {
        setBusy(true); setError(null);
        try {
            const res = await fetch('/api/me/witness/kit/download', { headers: { Authorization: `Bearer ${playerToken}` } });
            if (!res.ok) throw new Error('Could not download Arcaid Witness');
            const blob = await res.blob();
            const cd = res.headers?.get?.('Content-Disposition') ?? '';
            const m = /filename="?([^";]+)"?/i.exec(cd);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = m?.[1] || 'arcaid-witness-kit.zip';
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <button
                type="button"
                disabled={busy}
                onClick={() => void download()}
                className="px-4 py-1.5 rounded border border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan text-sm font-medium hover:bg-neon-cyan/20 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer inline-flex items-center gap-1.5"
            >
                <Download size={14} /> {busy ? 'Working…' : 'Get Arcaid Witness'}
            </button>
            {error && <p className="mt-1 text-xs text-rose-400" role="alert">{error}</p>}
        </>
    );
}

/** Account Settings: the button, the version caption and the guide link. */
export default function WitnessKitDownload({ playerToken }: { playerToken: string | null }) {
    const kit = useWitnessKit(playerToken);
    const { videoUrl } = useWitnessGuide();
    if (!playerToken || !kit) return null;
    return (
        <div className="mb-3" data-testid="witness-kit">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <KitDownloadButton playerToken={playerToken} />
                <span className="text-xs text-muted">
                    Version {kit.version}{kit.sizeBytes > 0 ? ` · ${kitSize(kit.sizeBytes)}` : ''}
                </span>
                <Link to={KIT_INSTALL_HREF} className="text-xs underline text-neon-cyan">How to install</Link>
                {videoUrl && (
                    <a href={videoUrl} target="_blank" rel="noopener noreferrer" className="text-xs underline text-neon-cyan">Watch the install video</a>
                )}
            </div>
        </div>
    );
}
