import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bindingScope, createInitiative, createPhase, createTask, LocalEngine } from '@mimir/core';
import type { Store } from '@mimir/core';
import { createTestStore, nodeIdOf, projectIdOf } from '@mimir/core/testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { gitPortAt } from '../git-port';
import { buildMcpServer } from '../mcp/server';
import { runCli } from './run';
import { fakeIo } from './testing';
import type { CapturingIo } from './testing';

let store: Store;
let engine: LocalEngine;
let closeStore: (() => Promise<void>) | undefined;
let root: string;

beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
  engine = new LocalEngine(store);
  await engine.create({
    key: 'MMR',
    name: 'mmr',
    remote: 'git@github.com:dbtlr/mimir.git',
    type: 'project',
  });
  await engine.create({ key: 'XX', name: 'xx', type: 'project' });
  for (const key of ['MMR', 'XX'] as const) {
    const projectId = await projectIdOf(store, key);
    const init = await createInitiative(store, { projectId, title: 'i' });
    const initId = await nodeIdOf(store, `${key}-${String(init.seq)}`);
    const phase = await createPhase(store, { parentId: initId, title: 'ph' });
    const phaseId = await nodeIdOf(store, `${key}-${String(phase.seq)}`);
    await createTask(store, { parentId: phaseId, title: `${key} work` });
  }
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mimir-bind-')));
});
afterEach(async () => {
  await closeStore?.();
  closeStore = undefined;
  rmSync(root, { force: true, recursive: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

/** A fresh clone directory, optionally with an origin remote. */
function clone(name: string, origin?: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  git(dir, 'init', '-q');
  if (origin !== undefined) {
    git(dir, 'remote', 'add', 'origin', origin);
  }
  return dir;
}

/** Run the CLI as the composition root wires it, from `cwd`. */
async function mimir(cwd: string, ...argv: string[]): Promise<{ code: number; io: CapturingIo }> {
  const io = fakeIo();
  const port = gitPortAt(cwd);
  const code = await runCli(argv, () => store, io, {
    cwd,
    git: port,
    scope: bindingScope(async () => engine, port, io.error),
  });
  return { code, io };
}

const configured = (cwd: string): string => {
  try {
    return git(cwd, 'config', '--get', 'mimir.project');
  } catch {
    return '';
  }
};

test('a fresh clone with a matching origin auto-binds on its first command; later commands read git config only', async () => {
  const dir = clone('fresh', 'https://github.com/dbtlr/mimir.git');
  const first = await mimir(dir, 'next', '-f', 'ids');
  expect(first.code).toBe(0);
  expect(first.io.out.join('')).toBe('MMR-3');
  expect(configured(dir)).toBe('MMR');
  expect(first.io.err.join('\n')).toContain('MMR');
  expect(first.io.err.join('\n')).toContain('origin');

  // The origin can vanish: the binding now comes from git config alone, silently.
  git(dir, 'remote', 'remove', 'origin');
  const later = await mimir(dir, 'next', '-f', 'ids');
  expect(later.io.out.join('')).toBe('MMR-3');
  expect(later.io.err).toEqual([]);
});

test('a command that needs no default scope never auto-binds', async () => {
  const dir = clone('quiet', 'git@github.com:dbtlr/mimir.git');
  expect((await mimir(dir, 'get', 'MMR-3', '-f', 'ids')).code).toBe(0);
  expect((await mimir(dir, 'next', '-s', 'XX', '-f', 'ids')).io.out.join('')).toBe('XX-3');
  expect(configured(dir)).toBe('');
});

test('explicit -s wins over the binding and -s all escapes it', async () => {
  const dir = clone('scoped', 'git@github.com:dbtlr/mimir.git');
  git(dir, 'config', 'mimir.project', 'MMR');
  expect((await mimir(dir, 'next', '-s', 'XX', '-f', 'ids')).io.out.join('')).toBe('XX-3');
  const all = await mimir(dir, 'list', '-s', 'all', '-f', 'ids');
  expect(all.io.out.join('\n').split('\n').toSorted()).toEqual(['MMR-3', 'XX-3']);
});

test('a clone with no origin, or an origin nothing matches, is unbound and lists every project', async () => {
  for (const [name, origin] of [
    ['bare', undefined],
    ['stranger', 'git@github.com:nobody/else.git'],
  ] as const) {
    const dir = clone(name, origin);
    const listed = await mimir(dir, 'list', '-f', 'ids');
    expect(listed.io.out.join('\n').split('\n').toSorted()).toEqual(['MMR-3', 'XX-3']);
    expect(configured(dir)).toBe('');
  }
});

test('a linked worktree resolves the key its clone bound', async () => {
  const main = clone('main', 'https://github.com/dbtlr/mimir');
  git(main, 'commit', '--allow-empty', '-q', '-m', 'init');
  const linked = join(root, 'linked');
  git(main, 'worktree', 'add', '-q', linked);
  expect((await mimir(main, 'bind')).io.out.join('')).toBe('MMR');
  git(main, 'remote', 'remove', 'origin');
  const fromLinked = await mimir(linked, 'bind');
  expect(fromLinked.code).toBe(0);
  expect(fromLinked.io.out.join('')).toBe('MMR');
  expect((await mimir(linked, 'next', '-f', 'ids')).io.out.join('')).toBe('MMR-3');
});

test('bare bind prints the key and exits 0, or says unbound and exits non-zero', async () => {
  const bound = clone('bound');
  git(bound, 'config', 'mimir.project', 'XX');
  const yes = await mimir(bound, 'bind');
  expect(yes.code).toBe(0);
  expect(yes.io.out.join('')).toBe('XX');

  const unbound = await mimir(clone('loose'), 'bind');
  expect(unbound.code).not.toBe(0);
  expect(unbound.io.out).toEqual([]);
  expect(unbound.io.err.join('\n')).toBe('unbound: run mimir bind KEY');
});

test('bare bind on an ambiguous origin names the candidates and stays unbound', async () => {
  await engine.updateProject({ id: 'XX', remote: 'https://github.com/dbtlr/mimir' });
  const dir = clone('twins', 'git@github.com:dbtlr/mimir.git');
  const result = await mimir(dir, 'bind');
  expect(result.code).not.toBe(0);
  expect(result.io.err.join('\n')).toContain('unbound: run mimir bind KEY');
  expect(result.io.err.join('\n')).toContain('MMR, XX');
  expect(configured(dir)).toBe('');
});

test('bind KEY writes git config, records the origin on a remote-less project, and echoes the key', async () => {
  const dir = clone('xx', 'git@github.com:dbtlr/xx.git');
  const result = await mimir(dir, 'bind', 'XX', '-f', 'ids');
  expect(result.code).toBe(0);
  expect(result.io.out.join('')).toBe('XX');
  expect(configured(dir)).toBe('XX');
  expect((await engine.getNode({ id: 'XX' })).remote).toBe('github.com/dbtlr/xx');
});

test('bind KEY on a project with a different remote binds the clone and keeps the stored remote', async () => {
  const dir = clone('fork', 'git@github.com:someone/mimir-fork.git');
  expect((await mimir(dir, 'bind', 'MMR')).code).toBe(0);
  expect(configured(dir)).toBe('MMR');
  expect((await engine.getNode({ id: 'MMR' })).remote).toBe('github.com/dbtlr/mimir');
});

test('bind notes a .mimir.toml that is ignored; it does not bind from it', async () => {
  const dir = clone('legacy');
  writeFileSync(join(dir, '.mimir.toml'), 'project = "XX"\n');
  const unbound = await mimir(dir, 'bind');
  expect(unbound.code).not.toBe(0);
  const result = await mimir(dir, 'bind', 'MMR');
  expect(result.code).toBe(0);
  expect(result.io.err.join('\n')).toContain('.mimir.toml is ignored');
  expect(configured(dir)).toBe('MMR');
});

test('bind refuses an unknown project (exit 1) and outside a git clone', async () => {
  const dir = clone('refuse');
  expect((await mimir(dir, 'bind', 'NOPE')).code).toBe(1);
  expect(configured(dir)).toBe('');
  const plain = join(root, 'plain');
  mkdirSync(plain);
  expect((await mimir(plain, 'bind', 'MMR')).code).toBe(1);
});

test('the MCP server resolves its binding from its spawn directory, lazily', async () => {
  const dir = clone('spawned', 'git@github.com:dbtlr/mimir.git');
  const notes: string[] = [];
  const scope = bindingScope(
    async () => engine,
    gitPortAt(dir),
    (line) => notes.push(line),
  );
  const server = buildMcpServer(store, '0.0.0', scope);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    // A tool that names its scope never resolves the binding.
    await client.callTool({ arguments: { scope: 'XX' }, name: 'next' });
    expect(configured(dir)).toBe('');
    const result = (await client.callTool({ name: 'next' })) as {
      content: { text: string }[];
    };
    expect(result.content[0]?.text).toContain('MMR-3');
    expect(result.content[0]?.text).not.toContain('XX-3');
    expect(configured(dir)).toBe('MMR');
    expect(notes).toHaveLength(1);
  } finally {
    await client.close();
  }
});

/** Every non-test TypeScript source file under the packages. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return ['node_modules', 'dist', '.output'].includes(entry.name) ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

test('no source reads .mimir.toml; the only mention is the note that it is ignored', () => {
  const packages = join(import.meta.dir, '..', '..', '..');
  const mentions = readdirSync(packages)
    .flatMap((pkg) => sourceFiles(join(packages, pkg, 'src')))
    .filter((file) => readFileSync(file, 'utf8').includes('.mimir.toml'))
    .map((file) => file.slice(packages.length + 1));
  expect(mentions).toEqual(['bin/src/cli/bind.ts']);
});

test('an ordinary command on an ambiguous origin says to bind and stays cross-project', async () => {
  await engine.updateProject({ id: 'XX', remote: 'https://github.com/dbtlr/mimir' });
  const dir = clone('twins-next', 'git@github.com:dbtlr/mimir.git');
  const result = await mimir(dir, 'list', '-f', 'ids');
  expect(result.io.err.join('\n')).toContain('mimir bind KEY');
  expect(result.io.err.join('\n')).toContain('MMR, XX');
  expect(result.io.out.join('\n').split('\n').toSorted()).toEqual(['MMR-3', 'XX-3']);
});

test('a malformed invocation is refused before scope resolution can open the store (MMR-39)', async () => {
  const dir = clone('wrong', 'git@github.com:dbtlr/mimir.git');
  const port = gitPortAt(dir);
  for (const argv of [
    ['list', '--status', 'bogus'],
    ['list', '--size', 'huge'],
    ['next', '--limit', 'x'],
    ['artifacts', '--at-or-after', 'created_at:garbage'],
  ]) {
    const io = fakeIo();
    const code = await runCli(argv, () => store, io, {
      cwd: dir,
      git: port,
      scope: bindingScope(
        async () => {
          throw new Error('store opened');
        },
        port,
        io.error,
      ),
    });
    expect(code).toBe(2);
    expect(io.err.join('\n')).not.toContain('store opened');
  }
});

test('bare bind answers from git config without opening the store', async () => {
  const dir = clone('configured', 'git@github.com:dbtlr/mimir.git');
  git(dir, 'config', 'mimir.project', 'XX');
  const io = fakeIo();
  const code = await runCli(
    ['bind'],
    () => {
      throw new Error('store opened');
    },
    io,
    { cwd: dir, git: gitPortAt(dir) },
  );
  expect(code).toBe(0);
  expect(io.out.join('')).toBe('XX');
});
