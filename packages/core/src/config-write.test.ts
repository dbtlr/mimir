import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readConfig } from './config';
import { configDeclaresStore, planHostUrl, setHostUrl } from './config-write';
import { MimirError } from './errors';

/**
 * Pairing records the host it paired with in `config.toml` (ADR 0038). The
 * edit is in place: comments, other keys, and other sections survive byte for
 * byte, and the candidate is re-parsed before anything is written.
 */
let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mimir-config-write-'));
  file = join(dir, 'config.toml');
});
afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

const ORIGIN = 'https://mimir.example.test';

function refusalOf(attempt: () => unknown): MimirError {
  try {
    attempt();
  } catch (error) {
    expect(error).toBeInstanceOf(MimirError);
    return error as MimirError;
  }
  throw new Error('expected a refusal');
}

const modeOf = (path: string) => statSync(path).mode & 0o777;

test('an absent file is created with only the [host] table, at 0600', () => {
  const previous = process.umask(0o000);
  try {
    setHostUrl(ORIGIN, file);
  } finally {
    process.umask(previous);
  }
  expect(readFileSync(file, 'utf8')).toBe(`[host]\nurl = "${ORIGIN}"\n`);
  expect(modeOf(file)).toBe(0o600);
  expect(readConfig(file).host).toEqual({ url: ORIGIN });
});

test('a missing parent directory is created', () => {
  const nested = join(dir, 'a', 'b', 'config.toml');
  setHostUrl(ORIGIN, nested);
  expect(readFileSync(nested, 'utf8')).toBe(`[host]\nurl = "${ORIGIN}"\n`);
});

type Case = { name: string; before: string; after: string };

const edits: Case[] = [
  {
    after: `# my mimir\n\n[logging]\nlevel = "debug" # loud\n\n[host]\nurl = "${ORIGIN}"\n`,
    before: '# my mimir\n\n[logging]\nlevel = "debug" # loud\n',
    name: 'no [host] table appends one after a blank line',
  },
  {
    after: `[logging]\nlevel = "debug"\n\n[host]\nurl = "${ORIGIN}"\n`,
    before: '[logging]\nlevel = "debug"',
    name: 'content without a final newline gets one, then a blank line',
  },
  {
    after: `[logging]\nlevel = "debug"\n\n[host]\nurl = "${ORIGIN}"\n`,
    before: '[logging]\nlevel = "debug"\n\n',
    name: 'content that already ends in a blank line gets no second one',
  },
  {
    after: `[host]\nurl = "${ORIGIN}"\n`,
    before: '',
    name: 'an empty file becomes just the table',
  },
  {
    after: `# keep me\n[host]\n# the host\nurl = "${ORIGIN}"\nlabel = "home"\n\n[logging]\nlevel = "debug"\n`,
    before:
      '# keep me\n[host]\n# the host\nurl = "http://old.test:1234"\nlabel = "home"\n\n[logging]\nlevel = "debug"\n',
    name: 'the url line inside [host] is replaced, comments and keys kept',
  },
  {
    after: `[logging]\nurl = "elsewhere"\n\n[host]\nurl = "${ORIGIN}"\n`,
    before: '[logging]\nurl = "elsewhere"\n\n[host]\nurl = "http://old.test"\n',
    name: 'a url key in another section is left alone',
  },
  {
    after: `[host] # the board\nurl = "${ORIGIN}"\nlabel = "home"\n`,
    before: '[host] # the board\nlabel = "home"\n',
    name: 'a url is inserted right after the header when the table has none',
  },
  {
    after: `[host]\nurl = "${ORIGIN}"\n[logging]\nlevel = "debug"\n`,
    before: '[host]\n[logging]\nlevel = "debug"\n',
    name: 'an empty [host] table gets its url before the next section',
  },
  {
    after: `[host]\r\nurl = "${ORIGIN}"\r\nlabel = "home"\r\n`,
    before: '[host]\r\nurl = "http://old.test"\r\nlabel = "home"\r\n',
    name: 'CRLF files keep CRLF when replacing',
  },
  {
    after: `[logging]\r\nlevel = "debug"\r\n\r\n[host]\r\nurl = "${ORIGIN}"\r\n`,
    before: '[logging]\r\nlevel = "debug"\r\n',
    name: 'CRLF files keep CRLF when appending',
  },
  {
    after: `[host]\nurl = "${ORIGIN}"\n[host.extra]\nkey = 1\n`,
    before: '[host]\n[host.extra]\nkey = 1\n',
    name: 'a [host.sub] table beside [host] is untouched',
  },
];

test.each(edits)('$name', ({ before, after }) => {
  writeFileSync(file, before);
  setHostUrl(ORIGIN, file);
  expect(readFileSync(file, 'utf8')).toBe(after);
  expect(readConfig(file).host?.url).toBe(ORIGIN);
});

test('setting the same origin twice changes nothing the second time', () => {
  writeFileSync(file, '# top\n[logging]\nlevel = "debug"\n');
  setHostUrl(ORIGIN, file);
  const once = readFileSync(file, 'utf8');
  setHostUrl(ORIGIN, file);
  expect(readFileSync(file, 'utf8')).toBe(once);
});

test('an existing file keeps its mode, and no temporary file is left behind', () => {
  writeFileSync(file, '[logging]\nlevel = "debug"\n');
  chmodSync(file, 0o640);
  setHostUrl(ORIGIN, file);
  expect(modeOf(file)).toBe(0o640);
  expect(readdirSync(dir)).toEqual(['config.toml']);
});

test('a symlinked config is edited through the link, which stays a link', () => {
  const real = join(dir, 'real.toml');
  writeFileSync(real, '[logging]\nlevel = "debug"\n');
  symlinkSync(real, file);
  setHostUrl(ORIGIN, file);
  expect(readFileSync(real, 'utf8')).toContain(`url = "${ORIGIN}"`);
  expect(readFileSync(real, 'utf8')).toContain('level = "debug"');
});

const refusals: Case[] = [
  { after: '', before: 'host = { url = "http://old.test" }\n', name: 'an inline table' },
  { after: '', before: 'host.url = "http://old.test"\n', name: 'a dotted key' },
  { after: '', before: '[host.sub]\nkey = 1\n', name: 'only a [host.sub] subtable' },
  { after: '', before: 'host = "http://old.test"\n', name: 'a plain string' },
  { after: '', before: '[host\nurl = "x"\n', name: 'malformed TOML' },
];

test.each(refusals)('$name is refused with a remedy and nothing is written', ({ before }) => {
  writeFileSync(file, before);
  const error = refusalOf(() => setHostUrl(ORIGIN, file));
  expect(error.hint).toBeTruthy();
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(readdirSync(dir)).toEqual(['config.toml']);
});

test('the refusal for another host form tells the user to write a [host] table', () => {
  writeFileSync(file, 'host = { url = "http://old.test" }\n');
  const error = refusalOf(() => setHostUrl(ORIGIN, file));
  expect(error.hint).toContain('[host]');
  expect(error.hint).toContain('url = "');
});

test('a string that looks like a header cannot fool the edit: the re-parse guard refuses', () => {
  const before = 'note = """\n[host]\nurl = "x"\n"""\n';
  writeFileSync(file, before);
  refusalOf(() => setHostUrl(ORIGIN, file));
  expect(readFileSync(file, 'utf8')).toBe(before);
});

test('an origin that is not an origin is refused before touching the file', () => {
  for (const bad of ['https://mimir.example.test/path', 'ftp://mimir.example.test', 'nope']) {
    refusalOf(() => setHostUrl(bad, file));
  }
  expect(existsSync(file)).toBe(false);
});

test('configDeclaresStore reads the raw file, not the defaulted config', () => {
  expect(configDeclaresStore(file)).toBe(false);
  writeFileSync(file, '[host]\nurl = "https://mimir.example.test"\n');
  expect(configDeclaresStore(file)).toBe(false);
  writeFileSync(file, '[store]\nbackend = "postgres"\nurl = "postgres://x/y"\n');
  expect(configDeclaresStore(file)).toBe(true);
  writeFileSync(file, '[store]\n');
  expect(configDeclaresStore(file)).toBe(true);
  writeFileSync(file, 'store = { backend = "sqlite" }\n');
  expect(configDeclaresStore(file)).toBe(true);
});

test("a [store] table is kept as is; refusing the pair is the caller's job", () => {
  writeFileSync(file, '[store]\nbackend = "sqlite"\n');
  setHostUrl(ORIGIN, file);
  expect(readFileSync(file, 'utf8')).toBe(
    `[store]\nbackend = "sqlite"\n\n[host]\nurl = "${ORIGIN}"\n`,
  );
  expect(configDeclaresStore(file)).toBe(true);
});

test.each(refusals)('planning refuses $name with a remedy and touches nothing', ({ before }) => {
  writeFileSync(file, before);
  const error = refusalOf(() => planHostUrl(ORIGIN, file));
  expect(error.hint).toBeTruthy();
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(readdirSync(dir)).toEqual(['config.toml']);
});

test('planning an absent file or a valid one writes nothing, and setHostUrl applies the plan', () => {
  planHostUrl(ORIGIN, file);
  expect(existsSync(file)).toBe(false);
  const before = '# mine\n[host]\nurl = "http://old.test"\n';
  writeFileSync(file, before);
  planHostUrl(ORIGIN, file);
  expect(readFileSync(file, 'utf8')).toBe(before);
  setHostUrl(ORIGIN, file);
  expect(readFileSync(file, 'utf8')).toBe(`# mine\n[host]\nurl = "${ORIGIN}"\n`);
});
