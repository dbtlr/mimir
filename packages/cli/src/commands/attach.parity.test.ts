import { afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NODE_REDIRECTS } from '../parity/differences';
import { argvCase as argv, argvLine } from '../testing/argv-case';
import type { ParityCase } from '../testing/parity';
import { twinCases } from '../testing/twin';

// The cases name real files, so both CLIs read the same bytes at the same path.
const dir = mkdtempSync(join(tmpdir(), 'mimir-attach-'));
const file = join(dir, 'design.md');
const empty = join(dir, 'empty.md');
writeFileSync(file, '# Design\n\nThe body.\n');
writeFileSync(empty, '  \n');
afterAll(() => {
  rmSync(dir, { force: true, recursive: true });
});

/** The case names carry no machine path, so a difference entry can name one. */
const attach = (line: string[], tty?: true): ParityCase => {
  const masked: Record<string, string> = {
    [empty]: '<empty>',
    [file]: '<file>',
  };
  const named = argv(
    line.map((word) => masked[word] ?? word),
    tty,
  );
  return { ...named, argv: line };
};

const CASES: ParityCase[] = [
  // A document linked to a node, through every format.
  attach(['attach', 'MMR-5', '--file', file]),
  attach(['attach', 'MMR-5', '--file', file, '-f', 'json']),
  attach(['attach', 'MMR-5', '--file', file, '-f', 'jsonl']),
  attach(['attach', 'MMR-5', '--file', file, '-f', 'ids']),
  attach(['attach', 'MMR-5', '--file', file, '-f', 'table']),
  attach(['attach', 'MMR-5', '--file', file, '--ascii']),
  attach(['attach', 'MMR-5', '--file', file], true),
  // Titles, summaries, tags, and several links.
  attach(['attach', 'MMR-5', '--file', file, '--title', 'Design notes']),
  attach(['attach', 'MMR-5', '--file', file, '--summary', 'the design']),
  attach(['attach', 'MMR-5', '--file', file, '-t', 'design', '-t', 'review']),
  attach(['attach', 'MMR-5', '--file', file, '--tag', 'design']),
  attach(['attach', 'MMR-5', '--file', file, '--link', 'MMR-3,MMR-4']),
  attach(['attach', '--file', file, '--link', 'MMR-3', '--link', 'MMR-4']),
  attach(['attach', 'MMR-5', '--file', file, '--link', 'MMR-5']),
  // A project-level artifact.
  attach(['attach', '--file', file, '--project', 'MMR']),
  attach(['attach', '--file', file, '--project', 'MMR', '-f', 'json']),
  attach(['attach', 'MMR-5', '--file', file, '--project', 'MMR']),
  // Refusals Mimir raises.
  attach(['attach', 'MMR-99', '--file', file]),
  attach(['attach', 'MMR-99', '--file', file, '-f', 'json']),
  attach(['attach', 'MMR', '--file', file]),
  attach(['attach', 'MMR-a1', '--file', file]),
  attach(['attach', 'MMR-s1', '--file', file]),
  attach(['attach', 'nope', '--file', file]),
  attach(['attach', '--file', file]),
  attach(['attach', '--file', file, '--project', 'NOPE']),
  attach(['attach', '--file', file, '--project', 'nope']),
  attach(['attach', 'MMR-5', '--file', file, '--project', 'XX']),
  attach(['attach', 'MMR-5', '--file', empty]),
  attach(['attach', 'MMR-5', '--file', file, '--title', ' ']),
  // Faults Loom's parser raises.
  attach(['attach', 'MMR-5', '--file', file, '--bogus']),
  // Invocations the old CLI accepted and Loom's parser refuses.
  attach(['attach', 'MMR-5', '--file', file, '--file', file]),
  attach(['attach', 'MMR-5', 'MMR-6', '--file', file]),
  // Misplaced flags, redirected as the old CLI redirected them.
  ...NODE_REDIRECTS.filter((line) => line.startsWith('attach ')).map((line) => argvLine(line)),
];

twinCases(/^attach /, CASES);
