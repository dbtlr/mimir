/**
 * The host's project clones (ADR 0041, "The host syncs clones; the agent never
 * runs git"). A project with a `remote` gets one clone, synced by the host's own
 * code before each run. Server-only: it runs git as a child process.
 *
 * Each clone is split in two under `MIMIR_DATA_DIR`. Its work tree, which the
 * agent reads, is `clones/<KEY>` and holds no `.git`. Its git directory is
 * `git/<KEY>`, outside every work tree, and only the host's own git calls
 * write it, so the host trusts it. Every git call names both through `GIT_DIR`
 * and `GIT_WORK_TREE`, so git never reads repository state from the work tree.
 *
 * The work tree is disposable: each sync empties it before git runs, then
 * checks the commit out into it, so nothing written into it between syncs can
 * steer the checkout or survive it.
 */
import { execFile } from 'node:child_process';
import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readlink, realpath, rmdir, unlink } from 'node:fs/promises';
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

/** The directory under `MIMIR_DATA_DIR` that holds every project's work tree. */
export const CLONES_DIRECTORY = 'clones';

/** The directory under `MIMIR_DATA_DIR` that holds every clone's git directory, beside `clones`. */
export const GIT_DIRECTORIES = 'git';

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
  | 'git'
  /** A file or directory under `MIMIR_DATA_DIR` could not be read or written. */
  | 'filesystem';

/** A sync's outcome: the clone ready at `origin/HEAD`, or one line saying why not. */
export type CloneSyncResult =
  | {
      ok: true;
      /** The clone's working tree, as a real path. */
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
   * fetches, through git's `url.<base>.insteadOf`, and whose scheme git is then
   * allowed to use. The clone's `origin` stays `https://<remote>.git`.
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

/** The transport git uses for `fetchBase`: its URL scheme, or `file` for a path. */
function fetchBaseProtocol(fetchBase: string): string {
  return /^([a-z][a-z0-9+.-]*):\/\//i.exec(fetchBase)?.[1]?.toLowerCase() ?? 'file';
}

/**
 * The environment every git call runs with, before `syncClone` adds
 * `GIT_DIR` and `GIT_WORK_TREE`. It is built from nothing but `PATH`, proxy,
 * and CA settings, so the operator's `GIT_*` variables, askpass programs, and
 * global and system git config never apply. Transient config
 * (`GIT_CONFIG_COUNT`) turns off hooks, fsmonitor, sparse checkout,
 * commit-graphs, multi-pack indexes, submodules, and automatic maintenance;
 * allows https and no other transport; and names the credential helper, so
 * nothing is written into the clone's config. Replace refs are ignored.
 */
export function gitEnvironment(credentialsFile: string | undefined, fetchBase: string | undefined) {
  const config: [string, string][] = [
    ['core.hooksPath', '/dev/null'],
    ['core.fsmonitor', 'false'],
    ['core.sparseCheckout', 'false'],
    ['core.commitGraph', 'false'],
    ['core.multiPackIndex', 'false'],
    ['fetch.writeCommitGraph', 'false'],
    ['fetch.recurseSubmodules', 'false'],
    ['submodule.recurse', 'false'],
    ['gc.auto', '0'],
    ['maintenance.auto', 'false'],
    ['advice.detachedHead', 'false'],
    ['protocol.allow', 'never'],
    ['protocol.https.allow', 'always'],
    // An empty value clears any helper list before this one, URL-scoped helpers included.
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
    config.push(
      [`url.${fetchBase}.insteadOf`, 'https://'],
      [`protocol.${fetchBaseProtocol(fetchBase)}.allow`, 'always'],
    );
  }
  const env: Record<string, string> = {
    GIT_ASKPASS: '',
    GIT_CONFIG_COUNT: String(config.length),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
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
      maxBuffer: 64 * 1024 * 1024,
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

/** `path`'s own status, never a symlink target's, or `undefined` when nothing is there. */
async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/**
 * Remove everything inside `directory`, whose own status is `stats`, without
 * following symlinks: a symlink is unlinked, never its target. Each directory
 * first gets its owner's read, write, and search bits back, so no mode a
 * writer in the work tree set, such as 000 or 0500, can block the removal.
 * The chmod follows a symlink, so this relies on nothing replacing a directory
 * with one while the host syncs; no agent runs then (ADR 0041).
 */
async function emptyDirectory(directory: string, stats: Stats): Promise<void> {
  await chmod(directory, (stats.mode & 0o7777) | 0o700);
  const removals = await Promise.allSettled(
    (await readdir(directory)).map((name) => removeTree(join(directory, name))),
  );
  // Every removal settles first, so none still runs when the caller recovers.
  const failure = removals.find((removal) => removal.status === 'rejected');
  if (failure !== undefined) {
    throw failure.reason;
  }
}

/** Remove `path` and everything under it as `emptyDirectory` does; nothing there is fine. */
async function removeTree(path: string): Promise<void> {
  const stats = await lstatIfPresent(path);
  if (stats === undefined) {
    return;
  }
  if (!stats.isDirectory()) {
    await unlink(path);
    return;
  }
  await emptyDirectory(path, stats);
  await rmdir(path);
}

/**
 * Leave `workTree` an empty, real directory the host can write. Anything else
 * at its path, a symlink included, is removed rather than followed.
 */
async function emptyWorkTree(workTree: string): Promise<void> {
  const stats = await lstatIfPresent(workTree);
  if (stats?.isDirectory() === true) {
    await emptyDirectory(workTree, stats);
    return;
  }
  await removeTree(workTree);
  await mkdir(workTree, { recursive: true });
}

/**
 * The path, relative to the work tree, of the first symlink in it that
 * resolves outside it, into the host's git directories or anywhere else. A
 * dangling link is resolved from its real parent directory, so it fails when
 * its target would be outside.
 */
async function findEscapingSymlink(workTree: string): Promise<string | undefined> {
  const root = await realpath(workTree);
  const search = async (directory: string, prefix: string): Promise<string | undefined> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(path);
        } catch {
          target = resolve(await realpath(dirname(path)), await readlink(path));
        }
        if (!isInside(root, target)) {
          return name;
        }
      } else if (entry.isDirectory()) {
        const found = await search(path, `${name}/`);
        if (found !== undefined) {
          return found;
        }
      }
    }
    return undefined;
  };
  return search(root, '');
}

/** A failed sync. */
function failed(reason: CloneSyncFailure, message: string): CloneSyncResult {
  return { message, ok: false, reason };
}

/** One project's sync: its clone's two directories and the environment git runs with. */
type SyncContext = {
  key: string;
  remote: string;
  /** The work tree, `<data>/clones/<KEY>`. */
  workTree: string;
  /** The git directory, `<data>/git/<KEY>`. */
  gitDirectory: string;
  /** `gitEnvironment` with `GIT_DIR` and `GIT_WORK_TREE` naming the two directories. */
  env: Record<string, string>;
  credentials: GitCredentialsSetting;
  credentialsFile: string | undefined;
};

/** Run git for this clone, from its work tree. */
function cloneGit(context: SyncContext, args: string[], timeout?: number): Promise<GitRun> {
  return runGit(context.workTree, args, context.env, timeout);
}

/** A local git step's failure, naming the step. */
function stepFailed(context: SyncContext, step: string, run: { stderr: string }) {
  return failed(
    'git',
    `${step} failed for ${context.key}: ${gitDetail(run.stderr, context.credentialsFile)}`,
  );
}

/**
 * Whether the git directory's `origin` is exactly one URL that still
 * normalizes to the project's remote. Anything unreadable reads as a
 * mismatch, and the clone is made again.
 */
async function originMatches(context: SyncContext): Promise<boolean> {
  const origin = await runGit(
    dirname(context.gitDirectory),
    ['config', '--file', join(context.gitDirectory, 'config'), '--get-all', 'remote.origin.url'],
    context.env,
  );
  if (!origin.ok) {
    return false;
  }
  const urls = origin.stdout.split('\n');
  return urls.length === 1 && tryNormalizeRemote(urls[0] ?? '') === context.remote;
}

/**
 * Step 1: empty the work tree before any git call runs with it, so no file
 * planted there, such as a `.git`, a `.gitattributes`, a FIFO, or content
 * under a submodule's directory, can reach git or outlast the checkout.
 * Without `keep`, also remove the git directory and start a new, empty
 * repository whose `origin` is the remote's fetch URL; with it, the git
 * directory and its objects stay, so the sync fetches only what is new.
 */
async function prepareClone(
  context: SyncContext,
  keep: boolean,
): Promise<CloneSyncResult | undefined> {
  const { gitDirectory, workTree } = context;
  await emptyWorkTree(workTree);
  if (keep) {
    return undefined;
  }
  await removeTree(gitDirectory);
  await mkdir(gitDirectory, { recursive: true });
  for (const args of [
    ['init', '--quiet', '--template='],
    ['config', 'remote.origin.url', fetchUrl(context.remote)],
    ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
  ]) {
    const step = await cloneGit(context, args);
    if (!step.ok) {
      return stepFailed(context, `git ${args[0] ?? ''}`, step);
    }
  }
  return undefined;
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

/**
 * Step 2: fetch, and follow the remote's default branch. Refs are named in
 * full, so no other ref can shadow the one meant.
 */
async function fetchDefaultBranch(
  context: SyncContext,
): Promise<{ branch: string; commit: string } | CloneSyncResult> {
  const fetched = await cloneGit(
    context,
    ['fetch', '--quiet', '--prune', '--no-tags', '--no-recurse-submodules', 'origin'],
    600_000,
  );
  if (!fetched.ok) {
    return fetchFailed(context, fetched.stderr);
  }
  const head = await cloneGit(context, ['remote', 'set-head', 'origin', '--auto']);
  if (!head.ok && !/cannot determine remote head/i.test(head.stderr)) {
    return fetchFailed(context, head.stderr);
  }
  const branch = await cloneGit(context, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  const commit = await cloneGit(context, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    'refs/remotes/origin/HEAD^{commit}',
  ]);
  const prefix = 'refs/remotes/origin/';
  if (!head.ok || !branch.ok || !commit.ok || !branch.stdout.startsWith(prefix)) {
    return failed('no-default-branch', `${context.remote} reports no default branch`);
  }
  return { branch: branch.stdout.slice(prefix.length), commit: commit.stdout };
}

/**
 * Step 3: check the fetched commit out into the empty work tree with HEAD
 * detached, so no local branch goes stale. The index goes first, so the reset
 * trusts no cached state and writes every tracked file from the object store;
 * a submodule's path becomes an empty directory.
 */
async function checkOut(
  context: SyncContext,
  commit: string,
): Promise<CloneSyncResult | undefined> {
  await removeTree(join(context.gitDirectory, 'index'));
  for (const args of [
    ['update-ref', '--no-deref', 'HEAD', commit],
    ['reset', '--quiet', '--hard', commit],
  ]) {
    const step = await cloneGit(context, args);
    if (!step.ok) {
      return stepFailed(context, `git ${args[0] ?? ''}`, step);
    }
  }
  return undefined;
}

/** One pass at a sync, on the kept clone or (`keep` false) from nothing. */
async function syncOnce(context: SyncContext, keep: boolean): Promise<CloneSyncResult> {
  try {
    const refused = await prepareClone(context, keep);
    if (refused !== undefined) {
      return refused;
    }
    const fetched = await fetchDefaultBranch(context);
    if (!('commit' in fetched)) {
      return fetched;
    }
    const checkedOut = await checkOut(context, fetched.commit);
    if (checkedOut !== undefined) {
      return checkedOut;
    }
    // Step 4: refuse a symlink that would let a reader leave the clone.
    const escaping = await findEscapingSymlink(context.workTree);
    if (escaping !== undefined) {
      return failed(
        'escaping-symlink',
        `${context.remote} has a symlink that resolves outside the clone: ${escaping}`,
      );
    }
    // ADR 0041 gates reads by real paths inside the clone, so report the clone by its own.
    const directory = await realpath(context.workTree);
    return { ...fetched, directory, fresh: !keep, ok: true };
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, ' ');
    return failed('filesystem', `syncing ${context.key}'s clone failed: ${detail}`);
  }
}

/**
 * Failures a fresh clone would only repeat: they come from the remote, the
 * project, or the fetched content, not from state the kept clone holds.
 */
const FINAL_FAILURES = new Set<CloneSyncFailure>(['credentials', 'no-remote', 'escaping-symlink']);

/** The tail of each clone's queue of syncs, keyed by its directory; it never rejects. */
const syncQueues = new Map<string, Promise<void>>();

/**
 * Run `task` after every earlier task queued for `key` settles. This excludes
 * overlapping syncs within one process only; across processes, the runner
 * syncs a clone only after admitting a run, and admission allows one run at a
 * time (ADR 0041's runs table, MMR-632).
 */
async function exclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = syncQueues.get(key);
  const current = (async () => {
    await previous;
    return task();
  })();
  const settled = (async () => {
    try {
      await current;
    } catch {
      // The caller of this task sees its failure; the queue only waits for it.
    }
  })();
  syncQueues.set(key, settled);
  try {
    return await current;
  } finally {
    if (syncQueues.get(key) === settled) {
      syncQueues.delete(key);
    }
  }
}

/**
 * Sync a project's clone before a run: clone it again when its `origin` no
 * longer normalizes to the project's remote, empty the work tree, fetch,
 * follow the remote's default branch, check `origin/HEAD` out into the empty
 * work tree, and refuse a clone with a symlink that resolves outside it. A kept clone that fails for a reason a
 * fresh clone could fix, such as a stale lock or corrupt state after a crash,
 * is cloned again once. Writes nothing for a project without a remote. Syncs
 * of one project run one at a time.
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
  const workTree = join(options.dataDirectory, CLONES_DIRECTORY, key);
  const gitDirectory = join(options.dataDirectory, GIT_DIRECTORIES, key);
  return exclusive(resolve(workTree), async () => {
    const log = options.log ?? ((line: string) => console.error(line));
    const credentials = await currentGitCredentials(options.credentials);
    for (const warning of gitCredentialsWarnings(credentials)) {
      log(warning);
    }
    const credentialsFile =
      credentials.configured && credentials.problem === undefined ? credentials.file : undefined;
    const context: SyncContext = {
      credentials,
      credentialsFile,
      env: {
        ...gitEnvironment(credentialsFile, options.fetchBase),
        GIT_DIR: gitDirectory,
        GIT_WORK_TREE: workTree,
      },
      gitDirectory,
      key,
      remote,
      workTree,
    };
    const keep = await originMatches(context);
    const result = await syncOnce(context, keep);
    if (!keep || result.ok || FINAL_FAILURES.has(result.reason)) {
      return result;
    }
    log(`⚠ host: ${result.message}; cloning ${key} again`);
    return syncOnce(context, false);
  });
}
