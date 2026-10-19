import { expect, test } from 'bun:test';

import { parityBoard } from '../testing/fixture';
import { runArgv } from '../testing/run';

test('update assigns a worker explicitly while preserving the main conversation', async () => {
  const board = await parityBoard();
  try {
    await board.engine.update({ harness: 'codex', id: 'MMR-3', session: 'main' });
    const run = await runArgv(
      board.app(),
      ['update', 'MMR-3', '--worker-harness', 'claude', '--worker-session', 'worker', '-f', 'json'],
      { env: { CODEX_THREAD_ID: 'ambient-helper' } },
    );
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      harness: 'codex',
      session: 'main',
      worker_harness: 'claude',
      worker_session: 'worker',
    });
  } finally {
    await board.close();
  }
});

test('updating only the worker session clears its previous harness without borrowing the shell', async () => {
  const board = await parityBoard();
  try {
    const run = await runArgv(
      board.app(),
      ['update', 'MMR-5', '--worker-session', 'replacement', '-f', 'json'],
      { env: { CODEX_THREAD_ID: 'ambient-helper' } },
    );
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      harness: 'codex',
      session: 'main-session',
      worker_harness: null,
      worker_session: 'replacement',
    });
    const history = await board.engine.getNode({ facets: ['history'], id: 'MMR-5' });
    expect(history.history?.at(-1)).toMatchObject({
      kind: 'assignment',
      to: JSON.stringify({
        harness: 'codex',
        session: 'main-session',
        worker_harness: null,
        worker_session: 'replacement',
      }),
    });
  } finally {
    await board.close();
  }
});

test('blank worker flags clear the worker and ordinary updates never infer one', async () => {
  const board = await parityBoard();
  try {
    const env = { CODEX_THREAD_ID: 'ambient-helper' };
    const cleared = await runArgv(
      board.app(),
      ['update', 'MMR-5', '--worker-harness', '', '--worker-session', '', '-f', 'json'],
      { env },
    );
    expect(cleared.exitCode).toBe(0);
    expect(JSON.parse(cleared.stdout)).toMatchObject({
      harness: 'codex',
      session: 'main-session',
      worker_harness: null,
      worker_session: null,
    });
    const updated = await runArgv(
      board.app(),
      ['update', 'MMR-5', '--summary', 'Keep the main return point', '-f', 'json'],
      { env },
    );
    expect(updated.exitCode).toBe(0);
    expect(JSON.parse(updated.stdout)).toMatchObject({
      harness: 'codex',
      session: 'main-session',
      worker_harness: null,
      worker_session: null,
    });
  } finally {
    await board.close();
  }
});

test.each(['worker-harness', 'worker-session'])(
  'a misplaced --%s points to start and update',
  async (flag) => {
    const board = await parityBoard();
    try {
      const argv = ['list', '-s', 'MMR', `--${flag}`, 'worker'];
      const run = await runArgv(board.app(undefined, argv), argv);
      expect(run.exitCode).toBe(2);
      expect(run.stderr).toContain(
        `'--${flag}' identifies the distinct task owner at start/update`,
      );
    } finally {
      await board.close();
    }
  },
);
