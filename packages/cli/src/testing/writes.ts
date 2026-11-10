/**
 * Boards for the parity of writes. A write changes the store it runs on, so
 * each case runs on its own board, under a frozen clock: every stamp and every
 * derived id agrees from run to run. The board is built once per setup, as a
 * template, and each case runs on a copy of it that no other case has written
 * to. Ids that are random by design, the Scratchpad UUIDs, are named by tokens
 * and normalized in the output. A case pins what the CLI printed and the
 * records it changed, read as the difference from the template, which is never
 * written to; a write the CLI refuses must change nothing. Test-only.
 */
import { expect, test } from 'bun:test';

import { frozenBoard, parityBoard } from './fixture';
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
 * common ones. Only the store reaches the copies a template makes, so a setup
 * adds records and never files.
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
  const { board, close, value: tokens } = await frozenBoard((opened) => prepare(opened, setup));
  return { board, close, tokens };
}

/**
 * A board built once, for cases to copy: its store's bytes, the tokens naming
 * its records, and the snapshot of its records, which a write's changes are
 * read against.
 */
export type BoardTemplate = { image: Uint8Array; tokens: Tokens; untouched: string };

/** Build a board as `openBoard` does, and keep it as a template. */
export async function boardTemplate(setup?: Setup): Promise<BoardTemplate> {
  const open = await openBoard(setup);
  try {
    return {
      image: open.board.image(),
      tokens: open.tokens,
      untouched: await boardSnapshot(open.board, open.tokens),
    };
  } finally {
    await open.close();
  }
}

/**
 * Open a copy of `template` at the frozen instant: a board of its own, which
 * no other copy's writes reach. Call `close` to release it and the clock.
 */
export async function openCopy(template: BoardTemplate): Promise<OpenBoard> {
  const { board, close } = await frozenBoard(
    () => Promise.resolve(undefined),
    () => parityBoard(template.image),
  );
  return { board, close, tokens: template.tokens };
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

/**
 * The records a write changed on `board`, a copy of `template`, as lines: its
 * whole state against the template's, which was never written to. A copy
 * whose bytes still equal the template's holds the same records, so it
 * changed none and needs no snapshot.
 */
export async function stateChanges(
  board: ParityBoard,
  tokens: Tokens,
  template: BoardTemplate,
): Promise<string> {
  if (Buffer.compare(board.image(), template.image) === 0) {
    return '';
  }
  return changedRecords(template.untouched, await boardSnapshot(board, tokens));
}

/** What one write case did: its exit code, the records it changed, and its pin. */
type WriteRun = { exitCode: number; state: string; pin: string };

/**
 * Run one write case on its own copy of `template`: what the CLI printed, then
 * the records it changed. A refused write must change nothing.
 */
async function runWrite(c: SetupCase, template: BoardTemplate): Promise<WriteRun> {
  const open = await openCopy(template);
  try {
    const bound = bindCase(c, open.tokens);
    const run = await runNew((argv) => open.board.app(c.bound, argv, c.origin), bound);
    const changes = await stateChanges(open.board, open.tokens, template);
    // A refusal writes nothing, whatever it printed.
    expect(run.exitCode !== 0 ? changes : '', 'the refused write changed the board').toBe('');
    const state = `--- state\n${changes === '' ? 'unchanged\n' : changes}`;
    return { exitCode: run.exitCode, pin: pinText(run, open.board.dir, state), state };
  } finally {
    await open.close();
  }
}

/** Options that only choose how a result is shown. */
const PRESENTATION_OPTIONS: ReadonlySet<string> = new Set(['ascii', 'format']);

/** `argv` without its presentation words: every `-f` or `--format` and its value, and `--ascii`, before any `--`. */
function withoutPresentation(argv: readonly string[]): string[] {
  const stop = argv.indexOf('--');
  const head = stop === -1 ? argv : argv.slice(0, stop);
  const kept: string[] = [];
  for (let i = 0; i < head.length; i++) {
    const word = head[i]!;
    if (word === '-f' || word === '--format') {
      i++;
    } else if (word !== '--ascii' && !word.startsWith('--format=')) {
      kept.push(word);
    }
  }
  return stop === -1 ? kept : [...kept, ...argv.slice(stop)];
}

/**
 * The write a case runs, with how its result is shown set aside: the format,
 * `--ascii`, and the terminal. Two cases with the same key run the same write
 * on the same board, so they must change the same records. `setupId` names
 * the case's own setup, which a key cannot spell.
 */
export function writeKey(c: SetupCase, setupId: number): string {
  const { argv, name: _name, options, setup: _setup, tty: _tty, ...rest } = c;
  return JSON.stringify({
    ...rest,
    setupId,
    ...(argv === undefined ? {} : { argv: withoutPresentation(argv) }),
    ...(options === undefined
      ? {}
      : {
          options: Object.fromEntries(
            Object.entries(options).filter(([key]) => !PRESENTATION_OPTIONS.has(key)),
          ),
        }),
  });
}

/**
 * The cases among `runs` whose state differs from the first successful run of
 * the same write, as `name: differs from first` lines. A format, `--ascii`, or
 * a terminal changes how a result is shown and never what a write stores.
 */
export function formatVariance(
  runs: readonly { key: string; name: string; exitCode: number; state: string }[],
): string[] {
  const first = new Map<string, { name: string; state: string }>();
  const out: string[] = [];
  for (const run of runs) {
    if (run.exitCode !== 0) {
      continue;
    }
    const seen = first.get(run.key);
    if (seen === undefined) {
      first.set(run.key, run);
    } else if (seen.state !== run.state) {
      out.push(`${run.name}: changed other records than ${seen.name}`);
    }
  }
  return out;
}

/**
 * Register one write command's parity tests: every case runs on its own copy
 * of a board through `runWrite` and must match its pin. `setup` adds records
 * the cases need. Cases that share a setup copy one template, built when the
 * first of them runs. Every successful variant of one write, differing only
 * in how its result is shown, must pin the same records.
 */
export function writeCases(testUrl: string, cases: readonly SetupCase[], setup?: Setup): void {
  const setups = new Map<Setup | undefined, number>();
  const keyOf = (c: SetupCase): string => {
    if (!setups.has(c.setup)) {
      setups.set(c.setup, setups.size);
    }
    return writeKey(c, setups.get(c.setup)!);
  };
  // One template per case setup: a case's own setup runs on top of `setup`, which every case shares.
  const templates = new Map<Setup | undefined, Promise<BoardTemplate>>();
  const templateOf = (c: SetupCase): Promise<BoardTemplate> => {
    let template = templates.get(c.setup);
    if (template === undefined) {
      template = boardTemplate(setupOf(c, setup));
      templates.set(c.setup, template);
    }
    return template;
  };
  const runs = new Map<SetupCase, { key: string; name: string; exitCode: number; state: string }>();
  registerParity(testUrl, cases, async (c) => {
    const run = await runWrite(c, await templateOf(c));
    runs.set(c, { exitCode: run.exitCode, key: keyOf(c), name: c.name, state: run.state });
    return run.pin;
  });
  test('every format of one write changes the same records', () => {
    expect(formatVariance(cases.flatMap((c) => runs.get(c) ?? []))).toEqual([]);
  });
}
