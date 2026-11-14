import { useEffect, useState } from 'react';

/** W102 - the cabinet kit: `GET /api/me/witness/kit` (a stable release exists?) and its words. */

export const KIT_INSTALL_HREF = '/witness/install';

export type WitnessKit = { available: true; version: string; sizeBytes: number };

export function kitSize(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The install video address (super-admin set); only an https address is ever returned. */
export function useWitnessGuide(): { videoUrl: string | null } {
    const [videoUrl, setVideoUrl] = useState<string | null>(null);
    useEffect(() => {
        let live = true;
        fetch('/api/witness/guide')
            .then(res => (res && res.ok ? res.json() : null))
            .then(body => {
                if (!live) return;
                const v = body && typeof body.videoUrl === 'string' ? body.videoUrl : null;
                setVideoUrl(v && v.startsWith('https://') ? v : null);
            })
            .catch(() => { if (live) setVideoUrl(null); });
        return () => { live = false; };
    }, []);
    return { videoUrl };
}

export function useWitnessKit(playerToken: string | null): WitnessKit | null {
    const [kit, setKit] = useState<WitnessKit | null>(null);
    useEffect(() => {
        if (!playerToken) return;
        let live = true;
        fetch('/api/me/witness/kit', { headers: { Authorization: `Bearer ${playerToken}` } })
            .then(res => (res.ok ? res.json() : null))
            .then(body => {
                if (!live) return;
                setKit(body && body.available === true && typeof body.version === 'string'
                    ? { available: true, version: body.version, sizeBytes: Number(body.sizeBytes) || 0 }
                    : null);
            })
            .catch(() => { if (live) setKit(null); });
        return () => { live = false; };
    }, [playerToken]);
    return playerToken ? kit : null;
}
