import { useEffect, useState } from 'react';
import { playerApi } from '../lib/playerApi';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import Panel from './parts/Panel';

/**
 * Run recaps privacy (B31.1). Two switches, saved through `POST /me/preferences`
 * one key at a time:
 *
 * - "Show my play stats in run recaps" (default ON): games, averages, sessions,
 *   streaks and games per day. Best score and finishing place always show.
 * - "Show when I play" (default OFF): lets the player win time-of-day awards and
 *   shows the time of each game in their run detail.
 *
 * Enforced on the SERVER when a recap is built, so a hidden player's numbers are
 * never in the response. Modelled on `GlobalSharingSection`: the player client
 * (not the admin one), an optimistic toggle with rollback, rendered after load.
 */
type Key = 'recap_play_stats' | 'recap_time_of_day';

export default function RecapPrivacySection() {
    const { playerToken } = useViewerAuth();
    const [playStats, setPlayStats] = useState<boolean | null>(null);
    const [timeOfDay, setTimeOfDay] = useState<boolean>(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!playerToken) return;
        playerApi.get<{ recap_play_stats?: boolean; recap_time_of_day?: boolean }>('/me/preferences', { token: playerToken })
            .then(p => {
                setPlayStats(p?.recap_play_stats !== false);
                setTimeOfDay(p?.recap_time_of_day === true);
            })
            // Show the defaults rather than an empty box.
            .catch(() => { setPlayStats(true); setTimeOfDay(false); });
    }, [playerToken]);

    const save = async (key: Key, next: boolean) => {
        const setter = key === 'recap_play_stats' ? setPlayStats : setTimeOfDay;
        const previous = key === 'recap_play_stats' ? playStats : timeOfDay;
        setter(next);
        setSaving(true);
        setError('');
        try {
            await playerApi.post('/me/preferences', { [key]: next }, { token: playerToken });
        } catch (err) {
            // Roll back so a switch never shows a state the server rejected.
            setter(previous ?? (key === 'recap_play_stats'));
            setError((err as Error)?.message || 'Could not save that.');
        } finally {
            setSaving(false);
        }
    };

    if (playStats === null) return null;

    return (
        <Panel id="run-recaps" title="Run recaps">
            <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                    type="checkbox" checked={playStats} disabled={saving}
                    onChange={e => save('recap_play_stats', e.target.checked)}
                    className="accent-neon-cyan mt-0.5"
                    data-testid="recap-play-stats"
                />
                <span>
                    <span className="text-primary">Show my play stats in run recaps</span>
                    <span className="block text-xs text-muted mt-1">
                        Games played, averages, sessions, streaks and games per day. Your best score and
                        finishing place always show.
                    </span>
                </span>
            </label>
            <label className="flex items-start gap-2 text-sm cursor-pointer mt-3">
                <input
                    type="checkbox" checked={timeOfDay} disabled={saving}
                    onChange={e => save('recap_time_of_day', e.target.checked)}
                    className="accent-neon-cyan mt-0.5"
                    data-testid="recap-time-of-day"
                />
                <span>
                    <span className="text-primary">Show when I play</span>
                    <span className="block text-xs text-muted mt-1">
                        Lets you win time-of-day awards like Night owl, and shows the time of each of your
                        games in your run detail.
                    </span>
                </span>
            </label>
            {error && <p className="text-xs text-neon-coral mt-2">{error}</p>}
        </Panel>
    );
}
