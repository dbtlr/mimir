import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalJson } from '@mimir/core';

import { MACHINE_REDIRECTS, PARITY_DIFFERENCES } from '../parity/differences';
import { argvLine } from '../testing/argv-case';
import { parityBoard } from '../testing/fixture';
import type { ParityBoard } from '../testing/fixture';
import { parityProblems, registerParity, runNew, runOld } from '../testing/parity';
import type { ParityCase } from '../testing/parity';

let board: ParityBoard;
let document = '';
/** Where the cases write and read files. Both CLIs get the same paths; a case's file is removed between runs. */
const DIR = mkdtempSync(join(tmpdir(), 'mimir-store-parity-'));
const doc = join(DIR, 'doc.json');
const notJson = join(DIR, 'not-json.txt');
const notDocument = join(DIR, 'not-document.json');
const newerSchema = join(DIR, 'newer.json');
const taken = join(DIR, 'taken.json');
const folder = join(DIR, 'folder');

beforeAll(async () => {
  board = await parityBoard();
  document = `${canonicalJson(await board.store.export())}\n`;
  writeFileSync(doc, document);
  writeFileSync(notJson, 'not json');
  writeFileSync(notDocument, '{"nodes":[]}');
  writeFileSync(newerSchema, '{"schema_version":99}');
  writeFileSync(taken, 'a backup that must survive');
  mkdirSync(folder);
});
afterAll(async () => {
  await board.close();
  rmSync(DIR, { force: true, recursive: true });
});

type StoreCase = ParityCase & { stdin?: string; output?: string };

const store = (
  name: string,
  path: string[],
  options: ParityCase['options'] = {},
  extra: Partial<StoreCase> = {},
): StoreCase => ({ name, options, path: ['store', ...path], ...extra });

const upgrade = (name: string, options: ParityCase['options'] = {}) =>
  store(name, ['upgrade'], options);
const exported = (name: string, file: string, options: ParityCase['options'] = {}) =>
  store(name, ['export'], options, { args: { file }, output: file });
const imported = (
  name: string,
  file: string,
  options: ParityCase['options'] = {},
  stdin?: string,
) =>
  store(name, ['import'], options, { args: { file }, ...(stdin === undefined ? {} : { stdin }) });

/** A case both CLIs run as this literal argv, the new one through Loom's parser. */
const argv = (line: string, extra: Partial<StoreCase> = {}): StoreCase => ({
  // Named from the template, so the case name does not carry the temp directory.
  ...argvLine(line, extra.tty ? { tty: extra.tty } : {}),
  argv: line.split(' ').map((word) => word.replace('<dir>', DIR)),
  ...extra,
});

const out = (name: string) => join(DIR, name);

const CASES: StoreCase[] = [
  // upgrade: a fresh in-memory SQLite store applies every migration.
  upgrade('store upgrade'),
  upgrade('store upgrade -f records', { format: 'records' }),
  upgrade('store upgrade -f table', { format: 'table' }),
  upgrade('store upgrade -f ids', { format: 'ids' }),
  upgrade('store upgrade -f json', { format: 'json' }),
  upgrade('store upgrade -f jsonl', { format: 'jsonl' }),
  // export to the standard stream: the document is the output, in any format.
  exported('store export -', '-'),
  exported('store export - -f records', '-', { format: 'records' }),
  exported('store export - -f json', '-', { format: 'json' }),
  exported('store export - -f jsonl', '-', { format: 'jsonl' }),
  exported('store export - -f ids', '-', { format: 'ids' }),
  // export to a file reports a summary of what it wrote.
  exported('store export <file>', out('a.json')),
  exported('store export <file> -f records', out('b.json'), { format: 'records' }),
  exported('store export <file> -f table', out('c.json'), { format: 'table' }),
  exported('store export <file> -f ids', out('d.json'), { format: 'ids' }),
  exported('store export <file> -f json', out('e.json'), { format: 'json' }),
  exported('store export <file> -f jsonl', out('f.json'), { format: 'jsonl' }),
  // export refuses to overwrite a backup.
  exported('store export <taken>', taken),
  exported('store export <taken> -f json', taken, { format: 'json' }),
  // import is a preview unless told to apply.
  imported('store import <doc>', doc),
  imported('store import <doc> -f records', doc, { format: 'records' }),
  imported('store import <doc> -f table', doc, { format: 'table' }),
  imported('store import <doc> -f ids', doc, { format: 'ids' }),
  imported('store import <doc> -f json', doc, { format: 'json' }),
  imported('store import <doc> -f jsonl', doc, { format: 'jsonl' }),
  imported('store import <doc> --resume', doc, { resume: true }),
  imported('store import <doc> --resume -f json', doc, { format: 'json', resume: true }),
  // Re-running the same document in resume mode skips what is identical.
  imported('store import <doc> --apply --resume', doc, { apply: true, resume: true }),
  imported('store import <doc> --apply --resume -f json', doc, {
    apply: true,
    format: 'json',
    resume: true,
  }),
  // A fresh import of a store onto itself is refused by the backend.
  imported('store import <doc> --apply', doc, { apply: true }),
  imported('store import <doc> --apply -f json', doc, { apply: true, format: 'json' }),
  // The standard input.
  imported('store import - (stdin)', '-', {}, 'DOCUMENT'),
  imported(
    'store import - --resume -f json (stdin)',
    '-',
    { format: 'json', resume: true },
    'DOCUMENT',
  ),
  imported('store import - (not json)', '-', {}, 'nope'),
  // Refusals Mimir raises.
  imported('store import <missing>', out('missing.json')),
  imported('store import <folder>', folder),
  imported('store import <not json>', notJson),
  imported('store import <not a document>', notDocument),
  imported('store import <newer schema>', newerSchema),
  imported('store import <newer schema> -f json', newerSchema, { format: 'json' }),
  // Faults Loom's parser raises.
  store('store export (no file)', ['export']),
  store('store import (no file)', ['import']),
  store('store upgrade -f yaml', ['upgrade'], { format: 'yaml' }),
  store('store upgrade --bogus', ['upgrade'], { bogus: true }),
  store('store upgrade --apply', ['upgrade'], { apply: true }),
  { ...exported('store export <file> --apply', out('g.json'), { apply: true }) },
  { ...exported('store export <file> --resume', out('h.json'), { resume: true }) },
  // The group alone, and a verb it does not have.
  store('store', []),
  store('store frobnicate', ['frobnicate']),
  // Through Loom's parser, as a shell spells them.
  argv('store upgrade -f json'),
  argv('store export - --format json'),
  argv('store import <dir>/doc.json'),
  argv('store import <dir>/doc.json --apply --resume -f json'),
  // Invocations the old CLI accepted and Loom's parser refuses.
  argv('store upgrade extra'),
  argv('store export - extra'),
  argv('store import <dir>/doc.json extra'),
  argv('store upgrade -f json -f ids'),
  // The piped default is json and the terminal default is prose.
  argv('store upgrade', { tty: true }),
  argv('store import <dir>/doc.json', { tty: true }),
  argv('store import <dir>/doc.json -f json'),
  // Misplaced flags, redirected as the old CLI redirected them.
  ...MACHINE_REDIRECTS.filter((line) => line.startsWith('store ')).map((line) => argvLine(line)),
];

// One board is shared, unlike the twin harness's board per CLI: the cases name files on a
// shared disk, whose paths both CLIs print and must agree on, and import, which refuses or
// skips what the store already holds, writes nothing to the board.
registerParity(/^store /, CASES, async (c) => {
  board.stdin.text = c.stdin === 'DOCUMENT' ? document : (c.stdin ?? '');
  const old = await runOld(board.store, c, board.oldDefaults(c.bound));
  // Each CLI writes its own file: the old one's is taken away before the new one runs.
  const file =
    c.output !== undefined && c.output !== '-' && c.output !== taken ? c.output : undefined;
  const oldText = file !== undefined && existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  if (file !== undefined) {
    rmSync(file, { force: true });
  }
  const now = await runNew((words) => board.app(c.bound, words), c);
  if (file !== undefined && oldText !== undefined) {
    // The file the new CLI wrote is the file the old one did.
    expect(readFileSync(file, 'utf8')).toBe(oldText);
  }
  return parityProblems(board.app(), c, old, now, PARITY_DIFFERENCES);
});

test('a refused export leaves the existing backup untouched', () => {
  expect(readFileSync(taken, 'utf8')).toBe('a backup that must survive');
});
