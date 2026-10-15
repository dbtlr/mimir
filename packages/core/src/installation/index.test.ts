import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installBinary, readInstallationAt, registerInstallation } from './index';
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
