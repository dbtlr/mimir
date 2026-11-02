import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../app';
import { boundClone } from '../testing/fixture';
import { runArgv } from '../testing/run';

/**
 * `skills install` is Loom's skills plugin, so its command line and messages
 * are the plugin's: the group is `skills`, the agents are `claude` and
 * `agents`, and `--project` selects the working copy. What matters to an
 * installed skill is the files: install writes the same paths with the same
 * bytes as the repo's `skills/mimir/` folder, the one source a source run reads
 * and `loom build` carries into the binary.
 */
let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'mimir-skill-'));
});
afterEach(() => {
  rmSync(scratch, { force: true, recursive: true });
});

/** The repo's skill folder, which `skills({ folder })` installs. */
const SKILL_SOURCE = fileURLToPath(new URL('../../../../skills/mimir', import.meta.url));

const app = () =>
  createApp({
    git: boundClone(undefined),
    store: () => Promise.reject(new Error('the store is not read')),
  });

/** Every file under `dir`, relative, with its text, in path order. */
function tree(dir: string, prefix = ''): [string, string][] {
  return readdirSync(dir, { withFileTypes: true })
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry): [string, string][] =>
      entry.isDirectory()
        ? tree(join(dir, entry.name), `${prefix}${entry.name}/`)
        : [[`${prefix}${entry.name}`, readFileSync(join(dir, entry.name), 'utf8')]],
    );
}

const env = (home: string) => ({
  HOME: home,
  TERM: 'xterm-256color',
  XDG_STATE_HOME: join(home, '.state'),
});

/** The installation record the plugin keeps lives beside the skills; the skill folder is what compares. */
const skillFolder = (home: string, folder: '.claude' | '.agents') =>
  join(home, folder, 'skills', 'mimir');

/** What every install must write: the source folder's files. */
const expected = () => tree(SKILL_SOURCE);

test('install writes the skill folder for Claude Code', async () => {
  const home = join(scratch, 'home');
  mkdirSync(home);
  const run = await runArgv(app(), ['skills', 'install', '--agent', 'claude'], {
    env: env(home),
  });
  expect(run.exitCode).toBe(0);
  expect(tree(skillFolder(home, '.claude'))).toEqual(expected());
});

test('install writes the skill folder for Codex, in the shared agents folder', async () => {
  const home = join(scratch, 'home');
  mkdirSync(home);
  const run = await runArgv(app(), ['skills', 'install', '--agent', 'agents'], {
    env: env(home),
  });
  expect(run.exitCode).toBe(0);
  expect(tree(skillFolder(home, '.agents'))).toEqual(expected());
});

test('install without --agent writes both folders', async () => {
  const home = join(scratch, 'home');
  mkdirSync(home);
  const run = await runArgv(app(), ['skills', 'install'], { env: env(home) });
  expect(run.exitCode).toBe(0);
  expect(statSync(skillFolder(home, '.claude')).isDirectory()).toBe(true);
  expect(tree(skillFolder(home, '.agents'))).toEqual(expected());
  expect(tree(skillFolder(home, '.claude'))).toEqual(expected());
});

test('install --project writes the working copy the skill folder', async () => {
  const repo = join(scratch, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const run = await runArgv(
    app(),
    ['skills', 'install', '--project', '--agent', 'claude', '--directory', repo],
    { env: env(join(scratch, 'home')) },
  );
  expect(run.exitCode).toBe(0);
  expect(tree(skillFolder(repo, '.claude'))).toEqual(expected());
});

// The plugin adds verbs the old command lacked; the one that deletes is pinned.
test('uninstall removes the skill folder a global install wrote', async () => {
  const home = join(scratch, 'home');
  mkdirSync(home);
  await runArgv(app(), ['skills', 'install', '--agent', 'claude'], { env: env(home) });
  expect(statSync(skillFolder(home, '.claude')).isDirectory()).toBe(true);
  const run = await runArgv(app(), ['skills', 'uninstall', '--agent', 'claude'], {
    env: env(home),
  });
  expect(run.exitCode).toBe(0);
  expect(statSync(skillFolder(home, '.claude'), { throwIfNoEntry: false })).toBeUndefined();
});

test('install never opens the store', async () => {
  const home = join(scratch, 'home');
  mkdirSync(home);
  // The app above rejects any store read, so a pass is the proof.
  expect(
    (await runArgv(app(), ['skills', 'install', '--agent', 'claude'], { env: env(home) })).exitCode,
  ).toBe(0);
});
