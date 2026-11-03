import { expect, test } from 'bun:test';

import { normalizeRemote, normalizeStoredRemote, tryNormalizeRemote } from './remote';

test.each([
  ['git@github.com:dbtlr/mimir.git', 'github.com/dbtlr/mimir'],
  ['https://github.com/dbtlr/mimir.git', 'github.com/dbtlr/mimir'],
  ['https://github.com/dbtlr/mimir', 'github.com/dbtlr/mimir'],
  ['https://github.com/dbtlr/mimir/', 'github.com/dbtlr/mimir'],
  ['ssh://git@github.com/dbtlr/mimir.git', 'github.com/dbtlr/mimir'],
  ['ssh://git@github.com:2222/dbtlr/mimir.git', 'github.com/dbtlr/mimir'],
  ['https://user:token@GitHub.COM/dbtlr/mimir.git', 'github.com/dbtlr/mimir'],
  ['git://github.com/dbtlr/mimir.git', 'github.com/dbtlr/mimir'],
  ['  git@GitLab.example.org:group/sub/repo.git\n', 'gitlab.example.org/group/sub/repo'],
])('%j normalizes to %s', (raw, expected) => {
  expect(normalizeRemote(raw)).toBe(expected);
});

test('the path keeps its case, since hosting paths can be case-sensitive', () => {
  expect(normalizeRemote('git@github.com:Org/Repo.git')).toBe('github.com/Org/Repo');
});

test('ssh and https forms of one repository compare equal', () => {
  expect(normalizeRemote('git@github.com:dbtlr/mimir.git')).toBe(
    normalizeRemote('HTTPS://GITHUB.COM/dbtlr/mimir'),
  );
});

test.each([
  ['git@github.com:o/r/.git', 'github.com/o/r'],
  ['https://github.com/o/r.GIT', 'github.com/o/r'],
  ['https://github.com/o/r.git/', 'github.com/o/r'],
])('%j normalizes to %s (suffixes strip until stable)', (raw, expected) => {
  expect(normalizeRemote(raw)).toBe(expected);
});

test.each([
  'foo:bar',
  String.raw`C:\Users\me\repo`,
  '/srv/git/r.git',
  '../r',
  'file:///srv/git/r.git',
  'https://github.com/o/r?x=1',
  'https://github.com/o/r#frag',
])('%j is refused as not a network remote', (raw) => {
  expect(() => normalizeRemote(raw)).toThrow(/git remote/i);
  expect(tryNormalizeRemote(raw)).toBeUndefined();
});

test('tryNormalizeRemote returns the normalized form for a remote', () => {
  expect(tryNormalizeRemote('git@github.com:o/r.git')).toBe('github.com/o/r');
});

test.each(['', '   ', 'not a url', 'https://github.com', 'github.com', 'git@github.com:'])(
  '%j is refused as not a Git remote',
  (raw) => {
    expect(() => normalizeRemote(raw)).toThrow(/git remote/i);
  },
);

// An export carries remotes as they were stored, so reading one back must keep
// what `normalizeRemote` wrote — or a store refuses its own export (MMR-609).
test.each([
  'git@github.com:dbtlr/mimir.git',
  '  git@GitLab.example.org:group/sub/repo.git\n',
  'https://github.com/org/my repo',
  'git@github.com:org/a\tb.git',
])('the stored form of %j reads back unchanged', (raw) => {
  const stored = normalizeRemote(raw);
  expect(normalizeStoredRemote(stored)).toBe(stored);
});

test('a remote read back in written form is normalized as a written one', () => {
  expect(normalizeStoredRemote('  git@github.com:dbtlr/mimir.git ')).toBe('github.com/dbtlr/mimir');
  expect(() => normalizeStoredRemote('not a remote')).toThrow(/git remote/i);
});

test.each(['github.com/org/a\nb', 'github.com/org/a\rb', 'github.com/org/a\u2028b'])(
  'a stored remote %j with a line break is refused, as no write produces one',
  (raw) => {
    expect(() => normalizeStoredRemote(raw)).toThrow(/git remote/i);
  },
);

// The user part ends at the last `@`, as OpenSSH reads it, so the host never holds one.
test.each([
  ['ssh://john.doe@example.com@gerrit.example.com:29418/project', 'gerrit.example.com/project'],
  ['john.doe@example.com@gerrit.example.com:project', 'gerrit.example.com/project'],
  ['https://a@b@c.com/x', 'c.com/x'],
  ['a@b@c.com:x', 'c.com/x'],
  ['ssh://git@host:2222/path', 'host/path'],
  ['git@github.com:org/repo.git', 'github.com/org/repo'],
  ['https://user:pw@github.com/org/repo', 'github.com/org/repo'],
  ['org@dev.azure.com:v3/org/proj/repo', 'dev.azure.com/v3/org/proj/repo'],
])('%j normalizes to %s (the user part ends at the last @)', (raw, expected) => {
  expect(normalizeRemote(raw)).toBe(expected);
});

// A host holding `? # \` is not one `normalizeStoredRemote` reads back, so it
// is refused on the way in (MMR-612).
test.each([
  'https://a?b.com/x',
  'https://a#b.com/x',
  String.raw`https://a\b.com/x`,
  'git@a?b.com:x',
  'git@a#b.com:x',
  // A `?`, `#`, or backslash ends a URL's authority, so none belongs in its userinfo.
  'https://a?b@c@d.com/x',
  'https://a?b@c.com/x',
  'https://a#b@c.com/x',
  String.raw`https://a\b@c.com/x`,
  // An empty host, once the user part takes every `@`.
  'git@@:o/r',
  'a@@:x',
  'https://u@@/o/r',
  'ssh://@@/1',
])('%j is refused for a host that cannot be stored', (raw) => {
  expect(() => normalizeRemote(raw)).toThrow(/git remote/i);
});

// Git reads the scp form's host as everything before the first `:`, so
// `u:p@host.com:o/r` names host `u`, not `host.com`; it is refused rather than
// given an identity Git would not use (MMR-612).
test.each(['u:p@host.com:o/r', 'user:pw@host:o/r'])(
  '%j is refused for a scp user part holding a colon',
  (raw) => {
    expect(() => normalizeRemote(raw)).toThrow(/git remote/i);
  },
);

// Git reads `[::1]` as one IPv6 host, but the scp form's host stops at the
// first `:` and the stored form holds no `:` in its host, so a bracketed host
// is refused in every form rather than given a garbled identity (MMR-613).
test.each([
  'git@[::1]:o/r',
  '[::1]:o/r',
  'git@[fe80::1]:o/r',
  'git@[host.com]:o/r',
  'https://[::1]/o/r',
  'https://[abc]/o/r',
  'ssh://git@[::1]:22/o/r',
  'ssh://git@[host.com]/o/r',
])('%j is refused for a bracketed host', (raw) => {
  expect(() => normalizeRemote(raw)).toThrow(/git remote/i);
});

test.each([
  ['https://github.com/org/repo /', 'github.com/org/repo'],
  ['https://github.com/x/y .git', 'github.com/x/y'],
  ['https://github.com/x/y / .git /', 'github.com/x/y'],
  ['https://github.com/org/repo\t/', 'github.com/org/repo'],
  ['https://github.com/org/repo\u00a0.git', 'github.com/org/repo'],
  ['https://github.com/org/repo\u3000/', 'github.com/org/repo'],
])('%j normalizes to %s with no trailing space', (raw, expected) => {
  expect(normalizeRemote(raw)).toBe(expected);
});

test('a path that is only whitespace and suffixes is refused', () => {
  expect(() => normalizeRemote('https://github.com/ /')).toThrow(/git remote/i);
});

// Whatever `normalizeRemote` accepts, its stored-form reader must keep (MMR-612).
const REMOTE_FORMS: ((host: string, path: string) => string)[] = [
  (host, path) => `https://${host}/${path}`,
  (host, path) => `ssh://git@${host}/${path}`,
  (host, path) => `ssh://git@${host}:2222/${path}`,
  (host, path) => `http://user:pw@${host}/${path}`,
  (host, path) => `http://user:pw@${host}:8080/${path}`,
  (host, path) => `git@${host}:${path}`,
  (host, path) => `${host}:${path}`,
];

test('every accepted remote reads back unchanged from its stored form', () => {
  const hosts = [
    'github.com',
    'GitHub.COM',
    'a@b.com',
    'a?b.com',
    'a#b.com',
    String.raw`a\b.com`,
    '[::1]',
    '[host.com]',
    '',
    '@',
  ];
  const paths = ['org/repo', 'a/b/c', 'org/my repo', 'org/a\tb', 'org/repo '];
  const suffixes = [
    '',
    '/',
    '.git',
    '.GIT',
    ' /',
    ' .git',
    '/.git/',
    '.git /',
    '\t/',
    '\u00a0.git',
    '\u3000/',
  ];
  let checked = 0;
  for (const form of REMOTE_FORMS) {
    for (const host of hosts) {
      for (const path of paths) {
        for (const suffix of suffixes) {
          const stored = tryNormalizeRemote(form(host, path + suffix));
          if (stored !== undefined) {
            checked += 1;
            expect(normalizeStoredRemote(stored)).toBe(stored);
          }
        }
      }
    }
  }
  expect(checked).toBeGreaterThan(100);
});
