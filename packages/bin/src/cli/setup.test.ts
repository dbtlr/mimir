import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { expectMimirError } from '../core/testing';
import { bunExec } from '../exec';
import type { ServiceDeps } from '../service';
import { readConfig } from '../service/config';
import type { ServiceInfo, Supervisor } from '../service/launchd';
import { plistFor, plistForSnapshot } from '../service/plist';
import { SERVE_LABEL, SNAPSHOT_LABEL } from '../service/units';
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

/**
 * The setup deps over `dir`. Most cases drive the Norn arm — the one that owns
 * a vault and its snapshot timer — so the config starts fenced to it; a case
 * for the default local tier passes `backend: null` for an absent `[store]`.
 */
function deps(
  serve: FakeSupervisor,
  snap: FakeSupervisor,
  platform: NodeJS.Platform = 'darwin',
  backend: 'norn' | null = 'norn',
): SetupDeps {
  if (backend !== null) {
    writeFileSync(join(dir, 'config.toml'), `[store]\nbackend = "${backend}"\n`);
  }
  const service: ServiceDeps = {
    binPath: join(dir, 'mimir'),
    configFile: join(dir, 'config.toml'),
    defaultPort: 64647,
    eventsFile: join(dir, 'service-events.jsonl'),
    fetcher: () => Promise.reject(new Error('no network in tests')),
    health: () => Promise.resolve(undefined),
    platform,
    readConfig,
    readInstalledPort: () => undefined,
    scope: { kind: 'live' },
    units: {
      serve: {
        label: SERVE_LABEL,
        logFile: join(dir, 'serve.log'),
        render: () => plistFor(SERVE_LABEL, join(dir, 'mimir'), {}),
        supervisor: serve,
        unitFile: join(dir, 'com.dbtlr.mimir.serve.plist'),
      },
      snapshot: {
        label: SNAPSHOT_LABEL,
        logFile: join(dir, 'snapshot.log'),
        render: () =>
          plistForSnapshot(SNAPSHOT_LABEL, join(dir, 'mimir'), { intervalSeconds: 900 }),
        supervisor: snap,
        unitFile: join(dir, 'com.dbtlr.mimir.snapshot.plist'),
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
  return {
    defaultVaultPath: join(dir, 'vault'),
    service,
    sqlitePath: join(dir, 'mimir.db'),
    vault,
  };
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
    store: { backend: 'norn' },
    vault: { path: join(dir, 'vault') },
  });
  expect(serve.calls).toEqual([]);
  expect(snap.calls).toEqual([]);
  expect(io.out.join('\n')).toContain('setup complete');
});

test('-y on the default local tier converges no vault and writes no [vault]', async () => {
  const serve = new FakeSupervisor();
  const d = deps(serve, new FakeSupervisor(), 'darwin', null);
  const io = fakeIo(false);
  const code = await cmdSetup({ yes: true }, io, d, 'json');
  expect(code).toBe(0);
  expect(existsSync(join(dir, 'vault'))).toBe(false);
  expect(readConfig(d.service.configFile)).toEqual({ serve: {}, store: {}, vault: {} });
  expect(JSON.parse(io.out.join(''))).toMatchObject({
    store: { backend: 'sqlite', path: join(dir, 'mimir.db') },
  });
  expect(serve.calls).toEqual([]);
});

test('--install-service on the local tier installs the serve unit without a vault', async () => {
  const serve = new FakeSupervisor();
  const d = deps(serve, new FakeSupervisor(), 'darwin', null);
  const code = await cmdSetup({ installService: true, yes: true }, fakeIo(false), d, 'records');
  expect(code).toBe(0);
  expect(serve.calls).toContain('install');
  expect(existsSync(join(dir, 'vault'))).toBe(false);
});

test('vault and snapshot flags are refused on a backend without a vault', async () => {
  for (const values of [
    { vault: join(dir, 'vault') },
    { installSnapshot: true },
    { installSnapshot: true, snapshotInterval: '60' },
  ]) {
    const d = deps(new FakeSupervisor(), new FakeSupervisor(), 'darwin', null);
    let message = '';
    try {
      await cmdSetup({ ...values, yes: true }, fakeIo(false), d, 'records');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('only to the norn backend');
  }
  expect(existsSync(join(dir, 'vault'))).toBe(false);
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
    store: { backend: 'norn' },
    vault: { path: join(dir, 'vault') },
  });
});

test('setup --port wins over a captured MIMIR_PORT during service install', async () => {
  const d = deps(new FakeSupervisor(), new FakeSupervisor());
  d.service.portOverride = 55441;
  const io = fakeIo(false);

  expect(
    await cmdSetup(
      { installService: true, port: '55442', vault: join(dir, 'vault'), yes: true },
      io,
      d,
      'records',
    ),
  ).toBe(0);
  expect(io.out.join('\n')).toContain('http://127.0.0.1:55442');
});

// The dev-build fence (MMR-147): the setup install path routes through the same
// cmdService gate, so a from-source `setup --install-snapshot` (the smoke that
// polluted real launchd) fails loudly instead of writing a real unit.
test('--install-snapshot refuses without real-supervisor trust', async () => {
  const serve = new FakeSupervisor();
  const snap = new FakeSupervisor();
  const d = deps(serve, snap);
  d.service.scope = { kind: 'none' };
  const io = fakeIo(false);

  let thrown: unknown;
  try {
    await cmdSetup(
      { installSnapshot: true, vault: join(dir, 'vault'), yes: true },
      io,
      d,
      'records',
    );
  } catch (e) {
    thrown = e;
  }

  expect(thrown instanceof Error && thrown.message).toMatch(/dev\/from-source/);
  expect(serve.calls).toEqual([]);
  expect(snap.calls).toEqual([]);
  expect(existsSync(d.service.units.snapshot.unitFile)).toBe(false);
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
    service: { ok: boolean; units: string[]; leftInstalled: string[] };
    configFile: string;
  };
  expect(parsed.vault.outcome).toBe('created');
  expect(parsed.service).toEqual({ leftInstalled: [], ok: true, units: ['serve'] });
});

test('a ~/ vault path is expanded (converged + persisted) the way resolveVault reads it', async () => {
  // homedir() is fixed for the process, so the expansion lands in the real home;
  // a distinctive subdir + finally cleanup keeps the test hermetic.
  const sub = '.mimir-setup-tilde-test';
  const expanded = join(homedir(), sub);
  rmSync(expanded, { force: true, recursive: true });
  try {
    const d = deps(new FakeSupervisor(), new FakeSupervisor());
    const code = await cmdSetup({ vault: `~/${sub}`, yes: true }, fakeIo(false), d, 'records');
    expect(code).toBe(0);
    // Persisted absolute (not the literal ~), and the vault was created there —
    // the same path a later `serve` resolves through resolveVault.
    expect(readConfig(d.service.configFile).vault.path).toBe(expanded);
    expect(existsSync(join(expanded, MARKER_FILE))).toBe(true);
  } finally {
    rmSync(expanded, { force: true, recursive: true });
  }
});

test('--snapshot-interval / --upstream without --install-snapshot is a usage error', async () => {
  const d = deps(new FakeSupervisor(), new FakeSupervisor());
  const io = fakeIo(false);
  let message = '';
  try {
    await cmdSetup(
      { snapshotInterval: '600', vault: join(dir, 'vault'), yes: true },
      io,
      d,
      'records',
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toMatch(/require --install-snapshot/);
});

test('snapshot upstream: omitting --upstream keeps it, --upstream "" clears it', async () => {
  const d = deps(new FakeSupervisor(), new FakeSupervisor());
  await cmdSetup(
    {
      installSnapshot: true,
      snapshotInterval: '600',
      upstream: 'git@old:v.git',
      vault: join(dir, 'vault'),
      yes: true,
    },
    fakeIo(false),
    d,
    'records',
  );
  expect(readConfig(d.service.configFile).vault.snapshot).toEqual({
    interval: 600,
    upstream: 'git@old:v.git',
  });
  // Omitting --upstream keeps the current one (a bare re-run isn't a wipe).
  await cmdSetup(
    { installSnapshot: true, vault: join(dir, 'vault'), yes: true },
    fakeIo(false),
    d,
    'records',
  );
  expect(readConfig(d.service.configFile).vault.snapshot).toEqual({
    interval: 600,
    upstream: 'git@old:v.git',
  });
  // An explicit empty --upstream clears it.
  await cmdSetup(
    { installSnapshot: true, upstream: '', vault: join(dir, 'vault'), yes: true },
    fakeIo(false),
    d,
    'records',
  );
  expect(readConfig(d.service.configFile).vault.snapshot).toEqual({ interval: 600 });
});

test('a reconfigure preserves operator-set push/pull the wizard never asks about', async () => {
  const d = deps(new FakeSupervisor(), new FakeSupervisor());
  // Operator deliberately set local-only snapshots (push = false) by hand.
  writeFileSync(
    d.service.configFile,
    '[store]\nbackend = "norn"\n[vault]\npath = "/v"\n[vault.snapshot]\ninterval = 900\npush = false\n',
  );
  await cmdSetup(
    { installSnapshot: true, snapshotInterval: '600', vault: join(dir, 'vault'), yes: true },
    fakeIo(false),
    d,
    'records',
  );
  // interval updated, push = false survives (not silently reverted to push-on).
  expect(readConfig(d.service.configFile).vault.snapshot).toEqual({ interval: 600, push: false });
});

test('a malformed config is rewritten with a warning (reset is never silent)', async () => {
  const d = deps(new FakeSupervisor(), new FakeSupervisor());
  writeFileSync(d.service.configFile, 'this is [not valid toml');
  const io = fakeIo(false);
  // The unreadable file fences no backend, so setup runs the default local tier.
  const code = await cmdSetup({ port: '7777', yes: true }, io, d, 'records');
  expect(code).toBe(0);
  expect(io.err.join('\n')).toMatch(/was not valid TOML — rewrote it fresh/);
  expect(readConfig(d.service.configFile)).toEqual({ serve: { port: 7777 }, store: {}, vault: {} });
});

test('a valid but wrong-typed config does NOT trigger the false "not valid TOML" warning', async () => {
  const d = deps(new FakeSupervisor(), new FakeSupervisor());
  // Valid TOML whose serve section is wrong-typed — readConfig flags it, but the
  // file parses fine, so writeConfig merges (no reset) and no warning fires.
  writeFileSync(
    d.service.configFile,
    'serve = 5\n[store]\nbackend = "norn"\n[vault]\npath = "/keep"\n',
  );
  const io = fakeIo(false);
  const code = await cmdSetup({ vault: join(dir, 'vault'), yes: true }, io, d, 'records');
  expect(code).toBe(0);
  expect(io.err.join('\n')).not.toMatch(/not valid TOML/);
});

test('declining an already-installed unit leaves it running and says so (install-only)', async () => {
  const d = deps(new FakeSupervisor(), new FakeSupervisor());
  // Simulate a snapshot unit already installed on disk.
  writeFileSync(d.service.units.snapshot.unitFile, '<plist/>');
  const io = fakeIo(false);
  const code = await cmdSetup(
    { installService: true, vault: join(dir, 'vault'), yes: true },
    io,
    d,
    'records',
  );
  expect(code).toBe(0);
  // The snapshot unit is neither reinstalled nor removed — just called out.
  expect(io.err.join('\n')).toMatch(/snapshot is still installed.*service uninstall snapshot/);
});

test('on Linux, the service install goes through the systemd supervisor', async () => {
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
  expect(serve.calls).toEqual(['install']);
});

test('without a supervisor, install flags are ignored but vault + config still land', async () => {
  const serve = new FakeSupervisor();
  const snap = new FakeSupervisor();
  const d = deps(serve, snap, 'win32');
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
