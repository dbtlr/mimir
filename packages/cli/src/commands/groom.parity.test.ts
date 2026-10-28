import { argvCase as argv, argvLine } from '../testing/argv-case';
import type { ParityCase } from '../testing/parity';
import { NODE_REDIRECTS } from '../testing/redirects';
import { writeCases } from '../testing/writes';

const CASES: ParityCase[] = [
  // Every state, through every format.
  argv(['groom', 'MMR-4', 'groomed']),
  argv(['groom', 'MMR-4', 'groomed', '-f', 'json']),
  argv(['groom', 'MMR-4', 'groomed', '-f', 'jsonl']),
  argv(['groom', 'MMR-4', 'groomed', '-f', 'ids']),
  argv(['groom', 'MMR-4', 'groomed', '-f', 'table']),
  argv(['groom', 'MMR-4', 'groomed', '--ascii']),
  argv(['groom', 'MMR-4', 'groomed'], true),
  argv(['groom', 'MMR-4,MMR-5', 'groomed', 'scoped in the design']),
  argv(['groom', 'MMR-4,MMR-5', 'groomed', '-f', 'ids']),
  argv(['groom', 'MMR-4', 'MMR-5', 'groomed']),
  argv(['groom', 'MMR-4, MMR-5', 'groomed']),
  argv(['groom', 'MMR-4', 'needs_answers', 'which store owns the lock?']),
  argv(['groom', 'MMR-4', 'needs_answers', 'which store owns the lock?', '-f', 'json']),
  argv(['groom', 'MMR-3', 'not_groomed']),
  argv(['groom', 'MMR-4', 'groomed', '--', '--note', 'text']),
  argv(['groom', 'MMR-4', 'groomed', '--', '--note', 'text', '-f', 'json']),
  argv(['groom', 'MMR-4', 'needs_answers', '--', '--which', 'store?']),
  argv(['groom', 'MMR-4', 'needs_answers', 'which', '--', '-x', 'store?']),
  argv(['groom', 'MMR-4', 'needs_answers', '--']),
  argv(['groom', 'MMR-3', 'not_groomed', 'rethink the approach']),
  // Refusals Mimir raises.
  argv(['groom', 'MMR-4', 'needs_answers']),
  argv(['groom', 'MMR-4', 'needs_answers', '-f', 'json']),
  argv(['groom', 'MMR-4', 'bogus']),
  argv(['groom', 'MMR-4', 'bogus', '-f', 'json']),
  argv(['groom', 'MMR-99', 'groomed']),
  argv(['groom', 'MMR-4,MMR-99', 'groomed']),
  argv(['groom', 'MMR', 'groomed']),
  argv(['groom', 'MMR-2', 'groomed']),
  argv(['groom', 'MMR-a1', 'groomed']),
  argv(['groom', 'MMR-s1', 'groomed']),
  argv(['groom', 'nope', 'groomed']),
  argv(['groom', 'MMR-7', 'groomed']),
  argv(['groom', 'MMR-5', 'groomed']),
  argv(['groom', ',', 'groomed']),
  // Faults Loom's parser raises.
  argv(['groom']),
  argv(['groom', 'MMR-4']),
  argv(['groom', 'MMR-4', 'groomed', '--bogus']),
  // Misplaced flags, redirected as the old CLI redirected them.
  ...NODE_REDIRECTS.filter((line) => line.startsWith('groom ')).map((line) => argvLine(line)),
];

writeCases(import.meta.url, CASES);
