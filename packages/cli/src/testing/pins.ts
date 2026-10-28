import { afterAll, expect, test } from 'bun:test';
/**
 * Pinned output for the parity cases. Each parity test file keeps the output
 * the Loom CLI gave every case in `parity-pins/<name>.txt` beside it, as plain
 * text a reviewer can read in a diff. A case compares its fresh output to its
 * pin; a deliberate change re-records the pins:
 *
 *   bun packages/cli/scripts/update-pins.ts packages/cli/src/commands/get.parity.test.ts
 *
 * The script (also `bun run pins:update`, no arguments for every parity file)
 * runs the tests with `MIMIR_UPDATE_PINS=1` and `MIMIR_PINS_STAGE` set to a
 * directory only that run owns, where recording writes each file's pins. It
 * replaces the pin files with that run's recordings only if the whole run
 * passed (every test and cleanup hook), and always removes the directory, so a
 * failed run leaves nothing behind. Recording without the directory refuses.
 * Re-recording needs the whole file to run, and rewrites it in case order. The pins hold what the retired old CLI was proven to print,
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

/**
 * The directory the update script owns for one run; recording writes only
 * there. A recording with no run directory would leave files beside the pins
 * for any later run to find, so it refuses.
 */
export const STAGE_ENV = 'MIMIR_PINS_STAGE';
const STAGE = process.env[STAGE_ENV];
if (UPDATING && (STAGE === undefined || STAGE === '')) {
  throw new Error(
    `MIMIR_UPDATE_PINS=1 records only for a run that owns a staging directory (${STAGE_ENV}); use bun run pins:update`,
  );
}

const HEADER = '### ';

/** What one case printed, ready to pin. */
export type PinnedRun = {
  exitCode: number;
  stdout: string;
  failure?: { code: string; message: string; hints: readonly string[] };
};

/**
 * Text with its control characters made visible, reversibly: ESC reads `␛`,
 * every other control character reads `⟦hex⟧`, and the two characters this
 * spelling uses, `␛` and `⟦`, read `⟦hex⟧` themselves. So no two texts render
 * alike, and real ANSI bytes never match the printable `␛`.
 */
function visible(text: string): string {
  return Array.from(text, (char) => {
    const code = char.codePointAt(0) ?? 0;
    if (code === 27) {
      return '␛';
    }
    const control = code <= 31 && code !== 9 && code !== 10;
    return control || code === 127 || char === '␛' || char === '⟦'
      ? `⟦${code.toString(16)}⟧`
      : char;
  }).join('');
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** How an array element is named in a path: its `id` or `key`, a `[name, value]` pair's name, else its place. */
function labelOf(element: unknown, at: number): { label: string; value: unknown } {
  if (isRecord(element)) {
    for (const field of ['id', 'key']) {
      const name = element[field];
      if (typeof name === 'string') {
        return { label: name, value: element };
      }
    }
  }
  if (Array.isArray(element) && element.length === 2 && typeof element[0] === 'string') {
    return { label: escaped(element[0]), value: element[1] };
  }
  return { label: `@${String(at)}`, value: element };
}

/** A name with the characters this notation uses (`\`, `#`, `@`) escaped, so no name can pass for a mark. */
const escaped = (name: string): string => name.replaceAll(/[\\#@]/g, (c) => `\\${c}`);

/**
 * An array's elements by label, in order. A name read twice carries its
 * occurrence after a `#` (`x`, `x#2`); a literal `#` in a name is escaped, so
 * no name collides with an occurrence mark, and a place is `@n`, which no name
 * can spell either.
 */
function labelled(items: readonly unknown[]): { order: string[]; byLabel: Map<string, unknown> } {
  const byLabel = new Map<string, unknown>();
  const seen = new Map<string, number>();
  const order: string[] = [];
  items.forEach((item, at) => {
    const { label, value } = labelOf(item, at);
    const occurrence = (seen.get(label) ?? 0) + 1;
    seen.set(label, occurrence);
    const key = occurrence === 1 ? label : `${label}#${String(occurrence)}`;
    byLabel.set(key, value);
    order.push(key);
  });
  return { byLabel, order };
}

/** The labels of `order` that `other` also holds, in order. */
const kept = (order: readonly string[], other: ReadonlyMap<string, unknown>): string[] =>
  order.filter((label) => other.has(label));

/** `value` on one line, its control characters visible. */
const shown = (value: unknown): string => visible(JSON.stringify(value) ?? 'undefined');

/** Walk two parsed states in step, writing one line per change under `path`. */
function walk(path: string, before: unknown, after: unknown, out: string[]): void {
  if (JSON.stringify(before) === JSON.stringify(after)) {
    return;
  }
  if (isRecord(before) && isRecord(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const here = path === '' ? key : `${path}.${key}`;
      if (!(key in after)) {
        out.push(`- ${here}: ${shown(before[key])}`);
      } else if (!(key in before)) {
        out.push(`+ ${here}: ${shown(after[key])}`);
      } else {
        walk(here, before[key], after[key], out);
      }
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const was = labelled(before);
    const now = labelled(after);
    for (const label of new Set([...was.order, ...now.order])) {
      const here = `${path}[${label}]`;
      if (!now.byLabel.has(label)) {
        out.push(`- ${here}: ${shown(was.byLabel.get(label))}`);
      } else if (!was.byLabel.has(label)) {
        out.push(`+ ${here}: ${shown(now.byLabel.get(label))}`);
      } else {
        walk(here, was.byLabel.get(label), now.byLabel.get(label), out);
      }
    }
    // Position is part of a list's state: the records both sides hold must keep their order.
    const orderWas = kept(was.order, now.byLabel);
    const orderNow = kept(now.order, was.byLabel);
    if (orderWas.join('\u0000') !== orderNow.join('\u0000')) {
      out.push(`~ ${path} order: [${orderWas.join(', ')}] -> [${orderNow.join(', ')}]`);
    }
    return;
  }
  out.push(`~ ${path}: ${shown(before)} -> ${shown(after)}`);
}

/**
 * What changed between two board states (JSON, as `boardSnapshot` writes them),
 * one line per change keyed by the record it touched and the field path: `~`
 * for a changed value with old and new, `+` for a created record or field
 * whole, `-` for a removed one. Empty when the states are equal.
 */
export function changedRecords(before: string, after: string): string {
  const out: string[] = [];
  walk('', JSON.parse(before), JSON.parse(after), out);
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}

/** The pins of one test file. */
export class Pins {
  readonly path: string;
  readonly #stored = new Map<string, string>();
  readonly #recorded = new Map<string, string>();
  readonly names = new Set<string>();

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
    expect(this.#stored.has(name), `no pin for "${name}"; re-record with bun run pins:update`).toBe(
      true,
    );
    expect(text).toBe(this.#stored.get(name)!);
  }

  /**
   * Stage the recorded pins, in case order, when this run covered the whole
   * file. A test run cannot know its own outcome from inside, so the pins go to
   * the run's staging directory, named by the encoded path of the pin file;
   * `scripts/update-pins.ts` promotes them only when the whole run passed.
   */
  save(): void {
    if (!UPDATING) {
      return;
    }
    const missing = [...this.names].filter((name) => !this.#recorded.has(name));
    if (missing.length > 0) {
      throw new Error(`pins not staged: no run for ${missing.join(', ')}`);
    }
    const body = [...this.names]
      .map((name) => `${HEADER}${name}\n${this.#recorded.get(name)!}\n`)
      .join('');
    mkdirSync(STAGE!, { recursive: true });
    writeFileSync(join(STAGE!, encodeURIComponent(this.path)), body);
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
