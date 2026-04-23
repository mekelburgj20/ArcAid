import { beforeEach } from 'vitest';
import { _resetForTesting } from '../database/database.js';

// Use in-memory SQLite for all tests
process.env.DB_PATH = ':memory:';
// Prevent JWT_SECRET from throwing in tests
process.env.JWT_SECRET = 'test-secret';
// Deterministic base64 32-byte key for crypto tests (all-zero key — test only)
process.env.SECRETS_KEY = Buffer.alloc(32).toString('base64');

beforeEach(async () => {
    await _resetForTesting();
});
