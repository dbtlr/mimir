import { argvCase } from '../testing/argv-case';
import { writeCases } from '../testing/writes';
import type { Setup, SetupCase } from '../testing/writes';

const argv = argvCase;

/**
 * The since read (ADR 0042, MMR-692). The whole board is stamped at the frozen
 * instant, 2026-10-01T12:00Z, so every event ties on time and the order cases
 * pin is the tie order itself: the source's rank, then the record, then the row.
 */

/** Both structured formats and the records view of one command line. */
const shown = (line: readonly string[], setup?: Setup): SetupCase[] =>
  (['records', 'json'] as const).map((format) => {
    const made: SetupCase = argv([...line, '-f', format]);
    if (setup !== undefined) {
      made.setup = setup;
    }
    return made;
  });

/**
 * A delivery with two members, one that then leaves, a note, two checklist
 * items, a limitation, a declined finding, a decision, and a frozen journal.
 */
const busy: Setup = async (board) => {
  const { engine } = board;
  await engine.update({ delivery: 'MMR-d1', id: 'MMR-6' });
  await engine.update({ delivery: 'MMR-d1', id: 'MMR-8' });
  await engine.update({ delivery: null, id: 'MMR-8' });
  await engine.annotate({ content: 'Cache is warm', id: 'MMR-6' });
  await engine.itemAdd({ content: 'Check the cache', task: 'MMR-6' });
  await engine.itemAdd({ content: 'Drop the old path', task: 'MMR-6' });
  await engine.itemCheck({ number: 1, task: 'MMR-6' });
  await engine.itemDrop({ number: 2, reason: 'Moot', task: 'MMR-6' });
  await engine.deliveryLimitation({ id: 'MMR-d1', text: 'A cancelled run is charged in full' });
  await engine.deliveryDecline({ finding: 'Retry the clone', id: 'MMR-d1', reason: 'Filed later' });
  await engine.decide({
    class: 'architecture',
    delivery: 'MMR-d1',
    options: ['Here', 'There'],
    project: 'MMR',
    question: 'Where does it run?',
    recommended: 1,
  });
  const pad = await engine.scratchCreate({ anchors: ['MMR-d1'], project: 'MMR', title: 'Journal' });
  await engine.scratchFreeze({
    expectedUpdatedAt: pad.updatedAt,
    id: pad.id,
    summary: 'The run journal',
  });
};

const cases: SetupCase[] = [
  // Events after an earlier cursor, with the cursor the next read passes back.
  ...shown(['get', 'MMR-d1', '--since', '2026-10-01T11:00:00Z'], busy),
  // The cursor the answer gave: the overlap returns the same events, with the same ids.
  ...shown(['get', 'MMR-d1', '--since', '2026-10-01T11:59:55.000Z'], busy),
  // An event at exactly the cursor is not after it; an offset names the same instant.
  ...shown(['get', 'MMR-d1', '--since', '2026-10-01T12:00:00Z'], busy),
  ...shown(['get', 'MMR-d1', '--since', '2026-10-01T14:00:00+02:00'], busy),
  // A cursor ahead of the clock is its own as_of, and nothing is after it.
  ...shown(['get', 'MMR-d1', '--since', '2026-10-02T00:00:00Z'], busy),
  // A quiet delivery, and the other views.
  ...shown(['get', 'MMR-d1', '--since', '2026-10-01T11:00:00Z']),
  argv(['get', 'MMR-d1', '--since', '2026-10-01T11:00:00Z', '-f', 'ids']),
  { ...argv(['get', 'MMR-d1', '--since', '2026-10-01T11:00:00Z', '--ascii']), setup: busy },
  // Refusals: not a delivery, not an instant (a year past 9999 once the offset is applied is one), not found.
  argv(['get', 'MMR-3', '--since', '2026-10-01T11:00:00Z']),
  argv(['get', 'MMR', '--since', '2026-10-01T11:00:00Z']),
  argv(['get', 'MMR-d1', '--since', 'yesterday']),
  argv(['get', 'MMR-d1', '--since', '2026-10-01']),
  argv(['get', 'MMR-d1', '--since', '2026-10-01T11:00:00']),
  argv(['get', 'MMR-d1', '--since', '9999-12-31T23:00:00-04:00']),
  argv(['get', 'MMR-d99', '--since', '2026-10-01T11:00:00Z']),
  argv(['list', '--since', '2026-10-01T11:00:00Z']),
];

writeCases(import.meta.url, cases, async (board) => {
  await board.engine.deliveryCreate({ phase: 'MMR-2', tasks: [], title: 'Attempt' });
});
