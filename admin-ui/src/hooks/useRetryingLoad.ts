import { useEffect, useState } from 'react';
import { RetryingLoader, type LoadPhase } from '../lib/loadRetry';

/**
 * One page load that tries again by itself when it fails for now (a refused
 * request, a deploy restart, no connection). See `lib/loadRetry.ts` for the
 * rule; this is its React binding (G31, v2.265.4).
 *
 *   const { load, phase } = useRetryingLoad(
 *     () => roomFetch(`/api/rooms/${roomId}/leaderboard`),
 *     async res => setLeaderboards(await res.json()),
 *     roomId,
 *   );
 *   useEffect(() => { if (roomId) load(); }, [roomId, load]);
 *
 * - `load` never changes identity. Call it from the page's own effect, socket
 *   handlers and `useLiveRefresh`; the hook starts nothing by itself.
 * - `phase` is `loading` until the first answer, `retrying` while there is
 *   still no answer and a try has failed, `ready` afterwards. A page shows its
 *   empty state only on `ready`: before that it does not know the room is empty.
 * - `subject` is what the load is about (the room id). When it changes the
 *   phase is `loading` again at once and anything still in flight is dropped.
 *
 * Call this hook ABOVE the effect that first calls `load()`: effects run in
 * order, and the hook's own effect is what hands the loader its callbacks.
 */
export interface RetryingLoad {
  load: () => void;
  phase: LoadPhase;
}

export function useRetryingLoad(
  request: () => Promise<Response>,
  onOk: (res: Response) => void | Promise<void>,
  subject: unknown,
): RetryingLoad {
  // The phase is stored with the subject it belongs to, so a render with a new
  // subject reads `loading` without waiting for an effect to reset it.
  const [state, setState] = useState<{ subject: unknown; phase: LoadPhase }>({ subject, phase: 'loading' });
  const phase: LoadPhase = Object.is(state.subject, subject) ? state.phase : 'loading';

  const [loader] = useState(() => new RetryingLoader());

  // After every render, so callers can pass inline arrows and the loader
  // always runs the latest ones (a retry minutes later uses today's token).
  useEffect(() => {
    loader.setHooks({
      request,
      onOk,
      onPhase: next => setState(prev => (
        Object.is(prev.subject, subject) && prev.phase === next ? prev : { subject, phase: next }
      )),
    });
  });

  // Leaving a subject (or the page): stop the pending retry and ignore
  // whatever is still on its way.
  useEffect(() => () => loader.reset(), [subject, loader]);

  return { load: loader.load, phase };
}
