/**
 * Twin boards for the parity of writes. A write changes the store it runs on,
 * so the old and the new CLI each run a case on their own board, built the
 * same way under one frozen clock: every stamp and every derived id then
 * agrees, and a case compares like for like. Ids that are random by design,
 * the Scratchpad UUIDs, are named by tokens and normalized in the output.
 * A write the CLI refuses must leave its board as untouched as a fresh one.
 * Test-only.
 */
import { PARITY_DIFFERENCES } from '../parity/differences';
import { parityBoard } from './fixture';
import type { ParityBoard } from './fixture';
import { parityProblems, registerParity, runNew, runOld } from './parity';
import type { ParityCase, ParityRun } from './parity';
import { boardSnapshot } from './snapshot';

/** The instant both boards live at, which is every stamp and every Scratchpad guard. */
export const FROZEN_AT = new Date('2026-10-01T12:00:00.000Z');

const RealDate = Date;

/** A `Date` whose clock never moves: `new Date()` and `Date.now()` read the frozen instant. */
class FrozenDate extends RealDate {
  constructor(...args: [] | [string | number | Date]) {
    if (args.length === 0) {
      super(FROZEN_AT.getTime());
    } else {
      super(args[0]);
    }
  }

  static override now(): number {
    return FROZEN_AT.getTime();
  }
}

/** Freeze the clock, or thaw it. Bun's `setSystemTime` keeps ticking, so stamps would drift between boards. */
function freezeClock(frozen: boolean): void {
  Reflect.set(globalThis, 'Date', frozen ? FrozenDate : RealDate);
}

/** What `{token}` placeholders in a case stand for on one board. */
export type Tokens = Readonly<Record<string, string>>;

export type Twin = {
  /** The board the old CLI runs on, and the tokens that name its records. */
  old: { board: ParityBoard; tokens: Tokens };
  /** The board the new CLI runs on, and the tokens that name its records. */
  next: { board: ParityBoard; tokens: Tokens };
  close: () => Promise<void>;
};

/**
 * Extra records a family of cases needs on top of the common board, added to
 * each board after it is populated. Returns tokens naming them, which join the
 * common ones.
 */
export type Setup = (board: ParityBoard) => Promise<Tokens | void>;

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
 * Open the old and the new board at the frozen instant, each given the common
 * records and then `setup`'s. Call `close` to release both and the clock.
 */
export async function openTwin(setup?: Setup): Promise<Twin> {
  freezeClock(true);
  const opened: ParityBoard[] = [];
  try {
    const old = await parityBoard();
    opened.push(old);
    const next = await parityBoard();
    opened.push(next);
    return twinOf(old, await prepare(old, setup), next, await prepare(next, setup));
  } catch (error) {
    // A setup fault must not leave the clock frozen for every later test.
    await Promise.allSettled(opened.map((board) => board.close()));
    freezeClock(false);
    throw error;
  }
}

function twinOf(old: ParityBoard, oldTokens: Tokens, next: ParityBoard, nextTokens: Tokens): Twin {
  return {
    close: async () => {
      await old.close();
      await next.close();
      freezeClock(false);
    },
    next: { board: next, tokens: nextTokens },
    old: { board: old, tokens: oldTokens },
  };
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

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const named = (text: string): string => text.replaceAll(UUID, '<uuid>');

/** A run with every UUID, which differs by design between the boards, named `<uuid>`. */
export function uuidsNamed(run: ParityRun): ParityRun {
  return {
    ...run,
    stdout: named(run.stdout),
    ...(run.failure === undefined
      ? {}
      : {
          failure: {
            code: run.failure.code,
            hints: run.failure.hints.map(named),
            message: named(run.failure.message),
          },
        }),
  };
}

/** The state a board holds for `c`, as `boardSnapshot` reads it. */
const stateFor = (board: ParityBoard, tokens: Tokens, bound: ParityCase) =>
  boardSnapshot(board, tokens, [JSON.stringify(bound)]);

/**
 * Run one write case on a fresh twin, old CLI and new, and return every way it
 * breaks the parity rule. When both complete, the two boards must hold the same
 * state; when the new CLI refuses, its board must hold what an untouched one does.
 */
export async function twinProblems(c: ParityCase, setup?: Setup): Promise<string[]> {
  const twin = await openTwin(setup);
  try {
    const oldCase = bindCase(c, twin.old.tokens);
    const nextCase = bindCase(c, twin.next.tokens);
    const oldRaw = await runOld(twin.old.board.store, oldCase);
    const nextRaw = await runNew(twin.next.board.app(c.bound), nextCase);
    const problems = parityProblems(
      twin.next.board.app(),
      c,
      uuidsNamed(oldRaw),
      uuidsNamed(nextRaw),
      PARITY_DIFFERENCES,
    );
    if (nextRaw.exitCode !== 0) {
      // A refusal writes nothing, whatever the old CLI did: compare with a board never written to.
      const untouched = await parityBoard();
      try {
        const tokens = await prepare(untouched, setup);
        const [before, after] = await Promise.all([
          stateFor(untouched, tokens, bindCase(c, tokens)),
          stateFor(twin.next.board, twin.next.tokens, nextCase),
        ]);
        if (before !== after) {
          problems.push(
            `the refused write changed the board:\n--- untouched\n${before}\n--- new\n${after}`,
          );
        }
      } finally {
        await untouched.close();
      }
    } else if (oldRaw.exitCode === 0) {
      const [before, after] = await Promise.all([
        boardSnapshot(twin.old.board, twin.old.tokens, [JSON.stringify(oldCase), oldRaw.stdout]),
        boardSnapshot(twin.next.board, twin.next.tokens, [
          JSON.stringify(nextCase),
          nextRaw.stdout,
        ]),
      ]);
      if (before !== after) {
        problems.push(`state differs:\n--- old\n${before}\n--- new\n${after}`);
      }
    }
    return problems;
  } finally {
    await twin.close();
  }
}

/**
 * Register one write command's parity tests: every case runs on its own fresh
 * twin through `twinProblems`, and every checked-in difference entry whose case
 * `owner` matches must name one of `cases`. `setup` adds records the cases need.
 */
export function twinCases(owner: RegExp, cases: readonly ParityCase[], setup?: Setup): void {
  registerParity(owner, cases, (c) => twinProblems(c, setup));
}
