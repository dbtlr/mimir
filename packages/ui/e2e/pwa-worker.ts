import { test as base } from '@playwright/test';

import { PwaFixture } from './pwa-fixture';

type PwaWorkerFixtures = {
  pwaFixture: PwaFixture;
};

/**
 * Production builds are worker setup, not product behavior under test. Give
 * them an independent budget so a slow builder cannot consume the browser
 * lifecycle's test timeout; the unique temp root still tears down per worker.
 */
export const test = base.extend<{}, PwaWorkerFixtures>({
  pwaFixture: [
    async ({ browserName: _browserName }, use) => {
      const fixture = await PwaFixture.create();
      try {
        await use(fixture);
      } finally {
        await fixture.close();
      }
    },
    { scope: 'worker', timeout: 5 * 60_000 },
  ],
});
