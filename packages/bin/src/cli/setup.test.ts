import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expectMimirError } from '../core/testing';
import { bunExec } from '../exec';
import type { ServiceDeps } from '../service';
import { readConfig } from '../service/config';
import type { ServiceInfo, Supervisor } from '../service/launchd';
import { plistFor, plistForSnapshot } from '../service/plist';
import type { VaultDeps } from '../vault/commands';
import { MARKER_FILE } from '../vault/schema';
import { cmdSetup } from './setup';
import type { SetupDeps } from './setup';
import { fakeIo } from './testing';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mimir-setup-'));
});
afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

class FakeSupervisor implements Supervisor {
  calls: string[] = [];
  state: ServiceInfo = { loaded: false, running: false };
  install(): Promise<void> {
    this.calls.push('install');
    return Promise.resolve();
  }
  uninstall(): Promise<void> {
    this.calls.push('uninstall');
    return Promise.resolve();
  }
  start(): Promise<void> {
    this.calls.push('start');
    return Promise.resolve();
  }
  stop(): Promise<void> {
    this.calls.push('stop');
    return Promise.resolve();
  }
  restart(): Promise<void> {
    this.calls.push('restart');
    return Promise.resolve();
  }
  info(): Promise<ServiceInfo> {
    return Promise.resolve(this.state);
  }
}

function deps(
  serve: FakeSupervisor,
  snap: FakeSupervisor,
  platform: NodeJS.Platform = 'darwin',
): SetupDeps {
  const service: ServiceDeps = {
    binPath: join(dir, 'mimir'),
    configFile: join(dir, 'config.toml'),
    eventsFile: join(dir, 'service-events.jsonl'),
    fetcher: () => Promise.reject(new Error('no network in tests')),
    health: () => Promise.resolve(undefined),
    platform,
    units: {
      serve: {
        logFile: join(dir, 'serve.log'),
        plistFile: join(dir, 'com.dbtlr.mimir.serve.plist'),
        render: () => plistFor(join(dir, 'mimir'), {}),
        supervisor: serve,
      },
      snapshot: {
        logFile: join(dir, 'snapshot.log'),
        plistFile: join(dir, 'com.dbtlr.mimir.snapshot.plist'),
        render: () => plistForSnapshot(join(dir, 'mimir'), { intervalSeconds: 900 }),
        supervisor: snap,
      },
    },
    version: '0.5.0',
  };
  const vault: VaultDeps = {
    exec: bunExec,
    resolveVault: () => ({ allowCreate: true, path: join(dir, 'vault'), source: 'default' }),
    snapshotConfig: () => ({}),
    stamp: () => '2026-07-03T00:00:00.000Z',
  };
  return { defaultVaultPath: join(dir, 'vault'), service, vault };
}

test('non-TTY without -y refuses (a piped setup never acts silently)', async () => {
  const d = deps(new FakeSupervisor(), new FakeSupervisor());
  const io = fakeIo(false);
  let message = '';
  try {
    await cmdSetup({}, io, d, 'records');
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toMatch(/needs a TTY/);
});

test('-y converges a fresh vault and writes [vault] path — no units by default', async () => {
  const serve = new FakeSupervisor();
  const snap = new FakeSupervisor();
  const d = deps(serve, snap);
  const io = fakeIo(false);
  const code = await cmdSetup({ vault: join(dir, 'vault'), yes: true }, io, d, 'records');
  expect(code).toBe(0);
  expect(existsSync(join(dir, 'vault', MARKER_FILE))).toBe(true);
  expect(readConfig(d.service.configFile)).toEqual({
    serve: {},
    store: {},
    vault: { path: join(dir, 'vault') },
  });
  expect(serve.calls).toEqual([]);
  expect(snap.calls).toEqual([]);
  expect(io.out.join('\n')).toContain('setup complete');
});

test('--install-service --port installs the serve unit and persists the port', async () => {
  const serve = new FakeSupervisor();
  const snap = new FakeSupervisor();
  const d = deps(serve, snap);
  const io = fakeIo(false);
  const code = await cmdSetup(
    { installService: true, port: '50130', vault: join(dir, 'vault'), yes: true },
    io,
    d,
    'records',
  );
  expect(code).toBe(0);
  expect(serve.calls).toEqual(['install']);
  expect(snap.calls).toEqual([]);
  expect(readConfig(d.service.configFile)).toEqual({
    serve: { port: 50130 },
    store: {},
    vault: { path: join(dir, 'vault') },
  });
});

test('--port persists to [serve] even without --install-service (serve reads it)', async () => {
  const serve = new FakeSupervisor();
  const snap = new FakeSupervisor();
  const d = deps(serve, snap);
  const io = fakeIo(false);
  const code = await cmdSetup(
    { port: '50131', vault: join(dir, 'vault'), yes: true },
    io,
    d,
    'records',
  );
  expect(code).toBe(0);
  expect(serve.calls).toEqual([]);
  expect(readConfig(d.service.configFile).serve).toEqual({ port: 50131 });
});

test('--install-snapshot writes [vault.snapshot] and installs the snapshot unit', async () => {
  const serve = new FakeSupervisor();
  const snap = new FakeSupervisor();
  const d = deps(serve, snap);
  const io = fakeIo(false);
  const code = await cmdSetup(
    {
      installSnapshot: true,
      snapshotInterval: '600',
      upstream: 'git@host:me/v.git',
      vault: join(dir, 'vault'),
      yes: true,
    },
    io,
    d,
    'records',
  );
  expect(code).toBe(0);
  expect(serve.calls).toEqual([]);
  expect(snap.calls).toEqual(['install']);
  expect(readConfig(d.service.configFile).vault).toEqual({
    path: join(dir, 'vault'),
    snapshot: { interval: 600, upstream: 'git@host:me/v.git' },
  });
});

test('both units install in one sweep', async () => {
  const serve = new FakeSupervisor();
  const snap = new FakeSupervisor();
  const d = deps(serve, snap);
  const io = fakeIo(false);
  await cmdSetup(
    { installService: true, installSnapshot: true, vault: join(dir, 'vault'), yes: true },
    io,
    d,
    'records',
  );
  expect(serve.calls).toEqual(['install']);
  expect(snap.calls).toEqual(['install']);
});

test('a foreign non-empty directory is refused, not adopted', async () => {
  const foreign = join(dir, 'foreign');
  mkdirSync(foreign);
  writeFileSync(join(foreign, 'someones-file.txt'), 'hello');
  const d = deps(new FakeSupervisor(), new FakeSupervisor());
  const io = fakeIo(false);
  await expectMimirError('conflict', () =>
    cmdSetup({ vault: foreign, yes: true }, io, d, 'records'),
  );
});

test('json format emits one object and suppresses the service install transcript', async () => {
  const serve = new FakeSupervisor();
  const snap = new FakeSupervisor();
  const d = deps(serve, snap);
  const io = fakeIo(false);
  const code = await cmdSetup(
    { installService: true, vault: join(dir, 'vault'), yes: true },
    io,
    d,
    'json',
  );
  expect(code).toBe(0);
  // Exactly one stdout write, and it's setup's own envelope.
  expect(io.out).toHaveLength(1);
  const parsed = JSON.parse(io.out[0] ?? '') as {
    vault: { outcome: string; path: string };
    service: { ok: boolean; units: string[] };
    configFile: string;
  };
  expect(parsed.vault.outcome).toBe('created');
  expect(parsed.service).toEqual({ ok: true, units: ['serve'] });
});

test('off darwin, install flags are ignored (launchd unavailable) but vault + config still land', async () => {
  const serve = new FakeSupervisor();
  const snap = new FakeSupervisor();
  const d = deps(serve, snap, 'linux');
  const io = fakeIo(false);
  const code = await cmdSetup(
    { installService: true, vault: join(dir, 'vault'), yes: true },
    io,
    d,
    'records',
  );
  expect(code).toBe(0);
  expect(serve.calls).toEqual([]);
  expect(existsSync(join(dir, 'vault', MARKER_FILE))).toBe(true);
});
