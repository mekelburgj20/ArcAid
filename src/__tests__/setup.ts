import { beforeEach } from 'vitest';
import { _resetForTesting } from '../database/database.js';

// Use in-memory SQLite for all tests
process.env.DB_PATH = ':memory:';
// Prevent JWT_SECRET from throwing in tests
process.env.JWT_SECRET = 'test-secret';

beforeEach(async () => {
    await _resetForTesting();
});
