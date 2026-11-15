import { expect, test } from 'bun:test';

import { parityBoard } from '../testing/fixture';
import { runArgv } from '../testing/run';

test('decision updates refuse delivery-only flags even with task links', async () => {
  const board = await parityBoard();
  try {
    await board.engine.decide({
      class: 'other',
      options: ['A', 'B'],
      project: 'MMR',
      question: 'Which?',
      recommended: 1,
    });
    for (const flags of [['--agreement', 'Terms'], ['--clear-agreement'], ['--time-cap', '20']]) {
      for (const links of [[], ['--task', 'MMR-4']]) {
        const run = await runArgv(board.app(), ['update', 'MMR-q1', ...flags, ...links]);
        expect(run.exitCode).toBe(1);
        expect(run.stderr).toContain(`${flags[0]} doesn't apply to a decision`);
        for (const hint of ['--task', '--untask', '--delivery']) {
          expect(run.stderr).toContain(hint);
        }
      }
    }
  } finally {
    await board.close();
  }
});

test('other verbs refuse decision and delivery ids behaviorally', async () => {
  const board = await parityBoard();
  try {
    for (const id of ['MMR-q1', 'MMR-d1']) {
      for (const verb of [
        'promote',
        'resolve',
        'reject',
        ...(id.includes('-q') ? ['archive', 'unarchive'] : []),
      ]) {
        const run = await runArgv(board.app(), [verb, id]);
        expect(run.exitCode).toBe(1);
        expect(run.stderr).toContain(id.includes('-q') ? 'confirm' : 'land');
      }
    }
  } finally {
    await board.close();
  }
});

test('decision records echo identity first and separate linked tasks with commas and spaces', async () => {
  const board = await parityBoard();
  try {
    const run = await runArgv(board.app(), [
      'decide',
      'Which?',
      '--option',
      'A',
      '--option',
      'B',
      '--recommend',
      '1',
      '--class',
      'other',
      '-p',
      'MMR',
      '--task',
      'MMR-3',
      '--task',
      'MMR-4',
    ]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.startsWith('id: MMR-q1\n')).toBe(true);
    expect(run.stdout).toContain('tasks: MMR-3, MMR-4');
  } finally {
    await board.close();
  }
});

test('decide refuses words beyond the quoted question, before or after --', async () => {
  const board = await parityBoard();
  try {
    const rest = [
      '--option',
      'A',
      '--option',
      'B',
      '--recommend',
      '1',
      '--class',
      'other',
      '-p',
      'MMR',
    ];
    const unquoted = await runArgv(board.app(), ['decide', 'Store', 'snapshots', ...rest]);
    expect(unquoted.exitCode).toBe(2);
    expect(unquoted.stderr).toContain('accepts 1 argument');
    const passthrough = await runArgv(board.app(), ['decide', 'Store', ...rest, '--', 'snapshots']);
    expect(passthrough.exitCode).toBe(2);
    expect(passthrough.stderr).toContain('quote the question as one argument');
    const get = await runArgv(board.app(), ['get', 'MMR-q1']);
    expect(get.exitCode).not.toBe(0);
  } finally {
    await board.close();
  }
});
