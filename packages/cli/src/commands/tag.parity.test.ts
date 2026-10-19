import { NODE_REDIRECTS } from '../parity/differences';
import { argvCase as argv, argvLine } from '../testing/argv-case';
import type { ParityCase } from '../testing/parity';
import { twinCases } from '../testing/twin';

const CASES: ParityCase[] = [
  // tag: through every format.
  argv(['tag', 'MMR-5', 'design']),
  argv(['tag', 'MMR-5', 'design', '-f', 'json']),
  argv(['tag', 'MMR-5', 'design', '-f', 'jsonl']),
  argv(['tag', 'MMR-5', 'design', '-f', 'ids']),
  argv(['tag', 'MMR-5', 'design', '-f', 'table']),
  argv(['tag', 'MMR-5', 'design', '--ascii']),
  argv(['tag', 'MMR-5', 'design'], true),
  argv(['tag', 'MMR-5,MMR-6', 'design', 'review']),
  argv(['tag', 'MMR-5', '--', '-dash']),
  argv(['tag', 'MMR-5', 'design', '--', '-dash']),
  argv(['untag', 'MMR-3', '--', '-dash']),
  argv(['tag', 'MMR-5, MMR-6', 'design']),
  argv(['tag', 'MMR-5,MMR-6', 'design', '-f', 'ids']),
  argv(['tag', 'MMR-3', 'alpha']),
  argv(['tag', 'MMR', 'platform']),
  argv(['tag', 'MMR-a1', 'design', 'extra']),
  argv(['tag', 'MMR-2', 'phase-tag']),
  // tag: refusals Mimir raises.
  argv(['tag', 'MMR-99', 'design']),
  argv(['tag', 'MMR-99', 'design', '-f', 'json']),
  argv(['tag', 'MMR-s1', 'design']),
  argv(['tag', 'nope', 'design']),
  argv(['tag', 'XXXXX', 'design']),
  argv(['tag', 'MMR-5,MMR-99', 'design']),
  argv(['tag', 'ZZ', 'design']),
  argv(['tag', ',', 'design']),
  argv(['tag', 'MMR-5', 'Bad Tag']),
  argv(['tag', 'MMR-5', '']),
  // tag: faults Loom's parser raises.
  argv(['tag', 'MMR-5']),
  argv(['tag']),
  argv(['tag', 'MMR-5', 'design', '--bogus']),
  // untag: through every format.
  argv(['untag', 'MMR-3', 'alpha']),
  argv(['untag', 'MMR-3', 'alpha', '-f', 'json']),
  argv(['untag', 'MMR-3', 'alpha', '-f', 'jsonl']),
  argv(['untag', 'MMR-3', 'alpha', '-f', 'ids']),
  argv(['untag', 'MMR-3', 'alpha', '-f', 'table']),
  argv(['untag', 'MMR-3', 'alpha'], true),
  argv(['untag', 'MMR-3,MMR-4', 'alpha']),
  argv(['untag', 'MMR-3', 'never-set']),
  argv(['untag', 'MMR-a1', 'design']),
  // untag: refusals Mimir raises.
  argv(['untag', 'MMR-99', 'alpha']),
  argv(['untag', 'MMR-s1', 'alpha']),
  argv(['untag', 'nope', 'alpha']),
  argv(['untag', ',', 'alpha']),
  // untag: faults Loom's parser raises.
  argv(['untag', 'MMR-3']),
  // Misplaced flags, redirected as the old CLI redirected them.
  ...NODE_REDIRECTS.filter((line) => /^(un)?tag /.test(line)).map((line) => argvLine(line)),
];

twinCases(/^(un)?tag /, CASES);
