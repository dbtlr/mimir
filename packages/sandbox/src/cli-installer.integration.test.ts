import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LocalEngine } from '../../core/src/engine';
import { readInstallationAt, registerInstallation } from '../../core/src/installation/index';
import { scriptRecordDirectory } from '../../core/src/installation/script-record';
import { createSqliteStore, openSqlite, SQLITE_FILE } from '../../core/src/store-sqlite/index';
import { fakeReleases } from './fake-releases';
import type { FakeReleases } from './fake-releases';

/**
 * The Loom CLI's installer and self-update in a sandbox installation
 * (MMR-554): `packages/cli/install.sh` installs a release build, Loom's
 * self-update replaces it with the next build, and Mimir's receipt follows
 * both, bound to the sandbox's own directories. Releases come from a fake
 * GitHub reached through a proxy, so the script and the binaries run unchanged.
 */
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const installer = join(repository, 'packages', 'cli', 'install.sh');
const enabled = process.env.MIMIR_SANDBOX_LIFECYCLE_TEST === '1';

const asset = `mimir-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

let root: string;
let releases: FakeReleases;
const builds = new Map<string, Uint8Array>();

/**
 * Compile the Loom CLI as the release build of `version`, baking the release
 * facts `loom build --release` would: self-update and packages/cli/src/version.ts
 * both read them. Building through `loom` itself would need the package's
 * version stamped for each build.
 */
async function buildRelease(version: string): Promise<Uint8Array> {
  const facts = {
    build: 'distributed',
    compiled: true,
    release: { asset, repository: 'dbtlr/mimir', version },
  };
  const outfile = join(root, 'builds', version, 'mimir');
  const build = Bun.spawn(
    [
      process.execPath,
      'build',
      join(repository, 'packages', 'cli', 'src', 'main.ts'),
      '--compile',
      '--define',
      `__LOOM_RELEASE__=${JSON.stringify(facts)}`,
      '--outfile',
      outfile,
    ],
    { cwd: repository, stderr: 'pipe', stdout: 'pipe' },
  );
  if ((await build.exited) !== 0) {
    throw new Error(await new Response(build.stderr).text());
  }
  return new Uint8Array(await readFile(outfile));
}

beforeAll(async () => {
  if (!enabled) {
    return;
  }
  root = await realpath(await mkdtemp(join(tmpdir(), 'mimir-cli-install-')));
  await mkdir(join(root, 'tls'));
  releases = await fakeReleases(join(root, 'tls'));
  const [first, second] = await Promise.all([buildRelease('1.0.0'), buildRelease('1.1.0')]);
  builds.set('1.0.0', first);
  builds.set('1.1.0', second);
  for (const [version, bytes] of builds) {
    releases.publish(version, {
      SHA256SUMS: `${sha256(bytes)}  ${asset}\n`,
      [asset]: bytes,
    });
  }
  // The next lane: a prerelease the feed lists, which --check resolves without downloading.
  releases.publish('1.2.0-next.1', {
    SHA256SUMS: `${'0'.repeat(64)}  ${asset}\n`,
  });
  releases.feed(['1.2.0-next.1', '1.1.0', '1.0.0']);
  releases.latest('1.1.0');
}, 120_000);

afterAll(async () => {
  if (!enabled) {
    return;
  }
  await releases.close();
  await rm(root, { force: true, recursive: true });
});

/** A finished child: `out` is both streams, for assertions that do not care which. */
type Run = { code: number; out: string; stdout: string; stderr: string };

async function run(args: string[], env: Record<string, string>): Promise<Run> {
  const child = Bun.spawn(args, {
    cwd: root,
    env,
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, out: `${stdout}${stderr}`, stderr, stdout };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A sandbox: its own home, whose default Mimir directories hold a board. The
 * `home` environment sets no XDG roots, so an adoption binds those defaults;
 * the `redirected` one points every XDG root but the state root, which holds
 * Loom's record on linux, somewhere else.
 */
async function sandbox(name: string) {
  const base = join(root, name);
  const home = join(base, 'home');
  const paths = {
    cache: join(home, '.cache', 'mimir'),
    config: join(home, '.config', 'mimir'),
    data: join(home, '.local', 'share', 'mimir'),
  };
  await mkdir(paths.data, { recursive: true });
  const handle = await openSqlite(join(paths.data, SQLITE_FILE));
  const engine = new LocalEngine(createSqliteStore(handle.db));
  await engine.create({ key: 'MMR', name: 'mimir', type: 'project' });
  await engine.create({ parent: 'MMR', title: `The ${name} board`, type: 'initiative' });
  await handle.close();
  const common = {
    ...releases.env,
    HOME: home,
    NO_COLOR: '1',
    PATH: '/usr/bin:/bin',
    TMPDIR: tmpdir(),
  };
  const elsewhere = join(base, 'elsewhere');
  const redirected = {
    ...common,
    XDG_CACHE_HOME: join(elsewhere, 'cache'),
    XDG_CONFIG_HOME: join(elsewhere, 'config'),
    XDG_DATA_HOME: join(elsewhere, 'data'),
  };
  const env = (roots: 'home' | 'redirected'): Record<string, string> =>
    roots === 'home' ? common : redirected;
  const bin = join(base, 'bin');
  return { bin, env, paths, target: join(bin, 'mimir') };
}

/** The title of MMR-1, as the installed binary reads it from the store it is bound to. */
async function boardTitle(target: string, env: Record<string, string>): Promise<string> {
  const read = await run([target, 'get', 'MMR-1', '-f', 'json'], env);
  expect(read.code, read.out).toBe(0);
  return (JSON.parse(read.stdout) as { title: string }).title;
}

async function loomRecord(env: Record<string, string>): Promise<unknown> {
  const directory = scriptRecordDirectory(env, process.platform) ?? '';
  return JSON.parse(await readFile(join(directory, 'install.json'), 'utf8'));
}

// The installer's own steps are the subject below; its post-install command, which
// runs the installed binary, has a test of its own.
test.skipIf(!enabled)(
  'install.sh installs a release, self-update replaces it, and the receipt keeps its bindings',
  async () => {
    const box = await sandbox('fresh');
    const first = builds.get('1.0.0') ?? new Uint8Array();
    const second = builds.get('1.1.0') ?? new Uint8Array();

    const installed = await run(
      ['sh', installer, '--dir', box.bin, '--skip-post-install', '1.0.0'],
      box.env('home'),
    );
    expect(installed.code, installed.out).toBe(0);
    expect(installed.out).toContain(`Installed ${box.target}.`);
    expect(await loomRecord(box.env('home'))).toEqual({
      digest: `sha256:${sha256(first)}`,
      format: 1,
      method: 'script',
      path: box.target,
    });

    // A first run whose XDG roots are not HOME's defaults adopts nothing. Its
    // development config names Postgres, whose access check reads the
    // installation again, and the refusal still prints once.
    const development = join(box.bin, '.dev', 'config', 'mimir');
    await mkdir(development, { recursive: true });
    await writeFile(
      join(development, 'config.toml'),
      '[store]\nbackend = "postgres"\nurl = "postgres://127.0.0.1:1/mimir"\n',
    );
    const declined = await run([box.target, 'get', 'MMR-1', '-f', 'json'], box.env('redirected'));
    expect(declined.code).not.toBe(0);
    expect(declined.stderr.split('does not adopt it as live: XDG_')).toHaveLength(2);
    expect(declined.stderr).toContain(
      'run it once with XDG_CACHE_HOME, XDG_CONFIG_HOME, and XDG_DATA_HOME unset',
    );
    expect(declined.out).not.toContain('The fresh board');
    expect(readInstallationAt(box.target)).toBeUndefined();
    await rm(join(box.bin, '.dev'), { force: true, recursive: true });

    // A first run with HOME's defaults adopts the script installation, binding them.
    const firstRun = await run([box.target, 'get', 'MMR-1', '-f', 'json'], box.env('home'));
    expect(firstRun.code, firstRun.out).toBe(0);
    expect(firstRun.stderr).toContain(
      `adopted this installation as live, binding config ${box.paths.config}`,
    );
    expect((JSON.parse(firstRun.stdout) as { title: string }).title).toBe('The fresh board');
    const adopted = readInstallationAt(box.target);
    if (adopted === undefined) {
      throw new Error('the first run registered no receipt');
    }
    expect(adopted).toMatchObject({ mode: 'live', paths: box.paths, sha256: sha256(first) });
    // Later environments cannot redirect the registered installation.
    expect(await boardTitle(box.target, box.env('redirected'))).toBe('The fresh board');

    // `mimir version` and self-update read the same build version.
    expect((await run([box.target, 'version'], box.env('redirected'))).stdout).toBe('1.0.0\n');
    const check = await run([box.target, 'self-update', '--check'], box.env('redirected'));
    expect(check.code, check.out).toBe(0);
    expect(check.out).toContain('mimir can update from 1.0.0 to 1.1.0 on the stable channel.');
    const updated = await run([box.target, 'self-update'], box.env('redirected'));
    expect(updated.code, updated.out).toBe(0);
    expect(updated.out).toContain('Updated mimir from 1.0.0 to 1.1.0.');
    expect(sha256(new Uint8Array(await readFile(box.target)))).toBe(sha256(second));

    // The next run re-records the receipt for the new bytes, its bindings kept.
    expect(await boardTitle(box.target, box.env('redirected'))).toBe('The fresh board');
    expect(readInstallationAt(box.target)).toEqual({ ...adopted, sha256: sha256(second) });
    expect((await run([box.target, 'version'], box.env('redirected'))).stdout).toBe('1.1.0\n');
    const current = await run([box.target, 'self-update'], box.env('redirected'));
    expect(current.out).toContain('mimir 1.1.0 is the newest release on the stable channel.');
    // The next lane replaces MIMIR_NEXT=1.
    const next = await run(
      [box.target, 'self-update', '--channel', 'next', '--check'],
      box.env('redirected'),
    );
    expect(next.code, next.out).toBe(0);
    expect(next.out).toContain('mimir can update from 1.1.0 to 1.2.0-next.1 on the next channel.');

    // A copy no installer recorded is refused, and gains no live directories.
    const copied = join(root, 'fresh', 'copied', 'mimir');
    await mkdir(join(copied, '..'));
    await copyFile(box.target, copied);
    const refused = await run([copied, 'self-update'], box.env('home'));
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('mimir was installed some other way');
    const unbound = await run([copied, 'get', 'MMR-1', '-f', 'json'], box.env('home'));
    expect(unbound.code).toBe(1);
    // A refusal from the isolated defaults, not a crash, and never the sandbox's board.
    expect(unbound.out).not.toContain('The fresh board');
    expect(unbound.out).not.toMatch(/Cannot find module|TypeError|at .*\.ts:\d+/);
    expect(readInstallationAt(copied)).toBeUndefined();

    // Bytes swapped in by hand, behind both records, fail closed. They land through a
    // rename: macOS can SIGKILL a signed binary whose bytes were rewritten in place.
    const swap = `${box.target}.swap`;
    await writeFile(swap, first);
    await chmod(swap, 0o755);
    await rename(swap, box.target);
    const swapped = await run([box.target, 'get', 'MMR-1', '-f', 'json'], box.env('home'));
    expect(swapped.code).not.toBe(0);
    expect(swapped.out, `exit ${String(swapped.code)}`).toContain('does not match its receipt');
  },
  120_000,
);

test.skipIf(!enabled)(
  "install.sh over an old installer's receipt keeps its directories, not the ambient ones",
  async () => {
    const box = await sandbox('upgrade');
    await mkdir(box.bin, { recursive: true });
    await writeFile(box.target, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    const receipt = registerInstallation({
      executable: box.target,
      mode: 'live',
      paths: box.paths,
    });
    const installed = await run(
      ['sh', installer, '--dir', box.bin, '--skip-post-install'],
      box.env('redirected'),
    );
    expect(installed.code, installed.out).toBe(0);
    expect(installed.out).toContain('Downloading');
    expect(await boardTitle(box.target, box.env('redirected'))).toBe('The upgrade board');
    expect(readInstallationAt(box.target)).toEqual({
      ...receipt,
      sha256: sha256(builds.get('1.1.0') ?? new Uint8Array()),
    });
  },
  120_000,
);

test.skipIf(!enabled)(
  'install.sh registers the MCP server with Claude Code, and the binary is adopted by that run',
  async () => {
    const box = await sandbox('post-install');
    // A stand-in Claude Code: it records its calls and succeeds, so nothing real registers.
    const agents = join(root, 'post-install', 'agents');
    const log = join(agents, 'claude.log');
    await mkdir(agents, { recursive: true });
    await writeFile(join(agents, 'claude'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CLAUDE_LOG"\n', {
      mode: 0o755,
    });
    const env = { ...box.env('home'), CLAUDE_LOG: log, PATH: `${agents}:/usr/bin:/bin` };

    const installed = await run(['sh', installer, '--dir', box.bin, '1.0.0'], env);
    expect(installed.code, installed.out).toBe(0);
    expect(installed.out).toContain('Running the post-install command');
    expect(installed.out).toContain(`Registered mimir with claude to run ${box.target} mcp.`);
    expect(installed.out).toContain('mimir bind');
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual([
      '--version',
      `mcp add -s user mimir -- ${box.target} mcp`,
    ]);
    // The post-install run is the binary's first run, so it adopts the $HOME defaults.
    expect(readInstallationAt(box.target)).toMatchObject({ mode: 'live', paths: box.paths });
    expect(await boardTitle(box.target, box.env('redirected'))).toBe('The post-install board');

    // Skipping it runs nothing and says how to run it later.
    await rm(log, { force: true });
    const skipped = await run(
      ['sh', installer, '--dir', box.bin, '--skip-post-install', '1.0.0'],
      env,
    );
    expect(skipped.code, skipped.out).toBe(0);
    expect(skipped.out).toContain('Skipped the post-install command');
    expect(await Bun.file(log).exists()).toBe(false);
  },
  120_000,
);
