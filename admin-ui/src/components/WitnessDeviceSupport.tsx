import { useCallback, useEffect, useState } from 'react';
import { Download, FileText, Send, Trash2 } from 'lucide-react';

/**
 * W99 / W100 — per-device support controls under a paired cabinet on Account
 * Settings: pull the cabinet's logs, and choose how it updates itself.
 * Renders nothing for a desktop (Castcade) device. Authenticates with the
 * player token, like the rest of the Witness block.
 */

export type WitnessSupportDevice = {
    atgamesUniqueId: string;
    deviceType?: 'atgames' | 'desktop';
    appVersion?: string | null;
    autoUpdate?: boolean;
    testBuilds?: boolean;
    stagedVersion?: string | null;
    offeredVersion?: string | null;
    logsSupported?: boolean;
};

type LogRequest = {
    id: string;
    deviceId: string;
    status: 'pending' | 'ready' | 'failed' | 'expired';
    requestedAt: string;
    readyAt: string | null;
    sizeBytes: number | null;
    failReason: string | null;
    expiresAt: string;
    sharedAt: string | null;
};

const POLL_MS = 5000;

function formatSize(bytes: number | null): string {
    if (bytes == null) return '';
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function WitnessDeviceSupport({ device, playerToken, onChanged }: {
    device: WitnessSupportDevice;
    playerToken: string | null;
    onChanged?: () => void;
}) {
    const id = device.atgamesUniqueId;
    const isCabinet = device.deviceType !== 'desktop';
    const logsSupported = device.logsSupported === true;
    const auth = { Authorization: `Bearer ${playerToken}` };

    const [latest, setLatest] = useState<LogRequest | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [autoUpdate, setAutoUpdate] = useState(device.autoUpdate !== false);
    const [testBuilds, setTestBuilds] = useState(device.testBuilds === true);
    useEffect(() => { setAutoUpdate(device.autoUpdate !== false); }, [device.autoUpdate]);
    useEffect(() => { setTestBuilds(device.testBuilds === true); }, [device.testBuilds]);

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/me/witness/log-requests', {
                headers: { Authorization: `Bearer ${playerToken}` },
            });
            if (!res.ok) return;
            const body = await res.json();
            const list: LogRequest[] = Array.isArray(body?.requests) ? body.requests : [];
            setLatest(list.find(r => r.deviceId === id) ?? null);
        } catch { /* the controls simply show no request */ }
    }, [id, playerToken]);

    const active = isCabinet && logsSupported;
    useEffect(() => { if (active && playerToken) void load(); }, [active, playerToken, load]);

    const pending = latest?.status === 'pending';
    useEffect(() => {
        if (!pending) return;
        const t = setInterval(() => { void load(); }, POLL_MS);
        return () => clearInterval(t);
    }, [pending, load]);

    if (!isCabinet) return null;

    const requestLogs = async () => {
        setBusy(true); setError(null);
        try {
            const res = await fetch(`/api/me/witness/devices/${encodeURIComponent(id)}/log-requests`, {
                method: 'POST', headers: auth,
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || 'Could not ask your cabinet for its logs');
            }
            const body = await res.json();
            setLatest(body.request ?? null);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    };

    const download = async (r: LogRequest) => {
        setBusy(true); setError(null);
        try {
            const res = await fetch(`/api/me/witness/log-requests/${encodeURIComponent(r.id)}/download`, { headers: auth });
            if (!res.ok) throw new Error('Could not download the logs');
            const blob = await res.blob();
            const cd = res.headers?.get?.('Content-Disposition') ?? '';
            const m = /filename="?([^";]+)"?/i.exec(cd);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = m?.[1] || 'arcaid-witness-logs.tar.gz';
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

    const shareLogs = async (r: LogRequest) => {
        setBusy(true); setError(null);
        try {
            const res = await fetch(`/api/me/witness/log-requests/${encodeURIComponent(r.id)}/share`, {
                method: 'POST',
                headers: { ...auth, 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            if (!res.ok) throw new Error('Could not send the logs to Arcaid support');
            const body = await res.json();
            setLatest(body.request ?? null);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    };

    const removeLogs = async (r: LogRequest) => {
        setBusy(true); setError(null);
        try {
            const res = await fetch(`/api/me/witness/log-requests/${encodeURIComponent(r.id)}`, {
                method: 'DELETE', headers: auth,
            });
            if (!res.ok) throw new Error('Could not remove the logs');
            setLatest(null);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    };

    const saveUpdates = async (patch: { autoUpdate?: boolean; testBuilds?: boolean }) => {
        setError(null);
        try {
            const res = await fetch(`/api/me/witness/devices/${encodeURIComponent(id)}/updates`, {
                method: 'PATCH',
                headers: { ...auth, 'Content-Type': 'application/json' },
                body: JSON.stringify(patch),
            });
            if (!res.ok) throw new Error('Could not save the update setting');
            onChanged?.();
        } catch (err) {
            setError((err as Error).message);
            setAutoUpdate(device.autoUpdate !== false);
            setTestBuilds(device.testBuilds === true);
        }
    };

    const staged = device.stagedVersion && device.stagedVersion !== device.appVersion ? device.stagedVersion : null;
    const offered = !staged && device.offeredVersion ? device.offeredVersion : null;

    return (
        <div className="mt-2 pt-2 border-t border-border space-y-2" data-testid="witness-device-support">
            {!logsSupported ? (
                <p className="text-xs text-muted">Log download needs Arcaid Witness 1.1.0 or newer on this cabinet.</p>
            ) : (
                <div className="space-y-1">
                    {(!latest || latest.status === 'failed' || latest.status === 'expired') && (
                        <>
                            {latest?.status === 'expired' && (
                                <p className="text-xs text-amber-400">
                                    Your cabinet did not answer. Check it is on and online, open the Arcaid Witness tile once, then try again.
                                </p>
                            )}
                            {latest?.status === 'failed' && (
                                <p className="text-xs text-rose-400">
                                    Your cabinet could not send its logs ({latest.failReason || 'unknown reason'}). Try again.
                                </p>
                            )}
                        </>
                    )}
                    {pending && (
                        <p className="text-xs text-muted">
                            Asked your cabinet for its logs. It answers within about 2 minutes while it is switched on and the Witness has been opened since it was last powered on.
                        </p>
                    )}
                    {latest?.status === 'ready' && (
                        <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                                <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void download(latest)}
                                    className="px-2 py-1 rounded border border-border text-xs text-primary hover:border-neon-cyan/50 cursor-pointer inline-flex items-center gap-1"
                                >
                                    <Download size={12} /> Download logs
                                </button>
                                <span className="text-xs text-muted">
                                    {formatSize(latest.sizeBytes)} · kept until {new Date(latest.expiresAt).toLocaleDateString()}
                                </span>
                                <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void removeLogs(latest)}
                                    className="px-2 py-1 rounded border border-border text-xs text-muted hover:text-rose-400 hover:border-rose-500/40 cursor-pointer inline-flex items-center gap-1"
                                >
                                    <Trash2 size={12} /> Remove logs
                                </button>
                            </div>
                            {latest.sharedAt ? (
                                <p className="text-xs text-muted">
                                    Sent to Arcaid support on {new Date(latest.sharedAt).toLocaleDateString()}.
                                </p>
                            ) : (
                                <div className="space-y-1">
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => void shareLogs(latest)}
                                        className="px-2 py-1 rounded border border-border text-xs text-primary hover:border-neon-cyan/50 cursor-pointer inline-flex items-center gap-1"
                                    >
                                        <Send size={12} /> Send to Arcaid support
                                    </button>
                                    <p className="text-xs text-faint">
                                        Sends this cabinet's Witness log and VPX play records to the Arcaid team. You can still download or remove them.
                                    </p>
                                </div>
                            )}
                        </div>
                    )}
                    {latest?.status !== 'ready' && (
                        <button
                            type="button"
                            disabled={busy || pending}
                            onClick={() => void requestLogs()}
                            className="px-2 py-1 rounded border border-border text-xs text-muted hover:text-primary hover:border-neon-cyan/50 cursor-pointer inline-flex items-center gap-1"
                        >
                            <FileText size={12} /> Get logs
                        </button>
                    )}
                </div>
            )}

            {logsSupported && (
                <div className="space-y-1">
                    <label className="flex items-center gap-2 text-xs text-primary cursor-pointer">
                        <input
                            type="checkbox"
                            checked={autoUpdate}
                            onChange={e => { setAutoUpdate(e.target.checked); void saveUpdates({ autoUpdate: e.target.checked }); }}
                        />
                        Update this cabinet automatically
                    </label>
                    <label className={`flex items-center gap-2 text-xs ${autoUpdate ? 'text-primary cursor-pointer' : 'text-faint'}`}>
                        <input
                            type="checkbox"
                            checked={testBuilds}
                            disabled={!autoUpdate}
                            onChange={e => { setTestBuilds(e.target.checked); void saveUpdates({ testBuilds: e.target.checked }); }}
                        />
                        Get test builds early
                    </label>
                    {staged && (
                        <p className="text-xs text-muted">
                            Version {staged} is downloaded. It starts the next time you open the Arcaid Witness tile.
                        </p>
                    )}
                    {offered && (
                        <p className="text-xs text-muted">
                            Version {offered} is available. Your cabinet downloads it by itself while no table is running.
                        </p>
                    )}
                </div>
            )}

            {error && <p className="text-xs text-rose-400">{error}</p>}
        </div>
    );
}
