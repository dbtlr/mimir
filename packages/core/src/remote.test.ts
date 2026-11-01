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
