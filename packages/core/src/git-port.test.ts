import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BINDING_CONFIG_KEY } from './binding';
import { gitPortAt } from './git-port';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mimir-git-')));
});
afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    stdio: 'ignore',
  });
};

test('reads and writes the clone config and reports the origin', async () => {
  git(root, 'init', '-q');
  const port = gitPortAt(root);
  expect(await port.originUrl()).toBeUndefined();
  expect(await port.readConfig(BINDING_CONFIG_KEY)).toBeUndefined();
  git(root, 'remote', 'add', 'origin', 'git@github.com:o/r.git');
  expect(await port.originUrl()).toBe('git@github.com:o/r.git');
  expect(await port.writeConfig(BINDING_CONFIG_KEY, 'AAA')).toBe(true);
  expect(await port.readConfig(BINDING_CONFIG_KEY)).toBe('AAA');
});

test('a linked worktree resolves the binding written from the main clone, and the reverse', async () => {
  const main = join(root, 'main');
  const linked = join(root, 'linked');
  execFileSync('git', ['init', '-q', main]);
  git(main, 'commit', '--allow-empty', '-q', '-m', 'init');
  git(main, 'worktree', 'add', '-q', linked);
  expect(await gitPortAt(main).writeConfig(BINDING_CONFIG_KEY, 'AAA')).toBe(true);
  expect(await gitPortAt(linked).readConfig(BINDING_CONFIG_KEY)).toBe('AAA');
  expect(await gitPortAt(linked).writeConfig(BINDING_CONFIG_KEY, 'BBB')).toBe(true);
  expect(await gitPortAt(main).readConfig(BINDING_CONFIG_KEY)).toBe('BBB');
});

test('outside a git clone every call is a quiet miss', async () => {
  const port = gitPortAt(root);
  expect(await port.originUrl()).toBeUndefined();
  expect(await port.writeConfig(BINDING_CONFIG_KEY, 'AAA')).toBe(false);
});

test('readConfig ignores a global mimir.project: the binding is per clone', async () => {
  git(root, 'init', '-q');
  const globalConfig = join(root, 'global-gitconfig');
  execFileSync('git', ['config', '--file', globalConfig, BINDING_CONFIG_KEY, 'GLOBAL']);
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  try {
    expect(await gitPortAt(root).readConfig(BINDING_CONFIG_KEY)).toBeUndefined();
  } finally {
    if (previous === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL;
    } else {
      process.env.GIT_CONFIG_GLOBAL = previous;
    }
  }
});
