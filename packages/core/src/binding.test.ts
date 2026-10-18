import { afterEach, beforeEach, expect, test } from 'bun:test';

import { bindClone, BINDING_CONFIG_KEY, bindingScope, resolveBinding } from './binding';
import type { GitPort } from './binding';
import { LocalEngine } from './engine';
import { conflict } from './errors';
import { errorOf } from './testing/conformance';
import { createTestStore } from './testing/store';

let engine: LocalEngine;
let closeStore: (() => Promise<void>) | undefined;

beforeEach(async () => {
  const made = await createTestStore();
  closeStore = made.close;
  engine = new LocalEngine(made.store);
  await engine.create({
    key: 'AAA',
    name: 'Alpha',
    remote: 'git@github.com:dbtlr/mimir.git',
    type: 'project',
  });
  await engine.create({ key: 'BBB', name: 'Beta', type: 'project' });
});
afterEach(async () => {
  await closeStore?.();
});

/** An in-memory git port; `failWrite` makes config writes fail. */
function fakeGit(
  state: { config?: string; origin?: string; failWrite?: boolean } = {},
): GitPort & { written: string[] } {
  const git = {
    originUrl: async () => state.origin,
    readConfig: async (key: string) => (key === BINDING_CONFIG_KEY ? state.config : undefined),
    writeConfig: async (key: string, value: string) => {
      if (state.failWrite === true) {
        return false;
      }
      git.written.push(`${key}=${value}`);
      state.config = value;
      return true;
    },
    written: [] as string[],
  };
  return git;
}

test('a git-config binding resolves without touching the origin or the Engine', async () => {
  const notes: string[] = [];
  const git = fakeGit({ config: 'AAA', origin: 'git@github.com:other/repo.git' });
  const found = await resolveBinding(engine, git, (line) => notes.push(line));
  expect(found).toEqual({ key: 'AAA', source: 'git-config', state: 'bound' });
  expect(git.written).toEqual([]);
  expect(notes).toEqual([]);
});

test('a unique origin match binds, writes git config, and notes the key and source once', async () => {
  const notes: string[] = [];
  const state = { origin: 'https://github.com/dbtlr/mimir' };
  const git = fakeGit(state);
  const found = await resolveBinding(engine, git, (line) => notes.push(line));
  expect(found).toEqual({ key: 'AAA', source: 'origin', state: 'bound' });
  expect(git.written).toEqual(['mimir.project=AAA']);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain('AAA');
  expect(notes[0]).toContain('github.com/dbtlr/mimir');
  // The next resolution reads git config only.
  const again = await resolveBinding(engine, git, (line) => notes.push(line));
  expect(again).toEqual({ key: 'AAA', source: 'git-config', state: 'bound' });
  expect(notes).toHaveLength(1);
});

test('a failed git config write is silent and the match still binds', async () => {
  const notes: string[] = [];
  const git = fakeGit({ failWrite: true, origin: 'git@github.com:dbtlr/mimir.git' });
  const found = await resolveBinding(engine, git, (line) => notes.push(line));
  expect(found).toEqual({ key: 'AAA', source: 'origin', state: 'bound' });
  expect(notes).toEqual([]);
});

test('no origin, no match, and a local-path origin are unbound', async () => {
  const none = await resolveBinding(engine, fakeGit(), () => {});
  expect(none).toEqual({ reason: 'no-origin', state: 'unbound' });
  const nomatch = await resolveBinding(
    engine,
    fakeGit({ origin: 'git@github.com:nobody/nothing.git' }),
    () => {},
  );
  expect(nomatch).toEqual({ reason: 'no-match', state: 'unbound' });
  const local = await resolveBinding(engine, fakeGit({ origin: '/srv/git/r.git' }), () => {});
  expect(local).toEqual({ reason: 'no-match', state: 'unbound' });
});

test('several matching projects leave the clone unbound and name the candidates', async () => {
  await engine.create({
    key: 'CCC',
    name: 'Gamma',
    remote: 'https://github.com/dbtlr/mimir',
    type: 'project',
  });
  const git = fakeGit({ origin: 'git@github.com:dbtlr/mimir.git' });
  const found = await resolveBinding(engine, git, () => {});
  expect(found).toEqual({ candidates: ['AAA', 'CCC'], reason: 'ambiguous', state: 'unbound' });
  expect(git.written).toEqual([]);
});

test('bindClone writes git config and records the origin on a project with none', async () => {
  const git = fakeGit({ origin: 'git@github.com:dbtlr/beta.git' });
  const result = await bindClone(engine, git, 'BBB');
  expect(result).toEqual({ key: 'BBB', recordedRemote: 'github.com/dbtlr/beta' });
  expect(git.written).toEqual(['mimir.project=BBB']);
  expect((await engine.getNode({ id: 'BBB' })).remote).toBe('github.com/dbtlr/beta');
});

test('bindClone leaves a different stored remote alone', async () => {
  const git = fakeGit({ origin: 'git@github.com:dbtlr/fork.git' });
  const result = await bindClone(engine, git, 'AAA');
  expect(result).toEqual({ key: 'AAA' });
  expect((await engine.getNode({ id: 'AAA' })).remote).toBe('github.com/dbtlr/mimir');
});

test('bindClone with no usable origin binds without recording a remote', async () => {
  for (const origin of [undefined, '/srv/git/r.git']) {
    const git = fakeGit({ origin });
    expect(await bindClone(engine, git, 'BBB')).toEqual({ key: 'BBB' });
  }
  expect((await engine.getNode({ id: 'BBB' })).remote).toBeNull();
});

test('bindClone refuses an unknown project, a non-project id, and a failed config write', async () => {
  expect((await errorOf(bindClone(engine, fakeGit(), 'NOPE'))).code).toBe('not_found');
  const phase = await engine.create({ parent: 'AAA', title: 'p', type: 'initiative' });
  const notProject = await errorOf(bindClone(engine, fakeGit(), phase.id));
  expect(notProject.code).toBe('validation');
  expect(notProject.message).toContain('is not a project key');
  const refused = await errorOf(bindClone(engine, fakeGit({ failWrite: true }), 'AAA'));
  expect(refused.message).toContain('git config');
});

test('bindingScope resolves once, and not at all until asked', async () => {
  let engines = 0;
  const git = fakeGit({ origin: 'git@github.com:dbtlr/mimir.git' });
  const scope = bindingScope(
    async () => {
      engines += 1;
      return engine;
    },
    git,
    () => {},
  );
  expect(engines).toBe(0);
  expect(await scope()).toBe('AAA');
  expect(await scope()).toBe('AAA');
  expect(engines).toBe(1);
  expect(git.written).toEqual(['mimir.project=AAA']);
});

test('bindingScope is undefined for an unbound clone', async () => {
  const scope = bindingScope(
    async () => engine,
    fakeGit(),
    () => {},
  );
  expect(await scope()).toBeUndefined();
});

test('bindingScope tells the user to bind when several projects match the origin', async () => {
  await engine.updateProject({ id: 'BBB', remote: 'https://github.com/dbtlr/mimir' });
  const notes: string[] = [];
  const scope = bindingScope(
    async () => engine,
    fakeGit({ origin: 'git@github.com:dbtlr/mimir.git' }),
    (line) => notes.push(line),
  );
  expect(await scope()).toBeUndefined();
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain('AAA, BBB');
  expect(notes[0]).toContain('mimir bind KEY');
});

test('bindingScope retries after a failed resolution instead of caching the failure', async () => {
  let calls = 0;
  const scope = bindingScope(
    async () => {
      calls += 1;
      if (calls === 1) {
        throw conflict('connection reset');
      }
      return engine;
    },
    fakeGit({ origin: 'git@github.com:dbtlr/mimir.git' }),
    () => {},
  );
  expect((await errorOf(scope())).message).toBe('connection reset');
  expect(await scope()).toBe('AAA');
});

test('bindingScope re-reads an unbound clone so a later bind takes effect', async () => {
  const git = fakeGit();
  const scope = bindingScope(
    async () => engine,
    git,
    () => {},
  );
  expect(await scope()).toBeUndefined();
  await git.writeConfig(BINDING_CONFIG_KEY, 'AAA');
  expect(await scope()).toBe('AAA');
});
