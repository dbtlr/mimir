import { afterEach, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { syncClone } from './clones';
import type { CloneSyncOptions } from './clones';
import { gitCredentialsWarnings, readGitCredentials } from './git-credentials';

const run = promisify(execFile);

/** Fixture git, isolated from the operator's own git configuration. */
async function git(cwd: string, args: string[]) {
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
    },
  });
  return stdout.trim();
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
  { branch = 'main', links = {} }: { branch?: string; links?: Record<string, string> } = {},
) {
  const bare = join(remotes, `${remote}.git`);
  const work = `${bare}.work`;
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
  await git(bare, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
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
  const directory = join(dataDirectory, 'clones', 'CLN');
  expect(first).toEqual({ branch: 'main', commit, directory, fresh: true, ok: true });
  expect(await readFile(join(directory, 'README.md'), 'utf8')).toBe('hello\n');
  expect(await git(directory, ['config', '--get', 'remote.origin.url'])).toBe(
    'https://github.test/owner/repo.git',
  );
  expect(await syncClone(options('github.test/owner/repo'))).toEqual({
    branch: 'main',
    commit,
    directory,
    fresh: false,
    ok: true,
  });
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
  expect(await git(directory, ['config', '--get', 'remote.origin.url'])).toBe(
    'https://github.test/owner/new.git',
  );
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
    const config = await readFile(join(dataDirectory, 'clones', 'CLN', '.git', 'config'), 'utf8');
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

test('hooks and command config planted in a clone never run during a sync', async () => {
  const { dataDirectory, options, remotes, root } = await fixture();
  await publish(remotes, 'github.test/owner/repo', { 'README.md': 'hello\n' });
  await syncClone(options('github.test/owner/repo'));
  const directory = join(dataDirectory, 'clones', 'CLN');
  const marker = join(root, 'ran');
  const script = join(root, 'planted.sh');
  await writeFile(script, `#!/bin/sh\necho "$0" >> ${marker}\n`);
  await chmod(script, 0o755);
  await mkdir(join(directory, '.git', 'hooks'), { recursive: true });
  for (const hook of ['reference-transaction', 'post-checkout', 'post-merge', 'pre-auto-gc']) {
    await writeFile(join(directory, '.git', 'hooks', hook), `#!/bin/sh\n${script}\n`);
    await chmod(join(directory, '.git', 'hooks', hook), 0o755);
  }
  await git(directory, ['config', 'core.fsmonitor', script]);
  await git(directory, ['config', 'credential.helper', `!${script}`]);
  await publish(remotes, 'github.test/owner/repo', { 'README.md': 'changed\n' });
  expect(await syncClone(options('github.test/owner/repo'))).toMatchObject({
    fresh: false,
    ok: true,
  });
  expect(await readFile(join(directory, 'README.md'), 'utf8')).toBe('changed\n');
  expect(await exists(marker)).toBe(false);
});
