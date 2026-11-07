/**
 * The host's project clones (ADR 0041, "The host syncs clones; the agent never
 * runs git"). A project with a `remote` gets one clone under
 * `<MIMIR_DATA_DIR>/clones/<KEY>`, synced by the host's own code before each
 * run. Server-only: it runs git as a child process.
 *
 * Everything inside a kept clone's `.git` is untrusted between syncs: the host
 * owns that state, so each sync rewrites or removes whatever could change what
 * git fetches, checks out, or runs, and checks the objects it checks out.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readdir, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises';
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
 * The environment every git call runs with. It is built from nothing but
 * `PATH`, proxy, and CA settings, so the operator's `GIT_*` variables, askpass
 * programs, and global and system git config never apply. Transient config
 * (`GIT_CONFIG_COUNT`) is read after a clone's own config, so it wins: it turns
 * off hooks, fsmonitor, sparse checkout, commit-graphs, multi-pack indexes,
 * submodules, and automatic maintenance; allows https and no other transport;
 * and names the credential helper, so nothing is written into the clone's own
 * config. Replace refs are ignored. `resetGitState` removes the rest.
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

/** Whether a fetch failed on the clone's own refs or objects, not on the remote. */
function isLocalFetchFailure(stderr: string): boolean {
  return /cannot lock ref|unable to update local ref|some local refs could not be updated|bad object|is corrupt|unable to read [0-9a-f]{7,}/i.test(
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
 * Remove every entry named `.git` below the clone's top level, which git never
 * checks out and `git clean` never removes, and return the path, relative to
 * the clone, of the first symlink that resolves outside `root`. A dangling link
 * is resolved from its real parent directory, so it fails when its target
 * would be outside.
 */
async function sweepTree(root: string): Promise<string | undefined> {
  const realRoot = await realpath(root);
  const walk = async (directory: string, prefix: string): Promise<string | undefined> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.name.toLowerCase() === '.git') {
        if (prefix !== '') {
          await rm(path, { force: true, recursive: true });
        }
        continue;
      }
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
  /** The clone's git directory, `<directory>/.git`. */
  gitDirectory: string;
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
 * Whether the clone's `origin` is exactly one URL that still normalizes to the
 * project's remote. Read from the config file alone, so no include is followed;
 * anything unreadable reads as a mismatch, and the clone is made again.
 */
async function originMatches(context: SyncContext): Promise<boolean> {
  if (!(await isDirectory(context.gitDirectory))) {
    return false;
  }
  const origin = await runGit(
    context.directory,
    ['config', '--file', join(context.gitDirectory, 'config'), '--get-all', 'remote.origin.url'],
    context.cloneEnv,
  );
  if (!origin.ok) {
    return false;
  }
  const urls = origin.stdout.split('\n');
  return urls.length === 1 && tryNormalizeRemote(urls[0] ?? '') === context.remote;
}

/**
 * Git state a sync removes from a kept clone: everything that could change what
 * a fetch, reset, or checkout produces, or make git run code, beyond the config
 * `resetGitState` rewrites. Removing the index makes the reset write every file.
 */
const UNTRUSTED_GIT_STATE = [
  'info',
  'hooks',
  'branches',
  'remotes',
  'modules',
  'worktrees',
  'refs/replace',
  'objects/info/alternates',
  'objects/info/http-alternates',
  'objects/info/commit-graph',
  'objects/info/commit-graphs',
  'objects/pack/multi-pack-index',
  'index',
  'shallow',
  'config.worktree',
];

/** The only config a clone has: the repository format and the host's `origin`. */
async function writeHostConfig(context: SyncContext): Promise<GitRun> {
  const file = join(context.gitDirectory, 'config');
  await writeFile(
    file,
    '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n',
  );
  for (const [key, value] of [
    ['remote.origin.url', fetchUrl(context.remote)],
    ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
  ] as const) {
    const set = await runGit(
      context.directory,
      ['config', '--file', file, key, value],
      context.cloneEnv,
    );
    if (!set.ok) {
      return set;
    }
  }
  return { ok: true, stdout: '' };
}

/**
 * Put a clone's git state back to what the host owns: remove every lock file a
 * killed sync left, the untrusted state above, and replace the config.
 */
async function resetGitState(context: SyncContext): Promise<CloneSyncResult | undefined> {
  const { gitDirectory } = context;
  const entries = await readdir(gitDirectory, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.endsWith('.lock') && !entry.isDirectory()) {
      await rm(join(entry.parentPath, entry.name), { force: true });
    }
  }
  for (const path of UNTRUSTED_GIT_STATE) {
    await rm(join(gitDirectory, path), { force: true, recursive: true });
  }
  const configured = await writeHostConfig(context);
  return configured.ok ? undefined : stepFailed(context, 'git config', configured);
}

/**
 * Step 1: keep the clone only while its `origin` still normalizes to the
 * project's remote, and put its git state back to the host's; otherwise, or
 * when `rebuild` is set, start a new, empty repository whose `origin` is the
 * remote's fetch URL.
 */
async function prepareClone(
  context: SyncContext,
  keep: boolean,
): Promise<CloneSyncResult | undefined> {
  const { directory, env } = context;
  if (!keep) {
    await rm(directory, { force: true, recursive: true });
    await mkdir(directory, { recursive: true });
    const init = await runGit(directory, ['init', '--quiet', '--template=', directory], env);
    if (!init.ok) {
      return stepFailed(context, 'git init', init);
    }
  }
  return resetGitState(context);
}

/** A fetch-time failure: missing credentials, the clone's own state, or the fetch itself. */
function fetchFailed(context: SyncContext, stderr: string): CloneSyncResult {
  if (isAuthenticationFailure(stderr)) {
    return failed('credentials', credentialsMessage(context.remote, context.credentials));
  }
  return isLocalFetchFailure(stderr)
    ? stepFailed(context, 'git fetch', { stderr })
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
    ['fetch', '--quiet', '--prune', '--no-tags', '--no-recurse-submodules', 'origin'],
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
 * A reader of `git cat-file --batch` output that hashes each object as it
 * streams past and keeps the first one that is missing or does not hash to
 * its own name. A clone's format is SHA-1: `writeHostConfig` sets format
 * version 0.
 */
function objectBatchChecker() {
  let mismatch: string | undefined;
  let checked = 0;
  let header = '';
  let body: { oid: string; hash: ReturnType<typeof createHash>; remaining: number } | undefined;
  let separator = false;
  const finishBody = () => {
    if (body !== undefined && body.remaining === 0) {
      if (body.hash.digest('hex') !== body.oid) {
        mismatch ??= `object ${body.oid} does not match its content`;
      }
      checked += 1;
      body = undefined;
      // Each object's content is followed by one newline.
      separator = true;
    }
  };
  const readHeader = (line: string) => {
    const [oid = '', type, size] = line.split(' ');
    if (type === undefined || size === undefined) {
      mismatch ??= `object ${oid} is missing`;
      checked += 1;
      return;
    }
    body = { hash: createHash('sha1').update(`${type} ${size}\0`), oid, remaining: Number(size) };
    finishBody();
  };
  return {
    result: () => ({ checked, mismatch }),
    scan(chunk: Buffer) {
      let offset = 0;
      while (offset < chunk.length) {
        if (body !== undefined) {
          const take = Math.min(body.remaining, chunk.length - offset);
          body.hash.update(chunk.subarray(offset, offset + take));
          body.remaining -= take;
          offset += take;
          finishBody();
        } else if (separator) {
          separator = false;
          offset += 1;
        } else {
          const end = chunk.indexOf(10, offset);
          if (end === -1) {
            header += chunk.toString('latin1', offset);
            return;
          }
          const line = header + chunk.toString('latin1', offset, end);
          header = '';
          offset = end + 1;
          readHeader(line);
        }
      }
    },
  };
}

/**
 * Hash every object in `oids` through one `git cat-file --batch`, and return a
 * line naming the first that is missing or does not hash to its own name, or
 * `undefined` when all match.
 */
async function findMismatchedObject(
  context: SyncContext,
  oids: string[],
): Promise<string | undefined> {
  const child = spawn('git', ['cat-file', '--batch'], {
    cwd: context.directory,
    env: context.cloneEnv,
    stdio: ['pipe', 'pipe', 'ignore'],
    timeout: 600_000,
  });
  const closed = once(child, 'close');
  child.stdin.on('error', () => {});
  child.stdin.end(oids.length === 0 ? '' : `${oids.join('\n')}\n`);
  const checker = objectBatchChecker();
  try {
    for await (const chunk of child.stdout) {
      if (Buffer.isBuffer(chunk)) {
        checker.scan(chunk);
      }
    }
    await closed;
    const { checked, mismatch } = checker.result();
    if (mismatch === undefined && (child.exitCode !== 0 || checked !== oids.length)) {
      return 'git cat-file did not read every object';
    }
    return mismatch;
  } catch {
    return 'git cat-file could not run';
  }
}

/**
 * Step 3, for a kept clone: check that every object the commit checks out
 * hashes to its name, since an object written into the clone's store would
 * otherwise be trusted by the fetch and checked out as is. A fresh clone's
 * objects were each hashed as the fetch indexed them.
 */
async function verifyObjects(
  context: SyncContext,
  commit: string,
): Promise<CloneSyncResult | undefined> {
  const listed = await runGit(
    context.directory,
    ['rev-list', '--objects', '--no-object-names', '--no-walk', commit],
    context.cloneEnv,
    600_000,
  );
  if (!listed.ok) {
    return stepFailed(context, 'git rev-list', listed);
  }
  const mismatch = await findMismatchedObject(context, listed.stdout.split('\n').filter(Boolean));
  return mismatch === undefined
    ? undefined
    : failed('git', `checking ${context.key}'s objects failed: ${mismatch}`);
}

/**
 * Steps 4 and 5: hard-reset to the fetched commit with HEAD detached, so no
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

/** Failures a kept clone's own state can cause, which a fresh clone recovers from. */
const LOCAL_FAILURES = new Set<CloneSyncFailure>(['git', 'filesystem']);

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
    const mismatched = keep ? await verifyObjects(context, fetched.commit) : undefined;
    if (mismatched !== undefined) {
      return mismatched;
    }
    const reset = await resetAndClean(context, fetched.commit);
    if (reset !== undefined) {
      return reset;
    }
    // Step 6: refuse a symlink that would let a reader leave the clone.
    const escaping = await sweepTree(context.directory);
    if (escaping !== undefined) {
      return failed(
        'escaping-symlink',
        `${context.remote} has a symlink that resolves outside the clone: ${escaping}`,
      );
    }
    // ADR 0041 gates reads by real paths inside the clone, so report the clone by its own.
    const directory = await realpath(context.directory);
    return { ...fetched, directory, fresh: !keep, ok: true };
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, ' ');
    return failed('filesystem', `syncing ${context.key}'s clone failed: ${detail}`);
  }
}

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
 * longer normalizes to the project's remote, put its git state back to the
 * host's, fetch, follow the remote's default branch, check a kept clone's
 * objects, hard-reset to `origin/HEAD`, remove untracked and ignored files,
 * and refuse a clone with a symlink that resolves outside it. A kept clone
 * that fails a local step is cloned again once. Writes nothing for a project
 * without a remote. Syncs of one project run one at a time.
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
  const clones = join(options.dataDirectory, CLONES_DIRECTORY);
  const directory = join(clones, key);
  return exclusive(resolve(directory), async () => {
    const log = options.log ?? ((line: string) => console.error(line));
    const credentials = await currentGitCredentials(options.credentials);
    for (const warning of gitCredentialsWarnings(credentials)) {
      log(warning);
    }
    const credentialsFile =
      credentials.configured && credentials.problem === undefined ? credentials.file : undefined;
    const env = gitEnvironment(credentialsFile, options.fetchBase);
    const gitDirectory = join(directory, '.git');
    const context: SyncContext = {
      cloneEnv: {
        ...env,
        GIT_CEILING_DIRECTORIES: clones,
        GIT_DIR: gitDirectory,
        GIT_WORK_TREE: directory,
      },
      credentials,
      credentialsFile,
      directory,
      env,
      gitDirectory,
      key,
      remote,
    };
    const keep = await originMatches(context);
    const result = await syncOnce(context, keep);
    if (!keep || result.ok || !LOCAL_FAILURES.has(result.reason)) {
      return result;
    }
    log(`⚠ host: ${result.message}; cloning ${key} again`);
    return syncOnce(context, false);
  });
}
