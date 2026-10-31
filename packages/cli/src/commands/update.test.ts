import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { inapplicableUpdateFields } from '@mimir/core';

import { proseOrClear } from '../node-input';
import { parityBoard } from '../testing/fixture';
import type { ParityBoard } from '../testing/fixture';
import { runArgv } from '../testing/run';
import { foreignFields } from './update';

/** The flags core's update fields are spelled as; the rest derive as `--<kebab-key>`. */
const FLAG_OVERRIDES: Readonly<Record<string, readonly string[]>> = {
  description: ['desc', 'clear-desc'],
  externalRef: ['ref'],
  next: ['direction', 'clear-direction'],
  openEnded: ['open-ended', 'not-open-ended'],
};

const flagsOf = (field: string): readonly string[] =>
  FLAG_OVERRIDES[field] ?? [field.replaceAll(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)];

// A field core adds to the update vocabulary has no flag here until update owns or refuses it.
test.each(['artifact', 'project', 'seed'] as const)(
  'update refuses exactly the fields core says do not apply to a %s',
  (kind) => {
    const expected: string[] = inapplicableUpdateFields(kind).flatMap(flagsOf);
    const refused: string[] = foreignFields(kind);
    expect(refused).toEqual(expected);
  },
);

// Clearing long prose is its own flag; blank text is refused (ADR 0034 refinement).
describe('update clears direction and description explicitly', () => {
  let board: ParityBoard;
  let phase: string;
  beforeAll(async () => {
    board = await parityBoard();
  });
  beforeEach(async () => {
    phase = (await board.engine.create({ parent: 'MMR-1', title: 'Clearing', type: 'phase' })).id;
    await board.engine.update({ description: 'Phase prose.', id: phase, next: 'Hold this.' });
    await board.engine.updateProject({ description: 'About.', id: 'MMR', next: 'Project course.' });
    await board.engine.seedUpdate({ description: 'Seed prose.', id: 'MMR-s1' });
  });

  afterAll(async () => {
    await board.close();
  });
  const update = (...argv: string[]) => runArgv(board.app('MMR'), ['update', ...argv]);
  const nodeProse = async (id: string) =>
    board.engine.getNode({ facets: ['description', 'next'], id });

  test('--clear-direction and --clear-desc clear a container', async () => {
    expect((await update(phase, '--clear-direction', '--clear-desc')).exitCode).toBe(0);
    const read = await nodeProse(phase);
    expect(read.next).toBeUndefined();
    expect(read.description).toBeNull();
  });

  test('--clear-direction and --clear-desc clear a project', async () => {
    expect((await update('MMR', '--clear-direction', '--clear-desc')).exitCode).toBe(0);
    const read = await nodeProse('MMR');
    expect(read.next).toBeUndefined();
    expect(read.description).toBeNull();
  });

  test('--clear-desc clears a task and a seed', async () => {
    expect((await update('MMR-3', '--clear-desc')).exitCode).toBe(0);
    expect((await nodeProse('MMR-3')).description).toBeNull();
    expect((await update('MMR-s1', '--clear-desc')).exitCode).toBe(0);
    expect((await board.engine.getSeed({ content: true, id: 'MMR-s1' })).description).toBeNull();
  });

  test.each([
    ['--direction', 'x', '--clear-direction'],
    ['--desc', 'x', '--clear-desc'],
  ])('%s with its clear flag is a usage error', async (textFlag, text, clearFlag) => {
    const run = await update(phase, textFlag, text, clearFlag);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain(`at most one of ${textFlag} | ${clearFlag}`);
    const read = await nodeProse(phase);
    expect(read.next).toBe('Hold this.');
    expect(read.description).toBe('Phase prose.');
  });

  test.each([
    ['--direction', '--clear-direction'],
    ['--desc', '--clear-desc'],
  ])('blank %s is refused with a hint naming %s', async (textFlag, clearFlag) => {
    for (const blank of ['', '   ']) {
      for (const id of [phase, 'MMR']) {
        const run = await update(id, textFlag, blank);
        expect(run.exitCode).toBe(1);
        expect(run.stderr).toContain('cannot be blank');
        expect(run.stderr).toContain(clearFlag);
      }
    }
    expect((await update('MMR-s1', '--desc', '  ')).stderr).toContain('--clear-desc');
    const read = await nodeProse(phase);
    expect(read.next).toBe('Hold this.');
    expect(read.description).toBe('Phase prose.');
    expect((await nodeProse('MMR')).next).toBe('Project course.');
  });

  test('--clear-direction on a task is refused as --direction is', async () => {
    const clear = await update('MMR-3', '--clear-direction');
    const text = await update('MMR-3', '--direction', 'x');
    expect(clear.exitCode).toBe(text.exitCode);
    expect(clear.stderr).toContain('next applies only to phases and initiatives');
  });

  test('--clear-direction on a seed or an artifact is refused as --direction is', async () => {
    const seed = await update('MMR-s1', '--clear-direction');
    expect(seed.exitCode).toBe((await update('MMR-s1', '--direction', 'x')).exitCode);
    expect(seed.stderr).toContain("--clear-direction doesn't apply to a seed");
    const artifact = await update('MMR-a1', '--clear-desc');
    expect(artifact.exitCode).toBe((await update('MMR-a1', '--desc', 'x')).exitCode);
    expect(artifact.stderr).toContain("--clear-desc doesn't apply to an artifact");
  });
});

test('a clear flag sent false (an MCP caller) is not given', () => {
  expect(proseOrClear('New.', false, 'usage')).toBe('New.');
  expect(proseOrClear(undefined, false, 'usage')).toBeUndefined();
  expect(proseOrClear(undefined, true, 'usage')).toBeNull();
  expect(() => proseOrClear('New.', true, 'usage')).toThrow('usage');
});
