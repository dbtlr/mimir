import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { parityBoard } from '../testing/fixture';
import type { ParityBoard } from '../testing/fixture';
import { runArgv } from '../testing/run';
import { parseTimeCap } from './deliveries';

test.each(['1', '30', '2147483647'])('--time-cap %s is a whole number of minutes', (value) => {
  expect(parseTimeCap(value)).toBe(Number(value));
});

test('--time-cap none clears the cap, and an absent flag leaves it', () => {
  expect(parseTimeCap('none')).toBeNull();
  expect(parseTimeCap(undefined)).toBeUndefined();
});

test.each(['0', '-1', '1.5', '0x10', '1e3', ' 5 ', '', '+5', '05x', '2147483648'])(
  '--time-cap %p is refused',
  (value) => {
    expect(() => parseTimeCap(value)).toThrow('--time-cap requires a positive whole number');
  },
);

describe('delivery commands', () => {
  let board: ParityBoard;
  beforeAll(async () => {
    board = await parityBoard();
  });
  afterAll(async () => {
    await board.close();
  });
  const run = (...argv: string[]) => runArgv(board.app('MMR'), argv);
  const json = async (...argv: string[]) => {
    const result = await run(...argv, '-f', 'json');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };

  test('create takes the project from the phase, never from the phase id text', async () => {
    await board.engine.create({ key: 'OTHR', name: 'Other', type: 'project' });
    const root = await board.engine.create({ parent: 'OTHR', title: 'Far', type: 'initiative' });
    const phase = await board.engine.create({ parent: root.id, title: 'There', type: 'phase' });
    const created = await json('create', 'delivery', 'Elsewhere', '--phase', phase.id);
    expect(created.id).toBe('OTHR-d1');
    expect(created.project_key).toBe('OTHR');
    const missing = await run('create', 'delivery', 'Ghost', '--phase', 'MMR-999');
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("MMR-999 doesn't exist");
  });

  test('get, update, create, and deliveries all carry the whole history', async () => {
    const created = await json('create', 'delivery', 'Logged', '--phase', 'MMR-2');
    const id = String(created.id);
    const seq = Number(created.seq);
    await board.store.deliveries.patch('MMR', seq, {}, [
      {
        at: '2026-03-01T00:00:00.000Z',
        from_value: 'none',
        kind: 'hold',
        reason: 'wait',
        task: null,
        to_value: 'paused',
      },
    ]);
    const read = await json('get', id);
    expect(read.history).toHaveLength(1);
    expect(await json('get', id, '--col', 'history')).toEqual(read);
    const updated = await json('update', id, '--title', 'Logged again');
    expect(updated.history).toEqual(read.history);
    const listed = (await json('deliveries')).deliveries as Record<string, unknown>[];
    expect(listed.find((row) => row.id === id)?.history).toEqual(read.history);
  });

  test('blank --agreement is refused with a hint naming --clear-agreement', async () => {
    const created = await json(
      'create',
      'delivery',
      'Terms',
      '--phase',
      'MMR-2',
      '--agreement',
      'Kept',
    );
    const id = String(created.id);
    for (const blank of ['', '   ']) {
      const refused = await run('update', id, '--agreement', blank);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain('agreement cannot be blank');
      expect(refused.stderr).toContain('--clear-agreement');
      const onCreate = await run(
        'create',
        'delivery',
        'x',
        '--phase',
        'MMR-2',
        '--agreement',
        blank,
      );
      expect(onCreate.stderr).toContain('agreement cannot be blank');
      expect(onCreate.stderr).toContain('omit --agreement');
    }
    expect((await json('get', id)).agreement).toBe('Kept');
    expect((await json('update', id, '--clear-agreement')).agreement).toBeNull();
  });

  test('blank handle text clears a handle, as task update does', async () => {
    const created = await json(
      'create',
      'delivery',
      'Handles',
      '--phase',
      'MMR-2',
      '--branch',
      'feat/x',
      '--host',
      'box',
      '--harness',
      'codex',
      '--session',
      'thread',
    );
    const cleared = await json(
      'update',
      String(created.id),
      '--branch',
      '',
      '--host',
      '',
      '--harness',
      '',
      '--session',
      '',
    );
    expect([cleared.branch, cleared.host, cleared.harness, cleared.session]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });
});
