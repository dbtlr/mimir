/**
 * Boards for the parity of writes. A write changes the store it runs on, so
 * each case runs on its own fresh board, built under a frozen clock: every
 * stamp and every derived id agrees from run to run. Ids that are random by
 * design, the Scratchpad UUIDs, are named by tokens and normalized in the
 * output. A case pins what the CLI printed and the records it changed, read as
 * the difference from a board built the same way and never written to; a write
 * the CLI refuses must change nothing. Test-only.
 */
import { expect } from 'bun:test';

import { freezeClock } from './clock';
import { parityBoard } from './fixture';
import type { ParityBoard } from './fixture';
import { pinText, registerParity, runNew } from './parity';
import type { ParityCase } from './parity';
import { changedRecords } from './pins';
import { boardSnapshot } from './snapshot';

/** What `{token}` placeholders in a case stand for on one board. */
export type Tokens = Readonly<Record<string, string>>;

/** A populated board, the tokens that name its records, and a `close` that also thaws the clock. */
export type OpenBoard = { board: ParityBoard; tokens: Tokens; close: () => Promise<void> };

/**
 * Extra records a family of cases needs on top of the common board, added to
 * the board after it is populated. Returns tokens naming them, which join the
 * common ones.
 */
export type Setup = (board: ParityBoard) => Promise<Tokens | void>;

/** A case that moves the board to its own state, on top of the setup its family shares. */
export type SetupCase = ParityCase & { setup?: Setup };

/** `shared` then the case's own `setup`, as the one setup the case runs under. */
function setupOf(c: SetupCase, shared?: Setup): Setup | undefined {
  const own = c.setup;
  if (own === undefined) {
    return shared;
  }
  return async (board) => ({ ...(await shared?.(board)), ...(await own(board)) });
}

/**
 * What a case needs on each board beyond records, such as findings for doctor
 * to report. Runs on both boards after they are populated, before the case.
 */
export type Arrange<Case extends ParityCase> = (board: ParityBoard, c: Case) => void;

/**
 * Add the records the write cases act on: seeds in every state, a task whose
 * upstream seed settled, and two Scratchpads. Returns the tokens naming them.
 */
async function populate(board: ParityBoard): Promise<Tokens> {
  const { engine } = board;
  await engine.seedCreate({
    kind: 'idea',
    project: 'MMR',
    requester: null,
    title: 'Cache the plan',
  }); // s2
  await engine.seedCreate({
    description: 'Rejected up front.',
    kind: 'bug',
    project: 'MMR',
    requester: 'XX',
    title: 'Flaky retry',
  }); // s3
  await engine.seedReject({ id: 'MMR-s3', reason: 'cannot reproduce' });
  await engine.seedCreate({ kind: 'feature', project: 'MMR', requester: null, title: 'Export' }); // s4
  const promoted = await engine.seedPromote({ id: 'MMR-s4', parent: 'MMR-2' });
  await engine.start({ id: promoted.spawnedId });
  await engine.done({ id: promoted.spawnedId });
  await engine.seedCreate({ kind: 'idea', project: 'MMR', requester: null, title: 'Parked one' }); // s5
  await engine.seedPark({ id: 'MMR-s5', reason: 'later' });
  await engine.seedCreate({ kind: 'bug', project: 'XX', requester: 'MMR', title: 'Their bug' }); // XX-s1
  await engine.seedResolve({ id: 'XX-s1', reason: 'fixed' });
  await engine.create({
    parent: 'XX-2',
    title: 'Waiting on their fix',
    type: 'task',
    upstream: 'XX-s1',
  });

  const blank = await engine.scratchCreate({ project: 'MMR', title: 'Blank' });
  let pad = await engine.scratchCreate({
    anchors: ['MMR-3'],
    project: 'MMR',
    title: 'Index rewrite',
  });
  const at = () => pad.updatedAt;
  pad = await engine.scratchCheckpoint({
    content: 'Found the cause.',
    expectedUpdatedAt: at(),
    id: pad.id,
  });
  for (const content of ['Port the verbs', 'Wire the host', 'Spike it']) {
    pad = await engine.scratchAgendaAdd({ content, expectedUpdatedAt: at(), id: pad.id });
  }
  pad = await engine.scratchAgendaComplete({ expectedUpdatedAt: at(), id: pad.id, number: 3 });
  const gone = await engine.scratchCreate({ project: 'MMR', title: 'Gone' });
  await engine.scratchDiscard({ expectedUpdatedAt: gone.updatedAt, id: gone.id });
  return {
    blank: blank.id,
    gone: gone.id,
    pad: pad.id,
    token: pad.updatedAt.toISOString(),
  };
}

/** A board populated, then given its extra records by `setup`; the tokens naming all of them. */
async function prepare(board: ParityBoard, setup?: Setup): Promise<Tokens> {
  const tokens = await populate(board);
  return { ...tokens, ...(await setup?.(board)) };
}

/**
 * Open a board at the frozen instant, given the common records and then
 * `setup`'s. Call `close` to release it and the clock.
 */
export async function openBoard(setup?: Setup): Promise<OpenBoard> {
  freezeClock(true);
  const board = await parityBoard();
  try {
    const tokens = await prepare(board, setup);
    return {
      board,
      close: async () => {
        await board.close();
        freezeClock(false);
      },
      tokens,
    };
  } catch (error) {
    // A setup fault must not leave the clock frozen for every later test.
    await board.close();
    freezeClock(false);
    throw error;
  }
}

const fill = (text: string, tokens: Tokens): string =>
  text.replaceAll(/\{(\w+)\}/g, (whole, name: string) => tokens[name] ?? whole);

/** A case with each `{token}` in its arguments, options, and argv replaced by the board's value. */
export function bindCase(c: ParityCase, tokens: Tokens): ParityCase {
  const fillValue = (value: string | readonly string[] | true) => {
    if (value === true) {
      return value;
    }
    return typeof value === 'string' ? fill(value, tokens) : value.map((v) => fill(v, tokens));
  };
  return {
    ...c,
    ...(c.args === undefined
      ? {}
      : { args: Object.fromEntries(Object.entries(c.args).map(([k, v]) => [k, fill(v, tokens)])) }),
    ...(c.options === undefined
      ? {}
      : {
          options: Object.fromEntries(Object.entries(c.options).map(([k, v]) => [k, fillValue(v)])),
        }),
    ...(c.argv === undefined ? {} : { argv: c.argv.map((word) => fill(word, tokens)) }),
  };
}

/** `text` with each of one board's token values swapped for the same token's value on another. */
function retarget(text: string, from: Tokens, to: Tokens): string {
  return Object.entries(from).reduce(
    (swapped, [name, value]) => swapped.replaceAll(value, to[name] ?? value),
    text,
  );
}

/**
 * The records a write changed on `board`, as lines: its state against a board
 * built the same way and never written to, both read for the same names.
 */
export async function stateChanges(
  board: ParityBoard,
  tokens: Tokens,
  texts: readonly string[],
  setup?: Setup,
): Promise<string> {
  const untouched = await parityBoard();
  try {
    const fresh = await prepare(untouched, setup);
    const before = await boardSnapshot(
      untouched,
      fresh,
      texts.map((text) => retarget(text, tokens, fresh)),
    );
    return changedRecords(before, await boardSnapshot(board, tokens, texts));
  } finally {
    await untouched.close();
  }
}

/**
 * Run one write case on a fresh board and return its pin: what the CLI
 * printed, then the records it changed. A refused write must change nothing.
 */
export async function writePin<Case extends SetupCase>(
  c: Case,
  shared?: Setup,
  arrange?: Arrange<Case>,
): Promise<string> {
  const setup = setupOf(c, shared);
  const open = await openBoard(setup);
  try {
    const bound = bindCase(c, open.tokens);
    arrange?.(open.board, c);
    const run = await runNew((argv) => open.board.app(c.bound, argv, c.origin), bound);
    const changes = await stateChanges(
      open.board,
      open.tokens,
      [JSON.stringify(bound), run.stdout],
      setup,
    );
    // A refusal writes nothing, whatever it printed.
    expect(run.exitCode !== 0 ? changes : '', 'the refused write changed the board').toBe('');
    return pinText(run, open.board.dir, `--- state\n${changes === '' ? 'unchanged\n' : changes}`);
  } finally {
    await open.close();
  }
}

/**
 * Register one write command's parity tests: every case runs on its own fresh
 * board through `writePin` and must match its pin. `setup` adds records the
 * cases need, and `arrange` readies the board for one case.
 */
export function writeCases<Case extends SetupCase>(
  testUrl: string,
  cases: readonly Case[],
  setup?: Setup,
  arrange?: Arrange<Case>,
): void {
  registerParity(testUrl, cases, (c) => writePin(c, setup, arrange));
}
