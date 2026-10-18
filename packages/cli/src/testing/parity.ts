import { runCli } from '@mimir/bin/src/cli';
import { fakeIo } from '@mimir/bin/src/cli/testing';
/**
 * The parity harness. Each case runs through the old CLI's `runCli` and the new
 * CLI's `app.invoke` over one store, and the two must agree under the rule ADR
 * 0037 states:
 *
 * - `json`, `jsonl`, and `ids` output and exit codes are byte-identical;
 * - `table` and `records` output may differ only by the lines a checked-in
 *   difference entry lists;
 * - a failure compares by exit code, code, message, and hints, except a fault
 *   Loom's parser raises in its own voice, which a difference entry names and
 *   which compares by exit code alone.
 *
 * Help is pinned on its own, never compared. Test-only.
 */
import type { Store } from '@mimir/core';
import { parseJson } from '@mimir/helpers';

import type { createApp } from '../app';
import type { ParityDifference } from '../parity/differences';

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
};

/** What one CLI did for a case. */
export type ParityRun = {
  exitCode: number;
  stdout: string;
  failure?: { code: string; message: string; hints: readonly string[] };
};

/** The old CLI's argv for a case: path, then arguments in order, then `--name value` flags. */
export function argvOf(c: ParityCase): string[] {
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

/** Each write as the old CLI's stdout writer emits it: one newline unless the text ends with one. */
const joined = (lines: readonly string[]): string =>
  lines.map((line) => (line.endsWith('\n') ? line : `${line}\n`)).join('');

/** The process zone, which both CLIs render in. */
const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;

async function oldRun(store: Store, argv: string[], bound: string | undefined) {
  const io = fakeIo(false, { zone });
  const exitCode = await runCli(argv, () => store, io, { scope: () => Promise.resolve(bound) });
  return { exitCode, stderr: joined(io.err), stdout: joined(io.out) };
}

/**
 * Run a case through the old CLI, piped, its clone bound to the case's `bound`. A failure
 * is read from the JSON envelope, so a case that names no format runs again
 * under `--format json` to read it; a failed read changes nothing.
 */
export async function runOld(store: Store, c: ParityCase): Promise<ParityRun> {
  const argv = argvOf(c);
  const bound = c.bound;
  const run = await oldRun(store, argv, bound);
  if (run.exitCode === 0) {
    return { exitCode: 0, stdout: run.stdout };
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

/** Run a case through the new CLI by name. */
export async function runNew(app: App, c: ParityCase): Promise<ParityRun> {
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
  if (typeof c.options?.format === 'string') {
    return c.options.format;
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
  const problems: string[] = [];
  const entry = differences.find((d) => d.case === c.name);
  if (old.exitCode !== next.exitCode) {
    problems.push(`exit code: old ${String(old.exitCode)}, new ${String(next.exitCode)}`);
  }
  if (old.exitCode !== 0) {
    if (entry?.kind === 'loom-voice') {
      return problems;
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
