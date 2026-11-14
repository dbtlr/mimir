import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { DASH_TITLE_HINT } from '../failures';
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

  test('omitting --task sweeps, repeated --task selects, and update joins and leaves', async () => {
    const phase = await board.engine.create({
      parent: 'MMR-1',
      title: 'Membership',
      type: 'phase',
    });
    const first = await board.engine.create({ parent: phase.id, title: 'First', type: 'task' });
    const second = await board.engine.create({ parent: phase.id, title: 'Second', type: 'task' });
    const swept = await json('create', 'delivery', 'Sweep', '--phase', phase.id);
    expect(swept.members).toEqual([first.id, second.id]);
    await json('update', first.id, '--delivery', 'none');
    await json('update', second.id, '--delivery', 'none');
    const selected = await json(
      'create',
      'delivery',
      'Select',
      '--phase',
      phase.id,
      '--task',
      first.id,
      '--task',
      second.id,
    );
    expect(selected.members).toEqual([first.id, second.id]);
    await json('update', first.id, '--delivery', 'none');
    const joined = await json('update', first.id, '--delivery', String(swept.id));
    expect(joined.delivery).toBe(swept.id);
  });

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
    expect(read.history).toHaveLength((created.history as unknown[]).length + 1);
    expect(await json('get', id, '--col', 'history')).toEqual(read);
    const updated = await json('update', id, '--title', 'Logged again');
    expect(updated.history).toEqual(read.history);
    const listed = (await json('deliveries')).deliveries as Record<string, unknown>[];
    expect(listed.find((row) => row.id === id)?.history).toEqual(read.history);
  });

  test('create reads a dashed title after --', async () => {
    const made = await run(
      'create',
      'delivery',
      '--phase',
      'MMR-2',
      '-f',
      'json',
      '--',
      '--weird title',
    );
    expect(made.exitCode).toBe(0);
    expect((JSON.parse(made.stdout) as Record<string, unknown>).title).toBe('--weird title');
  });

  test('a missing title gives the usage error and hint the other creates give', async () => {
    const task = await run('create', 'task', '--parent', 'MMR-2');
    const delivery = await run('create', 'delivery', '--phase', 'MMR-2');
    expect(delivery.exitCode).toBe(task.exitCode);
    expect(delivery.stderr).toContain('create delivery requires a title');
    expect(delivery.stderr).toContain(DASH_TITLE_HINT);
    expect(task.stderr).toContain(DASH_TITLE_HINT);
  });

  test('plain output of a delivery history keeps to ASCII', async () => {
    const created = await json('create', 'delivery', 'Glyphs', '--phase', 'MMR-2');
    const id = String(created.id);
    await board.store.deliveries.patch('MMR', Number(created.seq), {}, [
      {
        at: '2026-03-01T00:00:00.000Z',
        from_value: null,
        kind: 'hold',
        reason: 'wait',
        task: null,
        to_value: 'paused',
      },
    ]);
    for (const argv of [['get', id], ['update', id, '--title', 'Glyphs 2'], ['deliveries']]) {
      const plain = await run(...argv, '-f', 'records', '--ascii');
      expect(plain.exitCode).toBe(0);
      expect(plain.stdout).toContain('hold: - -> paused - wait');
      expect(plain.stdout).not.toMatch(/[→—]/u);
    }
    const made = await run('create', 'delivery', 'Glyphs 3', '--phase', 'MMR-2', '--ascii');
    expect(made.exitCode).toBe(0);
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
