import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readSandboxAuthority, assertSandboxPostgresUrl } from './sandbox-authority';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mimir-authority-')));
  const paths = {
    cache: join(root, 'cache', 'mimir'),
    config: join(root, 'config', 'mimir'),
    data: join(root, 'data', 'mimir'),
  };
  for (const path of Object.values(paths)) {
    mkdirSync(path, { recursive: true });
  }
  const value = {
    containerId: 'a'.repeat(64),
    id: '12345678-1234-4234-8234-123456789012',
    image: `postgres:18.6-alpine@sha256:${'b'.repeat(64)}`,
    paths,
    postgresUrl: `postgres://mimir_sandbox:${'c'.repeat(64)}@127.0.0.1:15432/mimir_sandbox`,
    root,
    version: 1,
  };
  const file = join(root, 'authority.json');
  writeFileSync(file, JSON.stringify(value));
  return { close: () => rmSync(root, { force: true, recursive: true }), file, root, value };
}

test('sandbox authorizes its generated endpoint and a generated test schema only', () => {
  const f = fixture();
  try {
    const authority = readSandboxAuthority(f.file);
    expect(() => assertSandboxPostgresUrl(f.value.postgresUrl, authority)).not.toThrow();
    expect(() =>
      assertSandboxPostgresUrl(
        `${f.value.postgresUrl}?options=${encodeURIComponent(`-c search_path=mimir_test_${'d'.repeat(32)}`)}`,
        authority,
      ),
    ).not.toThrow();
    for (const url of [
      'postgres://live:secret@production.example/live',
      f.value.postgresUrl.replace('15432', '5432'),
      `${f.value.postgresUrl}?host=production.example`,
      `${f.value.postgresUrl}?options=-c%20search_path=public`,
      `${f.value.postgresUrl}?sslmode=disable`,
    ]) {
      expect(() => assertSandboxPostgresUrl(url, authority)).toThrow('sandbox');
    }
  } finally {
    f.close();
  }
});

test('authority rejects paths escaping its owned root and a substituted endpoint', () => {
  const f = fixture();
  try {
    writeFileSync(
      f.file,
      JSON.stringify({ ...f.value, postgresUrl: 'postgres://live:secret@production.example/live' }),
    );
    expect(() => readSandboxAuthority(f.file)).toThrow('sandbox');
    writeFileSync(f.file, JSON.stringify(f.value));
    rmSync(f.value.paths.config, { recursive: true });
    symlinkSync(tmpdir(), f.value.paths.config);
    expect(() => readSandboxAuthority(f.file)).toThrow('sandbox');
  } finally {
    f.close();
  }
});

test('sandbox configuration cannot be a symlink to an external installation', () => {
  const f = fixture();
  try {
    const external = join(f.root, 'external-config.toml');
    writeFileSync(external, '[store]\nbackend = "postgres"\n');
    symlinkSync(external, join(f.value.paths.config, 'config.toml'));
    expect(() => readSandboxAuthority(f.file)).toThrow('sandbox');
  } finally {
    f.close();
  }
});
