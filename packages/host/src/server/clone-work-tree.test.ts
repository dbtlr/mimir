/**
 * The filesystem-only steps of a clone sync (clones.ts), tested without git:
 * emptying the work tree before git runs, and finding a symlink that resolves
 * outside it after the checkout. clones.test.ts keeps the end-to-end cases.
 */
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { emptyWorkTree, findEscapingSymlink } from './clones';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/**
 * A scratch data directory laid out as a sync leaves it: the work tree at
 * `<data>/clones/CLN` and its git directory, with a config, at `<data>/git/CLN`,
 * beside a directory `outside` the data directory.
 */
async function layout() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mimir-clone-work-tree-')));
  roots.push(root);
  const workTree = join(root, 'data', 'clones', 'CLN');
  const gitDirectory = join(root, 'data', 'git', 'CLN');
  const outside = join(root, 'outside');
  await mkdir(workTree, { recursive: true });
  await mkdir(gitDirectory, { recursive: true });
  await mkdir(outside);
  await writeFile(join(gitDirectory, 'config'), '[core]\n');
  return { outside, root, workTree };
}

/** Write each of `files` and make each of `links` under `directory`, making parents as needed. */
async function plant(
  directory: string,
  files: Record<string, string>,
  links: Record<string, string> = {},
) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  for (const [path, target] of Object.entries(links)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await symlink(target, join(directory, path));
  }
}

/** Make a FIFO at `path`. A reader that opens one blocks until a writer does. */
function mkfifo(path: string) {
  const made = spawnSync('mkfifo', [path], { encoding: 'utf8' });
  expect(made.status, made.stderr).toBe(0);
}

/** Give the owner rwx on every directory under `directory`, so a failed test can clean up. */
function unlock(directory: string) {
  spawnSync('chmod', ['-R', 'u+rwx', directory]);
}

/** Symlinks a commit can hold that resolve outside the clone, each the only one that does. */
const escaping: [string, Record<string, string>, string][] = [
  ['an absolute target', { 'etc-link': '/etc' }, 'etc-link'],
  ['a relative target', { 'nested/dir/up': '../../../outside' }, 'nested/dir/up'],
  ['a dangling absolute target', { gone: '/nonexistent/secret' }, 'gone'],
  // The host's git directory for this clone is outside it, at <data>/git/CLN.
  ['the host git directory', { 'host-git': '../../git/CLN' }, 'host-git'],
  ['the host git config', { 'docs/config': '../../../git/CLN/config' }, 'docs/config'],
  // Dangling, and only the kernel's walk sees it leave: deep/s is the root, so
  // deep/s/../.. is the clones directory, though the text reads as inside.
  ['a walk through a link', { a: 'deep/s/../../outside', 'deep/s': '..' }, 'a'],
  // Dangling through a link that resolves nowhere: where it lands is unknowable.
  ['a walk through a broken link', { b: 'hop/../c', hop: 'nowhere/deeper' }, 'b'],
  ['a walk into a broken link', { a: 'hop/x', hop: 'nowhere/deeper' }, 'a'],
  // Out of the clone through a path that does not exist yet.
  ['a walk through a missing path', { a: '../OTHER/x/../../CLN/later' }, 'a'],
  // `..` after a segment that does not exist yet: once it does, as a link, the
  // `..` leaves from wherever that link leads.
  ['a .. after a missing segment', { a: 'not-yet/../README.md' }, 'a'],
  // Out and back in by name: a step outside the clone passes through paths
  // another project's sync can later replace with links, so any step out refuses.
  ['a walk out and back in', { a: '../CLN/README.md' }, 'a'],
  ['a walk through a sibling clone', { a: '../OTH/d/../../CLN/README.md' }, 'a'],
];

test.each(escaping)(
  'findEscapingSymlink names a symlink that resolves outside the clone through %s',
  async (_name, links, expected) => {
    const { workTree } = await layout();
    await plant(workTree, { 'README.md': 'hello\n' }, links);
    expect(await findEscapingSymlink(workTree)).toBe(expected);
  },
);

test('findEscapingSymlink allows symlinks that stay inside the clone', async () => {
  const { workTree } = await layout();
  await plant(
    workTree,
    { 'docs/guide.md': 'guide\n' },
    {
      'docs/later': '../not-yet',
      'docs/self': '..',
      guide: 'docs/guide.md',
      // Dangling through a tracked file: it can never resolve, and never leaves.
      'through-file': 'docs/guide.md/x',
    },
  );
  expect(await findEscapingSymlink(workTree)).toBeUndefined();
});

test('emptyWorkTree unlinks symlinks to outside the clone, and leaves their targets alone', async () => {
  const { outside, workTree } = await layout();
  await plant(outside, { 'dir/keep.txt': 'keep' });
  // A mode the work tree's own directories get raised from, so a chmod that followed a link would show.
  await chmod(join(outside, 'dir'), 0o555);
  try {
    await plant(
      workTree,
      { 'docs/guide.md': 'guide\n' },
      {
        'docs/link-outside': outside,
        'link-dir': join(outside, 'dir'),
        'link-file': join(outside, 'dir', 'keep.txt'),
      },
    );
    await emptyWorkTree(workTree);
    expect(await readdir(workTree)).toEqual([]);
    expect(await readFile(join(outside, 'dir', 'keep.txt'), 'utf8')).toBe('keep');
    expect((await stat(join(outside, 'dir'))).mode & 0o777).toBe(0o555);
  } finally {
    await chmod(join(outside, 'dir'), 0o755);
  }
});

test('emptyWorkTree empties directories with modes 000 and 0500', async () => {
  const { workTree } = await layout();
  try {
    const locked = join(workTree, 'scratch', 'locked');
    await plant(workTree, {
      'docs/guide.md': 'guide\n',
      'scratch/locked/deeper/file.txt': 'planted',
    });
    await chmod(join(locked, 'deeper'), 0o000);
    await chmod(locked, 0o000);
    await chmod(join(workTree, 'docs'), 0o500);
    await chmod(workTree, 0o500);
    await emptyWorkTree(workTree);
    expect(await readdir(workTree)).toEqual([]);
    expect((await stat(workTree)).mode & 0o700).toBe(0o700);
  } finally {
    unlock(workTree);
  }
});

test('emptyWorkTree removes FIFOs without opening them', async () => {
  const { workTree } = await layout();
  await mkdir(join(workTree, 'docs'));
  mkfifo(join(workTree, '.gitattributes'));
  mkfifo(join(workTree, 'docs', '.gitattributes'));
  mkfifo(join(workTree, 'README.md'));
  // A read of any of them would block until the test times out.
  await emptyWorkTree(workTree);
  expect(await readdir(workTree)).toEqual([]);
});

test('emptyWorkTree makes a work tree replaced by a symlink a directory again, and leaves the target alone', async () => {
  const { outside, workTree } = await layout();
  await plant(outside, { 'keep.txt': 'keep' });
  await rm(workTree, { force: true, recursive: true });
  await symlink(outside, workTree);
  await emptyWorkTree(workTree);
  expect((await lstat(workTree)).isDirectory()).toBe(true);
  expect(await readdir(workTree)).toEqual([]);
  expect(await readdir(outside)).toEqual(['keep.txt']);
});

test('emptyWorkTree removes nested directories and keeps the work tree itself', async () => {
  const { workTree } = await layout();
  await plant(workTree, {
    '.git/hooks/post-checkout': '#!/bin/sh\n',
    'README.md': 'hello\n',
    'scratch/deep/deeper/file.txt': 'nested',
    'vendor/lib/.GIT/HEAD': 'ref: refs/heads/main\n',
  });
  await emptyWorkTree(workTree);
  expect((await lstat(workTree)).isDirectory()).toBe(true);
  expect(await readdir(workTree)).toEqual([]);
});
