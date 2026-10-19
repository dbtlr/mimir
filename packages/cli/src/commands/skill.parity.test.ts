import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '@mimir/bin/src/cli';
import { SKILL_FILES as OLD_SKILL_FILES, skillDirFor } from '@mimir/bin/src/cli/skill-assets';
import { fakeIo } from '@mimir/bin/src/cli/testing';

import { createApp } from '../app';
import { MIMIR_SKILL, SKILL_FILES } from '../skill-files';
import { boundClone } from '../testing/fixture';
import { runArgv } from '../testing/run';

/**
 * `skill install` moves onto Loom's skills plugin, so its command line and
 * messages are the plugin's: the group is `skills`, the agents are `claude` and
 * `agents`, and `--project` replaces `--local`. What stays is the contract that
 * matters to an installed skill, the files: the embedded skill is written to the
 * same paths with the same bytes, so it still matches the binary.
 */
let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'mimir-skill-'));
});
afterEach(() => {
  rmSync(scratch, { force: true, recursive: true });
});

/** The old install into a working copy: its global form writes to the real home, which a test must not touch. */
const oldInstall = (argv: string[], cwd: string) =>
  runCli(argv, () => Promise.reject(new Error('the store is not read')), fakeIo(), { cwd });

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

test('the embedded skill is the one the old binary embeds', () => {
  expect(SKILL_FILES).toEqual(OLD_SKILL_FILES);
  expect(MIMIR_SKILL.name).toBe('mimir');
});

test('install writes the same files the old skill install wrote for Claude Code', async () => {
  const oldHome = join(scratch, 'old');
  const newHome = join(scratch, 'new');
  mkdirSync(oldHome);
  mkdirSync(newHome);
  expect(await oldInstall(['skill', 'install', '--local'], oldHome)).toBe(0);
  const run = await runArgv(app(), ['skills', 'install', '--agent', 'claude'], {
    env: env(newHome),
  });
  expect(run.exitCode).toBe(0);
  expect(tree(skillFolder(newHome, '.claude'))).toEqual(tree(skillFolder(oldHome, '.claude')));
  expect(tree(skillFolder(newHome, '.claude')).map(([path]) => path)).toEqual(
    OLD_SKILL_FILES.map((file) => file.path).toSorted((a, b) => a.localeCompare(b)),
  );
});

test('install writes the same files the old skill install wrote for Codex, in the shared agents folder', async () => {
  const oldHome = join(scratch, 'old');
  const newHome = join(scratch, 'new');
  mkdirSync(oldHome);
  mkdirSync(newHome);
  expect(await oldInstall(['skill', 'install', '--local', '--agent', 'codex'], oldHome)).toBe(0);
  const run = await runArgv(app(), ['skills', 'install', '--agent', 'agents'], {
    env: env(newHome),
  });
  expect(run.exitCode).toBe(0);
  expect(tree(skillFolder(newHome, '.agents'))).toEqual(tree(skillFolder(oldHome, '.agents')));
  expect(skillDirFor('codex', oldHome)).toBe(skillFolder(oldHome, '.agents'));
});

test('install without --agent writes both folders', async () => {
  const home = join(scratch, 'home');
  mkdirSync(home);
  const run = await runArgv(app(), ['skills', 'install'], { env: env(home) });
  expect(run.exitCode).toBe(0);
  expect(statSync(skillFolder(home, '.claude')).isDirectory()).toBe(true);
  expect(tree(skillFolder(home, '.agents'))).toEqual(tree(skillFolder(home, '.claude')));
});

test('install --project writes the working copy the same tree the old --local did', async () => {
  const oldRepo = join(scratch, 'old-repo');
  const newRepo = join(scratch, 'new-repo');
  for (const repo of [oldRepo, newRepo]) {
    mkdirSync(join(repo, '.git'), { recursive: true });
  }
  expect(await oldInstall(['skill', 'install', '--local'], oldRepo)).toBe(0);
  const run = await runArgv(
    app(),
    ['skills', 'install', '--project', '--agent', 'claude', '--directory', newRepo],
    { env: env(join(scratch, 'home')) },
  );
  expect(run.exitCode).toBe(0);
  expect(tree(skillFolder(newRepo, '.claude'))).toEqual(tree(skillFolder(oldRepo, '.claude')));
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
