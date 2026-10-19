import { expect, test } from 'bun:test';

import { createApp } from '../app';
import { boundClone, parityBoard } from '../testing/fixture';
import { runArgv } from '../testing/run';

const ambient = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'incidental-helper' };

test('a plain queued start preserves main and preassigned worker despite an incidental shell', async () => {
  const board = await parityBoard();
  try {
    await board.engine.queue({ harness: 'codex', id: 'MMR-3', session: 'main' });
    await board.engine.update({ id: 'MMR-3', workerHarness: 'claude', workerSession: 'worker' });
    const run = await runArgv(board.app(), ['start', 'MMR-3', '-f', 'json'], { env: ambient });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      harness: 'codex',
      session: 'main',
      worker_harness: 'claude',
      worker_session: 'worker',
    });
    expect(run.stderr).toBe('');
  } finally {
    await board.close();
  }
});

test('explicit blank worker session clears a queued assignment without shell inference', async () => {
  const board = await parityBoard();
  try {
    await board.engine.queue({ harness: 'codex', id: 'MMR-3', session: 'main' });
    await board.engine.update({ id: 'MMR-3', workerHarness: 'claude', workerSession: 'worker' });
    const run = await runArgv(
      board.app(),
      ['start', 'MMR-3', '--worker-session', '', '-f', 'json'],
      { env: ambient },
    );
    expect(run.exitCode, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      harness: 'codex',
      session: 'main',
      worker_harness: null,
      worker_session: null,
    });
    expect(run.stderr).toBe('');
  } finally {
    await board.close();
  }
});

test('worker flags require an established main identity rather than promoting the ambient shell', async () => {
  const board = await parityBoard();
  try {
    const run = await runArgv(
      board.app(),
      ['start', 'MMR-3', '--worker-session', 'worker', '-f', 'json'],
      { env: ambient },
    );
    expect(run.exitCode).toBe(1);
    expect(JSON.parse(run.stderr).error.message).toContain('main session');
    expect(await board.engine.getNode({ id: 'MMR-3' })).toMatchObject({
      harness: null,
      lifecycle: 'todo',
      session: null,
      workerHarness: null,
      workerSession: null,
    });
  } finally {
    await board.close();
  }
});

test('worker flags are refused on queue before it reserves a task', async () => {
  const board = await parityBoard();
  try {
    const argv = [
      'queue',
      'MMR-3',
      '--session',
      'main',
      '--worker-session',
      'worker',
      '-f',
      'json',
    ];
    const run = await runArgv(board.app(undefined, argv), argv);
    expect(run.exitCode).toBe(2);
    expect(await board.engine.getNode({ id: 'MMR-3' })).toMatchObject({
      lifecycle: 'todo',
      session: null,
    });
  } finally {
    await board.close();
  }
});

test.each(['release', 'takeover', 'scalar'] as const)(
  'start checks the observed assignment inside its transaction after a concurrent %s',
  async (race) => {
    const board = await parityBoard();
    try {
      await board.engine.queue({ harness: 'codex', id: 'MMR-3', session: 'main' });
      let armed = true;
      const racingStore = new Proxy(board.store, {
        get(target, property) {
          if (property === 'transact') {
            return async (work: Parameters<typeof target.transact>[0]) => {
              if (armed) {
                armed = false;
                if (race === 'release') {
                  await board.engine.unqueue({ id: 'MMR-3', reason: 'cancelled' });
                } else if (race === 'takeover') {
                  await board.engine.update({ id: 'MMR-3', session: 'replacement' });
                } else {
                  await board.engine.update({ id: 'MMR-3', title: 'Concurrent title edit' });
                }
              }
              return target.transact(work);
            };
          }
          const value: unknown = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const app = createApp({ git: boundClone('MMR'), store: () => Promise.resolve(racingStore) });
      const run = await runArgv(
        app,
        ['start', 'MMR-3', '--worker-session', 'worker', '-f', 'json'],
        { env: ambient },
      );
      const node = await board.engine.getNode({ facets: ['history'], id: 'MMR-3' });
      expect(armed).toBe(false);
      if (race === 'scalar') {
        expect(run.exitCode, run.stderr).toBe(0);
        expect(node).toMatchObject({
          lifecycle: 'in_progress',
          session: 'main',
          title: 'Concurrent title edit',
          workerSession: 'worker',
        });
      } else {
        expect(run.exitCode).toBe(1);
        expect(JSON.parse(run.stderr).error.code).toBe('conflict');
        expect(node).toMatchObject({
          lifecycle: race === 'release' ? 'todo' : 'queued',
          session: race === 'release' ? null : 'replacement',
          workerSession: null,
        });
        expect(node.history).toHaveLength(2);
      }
    } finally {
      await board.close();
    }
  },
);
