import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['src/__tests__/**/*.test.ts'],
        setupFiles: ['src/__tests__/setup.ts'],
        testTimeout: 10000,
        // Run tests sequentially — SQLite in-memory DB is shared per test file
        fileParallelism: false,
    },
});
