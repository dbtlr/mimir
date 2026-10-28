/**
 * The parity harness. Each case runs the Loom CLI over one board, by name
 * through `app.invoke` or as a literal argv through Loom's parser, piped or on
 * a terminal, and must print what its pin holds (`pins.ts`): the exit code and
 * stdout, and for a failure its code, message, and hints. The pins were
 * recorded while the old CLI still ran the same cases and were proven equal to
 * its output modulo the reviewed differences in ADR 0037, so a changed byte
 * here is a deliberate change to re-record, or a regression.
 *
 * One normalization every case carries: help's pointer hint on an argv
 * failure is dropped, since it names the help page of whatever command failed.
 * Help is pinned on its own. Test-only.
 */
import { afterAll, beforeAll, test } from 'bun:test';

import { mockProcess } from '@loomcli/testing';
import { parseJson } from '@mimir/helpers';

import type { createApp } from '../app';
import { frozenBoard } from './fixture';
import type { FrozenBoard, ParityBoard } from './fixture';
import { pinsOf, renderRun } from './pins';
import { runArgv } from './run';

type App = ReturnType<typeof createApp>;

/** An app over the board, its failures reading `argv` as the run's words. */
export type AppFor = (argv?: readonly string[]) => App;

/** One invocation, spelled by name or as a literal argv. */
export type ParityCase = {
  /** Unique, led by the command path, such as `get MMR-3 -f json`. */
  name: string;
  path: readonly string[];
  args?: Readonly<Record<string, string>>;
  options?: Readonly<Record<string, string | readonly string[] | true>>;
  /** The project the clone is bound to; unbound when absent. */
  bound?: string;
  /** The origin remote of the clone; none when absent. */
  origin?: string;
  /** Run this literal argv through Loom's parser instead of invoking by name. */
  argv?: readonly string[];
  /** Write to a color terminal rather than a pipe. Argv cases only. */
  tty?: true;
};

/** What the CLI did for a case. */
export type ParityRun = {
  exitCode: number;
  stdout: string;
  failure?: { code: string; message: string; hints: readonly string[] };
};

/** Help's pointer hint, appended as the last hint of every usage failure through argv. */
const HELP_POINTER = /^Run "mimir(?: [a-z-]+)* --help" to see the usage\.$/;

/** The CLI's failure, read back from Loom's JSON failure line, help's pointer dropped. */
function newFailure(stderr: string): ParityRun['failure'] {
  if (!stderr.startsWith('{"error"')) {
    return undefined;
  }
  const { error } = parseJson<{ error: { code: string; message: string; hints: string[] } }>(
    stderr,
  );
  return {
    code: error.code,
    hints: error.hints.filter((hint) => !HELP_POINTER.test(hint)),
    message: error.message,
  };
}

/** The `-f` an argv names, the last one when it repeats. */
function argvFormat(argv: readonly string[]): string | undefined {
  const at = Math.max(argv.lastIndexOf('-f'), argv.lastIndexOf('--format'));
  return at === -1 ? undefined : argv[at + 1];
}

/**
 * An argv with every `-f` value set to `json`, or `--format json` added when it
 * names none. The option goes before the first `--`, since words after it are
 * passthrough or reason text and would never parse as the format.
 */
export function underJson(argv: readonly string[]): string[] {
  const named = argv.map((word, i) =>
    i > 0 && (argv[i - 1] === '-f' || argv[i - 1] === '--format') ? 'json' : word,
  );
  if (argvFormat(argv) !== undefined) {
    return named;
  }
  const stop = named.indexOf('--');
  const at = stop === -1 ? named.length : stop;
  return [...named.slice(0, at), '--format', 'json', ...named.slice(at)];
}

/**
 * A failure Loom wrote in prose even under `--format json`: the fault kept the
 * format option from parsing, so it is the parser's, and its code goes unread.
 */
function proseFailure(stderr: string): ParityRun['failure'] {
  const [first = '', ...hints] = stderr.trimEnd().split('\n');
  return {
    code: 'parser',
    hints: hints.filter((hint) => !HELP_POINTER.test(hint)),
    message: first.replace(/^mimir: /, ''),
  };
}

/** Run an argv case through Loom's parser, reading a failure from its JSON line. */
async function runNewArgv(
  appFor: AppFor,
  argv: readonly string[],
  tty = false,
): Promise<ParityRun> {
  const run = await runArgv(appFor(argv), [...argv], { tty });
  if (run.exitCode === 0) {
    return { exitCode: 0, stdout: run.stdout };
  }
  const json = run.stderr.startsWith('{"error"')
    ? run.stderr
    : (await runArgv(appFor(underJson(argv)), underJson(argv))).stderr;
  const failure = newFailure(json) ?? proseFailure(json);
  return {
    exitCode: run.exitCode,
    stdout: run.stdout,
    ...(failure === undefined ? {} : { failure }),
  };
}

/** Run a case through the CLI: by name, or through its parser for an argv case. */
export async function runNew(appFor: AppFor, c: ParityCase): Promise<ParityRun> {
  if (c.argv !== undefined) {
    return runNewArgv(appFor, c.argv, c.tty);
  }
  // The mock process, not the real one, so no machine's zone or environment reaches the run.
  const outcome = await appFor().invoke(
    c.path,
    { args: c.args ?? {}, options: c.options ?? {} },
    { process: mockProcess() },
  );
  if (outcome.status === 'cancelled') {
    return { exitCode: outcome.exitCode, stdout: '' };
  }
  if (outcome.status === 'completed') {
    return { exitCode: 0, stdout: outcome.output };
  }
  const { code, hints, message } = outcome.form;
  return { exitCode: outcome.exitCode, failure: { code, hints, message }, stdout: outcome.output };
}

/** What a parity file's setup returns: how to rewrite each case once the board exists, if it must. */
type CaseRewrite = (c: ParityCase) => ParityCase;

/** Every UUID, random by design, named `<uuid>`. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** The pin text for a run: UUIDs named `<uuid>` and the scratch `dir` named `<dir>`. */
export function pinText(run: ParityRun, dir: string, extra = ''): string {
  return renderRun(run, extra, (text) => text.replaceAll(UUID, '<uuid>').replaceAll(dir, '<dir>'));
}

/**
 * Register the tests every parity file carries: each case must print what its
 * pin holds, and every pin must name a case. `testUrl` is the file's
 * `import.meta.url`; `pinOf` runs a case and returns its pin text.
 */
export function registerParity<Case extends ParityCase>(
  testUrl: string,
  cases: readonly Case[],
  pinOf: (c: Case) => Promise<string>,
): void {
  const pins = pinsOf(testUrl);
  const keys = new Map(cases.map((c) => [c, pins.claim(c.name)]));
  test.each([...cases])('parity: $name', async (c) => {
    pins.check(keys.get(c)!, await pinOf(c));
  });
}

/**
 * Register one read command's parity tests: every case runs over one shared
 * board. `setup` fills the board before the cases run, and may return a
 * rewrite for the cases that name what only the board knows, such as a
 * generated id. A write, which changes its board, registers through
 * `writeCases` instead.
 */
export function parityCases(
  testUrl: string,
  cases: readonly ParityCase[],
  setup?: (board: ParityBoard) => Promise<CaseRewrite | undefined>,
): void {
  // Frozen, the board's stamps and every age the views print are the same on every run. A
  // setup fault leaves nothing assigned and the clock thawed, so the cleanup has nothing to close.
  let opened: FrozenBoard<CaseRewrite | undefined> | undefined;
  beforeAll(async () => {
    opened = await frozenBoard(async (board) => setup?.(board));
  });
  afterAll(async () => {
    await opened?.close();
  });

  registerParity(testUrl, cases, async (c) => {
    const { board, value: rewrite } = opened!;
    const run = rewrite === undefined ? c : rewrite(c);
    return pinText(await runNew((argv) => board.app(c.bound, argv), run), board.dir);
  });
}
