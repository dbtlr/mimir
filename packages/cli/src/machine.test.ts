import { expect, test } from 'bun:test';

import { createApp } from './app';
import { boundClone } from './testing/fixture';
import { runArgv } from './testing/run';

/** An app whose source supplies no machine services, and whose store must never be read. */
const bare = () =>
  createApp({
    git: boundClone(undefined),
    store: () => Promise.reject(new Error('the store is not read')),
  });

test.each([
  [['doctor'], 'doctor is unavailable in this context'],
  [['bind', 'MMR'], 'bind is unavailable in this context'],
  [['store', 'upgrade'], 'store is unavailable in this context'],
])('%p refuses where the context supplies no machine services', async (argv, message) => {
  const run = await runArgv(bare(), [...argv, '-f', 'json']);
  expect(run.exitCode).toBe(2);
  expect(JSON.parse(run.stderr)).toMatchObject({ error: { code: 'usage', message } });
});

test('a store verb refuses a bad invocation before any store opens', async () => {
  const run = await runArgv(bare(), ['store', 'import', '/nonexistent/mimir-document.json']);
  expect(run.exitCode).toBe(2);
});
