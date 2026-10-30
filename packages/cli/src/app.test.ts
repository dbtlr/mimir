import { expect, test } from 'bun:test';

import { assertAssembles } from '@loomcli/testing';

import { createApp } from './app';
import { boundClone } from './testing/fixture';
import { runArgv } from './testing/run';

test('the CLI assembles without opening its store', () => {
  assertAssembles(
    createApp({
      git: boundClone('MMR'),
      store: () => {
        throw new Error('assembly must not open the store');
      },
    }),
  );
});

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
test.each([['store export -'], ['doctor']])(
  '%s reports a failing open by its message',
  async (line) => {
    const app = createApp({
      git: boundClone('MMR'),
      machine: {
        cwd: '/nowhere',
        doctor: () => Promise.reject(new Error(unregistered)),
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
