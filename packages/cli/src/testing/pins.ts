import { afterAll, expect, test } from 'bun:test';
/**
 * Pinned output for the parity cases. Each parity test file keeps the output
 * the Loom CLI gave every case in `parity-pins/<name>.txt` beside it, as plain
 * text a reviewer can read in a diff. A case compares its fresh output to its
 * pin; a deliberate change re-records the pins:
 *
 *   MIMIR_UPDATE_PINS=1 bun test packages/cli/src/commands/get.parity.test.ts
 *
 * Re-recording needs the whole file to run and pass, and rewrites the file in
 * case order. The pins hold what the retired old CLI was proven to print,
 * modulo the reviewed differences recorded in ADR 0037. Test-only.
 *
 * A pin file is a run of entries, each `### <case name>`, a body, and a blank
 * line. Body lines are quoted (`| `) or start with a keyword, so none starts
 * with `### `.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Whether this run re-records pins instead of comparing with them. */
const UPDATING = process.env.MIMIR_UPDATE_PINS === '1';

const HEADER = '### ';

/** What one case printed, ready to pin. */
export type PinnedRun = {
  exitCode: number;
  stdout: string;
  failure?: { code: string; message: string; hints: readonly string[] };
};

/** A control character spelled so a reader can see it: ESC as `␛`, the rest as `⟦hex⟧`. */
function visible(text: string): string {
  return (
    text
      .replaceAll('\u001B', '␛')
      // eslint-disable-next-line no-control-regex
      .replaceAll(/[\u0000-\u0008\u000B-\u001F\u007F]/g, (c) => `⟦${c.charCodeAt(0).toString(16)}⟧`)
  );
}

/** Text as quoted lines, with a marker when it lacks its final newline. */
export function quoted(text: string): string {
  if (text === '') {
    return '';
  }
  const lines = text.split('\n');
  const complete = lines.at(-1) === '';
  if (complete) {
    lines.pop();
  }
  const body = lines.map((line) => (line === '' ? '|' : `| ${visible(line)}`)).join('\n');
  return `${body}\n${complete ? '' : '\\ no newline at end\n'}`;
}

/** One run as pin text: its exit code, stdout, and failure, with `scrub` applied to the whole. */
export function renderRun(
  run: PinnedRun,
  extra = '',
  scrub: (text: string) => string = (t) => t,
): string {
  const failure =
    run.failure === undefined
      ? ''
      : `--- failure\n${quoted(`${JSON.stringify(run.failure, null, 2)}\n`)}`;
  return scrub(`exit ${String(run.exitCode)}\n--- stdout\n${quoted(run.stdout)}${failure}${extra}`);
}

/**
 * The lines that differ between two texts, each change with `context` lines around it, hunks
 * separated by `...`. Empty when the texts are equal.
 */
export function changedLines(before: string, after: string, context = 2): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    head++;
  }
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a.at(-1 - tail) === b.at(-1 - tail)) {
    tail++;
  }
  const from = a.slice(head, a.length - tail);
  const to = b.slice(head, b.length - tail);
  if (from.length === 0 && to.length === 0) {
    return '';
  }
  // Longest common subsequence of the differing middle, so unrelated edits stay separate.
  const lcs = Array.from({ length: from.length + 1 }, () => new Uint32Array(to.length + 1));
  for (let i = from.length - 1; i >= 0; i--) {
    for (let j = to.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        from[i] === to[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const rows: { mark: ' ' | '-' | '+'; line: string }[] = a
    .slice(0, head)
    .map((line) => ({ line, mark: ' ' }));
  let i = 0;
  let j = 0;
  while (i < from.length || j < to.length) {
    if (i < from.length && j < to.length && from[i] === to[j]) {
      rows.push({ line: from[i]!, mark: ' ' });
      i++;
      j++;
    } else if (j < to.length && (i === from.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      rows.push({ line: to[j]!, mark: '+' });
      j++;
    } else {
      rows.push({ line: from[i]!, mark: '-' });
      i++;
    }
  }
  rows.push(
    ...a.slice(a.length - tail).map((line): (typeof rows)[number] => ({ line, mark: ' ' })),
  );
  const keep = rows.map((row, at) =>
    rows.slice(Math.max(0, at - context), at + context + 1).some((near) => near.mark !== ' '),
  );
  const out: string[] = [];
  let gap = false;
  rows.forEach((row, at) => {
    if (!keep[at]) {
      gap = out.length > 0;
      return;
    }
    if (gap) {
      out.push('...');
      gap = false;
    }
    out.push(`${row.mark} ${visible(row.line)}`.trimEnd());
  });
  return `${out.join('\n')}\n`;
}

/** The pins of one test file. */
export class Pins {
  readonly path: string;
  readonly #stored = new Map<string, string>();
  readonly #recorded = new Map<string, string>();
  readonly names = new Set<string>();
  failed = false;

  /** The key a case's pin goes under: its name, numbered `#2`, `#3`... when an earlier case took it. */
  claim(name: string): string {
    let key = name;
    for (let n = 2; this.names.has(key); n++) {
      key = `${name} #${String(n)}`;
    }
    this.names.add(key);
    return key;
  }

  constructor(testUrl: string) {
    this.path = join(
      dirname(fileURLToPath(testUrl)),
      'parity-pins',
      basename(fileURLToPath(testUrl)).replace(/\.test\.ts$/, '.txt'),
    );
    if (!UPDATING && existsSync(this.path)) {
      const entries = readFileSync(this.path, 'utf8')
        .split(new RegExp(`^${HEADER}`, 'm'))
        .slice(1);
      for (const entry of entries) {
        const at = entry.indexOf('\n');
        this.#stored.set(entry.slice(0, at), entry.slice(at + 1, -1));
      }
    }
  }

  /** Every case name the file pins. */
  pinned(): string[] {
    return [...this.#stored.keys()];
  }

  /** Compare `text` with the pin for `name`, or record it when re-recording. */
  check(name: string, text: string): void {
    if (UPDATING) {
      expect(this.#recorded.has(name), `two cases are named "${name}"`).toBe(false);
      this.#recorded.set(name, text);
      return;
    }
    expect(this.#stored.has(name), `no pin for "${name}"; re-record with MIMIR_UPDATE_PINS=1`).toBe(
      true,
    );
    expect(text).toBe(this.#stored.get(name)!);
  }

  /** Write the recorded pins, in case order, when this run covered the whole file. */
  save(): void {
    if (!UPDATING) {
      return;
    }
    const missing = [...this.names].filter((name) => !this.#recorded.has(name));
    if (this.failed || missing.length > 0) {
      throw new Error(
        `pins not written: ${this.failed ? 'a case failed' : `no run for ${missing.join(', ')}`}`,
      );
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const body = [...this.names]
      .map((name) => `${HEADER}${name}\n${this.#recorded.get(name)!}\n`)
      .join('');
    writeFileSync(this.path, body);
  }
}

const files = new Map<string, Pins>();

/**
 * The pins of the test file at `testUrl` (its `import.meta.url`), the same
 * object however many case families the file registers. Registers the end-of-file
 * save, and a test that every pin names a case claimed.
 */
export function pinsOf(testUrl: string): Pins {
  let pins = files.get(testUrl);
  if (pins === undefined) {
    const made = new Pins(testUrl);
    pins = made;
    files.set(testUrl, made);
    afterAll(() => made.save());
  }
  const held = pins;
  test.skipIf(UPDATING)('every pin names a case', () => {
    expect(held.pinned().filter((name) => !held.names.has(name))).toEqual([]);
  });
  return pins;
}
