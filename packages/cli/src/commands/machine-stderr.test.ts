import { afterAll, beforeAll, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DoctorFinding } from '@mimir/core';

import { parityBoard } from '../testing/fixture';
import type { ParityBoard } from '../testing/fixture';
import { runArgv } from '../testing/run';
import { LEGACY_BINDING_FILE } from './bind';

/**
 * The parity pins hold stdout and the exit code on success, so the lines the
 * machine commands write to stderr are pinned here. The expected lines are
 * what the old CLI wrote to `io.err` for the same argv.
 */
let board: ParityBoard;
beforeAll(async () => {
  board = await parityBoard();
});
afterAll(async () => {
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

async function newStderr(argv: string[], origin?: string): Promise<string> {
  return (await runArgv(board.app(undefined, undefined, origin), argv)).stderr;
}

const FINDING_LINE = '[warn] MMR-2: MMR-2 depends on a node that is gone (edge · to_id)\n';

test.each([
  [['doctor', '-s', 'MMR', '-f', 'records']],
  [['doctor', '-s', 'MMR', '-f', 'ids']],
  [['doctor', '-s', 'MMR', '-f', 'table']],
])('doctor %p writes the finding line', async (argv) => {
  board.findings.push(FINDING);
  try {
    expect(await newStderr(argv)).toBe(FINDING_LINE);
  } finally {
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
    const run = await runArgv(board.app(), argv);
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain('orphan-edge');
  } finally {
    board.findings.length = 0;
  }
});

test('doctor warns when its scope matches no records', async () => {
  expect(await newStderr(['doctor', '-s', 'NOPE'])).toBe(
    "[warn] doctor scope 'NOPE' matched 0 records\n",
  );
});

test('bind announces an auto-bind from the origin', async () => {
  expect(await newStderr(['bind'], MIMIR_ORIGIN)).toBe(
    'bound to MMR from the origin remote github.com/dbtlr/mimir (saved in git config)\n',
  );
});

test('bind warns that the retired binding file is ignored', async () => {
  const file = join(board.dir, LEGACY_BINDING_FILE);
  writeFileSync(file, 'project = "MMR"\n');
  try {
    expect(await newStderr(['bind', 'MMR'])).toBe(
      '[warn] .mimir.toml is ignored now; you can delete it\n',
    );
  } finally {
    rmSync(file, { force: true });
  }
});
