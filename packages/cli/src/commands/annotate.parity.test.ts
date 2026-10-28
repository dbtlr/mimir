import { argvCase, argvLine } from '../testing/argv-case';
import type { ParityCase } from '../testing/parity';
import { NODE_REDIRECTS } from '../testing/redirects';
import { writeCases } from '../testing/writes';

const argv = argvCase;

const CASES: ParityCase[] = [
  argv(['annotate', 'MMR-3', 'Settled', 'on', 'one', 'store']),
  argv(['annotate', 'MMR-3', 'a note', '-f', 'json']),
  argv(['annotate', 'MMR-3', 'a note', '-f', 'jsonl']),
  argv(['annotate', 'MMR-3', 'a note', '-f', 'ids']),
  argv(['annotate', 'MMR-3', 'a note', '-f', 'table']),
  argv(['annotate', 'MMR-3', 'a note', '--ascii']),
  argv(['annotate', 'MMR-3', 'a note'], true),
  argv(['annotate', 'MMR-2', 'a note on a container'], true),
  argv(['annotate', 'MMR-3', '--', '-a note led by a dash']),
  // Refusals Mimir raises.
  argv(['annotate', 'MMR-3', ' ']),
  argv(['annotate', 'MMR-99', 'a note']),
  argv(['annotate', 'MMR-99', 'a note', '-f', 'json']),
  argv(['annotate', 'MMR', 'a note']),
  argv(['annotate', 'MMR-a1', 'a note']),
  argv(['annotate', 'MMR-s1', 'a note']),
  argv(['annotate', 'nope', 'a note']),
  // Faults Loom's parser raises.
  argv(['annotate']),
  argv(['annotate', 'MMR-3', 'a note', '--bogus']),
  // Misplaced flags, redirected as the old CLI redirected them.
  ...NODE_REDIRECTS.filter((line) => line.startsWith('annotate ')).map((line) => argvLine(line)),
];

writeCases(import.meta.url, CASES);
