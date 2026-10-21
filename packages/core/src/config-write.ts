/**
 * The one writer of `config.toml` (ADR 0038): pairing records the host it
 * paired with as `[host] url`. The file is operator-edited, so the edit is
 * textual and in place: comments, other keys, and other sections stay byte
 * for byte. A candidate is re-parsed before it is written, and any form this
 * edit cannot change safely is refused rather than rewritten.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { writeFileAtomic } from './atomic-write';
import { configPath, urlOrigin } from './config';
import { invariant } from './errors';
import type { MimirError } from './errors';

type Table = Record<string, unknown>;

const isTable = (value: unknown): value is Table =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `[host]` on a line of its own, an end-of-line comment allowed. */
const HOST_HEADER = /^[ \t]*\[[ \t]*host[ \t]*\][ \t]*(#.*)?\r?\n?$/;
/** A key never starts with `[`, so any such line opens the next table. */
const TABLE_START = /^[ \t]*\[/;
const URL_KEY = /^[ \t]*(url|"url"|'url')[ \t]*=/;
const LINE_END = /\r?\n$/;
/** After a quoted value: the spacing and `# comment` that trail it, then the line end. */
const TRAILING_COMMENT = /=[ \t]*(?:"(?:[^"\\\n]|\\.)*"|'[^'\n]*')([ \t]*#[^\n]*?)(?=\r?\n?$)/;
const BOM = '\uFEFF';

function parseConfig(text: string): Table | undefined {
  try {
    const parsed: unknown = Bun.TOML.parse(text);
    return isTable(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A validated edit of the config file, ready to write. */
export type HostUrlPlan = {
  /** The file the edit lands in, with a symlink resolved. */
  target: string;
  /** The whole file after the edit. */
  text: string;
};

/**
 * Work out the edit that sets `[host] url` to `origin`, without writing
 * anything. Refuses a file that is not valid TOML, one that defines `host`
 * other than as a `[host]` table, and any edit whose re-parse does not hold
 * `origin` with everything else unchanged, so a caller can learn before it
 * starts a long step that the edit could not be made.
 */
export function planHostUrl(origin: string, file: string = configPath()): HostUrlPlan {
  if (urlOrigin(origin) !== origin) {
    throw invariant(`${origin} is not a host origin`, 'give an http or https URL with no path');
  }
  // Edit through a symlinked config rather than replacing the link.
  const target = existsSync(file) ? realpathSync(file) : file;
  const raw = existsSync(target) ? readFileSync(target, 'utf8') : '';
  // A byte order mark is not TOML; the edit works on the text after it and puts it back.
  const bom = raw.startsWith(BOM) ? BOM : '';
  const current = raw.slice(bom.length);
  const before = parseConfig(current);
  if (before === undefined) {
    throw invariant(`${target} is not valid TOML`, `fix its syntax, then run the command again`);
  }
  const candidate = withHostUrl(current, before, origin, target);
  const expected = {
    ...before,
    host: { ...(isTable(before.host) ? before.host : {}), url: origin },
  };
  if (!isDeepStrictEqual(parseConfig(candidate), expected)) {
    throw unchangeable(target, origin);
  }
  return { target, text: `${bom}${candidate}` };
}

/**
 * Set `[host] url` to `origin` in the config file, creating the file (0600)
 * and its directory when absent. An existing file keeps its mode. The edit is
 * planned (and so refused) before anything is written; see {@link planHostUrl}.
 */
export function setHostUrl(origin: string, file: string = configPath()): void {
  writeHostUrlPlan(planHostUrl(origin, file));
}

/**
 * Write a plan from {@link planHostUrl}. A caller with other files to write
 * plans first, writes those, and writes the plan last, so a refusal never
 * follows a write.
 */
export function writeHostUrlPlan({ target, text }: HostUrlPlan): void {
  mkdirSync(dirname(target), { mode: 0o700, recursive: true });
  const mode = existsSync(target) ? statSync(target).mode & 0o7777 : 0o600;
  writeFileAtomic(target, text, mode);
}

function unchangeable(file: string, origin: string): MimirError {
  return invariant(
    `${file} defines host in a form that cannot be edited in place`,
    `rewrite it as a [host] table with url = "${origin}", then run the command again`,
  );
}

/** The config text with `[host] url` set; the caller verifies the result by re-parsing it. */
function withHostUrl(text: string, parsed: Table, origin: string, file: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const urlLine = `url = "${origin}"`;
  const lines = text.split(/(?<=\n)/);
  const header = lines.findIndex((line) => HOST_HEADER.test(line));
  if (header === -1) {
    if (parsed.host !== undefined) {
      throw unchangeable(file, origin);
    }
    return `${text}${separator(text, eol)}[host]${eol}${urlLine}${eol}`;
  }
  const next = lines.findIndex((line, index) => index > header && TABLE_START.test(line));
  const end = next === -1 ? lines.length : next;
  const existing = lines.findIndex(
    (line, index) => index > header && index < end && URL_KEY.test(line),
  );
  if (existing !== -1) {
    const line = lines[existing] ?? '';
    const terminator = LINE_END.exec(line)?.[0] ?? '';
    const comment = TRAILING_COMMENT.exec(line)?.[1] ?? '';
    lines[existing] = `${urlLine}${comment}${terminator}`;
  } else {
    const opener = lines[header] ?? '';
    lines[header] = LINE_END.test(opener) ? opener : `${opener}${eol}`;
    lines.splice(header + 1, 0, `${urlLine}${eol}`);
  }
  return lines.join('');
}

/** What goes between existing content and an appended table: one blank line. */
function separator(text: string, eol: string): string {
  if (text === '') {
    return '';
  }
  if (/(\r?\n){2}$/.test(text)) {
    return '';
  }
  return LINE_END.test(text) ? eol : `${eol}${eol}`;
}

/**
 * Whether the raw config file declares `[store]`. readConfig always fills a
 * default store, so only the file itself can say; an absent or unparseable
 * file declares none.
 */
export function configDeclaresStore(file: string = configPath()): boolean {
  return (
    existsSync(file) &&
    parseConfig(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))?.store !== undefined
  );
}
