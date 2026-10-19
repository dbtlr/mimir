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

const unregistered = 'Postgres requires a registered live installation.';

// The machine commands open the store outside the Engine getter; each open must translate too.
test.each([['store export -'], ['store upgrade'], ['doctor']])(
  '%s reports a failing open by its message',
  async (line) => {
    const app = createApp({
      git: boundClone('MMR'),
      machine: {
        cwd: '/nowhere',
        doctor: () => Promise.reject(new Error(unregistered)),
        openPostgres: () => {
          throw new Error(unregistered);
        },
        openSqlite: () => Promise.reject(new Error(unregistered)),
        readConfig: () => ({ store: {} }),
        readStdin: () => Promise.resolve(''),
      },
      store: () => Promise.reject(new Error(unregistered)),
    });
    const run = await runArgv(app, line.split(' '));
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(unregistered);
    expect(run.stderr).not.toContain('internal');
    expect(run.stderr).not.toContain('Something went wrong');
  },
);
