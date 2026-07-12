// Batches per-game score-count fetches into a single request per room per
// short window, instead of every scoreboard card firing its own
// /api/rooms/:roomId/score-counts/:gameId request on mount (48-card grid = 48 requests).
//
// Callers within a 50ms window for the same roomId are coalesced into one
// GET /api/rooms/:roomId/score-counts?gameIds=a,b,c request (chunked at 100
// ids per request). Each caller's promise resolves with that game's counts
// object, or {} on any failure — cards degrade to "no expand available"
// rather than throwing.

type ScoreCounts = Record<string, number>;

interface PendingBatch {
  gameIds: Set<string>;
  callbacks: Map<string, Array<(result: ScoreCounts) => void>>;
  timer: ReturnType<typeof setTimeout>;
}

const BATCH_WINDOW_MS = 50;
const MAX_IDS_PER_REQUEST = 100;

const pendingBatches = new Map<string, PendingBatch>();

export function fetchScoreCounts(roomId: string, gameId: string): Promise<ScoreCounts> {
  return new Promise((resolve) => {
    let batch = pendingBatches.get(roomId);
    if (!batch) {
      batch = {
        gameIds: new Set(),
        callbacks: new Map(),
        timer: setTimeout(() => flushBatch(roomId), BATCH_WINDOW_MS),
      };
      pendingBatches.set(roomId, batch);
    }
    batch.gameIds.add(gameId);
    const existing = batch.callbacks.get(gameId);
    if (existing) {
      existing.push(resolve);
    } else {
      batch.callbacks.set(gameId, [resolve]);
    }
  });
}

function flushBatch(roomId: string) {
  const batch = pendingBatches.get(roomId);
  if (!batch) return;
  pendingBatches.delete(roomId);

  const gameIds = Array.from(batch.gameIds);
  for (let i = 0; i < gameIds.length; i += MAX_IDS_PER_REQUEST) {
    const chunk = gameIds.slice(i, i + MAX_IDS_PER_REQUEST);
    fetchChunk(roomId, chunk, batch.callbacks);
  }
}

async function fetchChunk(
  roomId: string,
  gameIds: string[],
  callbacks: Map<string, Array<(result: ScoreCounts) => void>>
): Promise<void> {
  let counts: Record<string, ScoreCounts> = {};
  try {
    const idsParam = gameIds.map(encodeURIComponent).join(',');
    const res = await fetch(`/api/rooms/${roomId}/score-counts?gameIds=${idsParam}`);
    const data = res.ok ? await res.json() : { counts: {} };
    counts = data?.counts || {};
  } catch {
    counts = {};
  }

  for (const gameId of gameIds) {
    const resolvers = callbacks.get(gameId);
    if (!resolvers) continue;
    const result = counts[gameId] ?? {};
    resolvers.forEach((resolve) => resolve(result));
  }
}
