import { argvCase } from '../testing/argv-case';
import { writeCases } from '../testing/writes';
import type { Setup, SetupCase } from '../testing/writes';

const argv = argvCase;

/** Every format of one delivery list write: the echoed delivery must match across them. */
const formats = (line: readonly string[]): SetupCase[] =>
  (['records', 'table', 'ids', 'json', 'jsonl'] as const).map((format) =>
    argv([...line, '-f', format]),
  );

/** A delivery that already has one entry of each kind. */
const listed: Setup = async (board) => {
  await board.engine.deliveryLimitation({ id: 'MMR-d1', text: 'First limit' });
  await board.engine.deliveryDecline({ finding: 'A finding', id: 'MMR-d1', reason: 'Why' });
};

const cases: SetupCase[] = [
  ...formats(['limitation', 'MMR-d1', 'A', 'cancelled', 'run', 'is', 'charged', 'in', 'full']),
  ...formats(['decline', 'MMR-d1', 'Retry the clone', 'Filed', 'as', 'MMR-s55']),
  argv(['limitation', 'MMR-d1', 'a note', '--ascii']),
  argv(['limitation', 'MMR-d1', '--', '-led by a dash']),
  argv(['decline', 'MMR-d1', 'Retry the clone', '--reason', 'Filed as MMR-s55']),
  argv(['decline', 'MMR-d1', 'Retry the clone', '--', '-no longer needed']),
  // The lists number together, and a terminal delivery still takes entries.
  { ...argv(['limitation', 'MMR-d1', 'Second limit', '-f', 'json']), setup: listed },
  {
    ...argv(['decline', 'MMR-d1', 'Found after the merge', 'Filed later', '-f', 'json']),
    setup: async (board) => {
      await board.engine.deliveryAbandon({ id: 'MMR-d1', reason: 'reset' });
    },
  },
  // Refusals Mimir raises: blank text and a missing or blank reason are validation.
  argv(['limitation', 'MMR-d1']),
  argv(['limitation', 'MMR-d1', ' ']),
  argv(['decline', 'MMR-d1', 'Retry the clone']),
  argv(['decline', 'MMR-d1', 'Retry the clone', ' ']),
  argv(['decline', 'MMR-d1', 'Retry the clone', '--reason', ' ']),
  argv(['decline', 'MMR-d1', ' ', 'reason']),
  argv(['decline', 'MMR-d1']),
  argv(['limitation', 'MMR-d99', 'a note']),
  argv(['limitation', 'nope', 'a note']),
  ...['MMR-2', 'MMR-1', 'MMR', 'MMR-a1', 'MMR-s1', 'MMR-q1'].map((id) =>
    argv(['decline', id, 'a finding', 'a reason']),
  ),
  // The reads show the lists.
  { ...argv(['get', 'MMR-d1']), setup: listed },
  { ...argv(['get', 'MMR-d1', '-f', 'json']), setup: listed },
];

writeCases(import.meta.url, cases, async (board) => {
  await board.engine.deliveryCreate({ phase: 'MMR-2', tasks: [], title: 'Attempt' });
});
