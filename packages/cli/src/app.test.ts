import { expect, test } from 'bun:test';

import { createApp } from './app';
import { boundClone } from './testing/fixture';
import { runArgv } from './testing/run';

test('a store that fails to open reports its message, not a generic internal error', async () => {
  const app = createApp({
    git: boundClone('MMR'),
    store: () => Promise.reject(new Error('Postgres requires a registered live installation.')),
  });
  const run = await runArgv(app, ['list']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain('Postgres requires a registered live installation.');
  expect(run.stderr).not.toContain('Something went wrong');
});
