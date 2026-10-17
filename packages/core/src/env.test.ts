import { expect, test } from 'bun:test';

import { IS_PRODUCTION, sqliteStorePath } from './env';

test('source runs do not gain live installation authority', () => {
  expect(IS_PRODUCTION).toBe(false);
});

test('the dev store is an isolated repo-local .dev file, never the production path', () => {
  const path = sqliteStorePath();
  expect(path).toEndWith('/.dev/store.sqlite');
  expect(path).not.toContain('/.local/share/mimir');
});
