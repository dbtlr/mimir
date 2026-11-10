import { argvCase as argv } from '../testing/argv-case';
import type { ParityCase } from '../testing/parity';
import { writeCases } from '../testing/writes';

// `move` and `reorder` echo the node they wrote through one set of views, so
// the full format, `--ascii`, and terminal matrix runs once, on `move`. Each id
// is checked by the shared node-token rule, whose wrong-subject sweep runs once
// in lifecycle.parity.test.ts; each id here keeps one wrong kind and one
// unknown id.
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
  argv(['move', 'MMR', '--to', 'MMR-1']),
  argv(['move', 'MMR-5', '--to', 'MMR-s1']),
  argv(['move', 'MMR-5', '--to', '']),
  // move: faults Loom's parser raises.
  argv(['move', 'MMR-5']),
  // reorder: each place.
  argv(['reorder', 'MMR-5', '--top']),
  argv(['reorder', 'MMR-3', '--bottom']),
  argv(['reorder', 'MMR-8', '--before', 'MMR-4']),
  argv(['reorder', 'MMR-3', '--after', 'MMR-5']),
  // reorder: refusals Mimir raises.
  argv(['reorder', 'MMR-99', '--top']),
  argv(['reorder', 'MMR', '--top']),
  argv(['reorder', 'MMR-2', '--top']),
  argv(['reorder', 'MMR-3', '--before', 'MMR-99']),
  argv(['reorder', 'MMR-3', '--before', 'MMR']),
  argv(['reorder', 'MMR-3', '--before', 'MMR-3']),
  argv(['reorder', 'MMR-3', '--before', 'XX-3']),
  argv(['reorder', 'MMR-3', '--after', '']),
  argv(['reorder', 'MMR-3', '--before', '']),
  // reorder: faults Loom's parser raises.
  argv(['reorder', 'MMR-3']),
  // reorder: invocations the old CLI accepted and Loom's parser refuses.
  argv(['reorder', 'MMR-3', '--top', '--bottom']),
  argv(['reorder', 'MMR-3', '--top', '--before', 'MMR-5']),
];

writeCases(import.meta.url, CASES);
