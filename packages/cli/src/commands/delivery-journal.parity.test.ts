import { argvCase } from '../testing/argv-case';
import { writeCases } from '../testing/writes';
import type { Setup, SetupCase } from '../testing/writes';

const argv = argvCase;

/** Both structured formats and the records view of one command line. */
const shown = (line: readonly string[], setup?: Setup): SetupCase[] =>
  (['records', 'json'] as const).map((format) => ({
    ...argv([...line, '-f', format]),
    ...(setup === undefined ? {} : { setup }),
  }));

/** A live pad that journals MMR-d1; `{jpad}` names it and `{jtoken}` is its guard. */
const liveJournal: Setup = async (board) => {
  const pad = await board.engine.scratchCreate({
    anchors: ['MMR-d1'],
    project: 'MMR',
    title: 'Run journal',
  });
  return { jpad: pad.id, jtoken: pad.updatedAt.toISOString() };
};

/** One frozen journal of MMR-d1 (`{frozen}`), then a live pad on it. */
const frozenAndLive: Setup = async (board) => {
  const first = await board.engine.scratchCreate({
    anchors: ['MMR-d1'],
    project: 'MMR',
    title: 'First run',
  });
  const frozen = await board.engine.scratchFreeze({
    expectedUpdatedAt: first.updatedAt,
    id: first.id,
    summary: 'first run journal',
  });
  return { ...(await liveJournal(board)), frozen: frozen.id };
};

const cases: SetupCase[] = [
  // A pad created with a delivery link names the delivery, on every view that carries it.
  ...shown(['scratch', 'create', 'Journal', '--link', 'MMR-d1', '--scope', 'MMR']),
  ...shown(['scratch', 'get', '{jpad}'], liveJournal),
  ...shown(
    ['scratch', 'freeze', '{jpad}', '--expected-updated-at', '{jtoken}', '--summary', 'journal'],
    liveJournal,
  ),
  // The frozen journal names the delivery too, and the delivery names the live pad and the journal.
  ...shown(['get', '{frozen}'], frozenAndLive),
  ...shown(['get', 'MMR-d1'], frozenAndLive),
  // The list and overview rows carry the delivery as well.
  ...shown(['scratch', 'list', '--scope', 'MMR'], frozenAndLive),
  ...shown(['artifacts', '--scope', 'MMR'], frozenAndLive),
  ...shown(['overview', '--scope', 'MMR'], frozenAndLive),
];

writeCases(import.meta.url, cases, async (board) => {
  await board.engine.deliveryCreate({ phase: 'MMR-2', tasks: [], title: 'Attempt' });
});
