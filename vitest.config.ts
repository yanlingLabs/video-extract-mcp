import { defineConfig } from 'vitest/config';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    env: {
      // The status discovery registry (src/status/discovery.ts) writes one
      // small file per live server. Point every test run at a throwaway
      // directory so the suite never touches a developer's real ~/.cache --
      // lifecycle tests deliberately force-kill server processes, so exit
      // handlers cannot be relied on to clean up after an interrupted run.
      // This is the baseline for the whole suite; individual tests that need
      // their OWN isolated cache dir (tests/statusDiscovery.test.ts) still
      // override it per-test with vi.stubEnv, which wins over this default.
      VIDEO_EXTRACT_CACHE_DIR: join(tmpdir(), 'video-extract-mcp-test-cache'),
    },
  },
});
