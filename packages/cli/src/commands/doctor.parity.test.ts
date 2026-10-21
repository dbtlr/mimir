import { expect, test } from 'bun:test';

import type { DoctorFinding } from '@mimir/core';

import { MACHINE_REDIRECTS } from '../parity/differences';
import { argvLine } from '../testing/argv-case';
import type { ArgvExtras } from '../testing/argv-case';
import { parityBoard } from '../testing/fixture';
import { oldRun } from '../testing/parity';
import type { ParityCase } from '../testing/parity';
import { runArgv } from '../testing/run';
import { twinCases } from '../testing/twin';

/** The real checks find nothing on the fixture board, so a case can add findings of its own. */
const FINDINGS: DoctorFinding[] = [
  {
    check: 'dangling-parent',
    code: 'dangling-parent',
    evidence: { parent_id: 'MMR-404', value: 'MMR-404' },
    locator: 'node/MMR-1',
    message: 'MMR-1 names parent MMR-404, which no node row holds',
    node: 'MMR-1',
    remedy: 'set parent_id to an existing node',
    scopeKey: 'MMR',
    severity: 'error',
    stem: 'MMR-1',
    where: 'node · parent_id',
  },
  {
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
  },
];

type DoctorCase = ParityCase & { found?: true };

const doctor = (
  name: string,
  options: ParityCase['options'] = {},
  extra: Partial<DoctorCase> = {},
): DoctorCase => ({ name, options, path: ['doctor'], ...extra });

/** A case both CLIs run as this literal argv, the new one through Loom's parser. */
const argv = (line: string, extras: ArgvExtras & { found?: true } = {}): DoctorCase => {
  const named = argvLine(line, extras);
  return {
    ...named,
    ...(extras.found ? { found: extras.found } : {}),
    name: `${named.name}${extras.found ? ' (findings)' : ''}`,
  };
};

const CASES: DoctorCase[] = [
  // A clean store, through every format.
  doctor('doctor -s MMR', { scope: 'MMR' }),
  doctor('doctor -s MMR -f records', { format: 'records', scope: 'MMR' }),
  doctor('doctor -s MMR -f table', { format: 'table', scope: 'MMR' }),
  doctor('doctor -s MMR -f ids', { format: 'ids', scope: 'MMR' }),
  doctor('doctor -s MMR -f json', { format: 'json', scope: 'MMR' }),
  doctor('doctor -s MMR -f jsonl', { format: 'jsonl', scope: 'MMR' }),
  // The scope: the clone binding, every project, or one named.
  doctor('doctor (bound to MMR) -f json', { format: 'json' }, { bound: 'MMR' }),
  doctor('doctor (bound to XX) -s all -f json', { format: 'json', scope: 'all' }, { bound: 'XX' }),
  doctor('doctor (unbound) -f json', { format: 'json' }),
  doctor('doctor -s XX -f json', { format: 'json', scope: 'XX' }),
  doctor('doctor -s ""', { scope: '' }),
  // A scope that matches nothing warns on stderr and still reports the clean scan.
  doctor('doctor -s NOPE', { scope: 'NOPE' }),
  doctor('doctor -s NOPE -f json', { format: 'json', scope: 'NOPE' }),
  // Findings are output, not the exit status.
  doctor('doctor -s MMR (findings)', { scope: 'MMR' }, { found: true }),
  doctor(
    'doctor -s MMR -f records (findings)',
    { format: 'records', scope: 'MMR' },
    { found: true },
  ),
  doctor('doctor -s MMR -f ids (findings)', { format: 'ids', scope: 'MMR' }, { found: true }),
  doctor('doctor -s MMR -f json (findings)', { format: 'json', scope: 'MMR' }, { found: true }),
  doctor('doctor -s MMR -f jsonl (findings)', { format: 'jsonl', scope: 'MMR' }, { found: true }),
  // Faults Loom's parser raises.
  doctor('doctor -s MMR -f yaml', { format: 'yaml', scope: 'MMR' }),
  doctor('doctor -s MMR --bogus', { bogus: true, scope: 'MMR' }),
  // Through Loom's parser, as a shell spells them.
  argv('doctor -s MMR'),
  argv('doctor --scope MMR --format json'),
  argv('doctor -s all -f jsonl', { found: true }),
  // Invocations the old CLI accepted and Loom's parser refuses.
  argv('doctor -s MMR -s XX'),
  argv('doctor extra'),
  // The piped default is json and the terminal default is prose.
  argv('doctor -s MMR', { found: true }),
  argv('doctor -s MMR', { tty: true }),
  argv('doctor -s MMR', { found: true, tty: true }),
  // Misplaced flags, redirected as the old CLI redirected them.
  ...MACHINE_REDIRECTS.filter((line) => line.startsWith('doctor ')).map((line) => argvLine(line)),
];

// Doctor reads, but a case adds findings to the board it runs on, so each runs on a fresh twin.
twinCases(/^doctor /, CASES, undefined, (board, c) => {
  board.findings.push(...(c.found ? FINDINGS : []));
});

test('both CLIs print a doctor remedy on the terminal and preserve it in JSON and JSONL', async () => {
  const board = await parityBoard();
  board.findings.push(...FINDINGS);
  try {
    for (const format of ['records', 'json', 'jsonl']) {
      const words = ['doctor', '-s', 'MMR', '-f', format];
      const old = await oldRun(board.store, words, undefined, true, board.oldDefaults());
      const next = await runArgv(board.app(undefined, words), words, { tty: true });
      for (const run of [old, next]) {
        expect(run.exitCode).toBe(0);
        if (format === 'records') {
          expect(run.stdout).toBe('');
          expect(run.stderr).toContain('\n  fix: set parent_id to an existing node\n');
        } else {
          expect(run.stderr).toBe('');
          const findings: unknown =
            format === 'json'
              ? JSON.parse(run.stdout)
              : run.stdout
                  .trimEnd()
                  .split('\n')
                  .map((line) => JSON.parse(line));
          expect(findings).toEqual(FINDINGS);
        }
      }
    }
  } finally {
    await board.close();
  }
});
