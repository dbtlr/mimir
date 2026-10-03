import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MimirError } from '../core/errors';
import type { ServiceDeps } from '../service';
import { readConfig } from '../service/config';
import type { ServiceInfo, Supervisor } from '../service/launchd';
import { plistFor } from '../service/plist';
import { SERVE_LABEL } from '../service/units';
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

/** The setup deps over `dir`, with no config file: the default local tier. */
function deps(serve: FakeSupervisor, platform: NodeJS.Platform = 'darwin'): SetupDeps {
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
    },
    version: '0.5.0',
  };
  return { service, sqlitePath: join(dir, 'mimir.db') };
}

/** Run setup expecting a throw; yields the thrown message. */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof MimirError) {
      return `${error.message} — ${error.hint ?? ''}`;
    }
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected setup to refuse, but it completed');
}

test('non-TTY without -y refuses (a piped setup never acts silently)', async () => {
  const d = deps(new FakeSupervisor());
  expect(await refusal(() => cmdSetup({}, fakeIo(false), d, 'records'))).toMatch(/needs a TTY/);
});

test('-y on the default local tier reports the store file and installs no unit', async () => {
  const serve = new FakeSupervisor();
  const d = deps(serve);
  const io = fakeIo(false);
  const code = await cmdSetup({ yes: true }, io, d, 'json');
  expect(code).toBe(0);
  expect(readConfig(d.service.configFile)).toEqual({ serve: {}, store: {} });
  expect(JSON.parse(io.out.join(''))).toMatchObject({
    store: { backend: 'sqlite', path: join(dir, 'mimir.db') },
  });
  expect(serve.calls).toEqual([]);
});

test('an unusable [store] section is refused before setup writes anything', async () => {
  for (const isTTY of [false, true]) {
    const d = deps(new FakeSupervisor());
    writeFileSync(d.service.configFile, '[store]\nbackend = "mysql"\n');
    const message = await refusal(() => cmdSetup({ yes: true }, fakeIo(isTTY), d, 'records'));
    expect(message).toContain('[store] is unusable (invalid-backend)');
    // The bad section is the operator's to fix; setup leaves the file alone.
    expect(readFileSync(d.service.configFile, 'utf8')).toBe('[store]\nbackend = "mysql"\n');
  }
});

test('a removed norn backend is refused with the migration path', async () => {
  const d = deps(new FakeSupervisor());
  writeFileSync(d.service.configFile, '[store]\nbackend = "norn"\n');
  const message = await refusal(() => cmdSetup({ yes: true }, fakeIo(false), d, 'records'));
  expect(message).toContain('[store] is unusable (removed-backend)');
  expect(message).toContain('the norn backend was removed');
  expect(message).toContain('store export');
  expect(readFileSync(d.service.configFile, 'utf8')).toBe('[store]\nbackend = "norn"\n');
});

test('--install-service --port installs the serve unit and persists the port', async () => {
  const serve = new FakeSupervisor();
  const d = deps(serve);
  const code = await cmdSetup(
    { installService: true, port: '50130', yes: true },
    fakeIo(false),
    d,
    'records',
  );
  expect(code).toBe(0);
  expect(serve.calls).toEqual(['install']);
  expect(readConfig(d.service.configFile)).toEqual({ serve: { port: 50130 }, store: {} });
});

test('setup --port wins over a captured MIMIR_PORT during service install', async () => {
  const d = deps(new FakeSupervisor());
  d.service.portOverride = 55441;
  const io = fakeIo(false);

  expect(await cmdSetup({ installService: true, port: '55442', yes: true }, io, d, 'records')).toBe(
    0,
  );
  expect(io.out.join('\n')).toContain('http://127.0.0.1:55442');
});

// The dev-build fence (MMR-147): the setup install path routes through the same
// cmdService gate, so a from-source `setup --install-service` fails loudly
// instead of writing a real unit.
test('--install-service refuses without real-supervisor trust', async () => {
  const serve = new FakeSupervisor();
  const d = deps(serve);
  d.service.scope = { kind: 'none' };

  const message = await refusal(() =>
    cmdSetup({ installService: true, yes: true }, fakeIo(false), d, 'records'),
  );

  expect(message).toMatch(/dev\/from-source/);
  expect(serve.calls).toEqual([]);
  expect(existsSync(d.service.units.serve.unitFile)).toBe(false);
});

test('--port persists to [serve] even without --install-service (serve reads it)', async () => {
  const serve = new FakeSupervisor();
  const d = deps(serve);
  const code = await cmdSetup({ port: '50131', yes: true }, fakeIo(false), d, 'records');
  expect(code).toBe(0);
  expect(serve.calls).toEqual([]);
  expect(readConfig(d.service.configFile).serve).toEqual({ port: 50131 });
});

test('json format emits one object and suppresses the service install transcript', async () => {
  const d = deps(new FakeSupervisor());
  const io = fakeIo(false);
  const code = await cmdSetup({ installService: true, yes: true }, io, d, 'json');
  expect(code).toBe(0);
  // Exactly one stdout write, and it's setup's own envelope.
  expect(io.out).toHaveLength(1);
  const parsed = JSON.parse(io.out[0] ?? '') as {
    service: { ok: boolean; units: string[]; leftInstalled: string[] };
    configFile: string;
  };
  expect(parsed.service).toEqual({ leftInstalled: [], ok: true, units: ['serve'] });
  expect(parsed.configFile).toBe(d.service.configFile);
});

test('a malformed config is rewritten with a warning (reset is never silent)', async () => {
  const d = deps(new FakeSupervisor());
  writeFileSync(d.service.configFile, 'this is [not valid toml');
  const io = fakeIo(false);
  // The unreadable file fences no backend, so setup runs the default local tier.
  const code = await cmdSetup({ port: '7777', yes: true }, io, d, 'records');
  expect(code).toBe(0);
  expect(io.err.join('\n')).toMatch(/was not valid TOML — rewrote it fresh/);
  expect(readConfig(d.service.configFile)).toEqual({ serve: { port: 7777 }, store: {} });
});

test('a valid but wrong-typed config does NOT trigger the false "not valid TOML" warning', async () => {
  const d = deps(new FakeSupervisor());
  // Valid TOML whose serve section is wrong-typed — readConfig flags it, but the
  // file parses fine, so writeConfig merges (no reset) and no warning fires.
  writeFileSync(d.service.configFile, 'serve = 5\n[store]\nbackend = "sqlite"\n');
  const io = fakeIo(false);
  const code = await cmdSetup({ yes: true }, io, d, 'records');
  expect(code).toBe(0);
  expect(io.err.join('\n')).not.toMatch(/not valid TOML/);
});

test('declining an already-installed unit leaves it running and says so (install-only)', async () => {
  const serve = new FakeSupervisor();
  const d = deps(serve);
  // Simulate the serve unit already installed on disk.
  writeFileSync(d.service.units.serve.unitFile, '<plist/>');
  const io = fakeIo(false);
  const code = await cmdSetup({ yes: true }, io, d, 'records');
  expect(code).toBe(0);
  // The unit is neither reinstalled nor removed — just called out.
  expect(serve.calls).toEqual([]);
  expect(io.err.join('\n')).toMatch(/serve is still installed.*service uninstall serve/);
});

test('on Linux, the service install goes through the systemd supervisor', async () => {
  const serve = new FakeSupervisor();
  const d = deps(serve, 'linux');
  const code = await cmdSetup({ installService: true, yes: true }, fakeIo(false), d, 'records');
  expect(code).toBe(0);
  expect(serve.calls).toEqual(['install']);
});

test('without a supervisor, install flags are ignored but the config still lands', async () => {
  const serve = new FakeSupervisor();
  const d = deps(serve, 'win32');
  const io = fakeIo(false);
  const code = await cmdSetup({ installService: true, port: '50132', yes: true }, io, d, 'records');
  expect(code).toBe(0);
  expect(serve.calls).toEqual([]);
  expect(io.err.join('\n')).toMatch(/needs launchd \(macOS\) or systemd \(Linux\)/);
  expect(readConfig(d.service.configFile).serve).toEqual({ port: 50132 });
});
