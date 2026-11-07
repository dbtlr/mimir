import { afterEach, expect, test } from 'bun:test';
import { execFile, spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';

import { gitEnvironment, syncClone } from './clones';
import type { CloneSyncOptions } from './clones';
import { gitCredentialsWarnings, readGitCredentials } from './git-credentials';

const run = promisify(execFile);

/** Fixture git, isolated from the operator's own git configuration. */
async function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  const { stdout } = await run('git', args, {
    cwd,
    env: {
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      PATH: process.env.PATH,
      ...env,
    },
  });
  return stdout.trim();
}

/** Fixture git on the host's own git directory for the `CLN` clone under `dataDirectory`. */
function hostGit(dataDirectory: string, args: string[]) {
  const workTree = join(dataDirectory, 'clones', 'CLN');
  return git(workTree, args, {
    GIT_DIR: join(dataDirectory, 'git', 'CLN'),
    GIT_WORK_TREE: workTree,
  });
}

/** Every entry named `.git`, in any case, at any depth below `directory`, without following symlinks. */
async function gitEntries(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.name.toLowerCase() === '.git')
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)));
}

/**
 * The layout every sync leaves: a work tree with no `.git` entry at any depth,
 * and its git directory at `<data>/git/CLN`, outside `<data>/clones`.
 */
async function expectHostLayout(dataDirectory: string) {
  const clones = join(dataDirectory, 'clones');
  const gitDirectory = join(dataDirectory, 'git', 'CLN');
  expect(await gitEntries(join(clones, 'CLN'))).toEqual([]);
  expect(await exists(join(gitDirectory, 'HEAD'))).toBe(true);
  expect(relative(await realpath(clones), await realpath(gitDirectory))).toStartWith('..');
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** A scratch root with a data directory and a directory of bare repositories named `host/path.git`. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mimir-clones-'));
  roots.push(root);
  const remotes = join(root, 'remotes');
  return {
    dataDirectory: join(root, 'data'),
    /** Sync options that fetch `https://<remote>.git` from the local bare repositories. */
    options: (remote: string | null, extra: Partial<CloneSyncOptions> = {}): CloneSyncOptions => ({
      credentials: { configured: false },
      dataDirectory: join(root, 'data'),
      fetchBase: `${remotes}/`,
      log: () => {},
      project: { key: 'CLN', remote },
      ...extra,
    }),
    remotes,
    root,
  };
}

/** Publish `files` as a commit on `branch` of the bare repository for `remote`, made its default. */
async function publish(
  remotes: string,
  remote: string,
  files: Record<string, string>,
  {
    branch = 'main',
    links = {},
    makeDefault = true,
  }: { branch?: string; links?: Record<string, string>; makeDefault?: boolean } = {},
) {
  const bare = join(remotes, `${remote}.git`);
  const work = `${bare}.work-${branch}`;
  await mkdir(bare, { recursive: true });
  await git(bare, ['init', '--quiet', '--bare', '--initial-branch', branch]);
  await mkdir(work, { recursive: true });
  await git(work, ['init', '--quiet', '--initial-branch', branch]);
  await git(work, ['checkout', '--quiet', '-B', branch]);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), content);
  }
  for (const [path, target] of Object.entries(links)) {
    await mkdir(dirname(join(work, path)), { recursive: true });
    await symlink(target, join(work, path));
  }
  await git(work, ['add', '--all']);
  await git(work, ['commit', '--quiet', '--allow-empty', '-m', `publish ${branch}`]);
  await git(work, ['push', '--quiet', '--force', bare, `${branch}:${branch}`]);
  if (makeDefault) {
    await git(bare, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  }
  return git(work, ['rev-parse', 'HEAD']);
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test('a first sync clones the project remote into the clones directory, and later syncs reuse it', async () => {
  const { dataDirectory, options, remotes } = await fixture();
  const commit = await publish(remotes, 'github.test/owner/repo', { 'README.md': 'hello\n' });
  const first = await syncClone(options('github.test/owner/repo'));
  const directory = await realpath(join(dataDirectory, 'clones', 'CLN'));
  expect(first).toEqual({ branch: 'main', commit, directory, fresh: true, ok: true });
  expect(await readFile(join(directory, 'README.md'), 'utf8')).toBe('hello\n');
  expect(await hostGit(dataDirectory, ['config', '--get', 'remote.origin.url'])).toBe(
    'https://github.test/owner/repo.git',
  );
  await expectHostLayout(dataDirectory);
  expect(await syncClone(options('github.test/owner/repo'))).toEqual({
    branch: 'main',
    commit,
    directory,
    fresh: false,
    ok: true,
  });
  await expectHostLayout(dataDirectory);
});

test('a changed project remote clones the new repository again', async () => {
  const { dataDirectory, options, remotes } = await fixture();
  await publish(remotes, 'github.test/owner/old', { 'old.txt': 'old\n' });
  const commit = await publish(remotes, 'github.test/owner/new', { 'new.txt': 'new\n' });
  await syncClone(options('github.test/owner/old'));
  const directory = join(dataDirectory, 'clones', 'CLN');
  expect(await syncClone(options('github.test/owner/new'))).toMatchObject({
    commit,
    fresh: true,
    ok: true,
  });
  expect(await exists(join(directory, 'old.txt'))).toBe(false);
  expect(await readFile(join(directory, 'new.txt'), 'utf8')).toBe('new\n');
  expect(await hostGit(dataDirectory, ['config', '--get', 'remote.origin.url'])).toBe(
    'https://github.test/owner/new.git',
  );
  await expectHostLayout(dataDirectory);
});

test('a directory that is not a clone is replaced, never mistaken for an enclosing repository', async () => {
  const { dataDirectory, options, remotes, root } = await fixture();
  await publish(remotes, 'github.test/owner/repo', { 'README.md': 'hello\n' });
  // The data directory sits inside a checkout of the same remote, as a development host's does.
  await git(root, ['init', '--quiet']);
  await git(root, ['remote', 'add', 'origin', 'https://github.test/owner/repo.git']);
  await writeFile(join(root, 'enclosing.txt'), 'keep');
  // An empty `.git` is no repository, so git would otherwise search upward from it.
  await mkdir(join(dataDirectory, 'clones', 'CLN', '.git'), { recursive: true });
  await writeFile(join(dataDirectory, 'clones', 'CLN', 'stray.txt'), 'stray');
  expect(await syncClone(options('github.test/owner/repo'))).toMatchObject({
    fresh: true,
    ok: true,
  });
  expect(await exists(join(dataDirectory, 'clones', 'CLN', 'stray.txt'))).toBe(false);
  expect(await exists(join(root, 'enclosing.txt'))).toBe(true);
});

test('a sync follows a changed default branch', async () => {
  const { dataDirectory, options, remotes } = await fixture();
  await publish(remotes, 'github.test/owner/repo', { 'main.txt': 'main\n' });
  await syncClone(options('github.test/owner/repo'));
  const commit = await publish(
    remotes,
    'github.test/owner/repo',
    { 'trunk.txt': 'trunk\n' },
    {
      branch: 'trunk',
    },
  );
  expect(await syncClone(options('github.test/owner/repo'))).toMatchObject({
    branch: 'trunk',
    commit,
    fresh: false,
    ok: true,
  });
  expect(await exists(join(dataDirectory, 'clones', 'CLN', 'trunk.txt'))).toBe(true);
});

test('a sync discards local edits and removes untracked and ignored files', async () => {
  const { dataDirectory, options, remotes } = await fixture();
  await publish(remotes, 'github.test/owner/repo', {
    '.gitignore': '*.log\n',
    'README.md': 'hello\n',
  });
  await syncClone(options('github.test/owner/repo'));
  const directory = join(dataDirectory, 'clones', 'CLN');
  await writeFile(join(directory, 'README.md'), 'edited\n');
  await writeFile(join(directory, 'untracked.txt'), 'untracked');
  await writeFile(join(directory, 'debug.log'), 'ignored');
  await mkdir(join(directory, 'scratch', 'deep'), { recursive: true });
  await writeFile(join(directory, 'scratch', 'deep', 'file.txt'), 'nested');
  expect(await syncClone(options('github.test/owner/repo'))).toMatchObject({ ok: true });
  expect(await readFile(join(directory, 'README.md'), 'utf8')).toBe('hello\n');
  for (const path of ['untracked.txt', 'debug.log', 'scratch']) {
    expect(await exists(join(directory, path)), path).toBe(false);
  }
});

test('a symlink that resolves outside the clone refuses the sync, absolute or relative', async () => {
  const { options, remotes } = await fixture();
  for (const [remote, links] of [
    ['github.test/owner/absolute', { 'etc-link': '/etc' }],
    ['github.test/owner/relative', { 'nested/dir/up': '../../../outside' }],
    ['github.test/owner/dangling', { gone: '/nonexistent/secret' }],
    // The host's git directory for this clone is outside it, at <data>/git/CLN.
    ['github.test/owner/git-directory', { 'host-git': '../../git/CLN' }],
    ['github.test/owner/git-config', { 'docs/config': '../../../git/CLN/config' }],
  ] as const) {
    await publish(remotes, remote, { 'README.md': 'hello\n' }, { links });
    const refused = await syncClone(options(remote));
    expect(refused, remote).toMatchObject({ ok: false, reason: 'escaping-symlink' });
    expect(refused.ok ? '' : refused.message).toContain(Object.keys(links)[0] ?? '');
  }
});

test('a symlink that stays inside the clone is allowed', async () => {
  const { options, remotes } = await fixture();
  await publish(
    remotes,
    'github.test/owner/repo',
    { 'docs/guide.md': 'guide\n' },
    { links: { 'docs/later': '../not-yet', 'docs/self': '..', guide: 'docs/guide.md' } },
  );
  expect(await syncClone(options('github.test/owner/repo'))).toMatchObject({ ok: true });
});

test('a remote that reports no default branch fails the sync', async () => {
  const { options, remotes } = await fixture();
  await publish(remotes, 'github.test/owner/repo', { 'README.md': 'hello\n' });
  await git(join(remotes, 'github.test/owner/repo.git'), [
    'symbolic-ref',
    'HEAD',
    'refs/heads/gone',
  ]);
  expect(await syncClone(options('github.test/owner/repo'))).toMatchObject({
    message: expect.stringContaining('default branch'),
    ok: false,
    reason: 'no-default-branch',
  });
});

test('a project without a remote says why it cannot sync, and writes nothing', async () => {
  const { dataDirectory, options } = await fixture();
  for (const remote of [null, '']) {
    const result = await syncClone(options(remote));
    expect(result).toMatchObject({ ok: false, reason: 'no-remote' });
    expect(result.ok ? '' : result.message).toContain('CLN has no remote');
  }
  expect(await exists(dataDirectory)).toBe(false);
});

test('a missing repository fails the fetch', async () => {
  const { options } = await fixture();
  expect(await syncClone(options('github.test/owner/missing'))).toMatchObject({
    ok: false,
    reason: 'fetch',
  });
});

/**
 * A stand-in private Git server: it refuses every request with a Basic challenge
 * and records the Authorization header each request carried.
 */
function privateServer() {
  const seen: { path: string; authorization: string | null }[] = [];
  const server = Bun.serve({
    fetch: (request) => {
      seen.push({
        authorization: request.headers.get('authorization'),
        path: new URL(request.url).pathname,
      });
      return new Response('authentication required', {
        headers: { 'www-authenticate': 'Basic realm="fixture"' },
        status: 401,
      });
    },
    hostname: '127.0.0.1',
    port: 0,
  });
  return { base: `http://127.0.0.1:${String(server.port)}/`, seen, server };
}

test('a credential is sent only to its own repository path, and never leaks into the clone or errors', async () => {
  const { dataDirectory, options, root } = await fixture();
  const { base, seen, server } = privateServer();
  try {
    const file = join(root, 'git-credentials');
    const stored = `${base.replace('http://', 'http://alice:s3cret-token@')}github.test/owner/other.git\n`;
    await writeFile(file, stored);
    const credentials = { configured: true, file, problem: undefined } as const;
    const refused = await syncClone(
      options('github.test/owner/private', { credentials, fetchBase: base }),
    );
    expect(refused).toMatchObject({ ok: false, reason: 'credentials' });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(({ authorization }) => authorization === null)).toBe(true);
    // The control: the same file, scoped to the requested path, is sent.
    seen.length = 0;
    await writeFile(file, stored.replace('owner/other.git', 'owner/private.git'));
    const rejected = await syncClone(
      options('github.test/owner/private', { credentials, fetchBase: base }),
    );
    expect(seen.map(({ authorization }) => authorization)).toContain(
      `Basic ${Buffer.from('alice:s3cret-token').toString('base64')}`,
    );
    expect(rejected).toMatchObject({
      message: expect.stringContaining('MIMIR_GIT_CREDENTIALS_FILE'),
      ok: false,
      reason: 'credentials',
    });
    expect(JSON.stringify(rejected)).not.toContain('s3cret-token');
    expect(JSON.stringify(rejected)).not.toContain(file);
    // Git's rejection never erases the operator's file, and nothing is copied into the clone.
    expect(await readFile(file, 'utf8')).toBe(
      stored.replace('owner/other.git', 'owner/private.git'),
    );
    const config = await readFile(join(dataDirectory, 'git', 'CLN', 'config'), 'utf8');
    expect(config).not.toContain('s3cret-token');
    expect(config).not.toContain('credential');
    expect(config).not.toContain(file);
  } finally {
    await server.stop(true);
  }
});

test('an unreadable credentials file degrades: it warns by setting name and clones without credentials', async () => {
  const { options, remotes, root } = await fixture();
  const file = join(root, 'unreadable-credentials');
  await writeFile(file, 'https://alice:s3cret-token@github.test/owner/repo.git\n');
  await chmod(file, 0o000);
  const missing = await readGitCredentials({ MIMIR_GIT_CREDENTIALS_FILE: join(root, 'missing') });
  expect(missing).toEqual({
    configured: true,
    file: join(root, 'missing'),
    problem: 'unreadable',
  });
  const warnings = gitCredentialsWarnings(missing);
  expect(warnings).toEqual([expect.stringContaining('MIMIR_GIT_CREDENTIALS_FILE is unreadable')]);
  expect(warnings.join('\n')).not.toContain(root);
  expect(await readGitCredentials({})).toEqual({ configured: false });
  expect(gitCredentialsWarnings({ configured: false })).toEqual([]);
  expect(await readGitCredentials({ MIMIR_GIT_CREDENTIALS_FILE: '' })).toMatchObject({
    problem: 'unreadable',
  });

  // A file that became unreadable after boot is checked again at each sync.
  const credentials = { configured: true, file, problem: undefined } as const;
  await publish(remotes, 'github.test/owner/repo', { 'README.md': 'public\n' });
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  const unreadable = process.getuid?.() === 0 ? [] : [credentials];
  for (const setting of [missing, ...unreadable]) {
    lines.length = 0;
    expect(
      await syncClone(options('github.test/owner/repo', { credentials: setting, log })),
    ).toMatchObject({ ok: true });
    expect(lines).toEqual([expect.stringContaining('MIMIR_GIT_CREDENTIALS_FILE is unreadable')]);
  }
  const { base, seen, server } = privateServer();
  try {
    const failed = await syncClone(
      options('github.test/owner/private', { credentials: missing, fetchBase: base, log }),
    );
    expect(failed).toMatchObject({
      message: expect.stringContaining('MIMIR_GIT_CREDENTIALS_FILE is unreadable'),
      reason: 'credentials',
    });
    const unset = await syncClone(options('github.test/owner/private', { fetchBase: base }));
    expect(unset).toMatchObject({
      message: expect.stringContaining('MIMIR_GIT_CREDENTIALS_FILE is unset'),
      reason: 'credentials',
    });
    expect(seen.every(({ authorization }) => authorization === null)).toBe(true);
  } finally {
    await server.stop(true);
    await chmod(file, 0o600);
  }
});

test('a sync refuses a project key that is not a key', async () => {
  const { options } = await fixture();
  const sync = syncClone({
    ...options('github.test/owner/repo'),
    project: { key: '../ESC', remote: 'github.test/owner/repo' },
  });
  // oxlint-disable-next-line typescript/await-thenable -- Bun awaits async matchers at runtime.
  await expect(sync).rejects.toThrow('project key');
});

/** Every file and symlink under `directory`, relative to it. */
async function treeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
    .toSorted();
}

/**
 * A kept clone of `github.test/owner/repo`, synced once, beside an `evil` branch
 * of the same repository and a separate `github.test/owner/evil` repository.
 */
async function keptClone() {
  const base = await fixture();
  const repo = 'github.test/owner/repo';
  const files = { '.gitignore': '*.log\n', 'README.md': 'hello\n', 'docs/guide.md': 'guide\n' };
  await publish(base.remotes, repo, files);
  const evilCommit = await publish(
    base.remotes,
    repo,
    { 'README.md': 'evil\n' },
    { branch: 'evil', makeDefault: false },
  );
  await publish(base.remotes, 'github.test/owner/evil', { 'README.md': 'evil\n' });
  const lines: string[] = [];
  const options = (remote: string | null, extra: Partial<CloneSyncOptions> = {}) =>
    base.options(remote, { log: (line) => lines.push(line), ...extra });
  expect(await syncClone(options(repo))).toMatchObject({ fresh: true, ok: true });
  const directory = join(base.dataDirectory, 'clones', 'CLN');
  const marker = join(base.root, 'ran');
  const script = join(base.root, 'planted.sh');
  await writeFile(script, `#!/bin/sh\necho "$0 $*" >> ${marker}\n`);
  await chmod(script, 0o755);
  return {
    ...base,
    directory,
    evilCommit,
    files,
    gitDirectory: join(base.dataDirectory, 'git', 'CLN'),
    /** Lines the syncs since `keptClone` logged. */
    lines,
    marker,
    options,
    repo,
    /** An executable that appends a line to `marker` when anything runs it. */
    script,
  };
}

type KeptClone = Awaited<ReturnType<typeof keptClone>>;

/**
 * Make `target` a repository a planted `.git` could name: a copy of the host's
 * git directory with the `evil` branch fetched, every ref git could resolve for
 * `origin/HEAD` naming it, every hook and command setting git reads running
 * `clone.script`, and an alternate store so `core.alternateRefsCommand` runs on
 * fetch. Git would act on any of it if it ever discovered this repository.
 */
async function hostileRepository(clone: KeptClone, target: string) {
  await run('cp', ['-R', clone.gitDirectory, target]);
  const hostile = (args: string[]) => git(clone.root, args, { GIT_DIR: target });
  const bare = join(clone.remotes, `${clone.repo}.git`);
  await hostile(['fetch', '--quiet', bare, 'evil']);
  for (const ref of [
    'refs/remotes/origin/HEAD',
    'refs/remotes/origin/main',
    'refs/tags/origin/HEAD',
    'refs/heads/origin/HEAD',
    'refs/heads/main',
  ]) {
    await hostile(['update-ref', '--no-deref', ref, clone.evilCommit]);
  }
  await hostile(['update-ref', '--no-deref', 'HEAD', clone.evilCommit]);
  await mkdir(join(target, 'hooks'), { recursive: true });
  for (const hook of [
    'pre-auto-gc',
    'post-checkout',
    'post-merge',
    'post-index-change',
    'reference-transaction',
  ]) {
    await writeFile(join(target, 'hooks', hook), `#!/bin/sh\n${clone.script} ${hook}\n`);
    await chmod(join(target, 'hooks', hook), 0o755);
  }
  const included = join(clone.root, 'included.gitconfig');
  await writeFile(
    included,
    `[url "${clone.remotes}/github.test/owner/evil.git"]\n\tinsteadOf = https://github.test/owner/repo.git\n`,
  );
  for (const [key, value] of [
    ['core.hooksPath', join(target, 'hooks')],
    ['core.fsmonitor', clone.script],
    ['core.alternateRefsCommand', clone.script],
    ['core.sshCommand', clone.script],
    ['credential.helper', `!${clone.script}`],
    ['filter.x.smudge', `${clone.script} smudge`],
    ['filter.x.required', 'true'],
    ['include.path', included],
    ['remote.origin.url', `${clone.remotes}/github.test/owner/evil.git`],
  ] as const) {
    await hostile(['config', key, value]);
  }
  await mkdir(join(target, 'info'), { recursive: true });
  await writeFile(join(target, 'info', 'attributes'), '* filter=x\n');
  await mkdir(join(target, 'objects', 'info'), { recursive: true });
  await writeFile(join(target, 'objects', 'info', 'alternates'), `${join(bare, 'objects')}\n`);
}

/**
 * Publish an upstream change, run `plant` against the kept clone, sync, and
 * expect the clone to hold exactly the upstream tree, in the host's layout,
 * with nothing planted having run.
 */
async function expectExactSyncAfter(clone: KeptClone, plant: (commit: string) => Promise<void>) {
  const commit = await publish(clone.remotes, clone.repo, {
    ...clone.files,
    'CHANGED.md': 'upstream\n',
  });
  await plant(commit);
  const result = await syncClone(clone.options(clone.repo));
  expect(result).toMatchObject({ branch: 'main', commit, ok: true });
  const bare = join(clone.remotes, `${clone.repo}.git`);
  const tracked = (await git(bare, ['ls-tree', '-r', '--name-only', commit])).split('\n');
  expect(await treeFiles(clone.directory)).toEqual(tracked.toSorted());
  for (const path of tracked) {
    const upstream = await git(bare, ['show', `${commit}:${path}`]);
    expect((await readFile(join(clone.directory, path), 'utf8')).trim(), path).toBe(upstream);
  }
  await expectHostLayout(clone.dataDirectory);
  expect(await hostGit(clone.dataDirectory, ['config', '--get', 'remote.origin.url'])).toBe(
    `https://${clone.repo}.git`,
  );
  expect(await exists(clone.marker)).toBe(false);
  return result;
}

/** Things a writer in the work tree can leave between syncs, none of which the host trusts. */
const plantedInWorkTree: [string, (clone: KeptClone, commit: string) => Promise<void>][] = [
  [
    'a .git directory with hooks, command config, and refs naming another commit',
    async (clone) => {
      await hostileRepository(clone, join(clone.directory, '.git'));
    },
  ],
  [
    'a .git directory whose commondir names a hostile repository',
    async (clone) => {
      const common = join(clone.root, 'hostile-common');
      await hostileRepository(clone, common);
      const dotGit = join(clone.directory, '.git');
      await mkdir(dotGit, { recursive: true });
      await writeFile(join(dotGit, 'commondir'), `${common}\n`);
      await writeFile(join(dotGit, 'HEAD'), `${clone.evilCommit}\n`);
    },
  ],
  [
    'a .git gitfile naming a hostile repository',
    async (clone) => {
      const hostile = join(clone.root, 'hostile-gitfile');
      await hostileRepository(clone, hostile);
      await rm(join(clone.directory, '.git'), { force: true, recursive: true });
      await writeFile(join(clone.directory, '.git'), `gitdir: ${hostile}\n`);
    },
  ],
  [
    'a .git symlink to the host git directory',
    async ({ directory }) => {
      await symlink('../../git/CLN', join(directory, '.git'));
    },
  ],
  [
    'nested .git entries in tracked and untracked directories',
    async (clone) => {
      const hostile = join(clone.root, 'hostile-nested');
      await hostileRepository(clone, hostile);
      await writeFile(join(clone.directory, 'docs', '.git'), `gitdir: ${hostile}\n`);
      await mkdir(join(clone.directory, 'vendor', 'lib'), { recursive: true });
      await hostileRepository(clone, join(clone.directory, 'vendor', 'lib', '.GIT'));
    },
  ],
  [
    'a symlink in place of a tracked directory, naming the host git directory',
    async ({ directory }) => {
      await rm(join(directory, 'docs'), { force: true, recursive: true });
      await symlink('../../git/CLN', join(directory, 'docs'));
    },
  ],
  [
    'a symlink in place of a tracked file, naming the host git config',
    async ({ directory }) => {
      await rm(join(directory, 'README.md'), { force: true });
      await symlink('../../git/CLN/config', join(directory, 'README.md'));
    },
  ],
  [
    'untracked symlinks naming the host git directory',
    async ({ directory }) => {
      await symlink('../../git/CLN', join(directory, 'host-git'));
      await symlink('../../../git/CLN/config', join(directory, 'docs', 'config.log'));
    },
  ],
  [
    'local edits, one keeping the size and modification time',
    async ({ directory }) => {
      const readme = join(directory, 'README.md');
      const before = await stat(readme);
      await writeFile(readme, 'HELLO\n');
      await utimes(readme, before.atime, before.mtime);
      await writeFile(join(directory, 'docs', 'guide.md'), 'edited\n');
    },
  ],
  [
    'untracked and ignored files',
    async ({ directory }) => {
      await writeFile(join(directory, 'untracked.txt'), 'untracked');
      await writeFile(join(directory, 'debug.log'), 'ignored');
      await mkdir(join(directory, 'scratch', 'deep'), { recursive: true });
      await writeFile(join(directory, 'scratch', 'deep', 'file.log'), 'nested');
    },
  ],
];

test.each(plantedInWorkTree)(
  'a sync reaches the remote default branch exactly, keeping its git directory, despite %s in the work tree',
  async (_name, plantState) => {
    const clone = await keptClone();
    const result = await expectExactSyncAfter(clone, (commit) => plantState(clone, commit));
    expect(result).toMatchObject({ fresh: false });
    expect(clone.lines).toEqual([]);
  },
);

test('a planted credential helper never runs when the remote asks for credentials', async () => {
  const clone = await keptClone();
  const { base, server } = privateServer();
  try {
    await hostileRepository(clone, join(clone.directory, '.git'));
    const dotGit = { GIT_DIR: join(clone.directory, '.git') };
    for (const scope of [base.replace(/\/$/, ''), 'https://github.test']) {
      await git(clone.root, ['config', `credential.${scope}.helper`, `!${clone.script}`], dotGit);
    }
    expect(await syncClone(clone.options(clone.repo, { fetchBase: base }))).toMatchObject({
      ok: false,
      reason: 'credentials',
    });
    expect(await exists(clone.marker)).toBe(false);
  } finally {
    await server.stop(true);
  }
});

test('the commit is resolved by its full ref name, never a short name another ref could shadow', async () => {
  const clone = await keptClone();
  // Defence in depth: the git directory is the host's, but a shadowing ref there must not win.
  await hostGit(clone.dataDirectory, [
    'fetch',
    '--quiet',
    join(clone.remotes, `${clone.repo}.git`),
    'evil',
  ]);
  for (const ref of ['refs/tags/origin/HEAD', 'refs/heads/origin/HEAD', 'refs/origin/HEAD']) {
    await hostGit(clone.dataDirectory, ['update-ref', ref, clone.evilCommit]);
  }
  const result = await expectExactSyncAfter(clone, async () => {});
  expect(result).toMatchObject({ fresh: false });
});

/** Host git state a crash or a full disk can leave, each of which a fresh clone recovers from. */
const brokenGitState: [string, (clone: KeptClone) => Promise<void>][] = [
  [
    'a stale index.lock',
    async ({ gitDirectory }) => {
      await writeFile(join(gitDirectory, 'index.lock'), '');
    },
  ],
  [
    'a garbage HEAD',
    async ({ gitDirectory }) => {
      await writeFile(join(gitDirectory, 'HEAD'), 'garbage\n');
    },
  ],
  [
    'a garbage packed-refs',
    async ({ gitDirectory }) => {
      await writeFile(join(gitDirectory, 'packed-refs'), 'garbage\n');
    },
  ],
  [
    'a corrupt object the checkout needs',
    async ({ dataDirectory, directory, gitDirectory }) => {
      const oid = await hostGit(dataDirectory, ['rev-parse', 'HEAD:README.md']);
      const path = join(gitDirectory, 'objects', oid.slice(0, 2), oid.slice(2));
      await rm(path, { force: true });
      await writeFile(path, 'not an object');
      // A local edit makes the reset read the object again.
      await writeFile(join(directory, 'README.md'), 'edited\n');
    },
  ],
];

test.each(brokenGitState)(
  'a sync recovers from %s in the git directory with one fresh clone',
  async (_name, breakState) => {
    const clone = await keptClone();
    const result = await expectExactSyncAfter(clone, () => breakState(clone));
    expect(result).toMatchObject({ fresh: true });
    expect(clone.lines.filter((line) => line.includes('cloning CLN again'))).toHaveLength(1);
  },
);

test('concurrent syncs of one project run one at a time, and each ends with the clone in place', async () => {
  const { dataDirectory, options, remotes } = await fixture();
  const commit = await publish(remotes, 'github.test/owner/repo', { 'README.md': 'hello\n' });
  const results = await Promise.all(
    Array.from({ length: 4 }, () => syncClone(options('github.test/owner/repo'))),
  );
  for (const result of results) {
    expect(result).toMatchObject({ commit, ok: true });
  }
  expect(results.filter((result) => result.ok && result.fresh)).toHaveLength(1);
  expect(await readFile(join(dataDirectory, 'clones', 'CLN', 'README.md'), 'utf8')).toBe('hello\n');
});

test('a filesystem failure is a typed failure, never a throw', async () => {
  const { options, remotes, root } = await fixture();
  await publish(remotes, 'github.test/owner/repo', { 'README.md': 'hello\n' });
  const file = join(root, 'not-a-directory');
  await writeFile(file, 'file');
  const result = await syncClone({ ...options('github.test/owner/repo'), dataDirectory: file });
  expect(result).toMatchObject({ ok: false, reason: 'filesystem' });
  expect(result.ok ? '' : result.message).not.toContain('\n');
});

test('a sync reports the clone by its real path', async () => {
  const { options, remotes, root } = await fixture();
  await publish(remotes, 'github.test/owner/repo', { 'README.md': 'hello\n' });
  const real = join(root, 'real-data');
  await mkdir(real);
  const linked = join(root, 'linked-data');
  await symlink(real, linked);
  const result = await syncClone({ ...options('github.test/owner/repo'), dataDirectory: linked });
  expect(result).toMatchObject({
    directory: await realpath(join(real, 'clones', 'CLN')),
    ok: true,
  });
});

test('production git refuses every protocol but https', async () => {
  const { remotes, root } = await fixture();
  await publish(remotes, 'github.test/owner/repo', { 'README.md': 'hello\n' });
  const env = gitEnvironment(undefined, undefined);
  for (const url of [
    `file://${remotes}/github.test/owner/repo.git`,
    'http://127.0.0.1:9/owner/repo.git',
    `ext::sh -c touch% ${join(root, 'ran')}`,
  ]) {
    const listed = spawnSync('git', ['ls-remote', url], { cwd: root, encoding: 'utf8', env });
    expect(listed.status, url).not.toBe(0);
    expect(listed.stderr, url).toMatch(/transport '\w+' not allowed/);
  }
  expect(await exists(join(root, 'ran'))).toBe(false);
});

test('the credential helper answers only for the repository path a credential names', async () => {
  const { root } = await fixture();
  const file = join(root, 'git-credentials');
  await writeFile(file, 'https://alice:s3cret-token@github.test/owner/repo.git\n');
  const env = gitEnvironment(file, undefined);
  const fill = (path: string) =>
    spawnSync('git', ['credential', 'fill'], {
      cwd: root,
      encoding: 'utf8',
      env,
      input: `protocol=https\nhost=github.test\npath=${path}\n\n`,
    });
  const matched = fill('owner/repo.git');
  expect(matched.status).toBe(0);
  expect(matched.stdout).toContain('username=alice\npassword=s3cret-token\n');
  for (const sibling of ['owner/repo2.git', 'owner/other.git']) {
    const refused = fill(sibling);
    expect(refused.status, sibling).not.toBe(0);
    expect(refused.stdout, sibling).not.toContain('s3cret-token');
  }
  expect(await readFile(file, 'utf8')).toBe(
    'https://alice:s3cret-token@github.test/owner/repo.git\n',
  );
});

type SeenRequest = { authorization: string | null; method: string; path: string };

/** A local HTTP server that records every request and answers with `respond`. */
function recordingServer(respond: (request: Request) => Response | Promise<Response>) {
  const seen: SeenRequest[] = [];
  const server = Bun.serve({
    fetch: (request) => {
      seen.push({
        authorization: request.headers.get('authorization'),
        method: request.method,
        path: new URL(request.url).pathname,
      });
      return respond(request);
    },
    hostname: '127.0.0.1',
    port: 0,
  });
  return { base: `http://127.0.0.1:${String(server.port)}/`, seen, server };
}

const authorized = (request: Request) => request.headers.get('authorization') !== null;

const challenge = () =>
  new Response('authentication required', {
    headers: { 'www-authenticate': 'Basic realm="fixture"' },
    status: 401,
  });

/** A smart-HTTP ref advertisement for the bare repository at `bare`. */
async function advertisement(bare: string): Promise<Response> {
  const { stdout } = await run(
    'git',
    ['upload-pack', '--stateless-rpc', '--advertise-refs', bare],
    { encoding: 'buffer', env: { GIT_CONFIG_GLOBAL: '/dev/null', PATH: process.env.PATH } },
  );
  const header = '# service=git-upload-pack\n';
  const line = `${(header.length + 4).toString(16).padStart(4, '0')}${header}0000`;
  return new Response(Buffer.concat([Buffer.from(line), stdout]), {
    headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
  });
}

/**
 * Redirects (MMR-631 review): the credential for the remote's own URL is never
 * sent to another host a redirect names, whether the redirect comes before the
 * credential, after it on the initial request, or on a later request.
 */
test('a redirect never carries the credential to another host', async () => {
  const { options, remotes, root } = await fixture();
  const bare = join(remotes, 'github.test/owner/private.git');
  await publish(remotes, 'github.test/owner/private', { 'README.md': 'private\n' });
  const target = recordingServer(challenge);
  const elsewhere = (request: Request) => {
    const url = new URL(request.url);
    return Response.redirect(`${target.base}${url.pathname.slice(1)}${url.search}`);
  };
  // What each scenario proved on git 2.47.3 and 2.56: whether the origin got the
  // credential, and whether git followed the redirect to the other host at all.
  const scenarios: [
    string,
    (request: Request) => Response | Promise<Response>,
    { originAuthorized: boolean; targetContacted: boolean },
  ][] = [
    ['before the credential', elsewhere, { originAuthorized: false, targetContacted: true }],
    [
      'after the credential, on the initial request',
      (request) => (authorized(request) ? elsewhere(request) : challenge()),
      { originAuthorized: true, targetContacted: true },
    ],
    [
      'on a later request',
      (request) => {
        if (!authorized(request)) {
          return challenge();
        }
        return request.method === 'GET'
          ? advertisement(bare)
          : Response.redirect(`${target.base}github.test/owner/private.git/git-upload-pack`, 307);
      },
      { originAuthorized: true, targetContacted: false },
    ],
  ];
  try {
    for (const [name, respond, expected] of scenarios) {
      const origin = recordingServer(respond);
      try {
        const file = join(root, 'git-credentials');
        await writeFile(
          file,
          `${origin.base.replace('http://', 'http://alice:s3cret-token@')}github.test/owner/private.git\n`,
        );
        const credentials = { configured: true, file, problem: undefined } as const;
        const result = await syncClone(
          options('github.test/owner/private', { credentials, fetchBase: origin.base }),
        );
        expect(result.ok, name).toBe(false);
        expect(
          origin.seen.some(({ authorization }) => authorization !== null),
          name,
        ).toBe(expected.originAuthorized);
        expect(target.seen.length > 0, name).toBe(expected.targetContacted);
        expect(
          target.seen.filter(({ authorization }) => authorization !== null),
          name,
        ).toEqual([]);
        target.seen.length = 0;
      } finally {
        await origin.server.stop(true);
      }
    }
  } finally {
    await target.server.stop(true);
  }
});
