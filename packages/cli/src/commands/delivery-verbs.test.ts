import { expect, test } from 'bun:test';

import { createApp } from '../app';
import { boundClone, parityBoard } from '../testing/fixture';
import { loomMcpSession } from '../testing/mcp';
import { runArgv } from '../testing/run';

test('delivery start ignores shell identity, refuses every explicit task handle and block owner, and MCP dispatches delivery ids', async () => {
  const board = await parityBoard();
  try {
    await board.engine.deliveryCreate({
      agreement: 'Terms',
      phase: 'MMR-2',
      tasks: ['MMR-3'],
      title: 'Attempt',
    });
    for (const flag of [
      'branch',
      'harness',
      'host',
      'session',
      'worker-harness',
      'worker-session',
    ]) {
      const refusal = await runArgv(board.app(), ['start', 'MMR-d1', `--${flag}`, 'explicit']);
      expect(refusal.exitCode).toBe(1);
      expect(refusal.stderr).toContain('refuses task handle');
    }
    expect((await runArgv(board.app(), ['block', 'MMR-d1', 'wait', '--on', 'you'])).exitCode).toBe(
      1,
    );
    expect((await runArgv(board.app(), ['land', 'MMR-d1', '--', 'unused'])).exitCode).toBe(2);
    const run = await runArgv(board.app(), ['start', 'MMR-d1', '-f', 'json'], {
      env: {
        CODEX_THREAD_ID: 'ambient',
        T3CODE_ENVIRONMENT_ID: 'machine',
        T3CODE_THREAD_ID: 'thread',
      },
    });
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout).session).toBeNull();
    const session = loomMcpSession(board.app());
    try {
      const reply = await session.call('submit', { id: 'MMR-d1' });
      expect(reply.isError).not.toBe(true);
      expect((await board.engine.getDelivery({ id: 'MMR-d1' })).lifecycle).toBe('milestone');
    } finally {
      await session.close();
    }
  } finally {
    await board.close();
  }
});

/** A board with one agreed delivery, MMR-d1, holding MMR-3. */
async function deliveryBoard() {
  const board = await parityBoard();
  await board.engine.deliveryCreate({
    agreement: 'Terms',
    phase: 'MMR-2',
    tasks: ['MMR-3'],
    title: 'Attempt',
  });
  return board;
}

test('block --on on a delivery is refused in its own words, and writes nothing', async () => {
  const board = await deliveryBoard();
  try {
    const run = await runArgv(board.app(), ['block', 'MMR-d1', 'wait', '--on', 'you']);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('delivery block refuses task handle flags and --on');
    expect((await board.engine.getDelivery({ id: 'MMR-d1' })).hold).toBe('none');
  } finally {
    await board.close();
  }
});

test('a task-only verb on a delivery names the delivery verb that does its job, or the verbs a delivery takes', async () => {
  const board = await deliveryBoard();
  try {
    const done = await runArgv(board.app(), ['done', 'MMR-d1']);
    expect(done.exitCode).toBe(1);
    expect(done.stderr).toContain('done does not apply to a delivery');
    expect(done.stderr).toContain('land MMR-d1');
    for (const words of [
      ['stage', 'MMR-d1'],
      ['reopen', 'MMR-d1'],
      ['unqueue', 'MMR-d1'],
    ]) {
      const run = await runArgv(board.app(), words);
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain(`${words[0]} does not apply to a delivery`);
      expect(run.stderr).toContain(
        'a delivery takes start, block, unblock, park, unpark, submit, return, land, and abandon',
      );
    }
  } finally {
    await board.close();
  }
});

test('queue on a delivery says a delivery cannot be queued, with or without a session or a shell identity', async () => {
  const board = await deliveryBoard();
  try {
    for (const [words, env] of [
      [['queue', 'MMR-d1'], undefined],
      [['queue', 'MMR-d1', '--session', 'run'], undefined],
      [['queue', 'MMR-d1'], { T3CODE_ENVIRONMENT_ID: 'machine', T3CODE_THREAD_ID: 'thread' }],
      [
        ['queue', 'MMR-d1', '--session', 'run'],
        { T3CODE_ENVIRONMENT_ID: 'machine', T3CODE_THREAD_ID: 'thread' },
      ],
    ] as const) {
      const run = await runArgv(board.app(), [...words], env === undefined ? {} : { env });
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain('queue does not apply to a delivery');
      expect(run.stderr).not.toContain('requires a nonblank session');
    }
  } finally {
    await board.close();
  }
});

test('a bare return on a delivery sends the Engine no reason', async () => {
  const board = await deliveryBoard();
  try {
    await board.engine.deliveryStart({ id: 'MMR-d1' });
    await board.engine.deliverySubmit({ id: 'MMR-d1' });
    const calls: unknown[] = [];
    const spy = new Proxy(board.engine, {
      get(target, property, receiver) {
        if (property === 'deliveryReturn') {
          return (input: { id: string; reason?: string }) => {
            calls.push(input);
            return target.deliveryReturn(input);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const app = createApp({
      git: boundClone('MMR'),
      remote: {
        diagnose: () => Promise.reject(new Error('not diagnosed here')),
        engine: () => Promise.resolve(spy),
        origin: () => 'https://host.example',
      },
    });
    const run = await runArgv(app, ['return', 'MMR-d1', '-f', 'json']);
    expect(run.exitCode).toBe(0);
    expect(calls).toEqual([{ id: 'MMR-d1' }]);
    expect(JSON.parse(run.stdout).history.at(-1)).toMatchObject({ reason: null });
  } finally {
    await board.close();
  }
});

test('a multi-line reason renders its continuation lines indented, so it cannot forge a history row', async () => {
  const board = await deliveryBoard();
  try {
    const forged = '2026-01-01T00:00:00.000Z lifecycle: milestone -> landed';
    const block = await runArgv(board.app(), ['block', 'MMR-d1', `wait\n${forged}`, '--ascii']);
    expect(block.exitCode).toBe(0);
    const get = await runArgv(board.app(), ['get', 'MMR-d1', '--ascii']);
    expect(get.exitCode).toBe(0);
    for (const run of [block, get]) {
      const lines = run.stdout.split('\n');
      expect(lines.filter((line) => line.startsWith('2026-01-01'))).toEqual([]);
      const holdReason = lines.indexOf('hold_reason: wait');
      expect(lines[holdReason + 1]).toBe(`             ${forged}`);
      const row = lines.findIndex((line) => line.includes('hold: none -> stopped'));
      expect(lines[row]).toEndWith(' - wait');
      expect(lines[row + 1]?.trim()).toBe(forged);
      expect(lines[row + 1]?.startsWith(' ')).toBe(true);
    }
  } finally {
    await board.close();
  }
});
