import { relativeTimeFrom } from '../lib/format';

/**
 * W102 - the health lines on a paired device card: is the Witness watching now,
 * and when did it last send a score. All from the additive fields on
 * `GET /api/me/witness/devices`; an older server omits them and nothing shows.
 * (The "update waiting" line lives in WitnessDeviceSupport, beside the switches.)
 */

export type WitnessHealthDevice = {
    deviceType?: 'atgames' | 'desktop';
    watching?: 'yes' | 'no' | 'unknown';
    heartbeatAt?: string | null;
    lastScoreAt?: string | null;
    lastScoreTable?: string | null;
};

export default function WitnessDeviceHealth({ device }: { device: WitnessHealthDevice }) {
    const watching = device.watching;
    const showWatching = watching === 'yes' || watching === 'no';
    if (!showWatching && !device.lastScoreAt) return null;
    const heard = relativeTimeFrom(device.heartbeatAt);
    return (
        <div className="mt-1 space-y-0.5" data-testid="witness-device-health">
            {watching === 'yes' && <p className="text-xs text-neon-green">Watching now</p>}
            {watching === 'no' && (
                <p className="text-xs text-neon-amber">
                    Not watching.{heard ? ` Last heard from ${heard}.` : ''}{' '}
                    {device.deviceType === 'desktop'
                        ? 'Start Castcade on the PC.'
                        : 'Open the [Arcaid Witness] tile on the cabinet after it powers on.'}
                </p>
            )}
            {device.lastScoreAt && (
                <p className="text-xs text-muted break-words">
                    Last score sent {relativeTimeFrom(device.lastScoreAt)}{device.lastScoreTable ? `: ${device.lastScoreTable}` : ''}
                </p>
            )}
        </div>
    );
}
