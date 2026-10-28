import { argvCase as argv, argvLine } from '../testing/argv-case';
import type { ParityCase } from '../testing/parity';
import { NODE_REDIRECTS } from '../testing/redirects';
import { writeCases } from '../testing/writes';

const CASES: ParityCase[] = [
  // Adding prerequisites, through every format.
  argv(['depend', 'MMR-5', '--on', 'MMR-3']),
  argv(['depend', 'MMR-5', '--on', 'MMR-3,MMR-4']),
  argv(['depend', 'MMR-5', '--on', 'MMR-3, MMR-4']),
  argv(['depend', 'MMR-5', '--on', 'MMR-3', '-f', 'json']),
  argv(['depend', 'MMR-5', '--on', 'MMR-3', '-f', 'jsonl']),
  argv(['depend', 'MMR-5', '--on', 'MMR-3', '-f', 'ids']),
  argv(['depend', 'MMR-5', '--on', 'MMR-3', '-f', 'table']),
  argv(['depend', 'MMR-5', '--on', 'MMR-3', '--ascii']),
  argv(['depend', 'MMR-5', '--on', 'MMR-3'], true),
  argv(['depend', 'MMR-4', '--on', 'MMR-3']),
  argv(['depend', 'MMR-5', '--on', 'XX-3']),
  // Removing them.
  argv(['undepend', 'MMR-4', '--on', 'MMR-3']),
  argv(['undepend', 'MMR-4', '--on', 'MMR-3', '-f', 'json']),
  argv(['undepend', 'MMR-4', '--on', 'MMR-3', '-f', 'ids']),
  argv(['undepend', 'MMR-4', '--on', 'MMR-3'], true),
  argv(['undepend', 'MMR-5', '--on', 'MMR-3']),
  // Refusals Mimir raises.
  argv(['depend', 'MMR-3', '--on', 'MMR-4']),
  argv(['depend', 'MMR-3', '--on', 'MMR-4', '-f', 'json']),
  argv(['depend', 'MMR-3', '--on', 'MMR-3']),
  argv(['depend', 'MMR-3', '--on', 'MMR-2']),
  argv(['depend', 'MMR-99', '--on', 'MMR-3']),
  argv(['depend', 'MMR-99', '--on', 'MMR-3', '-f', 'json']),
  argv(['depend', 'MMR-5', '--on', 'MMR-99']),
  argv(['depend', 'MMR-5', '--on', 'MMR-3,MMR-99']),
  argv(['depend', 'MMR', '--on', 'MMR-3']),
  argv(['depend', 'MMR-5', '--on', 'MMR']),
  argv(['depend', 'MMR-a1', '--on', 'MMR-3']),
  argv(['depend', 'MMR-5', '--on', 'MMR-s1']),
  argv(['depend', 'nope', '--on', 'MMR-3']),
  argv(['depend', 'MMR-5', '--on', 'nope']),
  argv(['depend', 'MMR-5', '--on', '']),
  argv(['depend', 'MMR-5', '--on', 'MMR-3,']),
  argv(['undepend', 'MMR-99', '--on', 'MMR-3']),
  argv(['undepend', 'MMR-4', '--on', 'MMR']),
  argv(['undepend', 'MMR-4', '--on', '']),
  // Faults Loom's parser raises.
  argv(['depend', 'MMR-5']),
  argv(['depend', '--on', 'MMR-3']),
  argv(['undepend', 'MMR-4']),
  argv(['depend', 'MMR-5', '--on', 'MMR-3', '--bogus']),
  // Invocations the old CLI accepted and Loom's parser refuses.
  argv(['depend', 'MMR-5', '--on', 'MMR-3', '--on', 'MMR-4']),
  argv(['depend', 'MMR-5', 'MMR-6', '--on', 'MMR-3']),
  // Misplaced flags, redirected as the old CLI redirected them.
  ...NODE_REDIRECTS.filter((line) => /^(un)?depend /.test(line)).map((line) => argvLine(line)),
];

writeCases(import.meta.url, CASES);
