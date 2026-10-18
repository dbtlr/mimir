import { runCli } from '@mimir/bin/src/cli';
import { fakeIo } from '@mimir/bin/src/cli/testing';
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
 *   which compares by exit code alone.
 *
 * Two differences every case carries are normalized, not listed: help's
 * pointer hint on an argv failure, and Loom's style resets on a terminal.
 * Help is pinned on its own, never compared. Test-only.
 */
import type { Store } from '@mimir/core';
import { parseJson } from '@mimir/helpers';

import type { createApp } from '../app';
import { HELP_POINTER, LOOM_RESETS } from '../parity/differences';
import type { ParityDifference } from '../parity/differences';
import { runArgv } from './run';

type App = ReturnType<typeof createApp>;

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
    oldFailure(run.stderr) ??
    oldFailure((await oldRun(store, [...argv, '--format', 'json'], bound)).stderr);
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

/** An argv with every `-f` value set to `json`, or `--format json` appended when it names none. */
function underJson(argv: readonly string[]): string[] {
  const named = argv.map((word, i) =>
    i > 0 && (argv[i - 1] === '-f' || argv[i - 1] === '--format') ? 'json' : word,
  );
  return argvFormat(argv) === undefined ? [...named, '--format', 'json'] : named;
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
async function runNewArgv(app: App, argv: readonly string[], tty = false): Promise<ParityRun> {
  const run = await runArgv(app, [...argv], { tty });
  if (run.exitCode === 0) {
    return { exitCode: 0, stdout: tty ? resetsNormalized(run.stdout) : run.stdout };
  }
  const json = run.stderr.startsWith('{"error"')
    ? run.stderr
    : (await runArgv(app, underJson(argv))).stderr;
  const failure = newFailure(json) ?? proseFailure(json);
  return {
    exitCode: run.exitCode,
    stdout: run.stdout,
    ...(failure === undefined ? {} : { failure }),
  };
}

/** Run a case through the new CLI: by name, or through its parser for an argv case. */
export async function runNew(app: App, c: ParityCase): Promise<ParityRun> {
  if (c.argv !== undefined) {
    return runNewArgv(app, c.argv, c.tty);
  }
  const outcome = await app.invoke(c.path, { args: c.args ?? {}, options: c.options ?? {} });
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

/** A `loom-voice` entry: the new failure is Loom's own, and differs from the old one. */
function loomVoiceProblems(old: ParityRun, next: ParityRun): string[] {
  const problems = loomFaultProblems(next.failure);
  if (problems.length === 0 && JSON.stringify(old.failure) === JSON.stringify(next.failure)) {
    return ['a loom-voice entry names failures that match; remove it'];
  }
  return problems;
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
): string[] {
  const entry = differences.find((d) => d.case === c.name);
  if (entry?.kind === 'loom-refusal') {
    return loomRefusalProblems(old, next);
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
