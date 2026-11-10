import { argvCase as argv } from '../testing/argv-case';
import type { ParityCase } from '../testing/parity';
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
  argv(['undepend', 'MMR-4']),
];

writeCases(import.meta.url, CASES);
