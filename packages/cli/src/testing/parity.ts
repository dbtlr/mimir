/**
 * The parity harness. Each case runs through the old CLI's `runCli` and the new
 * CLI over one store, by name through `app.invoke` or as a literal argv through
 * Loom's parser, piped or on a terminal. The two must agree under the rule ADR
 * 0037 states:
 *
 * - `json`, `jsonl`, and `ids` output and exit codes are byte-identical;
 * - `table` and `records` output may differ only by the lines a checked-in
 *   difference entry lists;
 * - a failure compares by exit code, code, message, and hints, except a fault
 *   Loom's parser raises in its own voice, which a difference entry names and
 *   which compares by exit code alone, except a misplaced or retired flag,
 *   which also compares its redirect hint;
 *
 * Two differences every case carries are normalized, not listed: help's
 * pointer hint on an argv failure, and Loom's style resets on a terminal.
 * Help is pinned on its own, never compared. Test-only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';

import { runCli } from '@mimir/bin/src/cli';
import { fakeIo } from '@mimir/bin/src/cli/testing';
import type { Store } from '@mimir/core';
import { parseJson } from '@mimir/helpers';

import type { createApp } from '../app';
import { HELP_POINTER, LOOM_RESETS, PARITY_DIFFERENCES } from '../parity/differences';
import type { ParityDifference } from '../parity/differences';
import { compactJson } from '../render/views';
import { parityBoard } from './fixture';
import type { ParityBoard } from './fixture';
import { runArgv } from './run';

type App = ReturnType<typeof createApp>;

/** An app over the board, its failures reading `argv` as the run's words. */
export type AppFor = (argv?: readonly string[]) => App;

/** One invocation, spelled by name; the old CLI's argv is derived from it. */
export type ParityCase = {
  /** Unique, led by the command path, such as `get MMR-3 -f json`. */
  name: string;
  path: readonly string[];
  args?: Readonly<Record<string, string>>;
  options?: Readonly<Record<string, string | readonly string[] | true>>;
  /** The project the clone is bound to, for both CLIs; unbound when absent. */
  bound?: string;
  /** Both CLIs run this literal argv, the new one through Loom's parser, instead of by name. */
  argv?: readonly string[];
  /** Both CLIs write to a color terminal rather than a pipe. Argv cases only. */
  tty?: true;
};

/** What one CLI did for a case. */
export type ParityRun = {
  exitCode: number;
  stdout: string;
  failure?: { code: string; message: string; hints: readonly string[] };
};

/**
 * The old CLI's argv for a case: its literal argv, else path, then arguments in
 * order, then `--name value` flags.
 */
export function argvOf(c: ParityCase): string[] {
  if (c.argv !== undefined) {
    return [...c.argv];
  }
  const argv = [...c.path, ...Object.values(c.args ?? {})];
  for (const [name, value] of Object.entries(c.options ?? {})) {
    if (value === true) {
      argv.push(`--${name}`);
      continue;
    }
    for (const one of typeof value === 'string' ? [value] : value) {
      argv.push(`--${name}`, one);
    }
  }
  return argv;
}

/** The old CLI's failure, read back from the JSON envelope it writes under `--format json`. */
function oldFailure(stderr: string): ParityRun['failure'] {
  if (!stderr.startsWith('{"error"')) {
    return undefined;
  }
  const { error } = parseJson<{ error: { code: string; message: string; hint?: string } }>(stderr);
  return {
    code: error.code.replaceAll('_', '-'),
    hints: error.hint === undefined ? [] : [error.hint],
    message: error.message,
  };
}

/** The new CLI's failure, read back from Loom's JSON failure line, help's pointer dropped. */
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

/** A terminal's bytes with every style reset spelled one way. */
const resetsNormalized = (text: string): string =>
  LOOM_RESETS.reduce((normal, reset) => normal.replaceAll(reset, '\u001B[0m'), text);

/** Each write as the old CLI's stdout writer emits it: one newline unless the text ends with one. */
const joined = (lines: readonly string[]): string =>
  lines.map((line) => (line.endsWith('\n') ? line : `${line}\n`)).join('');

/** The process zone, which both CLIs render in. */
const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;

async function oldRun(store: Store, argv: string[], bound: string | undefined, tty = false) {
  const io = fakeIo(tty, { plain: !tty, zone });
  const exitCode = await runCli(argv, () => store, io, { scope: () => Promise.resolve(bound) });
  return { exitCode, stderr: joined(io.err), stdout: joined(io.out) };
}

/**
 * Run a case through the old CLI, its clone bound to the case's `bound`. A failure
 * is read from the JSON envelope, so a case that names no format runs again,
 * piped, under `--format json` to read it; a failed read changes nothing.
 */
export async function runOld(store: Store, c: ParityCase): Promise<ParityRun> {
  const argv = argvOf(c);
  const bound = c.bound;
  const run = await oldRun(store, argv, bound, c.tty);
  if (run.exitCode === 0) {
    return { exitCode: 0, stdout: c.tty ? resetsNormalized(run.stdout) : run.stdout };
  }
  const failure =
    oldFailure(run.stderr) ?? oldFailure((await oldRun(store, underJson(argv), bound)).stderr);
  return {
    exitCode: run.exitCode,
    stdout: run.stdout,
    ...(failure === undefined ? {} : { failure }),
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

/** Run an argv case through the new CLI's parser, reading a failure as `runOld` does. */
async function runNewArgv(
  appFor: AppFor,
  argv: readonly string[],
  tty = false,
): Promise<ParityRun> {
  const run = await runArgv(appFor(argv), [...argv], { tty });
  if (run.exitCode === 0) {
    return { exitCode: 0, stdout: tty ? resetsNormalized(run.stdout) : run.stdout };
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

/** Run a case through the new CLI: by name, or through its parser for an argv case. */
export async function runNew(appFor: AppFor, c: ParityCase): Promise<ParityRun> {
  if (c.argv !== undefined) {
    return runNewArgv(appFor, c.argv, c.tty);
  }
  const outcome = await appFor().invoke(c.path, { args: c.args ?? {}, options: c.options ?? {} });
  if (outcome.status === 'cancelled') {
    return { exitCode: outcome.exitCode, stdout: '' };
  }
  if (outcome.status === 'completed') {
    return { exitCode: 0, stdout: outcome.output };
  }
  const { code, hints, message } = outcome.form;
  return { exitCode: outcome.exitCode, failure: { code, hints, message }, stdout: outcome.output };
}

/** The view a case renders: its `--format`, else the command's declared default. */
function viewOf(app: App, c: ParityCase): string {
  const named = c.argv === undefined ? c.options?.format : argvFormat(c.argv);
  if (typeof named === 'string') {
    return named;
  }
  let node = app.inspect().root;
  for (const name of c.path) {
    node = node.children.find((child) => child.name === name) ?? node;
  }
  return node.result?.default ?? '';
}

/** The line pairs where two outputs differ, by line number. */
function lineDiff(old: string, next: string): { old: string; new: string }[] {
  const a = old.split('\n');
  const b = next.split('\n');
  const pairs: { old: string; new: string }[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      pairs.push({ new: b[i] ?? '', old: a[i] ?? '' });
    }
  }
  return pairs;
}

const STRUCTURED = new Set(['json', 'jsonl', 'ids']);

/** The failure codes Mimir raises; any other code is one of Loom's parser faults. */
const MIMIR_CODES = new Set(['usage', 'not-found', 'validation', 'conflict', 'invariant']);

/** Why a Loom difference entry does not hold for the new failure; empty when it does. */
function loomFaultProblems(got: ParityRun['failure']): string[] {
  if (got === undefined) {
    return ['a Loom difference entry names a case the new CLI reported no failure for'];
  }
  if (MIMIR_CODES.has(got.code)) {
    return [
      `a Loom difference entry names a failure Mimir raises (${got.code}); the rule compares it`,
    ];
  }
  return [];
}

/** A `loom-refusal` entry: the old CLI accepted, and Loom's parser refuses with exit 2. */
function loomRefusalProblems(old: ParityRun, next: ParityRun): string[] {
  if (old.exitCode !== 0) {
    return [
      `a loom-refusal entry names a case the old CLI refused too (exit ${String(old.exitCode)}); use loom-voice`,
    ];
  }
  if (next.exitCode === 0) {
    return ['a loom-refusal entry names a case the new CLI accepts (exit 0); remove it'];
  }
  const problems =
    next.exitCode === 2 ? [] : [`a loom-refusal exits 2, not ${String(next.exitCode)}`];
  return [...problems, ...loomFaultProblems(next.failure)];
}

/** A `loom-scoped` entry: the old CLI refused with exit 1, and Loom's parser refuses with exit 2. */
function loomScopedProblems(old: ParityRun, next: ParityRun): string[] {
  const problems =
    old.exitCode === 1
      ? []
      : [`a loom-scoped entry names a case the old CLI exits ${String(old.exitCode)} for, not 1`];
  if (next.exitCode !== 2) {
    problems.push(`a loom-scoped refusal exits 2, not ${String(next.exitCode)}`);
  }
  return [...problems, ...loomFaultProblems(next.failure)];
}

/** An `engine-refusal` entry: the old CLI accepted, and the Engine refuses with a Mimir code. */
function engineRefusalProblems(old: ParityRun, next: ParityRun): string[] {
  if (old.exitCode !== 0) {
    return [
      `an engine-refusal entry names a case the old CLI refused too (exit ${String(old.exitCode)})`,
    ];
  }
  if (next.exitCode !== 1 || next.failure === undefined || !MIMIR_CODES.has(next.failure.code)) {
    return [
      `an engine-refusal entry needs the new CLI to refuse with a Mimir code at exit 1, not exit ${String(next.exitCode)}`,
    ];
  }
  return [];
}

/** A `loom-voice` entry: the new failure is Loom's own, and differs from the old one. */
function loomVoiceProblems(old: ParityRun, next: ParityRun): string[] {
  const problems = loomFaultProblems(next.failure);
  if (problems.length === 0 && JSON.stringify(old.failure) === JSON.stringify(next.failure)) {
    return ['a loom-voice entry names failures that match; remove it'];
  }
  return problems;
}

/** `c` run under `--format json`, the document a `jsonl` line must be the compact form of. */
export function jsonVariant(c: ParityCase): ParityCase {
  return c.argv === undefined
    ? { ...c, options: { ...c.options, format: 'json' } }
    : { ...c, argv: underJson(c.argv) };
}

/**
 * A `flag-redirect` entry: both CLIs refuse a flag the command does not own,
 * Loom with its own unknown-option message and code, and the hints are the old
 * CLI's redirect, so they and the exit code compare.
 */
function flagRedirectProblems(old: ParityRun, next: ParityRun): string[] {
  const problems =
    old.exitCode === next.exitCode
      ? []
      : [`exit code: old ${String(old.exitCode)}, new ${String(next.exitCode)}`];
  if (old.failure === undefined) {
    return [...problems, 'a flag-redirect entry names a case the old CLI did not refuse'];
  }
  problems.push(...loomFaultProblems(next.failure));
  if (
    next.failure !== undefined &&
    JSON.stringify(old.failure.hints) !== JSON.stringify(next.failure.hints)
  ) {
    problems.push(
      `failure hints: old ${JSON.stringify(old.failure.hints)}, new ${JSON.stringify(next.failure.hints)}`,
    );
  }
  return problems;
}

/** A `new-view` entry: the new CLI exits 0 and prints each line as the compact form of its `-f json` document. */
function newViewProblems(old: ParityRun, next: ParityRun, json: ParityRun | undefined): string[] {
  if (next.exitCode !== 0) {
    return [`a new-view entry needs the new CLI to exit 0, not ${String(next.exitCode)}`];
  }
  if (old.exitCode === 0 && old.stdout === next.stdout) {
    return ['a new-view entry names outputs that match; remove it'];
  }
  if (json === undefined || json.exitCode !== 0) {
    return ['a new-view entry needs the same case to exit 0 under -f json'];
  }
  const compact = compactJson(parseJson(json.stdout));
  const lines = next.stdout.split('\n').filter((line) => line !== '');
  return lines.length > 0 && lines.every((line) => line === compact)
    ? []
    : ['a new-view entry needs every output line to be the compact form of its -f json document'];
}

/** The record ids an output names: `KEY-seq`, `KEY-aN`, `KEY-sN`, and pad UUIDs. */
function idsOf(stdout: string): Set<string> {
  const pattern = /\b[A-Z][A-Z0-9]*-[as]?\d+\b|\b[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\b/g;
  return new Set(Array.from(stdout.matchAll(pattern), (match) => match[0]));
}

/**
 * A `board-read` entry: the old CLI accepted; the new one refuses with a Mimir
 * code, or exits 0 on the one board it names, so its ids are a subset of the
 * old CLI's wider read.
 */
function boardReadProblems(old: ParityRun, next: ParityRun): string[] {
  if (old.exitCode !== 0) {
    return ['a board-read entry names a case the old CLI refused'];
  }
  if (next.exitCode === 0) {
    if (old.stdout === next.stdout) {
      return ['a board-read entry names outputs that match; remove it'];
    }
    const wider = idsOf(old.stdout);
    const extra = [...idsOf(next.stdout)].filter((id) => !wider.has(id));
    return extra.length === 0
      ? []
      : [`a board-read entry needs the new ids within the old ids; extra: ${extra.join(', ')}`];
  }
  return next.failure !== undefined && MIMIR_CODES.has(next.failure.code)
    ? []
    : ['a board-read entry needs the new refusal to carry a Mimir code'];
}

/**
 * Every way a case breaks the parity rule; empty when it holds. `differences`
 * is the checked-in list, and an entry that matches nothing is itself a break.
 */
export function parityProblems(
  app: App,
  c: ParityCase,
  old: ParityRun,
  next: ParityRun,
  differences: readonly ParityDifference[],
  json?: ParityRun,
): string[] {
  const entry = differences.find((d) => d.case === c.name);
  if (entry?.kind === 'loom-refusal') {
    return loomRefusalProblems(old, next);
  }
  if (entry?.kind === 'flag-redirect') {
    return flagRedirectProblems(old, next);
  }
  if (entry?.kind === 'new-view') {
    return newViewProblems(old, next, json);
  }
  if (entry?.kind === 'board-read') {
    return boardReadProblems(old, next);
  }
  if (entry?.kind === 'loom-scoped') {
    return loomScopedProblems(old, next);
  }
  if (entry?.kind === 'engine-refusal') {
    return engineRefusalProblems(old, next);
  }
  const problems: string[] = [];
  if (old.exitCode !== next.exitCode) {
    problems.push(`exit code: old ${String(old.exitCode)}, new ${String(next.exitCode)}`);
  }
  if (old.exitCode !== 0) {
    if (entry?.kind === 'loom-voice') {
      return [...problems, ...loomVoiceProblems(old, next)];
    }
    const want = old.failure;
    const got = next.failure;
    if (want === undefined || got === undefined) {
      problems.push('failure: one side reported none');
      return problems;
    }
    if (want.code !== got.code) {
      problems.push(`failure code: old ${want.code}, new ${got.code}`);
    }
    if (want.message !== got.message) {
      problems.push(
        `failure message: old ${JSON.stringify(want.message)}, new ${JSON.stringify(got.message)}`,
      );
    }
    if (JSON.stringify(want.hints) !== JSON.stringify(got.hints)) {
      problems.push(
        `failure hints: old ${JSON.stringify(want.hints)}, new ${JSON.stringify(got.hints)}`,
      );
    }
    if (entry !== undefined) {
      problems.push('a difference entry names a failure the rule already compares');
    }
    return problems;
  }
  const view = viewOf(app, c);
  if (STRUCTURED.has(view)) {
    if (old.stdout !== next.stdout) {
      problems.push(`${view} output differs:\n--- old\n${old.stdout}--- new\n${next.stdout}`);
    }
    if (entry !== undefined) {
      problems.push(`${view} output takes no difference entry`);
    }
    return problems;
  }
  const diff = lineDiff(old.stdout, next.stdout);
  const allowed = entry?.kind === 'styled' ? entry.lines : [];
  if (JSON.stringify(diff) !== JSON.stringify(allowed)) {
    problems.push(
      `${view} output differs beyond its difference entry:\n${JSON.stringify(diff, null, 2)}\n--- old\n${old.stdout}--- new\n${next.stdout}`,
    );
  }
  return problems;
}

/** What a parity file's setup returns: how to rewrite each case once the board exists, if it must. */
type CaseRewrite = (c: ParityCase) => ParityCase;

/**
 * Register the two tests every parity file carries: each case must have no
 * problems, and every checked-in difference entry whose case `owner` matches
 * must name one of `cases`, so a stale entry fails.
 */
export function registerParity(
  owner: RegExp,
  cases: readonly ParityCase[],
  problemsOf: (c: ParityCase) => Promise<string[]>,
): void {
  test.each([...cases])('parity: $name', async (c) => {
    expect(await problemsOf(c)).toEqual([]);
  });

  test(`every difference entry for ${String(owner)} names a case`, () => {
    const names = new Set(cases.map((c) => c.name));
    const stale = PARITY_DIFFERENCES.filter((d) => owner.test(d.case) && !names.has(d.case));
    expect(stale).toEqual([]);
  });
}

/**
 * Register one read command's parity tests: every case runs through both CLIs
 * over one shared board. `setup` fills the board before the cases run, and may
 * return a rewrite for the cases that name what only the board knows, such as
 * a generated id. A write, which changes its board, registers through
 * `twinCases` instead.
 */
export function parityCases(
  owner: RegExp,
  cases: readonly ParityCase[],
  setup?: (board: ParityBoard) => Promise<CaseRewrite | undefined>,
): void {
  let board: ParityBoard;
  let rewrite: CaseRewrite | undefined;
  beforeAll(async () => {
    board = await parityBoard();
    rewrite = await setup?.(board);
  });
  afterAll(async () => {
    await board.close();
  });

  registerParity(owner, cases, async (c) => {
    const run = rewrite === undefined ? c : rewrite(c);
    const old = await runOld(board.store, run);
    const now = await runNew((argv) => board.app(c.bound, argv), run);
    const isNewView = PARITY_DIFFERENCES.some((d) => d.case === c.name && d.kind === 'new-view');
    const json = isNewView
      ? await runNew((argv) => board.app(c.bound, argv), jsonVariant(run))
      : undefined;
    return parityProblems(board.app(), c, old, now, PARITY_DIFFERENCES, json);
  });
}
