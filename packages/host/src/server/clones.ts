/**
 * The host's project clones (ADR 0041, "The host syncs clones; the agent never
 * runs git"). A project with a `remote` gets one clone under
 * `<MIMIR_DATA_DIR>/clones/<KEY>`, synced by the host's own code before each
 * run. Server-only: it runs git as a child process.
 */
import { execFile } from 'node:child_process';
import { mkdir, readdir, readlink, realpath, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { PROJECT_KEY_PATTERN } from '@mimir/contract';
import { tryNormalizeRemote } from '@mimir/core';

import {
  currentGitCredentials,
  GIT_CREDENTIALS_SETTING,
  gitCredentialsWarnings,
} from './git-credentials';
import type { GitCredentialsSetting } from './git-credentials';

/** The directory under `MIMIR_DATA_DIR` that holds every project's clone. */
export const CLONES_DIRECTORY = 'clones';

/** Why a sync failed, for the runner to report. */
export type CloneSyncFailure =
  /** The project has no remote, so it has nothing to clone. */
  | 'no-remote'
  /** The repository asked for credentials the host could not supply. */
  | 'credentials'
  /** The fetch failed for another reason, such as a missing repository. */
  | 'fetch'
  /** The remote reports no default branch. */
  | 'no-default-branch'
  /** A symlink in the clone resolves outside it. */
  | 'escaping-symlink'
  /** A local git step failed. */
  | 'git';

/** A sync's outcome: the clone ready at `origin/HEAD`, or one line saying why not. */
export type CloneSyncResult =
  | {
      ok: true;
      /** The clone's working tree. */
      directory: string;
      /** The remote's default branch the clone now matches. */
      branch: string;
      /** The commit checked out, detached. */
      commit: string;
      /** Whether this sync cloned from nothing. */
      fresh: boolean;
    }
  | { ok: false; reason: CloneSyncFailure; message: string };

export type CloneSyncOptions = {
  /** The host's working directory, `MIMIR_DATA_DIR`. */
  dataDirectory: string;
  /** The project to sync: its key and its stored, normalized remote (ADR 0036). */
  project: { key: string; remote: string | null | undefined };
  /** The git credentials setting as read at boot; checked again for this sync. */
  credentials: GitCredentialsSetting;
  log?: (line: string) => void;
  /**
   * Tests only: a base URL or directory that replaces `https://` when git
   * fetches, through git's `url.<base>.insteadOf`. The clone's `origin` stays
   * `https://<remote>.git`.
   */
  fetchBase?: string;
};

/** The fetch location for a stored `host/path` remote. ADR 0036 drops the scheme and port. */
export function fetchUrl(remote: string): string {
  return `https://${remote}.git`;
}

/** Quote one word for the POSIX shell git runs a `!` credential helper in. */
function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The environment every git call runs with. It is built from nothing but
 * `PATH`, proxy, and CA settings, so the operator's `GIT_*` variables, askpass
 * programs, and global and system git config never apply. Transient config
 * (`GIT_CONFIG_COUNT`) turns off hooks and fsmonitor, so a clone's content
 * cannot make git run host-side code, and names the credential helper, so
 * nothing is written into the clone's own config. `prepareClone` also removes
 * the clone's hooks directory, for git commands that ignore `core.hooksPath`.
 */
function gitEnvironment(credentialsFile: string | undefined, fetchBase: string | undefined) {
  const config: [string, string][] = [
    ['core.hooksPath', '/dev/null'],
    ['core.fsmonitor', 'false'],
    ['advice.detachedHead', 'false'],
    // An empty value clears any helper list before this one.
    ['credential.helper', ''],
    ['credential.useHttpPath', 'true'],
  ];
  if (credentialsFile !== undefined) {
    // Answer `get` only, so git never stores to or erases from the operator's file.
    config.push([
      'credential.helper',
      `!f() { test "$1" = get && exec git credential-store --file=${shellQuote(credentialsFile)} get; }; f`,
    ]);
  }
  if (fetchBase !== undefined) {
    config.push([`url.${fetchBase}.insteadOf`, 'https://']);
  }
  const env: Record<string, string> = {
    GIT_ASKPASS: '',
    GIT_CONFIG_COUNT: String(config.length),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
  for (const [index, [key, value]] of config.entries()) {
    env[`GIT_CONFIG_KEY_${String(index)}`] = key;
    env[`GIT_CONFIG_VALUE_${String(index)}`] = value;
  }
  for (const name of [
    'PATH',
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'NO_PROXY',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ]) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}

type GitRun = { ok: true; stdout: string } | { ok: false; stderr: string };

const execGit = promisify(execFile);

/** Run git with `env`; never throws for a failing git. */
async function runGit(
  cwd: string,
  args: string[],
  env: Record<string, string>,
  timeout = 120_000,
): Promise<GitRun> {
  try {
    const { stdout } = await execGit('git', args, {
      cwd,
      env,
      maxBuffer: 16 * 1024 * 1024,
      timeout,
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : '';
    return { ok: false, stderr: `${stderr}\n${error instanceof Error ? error.message : ''}` };
  }
}

/** Git's last meaningful stderr line, with any URL credentials and the credentials file removed. */
function gitDetail(stderr: string, credentialsFile: string | undefined): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('Command failed:'));
  let detail = lines.find((line) => /^(fatal|error):/.test(line)) ?? lines.at(-1) ?? 'git failed';
  detail = detail.replaceAll(/:\/\/[^/\s@]*@/g, '://');
  if (credentialsFile !== undefined && credentialsFile !== '') {
    detail = detail.replaceAll(credentialsFile, GIT_CREDENTIALS_SETTING);
  }
  return detail;
}

/** Whether git failed because the repository asked for credentials it did not get or accept. */
function isAuthenticationFailure(stderr: string): boolean {
  return /could not read (username|password)|authentication failed|terminal prompts disabled|returned error: 40[13]/i.test(
    stderr,
  );
}

/** The one line a credentials failure reports, naming the setting and never its value. */
function credentialsMessage(remote: string, setting: GitCredentialsSetting): string {
  let state = `${GIT_CREDENTIALS_SETTING} is unset`;
  if (setting.configured) {
    state =
      setting.problem === undefined
        ? `${GIT_CREDENTIALS_SETTING} has no accepted credential for this repository`
        : `${GIT_CREDENTIALS_SETTING} is ${setting.problem}`;
  }
  return `${remote} needs credentials: ${state}`;
}

/** Whether `target` is `root` or inside it. Both are real paths. */
function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/**
 * The path, relative to the clone, of the first symlink that resolves outside
 * `root`. A dangling link is resolved from its real parent directory, so it
 * fails when its target would be outside.
 */
async function findEscapingSymlink(root: string): Promise<string | undefined> {
  const realRoot = await realpath(root);
  const walk = async (directory: string, prefix: string): Promise<string | undefined> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (prefix === '' && entry.name === '.git') {
        continue;
      }
      const path = join(directory, entry.name);
      const name = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(path);
        } catch {
          target = resolve(await realpath(dirname(path)), await readlink(path));
        }
        if (!isInside(realRoot, target)) {
          return name;
        }
      } else if (entry.isDirectory()) {
        const found = await walk(path, `${name}/`);
        if (found !== undefined) {
          return found;
        }
      }
    }
    return undefined;
  };
  return walk(realRoot, '');
}

/** Whether `path` is a directory. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** A failed sync. */
function failed(reason: CloneSyncFailure, message: string): CloneSyncResult {
  return { message, ok: false, reason };
}

/** The environments one project's sync runs git with. */
type SyncContext = {
  key: string;
  remote: string;
  directory: string;
  /** For `git init`, before the clone exists. */
  env: Record<string, string>;
  /** Names the clone's own repository, so git never discovers an enclosing one. */
  cloneEnv: Record<string, string>;
  credentials: GitCredentialsSetting;
  credentialsFile: string | undefined;
};

/** A local git step's failure, naming the step. */
function stepFailed(context: SyncContext, step: string, run: { stderr: string }) {
  return failed(
    'git',
    `${step} failed for ${context.key}: ${gitDetail(run.stderr, context.credentialsFile)}`,
  );
}

/**
 * Step 1: keep the clone only while its `origin` still normalizes to the
 * project's remote; otherwise start a new, empty repository whose `origin` is
 * the remote's fetch URL.
 */
async function prepareClone(context: SyncContext): Promise<{ fresh: boolean } | CloneSyncResult> {
  const { cloneEnv, directory, env, remote } = context;
  const origin = (await isDirectory(join(directory, '.git')))
    ? await runGit(directory, ['config', '--local', '--get', 'remote.origin.url'], cloneEnv)
    : undefined;
  if (origin?.ok === true && tryNormalizeRemote(origin.stdout) === remote) {
    // A clone starts with no hooks (`--template=`); remove any written since. `core.hooksPath`
    // alone is not enough: git 2.47's `remote set-head` never reads it and runs `.git/hooks`.
    await rm(join(directory, '.git', 'hooks'), { force: true, recursive: true });
    return { fresh: false };
  }
  await rm(directory, { force: true, recursive: true });
  await mkdir(directory, { recursive: true });
  const init = await runGit(directory, ['init', '--quiet', '--template=', directory], env);
  if (!init.ok) {
    return stepFailed(context, 'git init', init);
  }
  const added = await runGit(directory, ['remote', 'add', 'origin', fetchUrl(remote)], cloneEnv);
  return added.ok ? { fresh: true } : stepFailed(context, 'git remote add', added);
}

/** A fetch-time failure: missing credentials, or the fetch itself. */
function fetchFailed(context: SyncContext, stderr: string): CloneSyncResult {
  return isAuthenticationFailure(stderr)
    ? failed('credentials', credentialsMessage(context.remote, context.credentials))
    : failed(
        'fetch',
        `fetching ${context.remote} failed: ${gitDetail(stderr, context.credentialsFile)}`,
      );
}

/** Step 2: fetch, and follow the remote's default branch. */
async function fetchDefaultBranch(
  context: SyncContext,
): Promise<{ branch: string; commit: string } | CloneSyncResult> {
  const { cloneEnv, directory, remote } = context;
  const fetched = await runGit(
    directory,
    ['fetch', '--quiet', '--prune', '--no-tags', 'origin'],
    cloneEnv,
    600_000,
  );
  if (!fetched.ok) {
    return fetchFailed(context, fetched.stderr);
  }
  const head = await runGit(directory, ['remote', 'set-head', 'origin', '--auto'], cloneEnv);
  if (!head.ok && !/cannot determine remote head/i.test(head.stderr)) {
    return fetchFailed(context, head.stderr);
  }
  const branch = await runGit(directory, ['symbolic-ref', 'refs/remotes/origin/HEAD'], cloneEnv);
  const commit = await runGit(
    directory,
    ['rev-parse', '--verify', 'origin/HEAD^{commit}'],
    cloneEnv,
  );
  if (!head.ok || !branch.ok || !commit.ok) {
    return failed('no-default-branch', `${remote} reports no default branch`);
  }
  return {
    branch: branch.stdout.replace(/^refs\/remotes\/origin\//, ''),
    commit: commit.stdout,
  };
}

/**
 * Steps 3 and 4: hard-reset to the fetched commit with HEAD detached, so no
 * local branch goes stale, then remove untracked and ignored files, nested
 * repositories included.
 */
async function resetAndClean(
  context: SyncContext,
  commit: string,
): Promise<CloneSyncResult | undefined> {
  for (const args of [
    ['update-ref', '--no-deref', 'HEAD', commit],
    ['reset', '--quiet', '--hard', commit],
    ['clean', '-ffdxq'],
  ]) {
    const step = await runGit(context.directory, args, context.cloneEnv);
    if (!step.ok) {
      return stepFailed(context, `git ${args[0] ?? ''}`, step);
    }
  }
  return undefined;
}

/**
 * Sync a project's clone before a run: clone it again when its `origin` no
 * longer normalizes to the project's remote, fetch, follow the remote's default
 * branch, hard-reset to `origin/HEAD`, remove untracked and ignored files, and
 * refuse a clone with a symlink that resolves outside it. Writes nothing for a
 * project without a remote. One sync per project at a time: the caller runs one
 * run at a time.
 */
export async function syncClone(options: CloneSyncOptions): Promise<CloneSyncResult> {
  const { key, remote } = options.project;
  if (!PROJECT_KEY_PATTERN.test(key)) {
    throw new Error(`not a project key: ${JSON.stringify(key)}`);
  }
  if (remote === null || remote === undefined || remote.trim() === '') {
    return failed(
      'no-remote',
      `project ${key} has no remote, so the host has no repository to clone; set one with mimir update ${key} --remote <url>`,
    );
  }
  const log = options.log ?? ((line: string) => console.error(line));
  const credentials = await currentGitCredentials(options.credentials);
  for (const warning of gitCredentialsWarnings(credentials)) {
    log(warning);
  }
  const credentialsFile =
    credentials.configured && credentials.problem === undefined ? credentials.file : undefined;
  const env = gitEnvironment(credentialsFile, options.fetchBase);
  const clones = join(options.dataDirectory, CLONES_DIRECTORY);
  const directory = join(clones, key);
  const context: SyncContext = {
    cloneEnv: {
      ...env,
      GIT_CEILING_DIRECTORIES: clones,
      GIT_DIR: join(directory, '.git'),
      GIT_WORK_TREE: directory,
    },
    credentials,
    credentialsFile,
    directory,
    env,
    key,
    remote,
  };
  const prepared = await prepareClone(context);
  if (!('fresh' in prepared)) {
    return prepared;
  }
  const fetched = await fetchDefaultBranch(context);
  if (!('commit' in fetched)) {
    return fetched;
  }
  const refused = await resetAndClean(context, fetched.commit);
  if (refused !== undefined) {
    return refused;
  }
  // Step 5: refuse a symlink that would let a reader leave the clone.
  const escaping = await findEscapingSymlink(directory);
  if (escaping !== undefined) {
    return failed(
      'escaping-symlink',
      `${remote} has a symlink that resolves outside the clone: ${escaping}`,
    );
  }
  return { ...fetched, directory, fresh: prepared.fresh, ok: true };
}
