import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installBinary, readInstallationAt, registerInstallation, scriptVouch } from './index';
import type { InstallationPaths } from './index';
import { protocolCandidate } from './test-fixtures';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mimir-installation-'));
  roots.push(root);
  const executable = join(root, 'mimir');
  writeFileSync(executable, 'candidate');
  return {
    executable,
    paths: { cache: join(root, 'cache'), config: join(root, 'config'), data: join(root, 'data') },
  };
}
test('only a registered executable gains installation bindings', () => {
  const options = fixture();
  expect(readInstallationAt(options.executable)).toBeUndefined();
  const installed = registerInstallation({ ...options, mode: 'live' });
  expect(readInstallationAt(options.executable)).toEqual(installed);
  expect(installed.paths).toEqual(options.paths);
});

test('replaced executable fails closed instead of keeping live paths', () => {
  const options = fixture();
  registerInstallation({ ...options, mode: 'live' });
  writeFileSync(options.executable, 'different candidate');
  expect(() => readInstallationAt(options.executable)).toThrow('does not match');
});

/** What Loom's installer record says for an executable as it is now. */
function vouchFor(executable: string, livePaths: InstallationPaths) {
  const sha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
  return {
    installation: { path: executable, sha256 },
    livePaths: () => livePaths,
  };
}

test('a script installation Loom recorded is adopted as live, binding the directories once', () => {
  const options = fixture();
  const adopted = readInstallationAt(
    options.executable,
    vouchFor(options.executable, options.paths),
  );
  expect(adopted).toMatchObject({
    executable: realpathSync(options.executable),
    mode: 'live',
    paths: options.paths,
  });
  // Once adopted, the receipt alone binds the run; other directories cannot redirect it.
  const elsewhere = {
    cache: '/elsewhere/cache',
    config: '/elsewhere/config',
    data: '/x/data',
  };
  expect(readInstallationAt(options.executable)).toEqual(adopted);
  expect(readInstallationAt(options.executable, vouchFor(options.executable, elsewhere))).toEqual(
    adopted,
  );
});

test('a script record for other bytes or another path grants nothing', () => {
  const options = fixture();
  const stale = vouchFor(options.executable, options.paths);
  writeFileSync(options.executable, 'changed after the installer recorded it');
  expect(readInstallationAt(options.executable, stale)).toBeUndefined();
  const other = join(options.paths.data, '..', 'other');
  writeFileSync(other, 'changed after the installer recorded it');
  expect(readInstallationAt(options.executable, vouchFor(other, options.paths))).toBeUndefined();
  expect(existsSync(`${options.executable}.installation.json`)).toBe(false);
});

test('an install over a receipted binary keeps its bindings and records the new digest', () => {
  const options = fixture();
  const original = registerInstallation({
    ...options,
    mode: 'sandbox',
    sandboxAuthority: join(options.paths.data, 'authority.json'),
  });
  writeFileSync(options.executable, 'the release the installer verified');
  const ambient = {
    cache: '/ambient/cache',
    config: '/ambient/config',
    data: '/ambient/data',
  };
  const refreshed = readInstallationAt(options.executable, vouchFor(options.executable, ambient));
  expect(refreshed?.sha256).not.toBe(original.sha256);
  expect(refreshed).toEqual({ ...original, sha256: refreshed?.sha256 ?? '' });
  expect(readInstallationAt(options.executable)).toEqual(refreshed);
});

test('a replaced binary no script record vouches for still fails closed', () => {
  const options = fixture();
  registerInstallation({ ...options, mode: 'live' });
  const stale = vouchFor(options.executable, options.paths);
  writeFileSync(options.executable, 'replaced by hand');
  expect(() => readInstallationAt(options.executable, stale)).toThrow('does not match');
});

test('malformed receipt is an error, not an uninstalled fallback', () => {
  const options = fixture();
  writeFileSync(`${options.executable}.installation.json`, '{}');
  expect(() => readInstallationAt(options.executable)).toThrow('Invalid installation receipt');
});

test('upgrade preserves installation paths and mode while binding the new digest', () => {
  const options = fixture();
  const original = registerInstallation({
    ...options,
    mode: 'sandbox',
    sandboxAuthority: join(options.paths.data, 'authority.json'),
  });
  const source = join(options.paths.data, '..', 'new-binary');
  writeFileSync(source, protocolCandidate);
  const upgraded = installBinary({
    registration: {
      mode: 'live',
      paths: { cache: '/unused/cache', config: '/unused/config', data: '/unused/data' },
    },
    source,
    target: options.executable,
  });
  expect(upgraded.mode).toBe('sandbox');
  expect(upgraded.paths).toEqual(original.paths);
  expect(upgraded.sha256).not.toBe(original.sha256);
  expect(readInstallationAt(options.executable)).toEqual(upgraded);
});

test('invalid installation bindings fail before replacing an executable', async () => {
  const options = fixture();
  const source = join(options.paths.data, '..', 'invalid-upgrade');
  writeFileSync(source, 'new');
  expect(() =>
    installBinary({
      registration: { mode: 'live', paths: { ...options.paths, config: 'relative' } },
      source,
      target: options.executable,
    }),
  ).toThrow('absolute');
  expect(await Bun.file(options.executable).text()).toBe('candidate');
});

test('legacy candidate is rejected before replacing a registered executable', async () => {
  const options = fixture();
  const original = registerInstallation({ ...options, mode: 'live' });
  const source = join(options.paths.data, '..', 'legacy');
  writeFileSync(source, '#!/bin/sh\nprintf "legacy version\\n"\n', { mode: 0o755 });
  expect(() =>
    installBinary({
      registration: { mode: 'live', paths: options.paths },
      source,
      target: options.executable,
    }),
  ).toThrow('installation protocol');
  expect(readInstallationAt(options.executable)).toEqual(original);
  expect(await Bun.file(options.executable).text()).toBe('candidate');
});

test('candidate preflight receives empty isolated configuration and no database environment', () => {
  const options = fixture();
  const source = join(options.paths.data, '..', 'environment-probe');
  writeFileSync(
    source,
    `#!/bin/sh
[ "$1" = installation-protocol ] || exit 2
[ -z "\${MIMIR_SANDBOX_AUTHORITY:-}" ] || exit 3
[ -z "\${PGDATABASE:-}" ] || exit 4
[ -z "\${DATABASE_URL:-}" ] || exit 5
[ "$PWD" = "$HOME" ] || exit 6
[ -d "$XDG_CONFIG_HOME" ] || exit 7
[ -z "$(ls -A "$XDG_CONFIG_HOME")" ] || exit 8
printf '%s\\n' '{"installationProtocol":1}'
`,
  );
  const previous = {
    authority: process.env.MIMIR_SANDBOX_AUTHORITY,
    database: process.env.PGDATABASE,
    url: process.env.DATABASE_URL,
  };
  try {
    process.env.MIMIR_SANDBOX_AUTHORITY = '/must-not-read/authority.json';
    process.env.PGDATABASE = 'must-not-connect';
    process.env.DATABASE_URL = 'must-not-connect';
    expect(
      installBinary({
        registration: { mode: 'live', paths: options.paths },
        source,
        target: options.executable,
      }).mode,
    ).toBe('live');
  } finally {
    if (previous.authority === undefined) {
      delete process.env.MIMIR_SANDBOX_AUTHORITY;
    } else {
      process.env.MIMIR_SANDBOX_AUTHORITY = previous.authority;
    }
    if (previous.database === undefined) {
      delete process.env.PGDATABASE;
    } else {
      process.env.PGDATABASE = previous.database;
    }
    if (previous.url === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previous.url;
    }
  }
});

test("a sandbox or test authority in the environment withdraws Loom's vouch", () => {
  const sandbox = { HOME: '/home/a', MIMIR_SANDBOX_AUTHORITY: '/tmp/authority.json' };
  expect(scriptVouch(sandbox, 'linux')).toBeUndefined();
  const testRun = { HOME: '/home/a', MIMIR_TEST_POSTGRES_URL: 'postgres://x' };
  expect(scriptVouch(testRun, 'linux')).toBeUndefined();
});

/** A home whose Loom installation record (on linux) names the fixture's executable as it is now. */
function recordedHome(executable: string): string {
  const home = mkdtempSync(join(tmpdir(), 'mimir-installation-home-'));
  roots.push(home);
  const record = join(home, '.local', 'state', 'mimir', 'installation');
  mkdirSync(record, { recursive: true });
  const sha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
  writeFileSync(
    join(record, 'install.json'),
    JSON.stringify({ digest: `sha256:${sha256}`, format: 1, method: 'script', path: executable }),
  );
  return home;
}

test('a first run with an XDG root redirected beside HOME adopts nothing', () => {
  const options = fixture();
  const home = recordedHome(options.executable);
  const lines: string[] = [];
  const env = { HOME: home, XDG_DATA_HOME: options.paths.data };
  const vouch = scriptVouch(env, 'linux', (line) => lines.push(line));
  expect(readInstallationAt(options.executable, vouch)).toBeUndefined();
  expect(existsSync(`${options.executable}.installation.json`)).toBe(false);
  const fallback = join(home, '.local', 'share');
  expect(lines).toEqual([
    `mimir: Loom's installation record names this binary, but this run does not adopt it as live: XDG_DATA_HOME is ${options.paths.data}, not its default ${fallback}. To adopt the $HOME defaults, run it once with XDG_DATA_HOME unset; if the directories under XDG_DATA_HOME hold your real config, data, or cache, install with the root install.sh instead, which records them. Until then it uses the development directories beside it.\n`,
  ]);
});

test('a first run with only the home defaults adopts them and says so', () => {
  const options = fixture();
  const home = recordedHome(options.executable);
  const lines: string[] = [];
  const vouch = scriptVouch({ HOME: home }, 'linux', (line) => lines.push(line));
  const data = join(home, '.local', 'share', 'mimir');
  expect(readInstallationAt(options.executable, vouch)).toMatchObject({
    mode: 'live',
    paths: { cache: join(home, '.cache', 'mimir'), config: join(home, '.config', 'mimir'), data },
  });
  expect(lines.join('')).toContain(`adopted this installation as live, binding config`);
});
