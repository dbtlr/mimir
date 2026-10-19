import { afterAll, beforeAll, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DoctorFinding } from '@mimir/core';

import { parityBoard } from '../testing/fixture';
import type { ParityBoard } from '../testing/fixture';
import { oldRun } from '../testing/parity';
import { runArgv } from '../testing/run';
import { LEGACY_BINDING_FILE } from './bind';

/**
 * The parity harness compares stdout and the exit code on success, so the
 * lines the machine commands write to stderr are pinned here against the old
 * CLI's `io.err`.
 */
let oldBoard: ParityBoard;
let board: ParityBoard;
beforeAll(async () => {
  oldBoard = await parityBoard();
  board = await parityBoard();
});
afterAll(async () => {
  await oldBoard.close();
  await board.close();
});

const FINDING: DoctorFinding = {
  check: 'orphan-edge',
  code: 'orphan-edge',
  evidence: {},
  locator: 'edge/7',
  message: 'MMR-2 depends on a node that is gone',
  node: 'MMR-2',
  scopeKey: 'MMR',
  severity: 'warn',
  stem: 'MMR-2',
  where: 'edge · to_id',
};

const MIMIR_ORIGIN = 'git@github.com:dbtlr/mimir.git';

/** What the old CLI wrote to stderr for an argv, one string, piped. */
async function oldStderr(argv: string[], origin?: string): Promise<string> {
  const run = await oldRun(
    oldBoard.store,
    argv,
    undefined,
    false,
    oldBoard.oldDefaults(undefined, origin),
  );
  return run.stderr;
}

async function newStderr(argv: string[], origin?: string): Promise<string> {
  return (await runArgv(board.app(undefined, undefined, origin), argv)).stderr;
}

test.each([
  [['doctor', '-s', 'MMR', '-f', 'records']],
  [['doctor', '-s', 'MMR', '-f', 'ids']],
  [['doctor', '-s', 'MMR', '-f', 'table']],
])('doctor %p writes the finding lines the old CLI wrote', async (argv) => {
  oldBoard.findings.push(FINDING);
  board.findings.push(FINDING);
  try {
    const want = await oldStderr(argv);
    expect(want).not.toBe('');
    expect(await newStderr(argv)).toBe(want);
  } finally {
    oldBoard.findings.length = 0;
    board.findings.length = 0;
  }
});

test.each([
  [['doctor', '-s', 'MMR', '-f', 'json']],
  [['doctor', '-s', 'MMR', '-f', 'jsonl']],
  [['doctor', '-s', 'MMR']],
])('doctor %p keeps stderr empty so the stream stays parseable', async (argv) => {
  board.findings.push(FINDING);
  try {
    expect(await oldStderr(argv)).toBe('');
    const run = await runArgv(board.app(), argv);
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain('orphan-edge');
  } finally {
    board.findings.length = 0;
  }
});

test('doctor warns when its scope matches no records', async () => {
  const argv = ['doctor', '-s', 'NOPE'];
  const want = await oldStderr(argv);
  expect(want).toContain('matched 0 records');
  expect(await newStderr(argv)).toBe(want);
});

test('bind announces an auto-bind from the origin', async () => {
  const argv = ['bind'];
  const want = await oldStderr(argv, MIMIR_ORIGIN);
  expect(want).not.toBe('');
  expect(await newStderr(argv, MIMIR_ORIGIN)).toBe(want);
});

test('bind warns that the retired binding file is ignored', async () => {
  const files = [oldBoard, board].map((b) => join(b.dir, LEGACY_BINDING_FILE));
  for (const file of files) {
    writeFileSync(file, 'project = "MMR"\n');
  }
  try {
    const argv = ['bind', 'MMR'];
    const want = await oldStderr(argv);
    expect(want).toContain('is ignored now');
    expect(await newStderr(argv)).toBe(want);
  } finally {
    for (const file of files) {
      rmSync(file, { force: true });
    }
  }
});
