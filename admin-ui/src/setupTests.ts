// S2 (Phase 0): registers @testing-library/jest-dom matchers (toBeInTheDocument,
// etc.) on Vitest's expect. Loaded via vite.config.ts `test.setupFiles`.
import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// X14: `findBy*` and `waitFor` give up after 1 s by default. On a loaded CI
// runner a first render plus a mocked fetch can take longer than that, and a
// test that passes locally fails a PR run or a deploy (PinnedCarousel,
// LiveSettingsRefresh, RoomAdminWitness, PicksQueueTabs three times: each a
// 26-minute re-run). Five seconds everywhere, instead of a `{ timeout: 5000 }`
// added to one call after each failure. It only changes how long a wait that
// is going to FAIL takes; `testTimeout` in vite.config.ts sits above it so
// such a failure still reports what it was waiting for.
configure({ asyncUtilTimeout: 5000 });
