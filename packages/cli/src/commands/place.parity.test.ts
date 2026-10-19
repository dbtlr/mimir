import { NODE_REDIRECTS } from '../parity/differences';
import { argvCase as argv, argvLine } from '../testing/argv-case';
import type { ParityCase } from '../testing/parity';
import { twinCases } from '../testing/twin';

const CASES: ParityCase[] = [
  // move: a new parent, through every format.
  argv(['move', 'MMR-5', '--to', 'MMR-1']),
  argv(['move', 'MMR-5', '--to', 'MMR-1', '-f', 'json']),
  argv(['move', 'MMR-5', '--to', 'MMR-1', '-f', 'jsonl']),
  argv(['move', 'MMR-5', '--to', 'MMR-1', '-f', 'ids']),
  argv(['move', 'MMR-5', '--to', 'MMR-1', '-f', 'table']),
  argv(['move', 'MMR-5', '--to', 'MMR-1', '--ascii']),
  argv(['move', 'MMR-5', '--to', 'MMR-1'], true),
  argv(['move', 'MMR-5', '--to', 'MMR-2']),
  argv(['move', 'MMR-2', '--to', 'MMR-1']),
  // move: refusals Mimir raises.
  argv(['move', 'MMR-5', '--to', 'MMR-5']),
  argv(['move', 'MMR-5', '--to', 'MMR-4']),
  argv(['move', 'MMR-1', '--to', 'MMR-2']),
  argv(['move', 'MMR-5', '--to', 'XX-2']),
  argv(['move', 'MMR-5', '--to', 'XX-2', '-f', 'json']),
  argv(['move', 'MMR-99', '--to', 'MMR-1']),
  argv(['move', 'MMR-5', '--to', 'MMR-99']),
  argv(['move', 'MMR-5', '--to', 'MMR-99', '-f', 'json']),
  argv(['move', 'MMR', '--to', 'MMR-1']),
  argv(['move', 'MMR-5', '--to', 'MMR']),
  argv(['move', 'MMR-a1', '--to', 'MMR-1']),
  argv(['move', 'MMR-5', '--to', 'MMR-s1']),
  argv(['move', 'nope', '--to', 'MMR-1']),
  argv(['move', 'MMR-5', '--to', '']),
  // move: faults Loom's parser raises.
  argv(['move', 'MMR-5']),
  argv(['move', '--to', 'MMR-1']),
  argv(['move', 'MMR-5', '--to', 'MMR-1', '--bogus']),
  // move: invocations the old CLI accepted and Loom's parser refuses.
  argv(['move', 'MMR-5', '--to', 'MMR-1', '--to', 'MMR-2']),
  // reorder: each place, through every format.
  argv(['reorder', 'MMR-5', '--top']),
  argv(['reorder', 'MMR-5', '--top', '-f', 'json']),
  argv(['reorder', 'MMR-5', '--top', '-f', 'ids']),
  argv(['reorder', 'MMR-5', '--top', '-f', 'table']),
  argv(['reorder', 'MMR-5', '--top', '--ascii']),
  argv(['reorder', 'MMR-5', '--top'], true),
  argv(['reorder', 'MMR-3', '--bottom']),
  argv(['reorder', 'MMR-3', '--bottom', '-f', 'json']),
  argv(['reorder', 'MMR-8', '--before', 'MMR-4']),
  argv(['reorder', 'MMR-8', '--before', 'MMR-4', '-f', 'json']),
  argv(['reorder', 'MMR-3', '--after', 'MMR-5']),
  argv(['reorder', 'MMR-3', '--after', 'MMR-5'], true),
  // reorder: refusals Mimir raises.
  argv(['reorder', 'MMR-99', '--top']),
  argv(['reorder', 'MMR-99', '--top', '-f', 'json']),
  argv(['reorder', 'MMR', '--top']),
  argv(['reorder', 'MMR-a1', '--top']),
  argv(['reorder', 'MMR-s1', '--top']),
  argv(['reorder', 'nope', '--top']),
  argv(['reorder', 'MMR-2', '--top']),
  argv(['reorder', 'MMR-3', '--before', 'MMR-99']),
  argv(['reorder', 'MMR-3', '--before', 'MMR']),
  argv(['reorder', 'MMR-3', '--before', 'MMR-3']),
  argv(['reorder', 'MMR-3', '--before', 'XX-3']),
  argv(['reorder', 'MMR-3', '--after', '']),
  argv(['reorder', 'MMR-3', '--before', '']),
  // reorder: faults Loom's parser raises.
  argv(['reorder', 'MMR-3']),
  argv(['reorder']),
  argv(['reorder', 'MMR-3', '--top', '--bogus']),
  // reorder: invocations the old CLI accepted and Loom's parser refuses.
  argv(['reorder', 'MMR-3', '--top', '--bottom']),
  argv(['reorder', 'MMR-3', '--top', '--before', 'MMR-5']),
  argv(['reorder', 'MMR-3', '--before', 'MMR-5', '--before', 'MMR-8']),
  // Misplaced flags, redirected as the old CLI redirected them.
  ...NODE_REDIRECTS.filter((line) => /^(move|reorder) /.test(line)).map((line) => argvLine(line)),
];

twinCases(/^(move|reorder) /, CASES);
