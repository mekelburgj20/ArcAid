import { beforeEach } from 'vitest';
import { _resetForTesting } from '../database/database.js';
import { drainBackgroundTasks } from '../utils/backgroundTasks.js';

// Use in-memory SQLite for all tests
process.env.DB_PATH = ':memory:';
// Prevent JWT_SECRET from throwing in tests
process.env.JWT_SECRET = 'test-secret';
// Deterministic base64 32-byte key for crypto tests (all-zero key — test only)
process.env.SECRETS_KEY = Buffer.alloc(32).toString('base64');

beforeEach(async () => {
    // Drain fire-and-forget post-submit chains from the PREVIOUS test before
    // resetting the shared in-memory DB. Without this, a still-running chain
    // (lobby feed / milestones / friend events / push) hits the closed handle
    // (SQLITE_MISUSE noise) or, on slow runners, races the next test's
    // transaction ("cannot start a transaction within a transaction" — the
    // community-scores-attribution / room-scores CI flakes).
    await drainBackgroundTasks();
    await _resetForTesting();
});
