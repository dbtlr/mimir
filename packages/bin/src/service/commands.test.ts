import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeIo } from '../cli/testing';
import { MimirError } from '../core';
import { PROD_PORT } from '../env';
import { protocolCandidate } from '../installation/test-fixtures';
import type { ServiceDeps } from './commands';
import { cmdSelfUpdate, cmdService } from './commands';
import { readConfig, readServeConfig } from './config';
import { recentEvents } from './events';
import type { ServiceInfo, Supervisor } from './launchd';
import { plistFor } from './plist';
import { SERVE_LABEL, unitLabels } from './units';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mimir-svc-'));
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

function deps(sup: FakeSupervisor, extra: Partial<ServiceDeps> = {}): ServiceDeps {
  return {
    binPath: join(dir, 'mimir'),
    configFile: join(dir, 'config.toml'),
    defaultPort: PROD_PORT,
    eventsFile: join(dir, 'service-events.jsonl'),
    fetcher: () => Promise.reject(new Error('no network in tests')),
    health: () => Promise.resolve(undefined),
    platform: 'darwin',
    readConfig,
    readInstalledPort: () => undefined,
    scope: { kind: 'live' },
    units: {
      serve: {
        label: SERVE_LABEL,
        logFile: join(dir, 'serve.log'),
        render: () => plistFor(SERVE_LABEL, join(dir, 'mimir'), {}),
        supervisor: sup,
        unitFile: join(dir, 'com.dbtlr.mimir.serve.plist'),
      },
    },
    version: '0.5.0',
    ...extra,
  };
}

// 1. install serve writes the plist, delegates, logs, and --port writes config
test('install refuses an unusable [store] before writing a unit that would crash-loop', async () => {
  const sup = new FakeSupervisor();
  const d = deps(sup);
  writeFileSync(d.configFile, '[store]\nbackend = "norn"\n');
  let message = '';
  try {
    await cmdService(['service', 'install'], {}, fakeIo(), d);
  } catch (error) {
    message =
      error instanceof MimirError ? `${error.message} — ${error.hint ?? ''}` : String(error);
  }
  expect(message).toContain('[store] is unusable (removed-backend)');
  expect(existsSync(d.units.serve.unitFile)).toBe(false);
  expect(sup.calls).toEqual([]);
});

test('install serve writes the plist, delegates, logs, and --port writes config', async () => {
  const sup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(sup);

  const code = await cmdService(['service', 'install', 'serve'], { port: '55440' }, io, d);

  expect(code).toBe(0);
  expect(existsSync(d.units.serve.unitFile)).toBe(true);
  const plistContent = readFileSync(d.units.serve.unitFile, 'utf8');
  expect(plistContent).toContain('--no-hunt');
  const config = readServeConfig(d.configFile);
  expect(config).toEqual({ port: 55440 });
  expect(sup.calls).toEqual(['install']);
  const events = recentEvents(d.eventsFile, 10);
  expect(events.map((e) => e.event)).toEqual(['install']);
  expect(io.out.join('\n')).toContain('55440');
});

// 1b. install --port over a malformed config rewrites it, but warns (not silent)
test('install --port over a malformed config warns about the lossy rewrite', async () => {
  const sup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(sup);
  writeFileSync(d.configFile, '[serve\nport = ???'); // broken TOML

  const code = await cmdService(['service', 'install', 'serve'], { port: '55441' }, io, d);

  expect(code).toBe(0);
  expect(readServeConfig(d.configFile)).toEqual({ port: 55441 });
  expect(io.err.join('\n')).toMatch(/was not valid TOML — rewrote it fresh/);
});

// 2. install without --port leaves config untouched
test('install without --port leaves config untouched', async () => {
  const sup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(sup);

  const code = await cmdService(['service', 'install', 'serve'], {}, io, d);

  expect(code).toBe(0);
  expect(existsSync(d.configFile)).toBe(false);
});

// 2b. the unit argument is optional: a bare `install` sets up the serve daemon
test('install with no unit installs serve', async () => {
  const sup = new FakeSupervisor();
  const d = deps(sup);

  expect(await cmdService(['service', 'install'], {}, fakeIo(), d)).toBe(0);

  expect(sup.calls).toEqual(['install']);
  expect(existsSync(d.units.serve.unitFile)).toBe(true);
  expect(recentEvents(d.eventsFile, 10).map((e) => e.event)).toEqual(['install']);
});

// 2d. an unknown unit is a usage error — including the removed snapshot unit
// and its `all` selector, which now name nothing.
test('an unknown unit is a usage error', async () => {
  for (const unit of ['nope', 'snapshot', 'all']) {
    const sup = new FakeSupervisor();
    const d = deps(sup);
    let thrown: unknown;
    try {
      await cmdService(['service', 'install', unit], {}, fakeIo(), d);
    } catch (e) {
      thrown = e;
    }
    expect(thrown instanceof Error && thrown.message).toMatch(/unknown unit/);
    expect(sup.calls).toEqual([]);
  }
});

// 3. a bad --port is a usage error and touches nothing
test('a bad --port is a usage error and touches nothing', async () => {
  const sup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(sup);

  let thrown: unknown;
  try {
    await cmdService(['service', 'install'], { port: 'no' }, io, d);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeDefined();
  expect(thrown instanceof Error && thrown.message).toMatch(/--port/);
  expect(sup.calls).toEqual([]);
  expect(existsSync(d.units.serve.unitFile)).toBe(false);
});

/** A serve render that cannot produce its unit file (a line break in a baked value). */
const boomRender = (): string => {
  throw new Error('unit file value contains a line break');
};

// 3b. a render that throws aborts before mutating config
test('a failing render aborts install before --port is persisted or the unit installs', async () => {
  const sup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(sup, {
    units: {
      serve: {
        label: SERVE_LABEL,
        logFile: join(dir, 'serve.log'),
        render: boomRender,
        supervisor: sup,
        unitFile: join(dir, 'com.dbtlr.mimir.serve.plist'),
      },
    },
  });

  let thrown: unknown;
  try {
    await cmdService(['service', 'install', 'serve'], { port: '55442' }, io, d);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(Error);
  // The --port write must NOT survive the aborted install (config never created)…
  expect(existsSync(d.configFile)).toBe(false);
  // …and nothing was installed or written.
  expect(sup.calls).toEqual([]);
  expect(existsSync(d.units.serve.unitFile)).toBe(false);
});

// 4. start/stop/restart delegate and log — events accumulate in order in ONE file
test('start/stop/restart delegate and log', async () => {
  const sup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(sup);
  // A lifecycle verb only acts on an installed unit — set serve up first.
  await cmdService(['service', 'install', 'serve'], {}, io, d);

  const c1 = await cmdService(['service', 'start', 'serve'], {}, io, d);
  const c2 = await cmdService(['service', 'stop', 'serve'], {}, io, d);
  const c3 = await cmdService(['service', 'restart', 'serve'], {}, io, d);

  expect(c1).toBe(0);
  expect(c2).toBe(0);
  expect(c3).toBe(0);
  expect(sup.calls).toEqual(['install', 'start', 'stop', 'restart']);
  expect(recentEvents(d.eventsFile, 10).map((e) => e.event)).toEqual([
    'install',
    'start',
    'stop',
    'restart',
  ]);
});

// 4b. a lifecycle verb acts only on an installed unit: a missing one is a
// reported failure, never a supervisor throw — and nonzero, so a `&&`-chaining
// deploy step never proceeds on a no-op.
test('a lifecycle verb on a not-installed unit reports it and exits nonzero', async () => {
  const sup = new FakeSupervisor();
  const d = deps(sup);
  for (const args of [
    ['service', 'restart'],
    ['service', 'start', 'serve'],
  ]) {
    const io = fakeIo();
    expect(await cmdService(args, {}, io, d)).toBe(1);
    expect(io.err.join('\n')).toContain('serve: not installed');
  }
  const io = fakeIo();
  expect(await cmdService(['service', 'stop'], {}, io, d, 'json')).toBe(1);
  expect(JSON.parse(io.out.join('\n'))).toEqual({
    actions: [{ action: 'stop', ok: false, unit: 'serve' }],
  });
  expect(sup.calls).toEqual([]);
  expect(recentEvents(d.eventsFile, 10)).toEqual([]);
});

// 4c. uninstalling a not-installed unit is idempotent — no supervisor call, no
// phantom teardown event, no "uninstalled" claim.
test('uninstall of a not-installed unit logs nothing and reports honestly', async () => {
  for (const args of [
    ['service', 'uninstall'],
    ['service', 'uninstall', 'serve'],
  ]) {
    const sup = new FakeSupervisor();
    const io = fakeIo();
    const d = deps(sup);

    expect(await cmdService(args, {}, io, d)).toBe(0);

    expect(io.out.join('\n')).toContain('nothing installed to uninstall');
    expect(sup.calls).toEqual([]);
    expect(recentEvents(d.eventsFile, 10)).toEqual([]);
  }
});

// 4d. uninstall tears the unit down, removes its file, and logs the teardown.
test('uninstall tears down an installed unit and removes its file', async () => {
  const sup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(sup);
  await cmdService(['service', 'install'], {}, io, d);

  expect(await cmdService(['service', 'uninstall'], {}, io, d)).toBe(0);

  expect(sup.calls).toEqual(['install', 'uninstall']);
  expect(existsSync(d.units.serve.unitFile)).toBe(false);
  expect(io.out.join('\n')).toContain('serve uninstalled');
  expect(recentEvents(d.eventsFile, 10).map((e) => e.event)).toEqual(['install', 'uninstall']);
});

// 4e. a unit still loaded whose file vanished is a REAL teardown — the
// supervisor uninstall runs and the event is logged, not "nothing installed"
// while the supervisor keeps the daemon running.
test('uninstall of a loaded unit with no unit file reports and logs a real teardown', async () => {
  const loaded = new FakeSupervisor();
  loaded.state = { loaded: true, pid: 999, running: true };
  const io = fakeIo();
  const d = deps(loaded);

  expect(await cmdService(['service', 'uninstall'], {}, io, d)).toBe(0);

  expect(loaded.calls).toContain('uninstall');
  expect(io.out.join('\n')).toContain('serve uninstalled');
  expect(recentEvents(d.eventsFile, 10).map((e) => e.event)).toEqual(['uninstall']);
});

// 5. unknown subcommand is usage; a platform without a supervisor is a loud operational error
test('unknown subcommand is usage; an unsupported platform is a loud operational error', async () => {
  const io = fakeIo();

  // unknown subcommand
  {
    const sup = new FakeSupervisor();
    const d = deps(sup);
    let thrown: unknown;
    try {
      await cmdService(['service', 'badverb'], {}, io, d);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(thrown instanceof Error && thrown.message).toMatch(/service:/);
  }

  // neither launchd nor systemd
  {
    const sup = new FakeSupervisor();
    const d = deps(sup, { platform: 'win32' });
    let thrown: unknown;
    try {
      await cmdService(['service', 'start'], {}, io, d);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(thrown instanceof Error && thrown.message).toMatch(/launchd \(macOS\) or systemd/);
    expect(sup.calls).toEqual([]);
  }
});

// 5b. Linux drives the same verbs through its systemd unit
test('on Linux, install writes the systemd unit and names it a unit file', async () => {
  const sup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(sup, { platform: 'linux' });
  d.units.serve = {
    ...d.units.serve,
    render: () => '[Service]\n',
    unitFile: join(dir, 'serve.service'),
  };

  expect(await cmdService(['service', 'install'], {}, io, d)).toBe(0);
  expect(readFileSync(join(dir, 'serve.service'), 'utf8')).toBe('[Service]\n');
  expect(sup.calls).toEqual(['install']);
  expect(io.out.join('\n')).toContain(`unit:   ${join(dir, 'serve.service')}`);
});

// 5c. unit files land in a directory that may not exist yet (a fresh
// ~/.config/systemd/user, a sandbox's data directory).
test('install creates the unit file and log directories', async () => {
  const sup = new FakeSupervisor();
  const d = deps(sup);
  d.units.serve = {
    ...d.units.serve,
    logFile: join(dir, 'fresh-logs', 'serve.log'),
    unitFile: join(dir, 'fresh', 'nested', 'serve.plist'),
  };
  expect(await cmdService(['service', 'install'], {}, fakeIo(), d)).toBe(0);
  expect(existsSync(join(dir, 'fresh', 'nested', 'serve.plist'))).toBe(true);
  expect(existsSync(join(dir, 'fresh-logs'))).toBe(true);
});

// 6. status reports running vs on-disk version and restart pending
test('status reports running vs on-disk version and restart pending', async () => {
  const sup = new FakeSupervisor();
  sup.state = { loaded: true, pid: 4242, running: true };
  const io = fakeIo();
  const d = deps(sup, {
    health: () => Promise.resolve({ schema: 8, status: 'ok', version: '0.5.0' }),
    version: '0.6.0',
  });

  const code = await cmdService(['service', 'status'], {}, io, d);

  expect(code).toBe(0);
  const out = io.out.join('\n');
  expect(out).toContain('4242');
  expect(out).toContain('running 0.5.0');
  expect(out).toContain('on-disk 0.6.0');
  expect(out).toContain('restart pending');
});

// 6b. a running prerelease differs from the on-disk release of the same
// triple — restart IS pending (the numeric-triple comparator hid this).
test('status flags restart pending when a prerelease runs against an on-disk release', async () => {
  const sup = new FakeSupervisor();
  sup.state = { loaded: true, pid: 4242, running: true };
  const io = fakeIo();
  const d = deps(sup, {
    health: () => Promise.resolve({ schema: 8, status: 'ok', version: '0.15.0-next.1' }),
    version: '0.15.0',
  });

  const code = await cmdService(['service', 'status'], {}, io, d);

  expect(code).toBe(0);
  expect(io.out.join('\n')).toContain('restart pending');
});

// 6c. the health payload is untrusted: a non-SemVer version (foreign
// responder on the port) reads as restart pending — never a crash.
test('status tolerates a non-SemVer running version from the health probe', async () => {
  const sup = new FakeSupervisor();
  sup.state = { loaded: true, pid: 4242, running: true };
  const io = fakeIo();
  const d = deps(sup, {
    health: () => Promise.resolve({ schema: 8, status: 'ok', version: 'not-a-version' }),
    version: '0.15.0',
  });

  const code = await cmdService(['service', 'status'], {}, io, d);

  expect(code).toBe(0);
  expect(io.out.join('\n')).toContain('restart pending');
});

// 7. status when not loaded says so and still shows paths
test('status when not loaded says so and still shows paths', async () => {
  const sup = new FakeSupervisor();
  // state default: loaded: false, running: false
  const io = fakeIo();
  const d = deps(sup);

  const code = await cmdService(['service', 'status'], {}, io, d);

  expect(code).toBe(0);
  const out = io.out.join('\n');
  expect(out).toContain('not loaded');
  expect(out).toContain('config:');
});

// 8. status surfaces an ignored config — warning goes to stderr with [warn] glyph (plain mode)
test('status surfaces an ignored config', async () => {
  const sup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(sup);
  // Write a bad config file
  writeFileSync(d.configFile, '[serve]\nport = "x"\n');

  const code = await cmdService(['service', 'status'], {}, io, d);

  expect(code).toBe(0);
  // Warning must be on stderr (io.err), NOT stdout
  expect(io.out.join('\n')).not.toContain('config ignored');
  expect(io.err.join('\n')).toContain('[warn] config key ignored (invalid-port)');
});

test('status warns on every ignored key and lists them all in json', async () => {
  const io = fakeIo();
  const d = deps(new FakeSupervisor());
  writeFileSync(d.configFile, '[serve]\nport = "x"\nhosts = "box"\n');

  expect(await cmdService(['service', 'status'], {}, io, d, 'json')).toBe(0);

  const err = io.err.join('\n');
  expect(err).toContain('config key ignored (invalid-port)');
  expect(err).toContain('config key invalid (hosts) — answering loopback names only');
  expect(JSON.parse(io.out.join('\n')).units[0].config_problems).toEqual([
    'invalid-port',
    'invalid-hosts',
  ]);
});

test('status probes the bound address and shows the configured console url', async () => {
  let probed = '';
  const d = deps(new FakeSupervisor(), {
    health: (host, port) => {
      probed = `${host}:${String(port)}`;
      return Promise.resolve(undefined);
    },
  });
  writeFileSync(
    d.configFile,
    '[serve]\nport = 55442\nbind = "100.64.1.2"\nurl = "https://box.tailnet.ts.net"\n',
  );

  const human = fakeIo();
  expect(await cmdService(['service', 'status'], {}, human, d)).toBe(0);
  expect(probed).toBe('100.64.1.2:55442');
  expect(human.out.join('\n')).toContain('console https://box.tailnet.ts.net');

  const json = fakeIo();
  expect(await cmdService(['service', 'status'], {}, json, d, 'json')).toBe(0);
  expect(JSON.parse(json.out.join('\n')).units[0]).toMatchObject({
    config_problems: [],
    console_url: 'https://box.tailnet.ts.net',
  });
});

test('status probes loopback for a wildcard bind', async () => {
  let probed = '';
  const d = deps(new FakeSupervisor(), {
    health: (host) => {
      probed = host;
      return Promise.resolve(undefined);
    },
  });
  writeFileSync(d.configFile, '[serve]\nbind = "0.0.0.0"\n');
  expect(await cmdService(['service', 'status'], {}, fakeIo(), d)).toBe(0);
  expect(probed).toBe('127.0.0.1');
});

test('install prints the console url', async () => {
  const io = fakeIo();
  const d = deps(new FakeSupervisor());
  writeFileSync(d.configFile, '[serve]\nbind = "0.0.0.0"\nurl = "https://box.tailnet.ts.net"\n');
  expect(await cmdService(['service', 'install'], {}, io, d)).toBe(0);
  expect(io.out.join('\n')).toContain('serving on https://box.tailnet.ts.net');
});

// 9. self-update: already up to date is a clean no-op
test('self-update: already up to date is a clean no-op', async () => {
  const sup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(sup, {
    fetcher: (url: string) => {
      // resolveLatestTag fetches /releases/latest and expects a 302 with Location header
      if (url.includes('/releases/latest')) {
        return Promise.resolve(
          new Response(null, {
            headers: { location: 'https://github.com/dbtlr/mimir/releases/tag/v0.5.0' },
            status: 302,
          }),
        );
      }
      return Promise.reject(new Error('unexpected fetch in test'));
    },
  });

  const code = await cmdSelfUpdate(io, d);

  expect(code).toBe(0);
  expect(io.out.join('\n')).toContain('up to date');
  expect(existsSync(d.eventsFile)).toBe(false);
});

// 10. self-update refuses when not a compiled binary
test('self-update refuses when not a compiled binary', async () => {
  const sup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(sup, { binPath: '/opt/homebrew/bin/bun' });

  let thrown: unknown;
  try {
    await cmdSelfUpdate(io, d);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeDefined();
  expect(thrown instanceof Error && thrown.message).toMatch(/installed binary/);
});

// 11. self-update logs the update even when restart fails
test('self-update logs the update even when restart fails', async () => {
  const newVersion = '0.6.0';
  const newTag = `v${newVersion}`;
  // Build a fake binary body and its matching SHA256SUMS line
  const fakeBody = new TextEncoder().encode(protocolCandidate);
  const sha256 = new Bun.CryptoHasher('sha256').update(fakeBody).digest('hex');
  // assetName() returns the platform asset name — import it to stay in sync
  const { assetName } = await import('./self-update');
  const asset = assetName();
  const fakeSums = `${sha256}  ${asset}\n`;

  // Supervisor that marks itself loaded so restart is attempted, but restart throws
  class FailingRestartSupervisor extends FakeSupervisor {
    override info(): Promise<ServiceInfo> {
      return Promise.resolve({ loaded: true, pid: 1234, running: true });
    }
    override restart(): Promise<void> {
      this.calls.push('restart');
      return Promise.reject(new Error('launchctl kaboom'));
    }
  }

  const sup = new FailingRestartSupervisor();
  const io = fakeIo();
  const d = deps(sup, {
    fetcher: (url: string) => {
      if (url.includes('/releases/latest')) {
        return Promise.resolve(
          new Response(null, {
            headers: { location: `https://github.com/dbtlr/mimir/releases/tag/${newTag}` },
            status: 302,
          }),
        );
      }
      if (url.includes(`/download/${newTag}/SHA256SUMS`)) {
        return Promise.resolve(new Response(fakeSums, { status: 200 }));
      }
      if (url.includes(`/download/${newTag}/${asset}`)) {
        return Promise.resolve(new Response(fakeBody, { status: 200 }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    },
    // binPath must not start with "bun" — use the shared temp dir/mimir path
    platform: 'darwin',
    version: '0.5.0',
  });

  // Must NOT throw — restart failure is non-fatal
  const code = await cmdSelfUpdate(io, d);

  expect(code).toBe(0);

  // Binary file was actually replaced
  const { readFileSync: rfs } = await import('node:fs');
  expect(rfs(d.binPath)).toEqual(Buffer.from(fakeBody));

  // Both events must be present in the log
  const events = recentEvents(d.eventsFile, 10);
  const eventNames = events.map((e) => e.event);
  expect(eventNames).toContain('self-update');
  expect(eventNames).toContain('restart');

  // self-update event must be ok:true (binary replaced)
  const suEvt = events.find((e) => e.event === 'self-update');
  expect(suEvt?.ok).toBe(true);

  // restart event must be ok:false (restart failed)
  const restartEvt = events.find((e) => e.event === 'restart');
  expect(restartEvt?.ok).toBe(false);

  // Operator must be warned on stderr
  expect(io.err.join('\n')).toContain('service did not restart');
});

test('self-update --tag is a no-op when already on that exact tag', async () => {
  const io = fakeIo();
  const d = deps(new FakeSupervisor(), { binPath: join(dir, 'mimir'), version: '0.6.0-next.5' });
  expect(await cmdSelfUpdate(io, d, { tag: 'v0.6.0-next.5' })).toBe(0);
  expect(io.out.join('\n')).toMatch(/already/i);
});

test('self-update --next reports up to date when running the latest prerelease', async () => {
  const atom = `<entry><link rel="alternate" href="https://github.com/dbtlr/mimir/releases/tag/v0.6.0-next.5"/></entry>`;
  const d = deps(new FakeSupervisor(), {
    binPath: join(dir, 'mimir'),
    fetcher: () => Promise.resolve(new Response(atom)),
    version: '0.6.0-next.5',
  });
  const io = fakeIo();
  expect(await cmdSelfUpdate(io, d, { next: true })).toBe(0);
  expect(io.out.join('\n')).toMatch(/up to date/i);
});

// Regression (MMR-285): a machine on a `-next` prerelease could never reach
// the official release with the same numeric triple via plain self-update,
// because the old comparator parsed only the numeric triple and treated
// `0.15.0-next.1` as equal to `0.15.0`.
test('self-update: stable channel proceeds past a prerelease onto the matching official release', async () => {
  const newTag = 'v0.15.0';
  const fakeBody = new TextEncoder().encode(protocolCandidate);
  const sha256 = new Bun.CryptoHasher('sha256').update(fakeBody).digest('hex');
  const { assetName } = await import('./self-update');
  const asset = assetName();
  const fakeSums = `${sha256}  ${asset}\n`;

  const io = fakeIo();
  const d = deps(new FakeSupervisor(), {
    binPath: join(dir, 'mimir'),
    fetcher: (url: string) => {
      if (url.includes('/releases/latest')) {
        return Promise.resolve(
          new Response(null, {
            headers: { location: `https://github.com/dbtlr/mimir/releases/tag/${newTag}` },
            status: 302,
          }),
        );
      }
      if (url.includes(`/download/${newTag}/SHA256SUMS`)) {
        return Promise.resolve(new Response(fakeSums, { status: 200 }));
      }
      if (url.includes(`/download/${newTag}/${asset}`)) {
        return Promise.resolve(new Response(fakeBody, { status: 200 }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    },
    version: '0.15.0-next.1',
  });

  const code = await cmdSelfUpdate(io, d);

  expect(code).toBe(0);
  expect(io.out.join('\n')).not.toMatch(/up to date/i);
  expect(io.out.join('\n')).toContain('0.15.0-next.1 -> 0.15.0');
});

// Regression (MMR-285): --next resolved the atom feed's publish-order head
// rather than the semver max, so it could move sideways or backwards. Guard
// against a downgrade explicitly, same as the stable channel now does.
test('self-update --next refuses to downgrade when the feed max is behind the running prerelease', async () => {
  const atom = `<entry><link rel="alternate" href="https://github.com/dbtlr/mimir/releases/tag/v0.15.0"/></entry>`;
  const d = deps(new FakeSupervisor(), {
    binPath: join(dir, 'mimir'),
    fetcher: () => Promise.resolve(new Response(atom)),
    version: '0.16.0-next.1',
  });
  const io = fakeIo();
  expect(await cmdSelfUpdate(io, d, { next: true })).toBe(0);
  expect(io.out.join('\n')).toMatch(/up to date/i);
});

// --- output contract (MMR-59): the format param routes to structured envelopes ---

test('service status emits the json envelope when format is json', async () => {
  const sup = new FakeSupervisor();
  sup.state = { loaded: true, pid: 4242, running: true };
  const io = fakeIo();
  const d = deps(sup, {
    health: () => Promise.resolve({ schema: 8, status: 'ok', version: '0.5.0' }),
    version: '0.6.0',
  });

  const code = await cmdService(['service', 'status'], {}, io, d, 'json');

  expect(code).toBe(0);
  const parsed = JSON.parse(io.out.join('\n'));
  expect(parsed.units).toHaveLength(1);
  const serve = parsed.units[0];
  expect(serve).toMatchObject({
    health: { on_disk_version: '0.6.0', restart_pending: true, running_version: '0.5.0' },
    loaded: true,
    pid: 4242,
    port: PROD_PORT,
    running: true,
  });
  expect(serve.unit_file).toBe(d.units.serve.unitFile);
  expect(serve).not.toHaveProperty('plist');
});

test('service status probes the build profile default when config contributes no port', async () => {
  const io = fakeIo();
  let probed: number | undefined;
  const d = deps(new FakeSupervisor(), {
    defaultPort: 64747,
    health: (_host, port) => {
      probed = port;
      return Promise.resolve(undefined);
    },
    readConfig: () => ({ serve: {}, store: {} }),
  });

  expect(await cmdService(['service', 'status'], {}, io, d, 'json')).toBe(0);
  expect(probed).toBe(64747);
  expect(JSON.parse(io.out.join('\n')).units[0].port).toBe(64747);
});

test('service status prefers the port persisted in an installed dev plist', async () => {
  const io = fakeIo();
  let probed: number | undefined;
  const d = deps(new FakeSupervisor(), {
    defaultPort: 64747,
    health: (_host, port) => {
      probed = port;
      return Promise.resolve(undefined);
    },
    readConfig: () => ({ serve: {}, store: {} }),
    readInstalledPort: () => 55440,
  });

  expect(await cmdService(['service', 'status'], {}, io, d, 'json')).toBe(0);
  expect(probed).toBe(55440);
  expect(JSON.parse(io.out.join('\n')).units[0].port).toBe(55440);
});

test('service install serve echoes the action envelope when format is json', async () => {
  const sup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(sup);

  const code = await cmdService(['service', 'install', 'serve'], { port: '55440' }, io, d, 'json');

  expect(code).toBe(0);
  const parsed = JSON.parse(io.out.join('\n'));
  expect(parsed.actions).toHaveLength(1);
  expect(parsed.actions[0]).toMatchObject({
    action: 'install',
    ok: true,
    port: 55440,
    unit: 'serve',
  });
  expect(parsed.actions[0].paths.unit_file).toBe(d.units.serve.unitFile);
  expect(parsed.actions[0].paths).not.toHaveProperty('plist');
  // The human path's detail lines must not leak into json mode.
  expect(io.out.join('\n')).not.toContain('plist:');
});

test('linux service install and status carry the systemd unit under unit_file only', async () => {
  const sup = new FakeSupervisor();
  const d = deps(sup, { platform: 'linux' });
  const unitFile = join(dir, 'com.dbtlr.mimir.serve.service');
  d.units.serve.unitFile = unitFile;

  const installIo = fakeIo();
  expect(await cmdService(['service', 'install', 'serve'], {}, installIo, d, 'json')).toBe(0);
  const paths = JSON.parse(installIo.out.join('\n')).actions[0].paths;
  expect(paths.unit_file).toBe(unitFile);
  expect(paths).not.toHaveProperty('plist');

  const statusIo = fakeIo();
  expect(await cmdService(['service', 'status'], {}, statusIo, d, 'json')).toBe(0);
  const serve = JSON.parse(statusIo.out.join('\n')).units[0];
  expect(serve.unit_file).toBe(unitFile);
  expect(serve).not.toHaveProperty('plist');
});

test('dev service install honors its captured MIMIR_PORT override', async () => {
  const io = fakeIo();
  const d = deps(new FakeSupervisor(), {
    defaultPort: 64747,
    portOverride: 55441,
    readConfig: () => ({ serve: {}, store: {} }),
  });

  expect(await cmdService(['service', 'install', 'serve'], {}, io, d, 'json')).toBe(0);
  expect(JSON.parse(io.out.join('\n')).actions[0].port).toBe(55441);
});

test('self-update emits the json result envelope when format is json', async () => {
  const sup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(sup, {
    fetcher: (url: string) =>
      url.includes('/releases/latest')
        ? Promise.resolve(
            new Response(null, {
              headers: { location: 'https://github.com/dbtlr/mimir/releases/tag/v0.5.0' },
              status: 302,
            }),
          )
        : Promise.reject(new Error('unexpected fetch in test')),
    version: '0.5.0',
  });

  const code = await cmdSelfUpdate(io, d, {}, 'json');

  expect(code).toBe(0);
  const parsed = JSON.parse(io.out.join('\n'));
  expect(parsed).toMatchObject({ from: '0.5.0', restarted: false, updated: false });
});

test('self-update (default selection {}) still uses official latest + semver compare', async () => {
  const d = deps(new FakeSupervisor(), {
    binPath: join(dir, 'mimir'),
    fetcher: () =>
      Promise.resolve(
        new Response(null, {
          headers: { location: 'https://github.com/dbtlr/mimir/releases/tag/v0.6.0' },
          status: 302,
        }),
      ),
    version: '0.6.0',
  });
  const io = fakeIo();
  expect(await cmdSelfUpdate(io, d, {})).toBe(0);
  expect(io.out.join('\n')).toMatch(/up to date/i);
});

// --- the dev-build fence (MMR-147): only a trusted process mutates real launchd ---

// 12. every mutating verb refuses without real-supervisor trust — loudly, before
// any effect: no supervisor call, no plist write, no logged event.
test('every mutating verb refuses without real-supervisor trust', async () => {
  for (const verb of ['install', 'uninstall', 'start', 'stop', 'restart']) {
    const sup = new FakeSupervisor();
    const io = fakeIo();
    const d = deps(sup, { scope: { kind: 'none' } });

    let thrown: unknown;
    try {
      await cmdService(['service', verb], {}, io, d);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(MimirError);
    expect(thrown instanceof Error && thrown.message).toMatch(/dev\/from-source/);
    expect(thrown instanceof Error && thrown.message).toContain(verb);
    expect(thrown instanceof MimirError && thrown.hint).toContain(
      'registered live or sandbox installation',
    );
    expect(sup.calls).toEqual([]);
    expect(existsSync(d.units.serve.unitFile)).toBe(false);
    expect(existsSync(d.eventsFile)).toBe(false);
  }
});

// 12b. status is a read — it stays available without trust.
test('status stays available without real-supervisor trust', async () => {
  const sup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(sup, { scope: { kind: 'none' } });

  const code = await cmdService(['service', 'status'], {}, io, d);

  expect(code).toBe(0);
  expect(io.out.join('\n')).toContain('not loaded');
});

// 12c. self-update without trust still replaces the binary but never kicks the
// real daemon (the restart is a supervisor mutation like any other) — and says
// so: a loaded daemon silently left on stale code would break the "restarted
// or surfaced" invariant.
test('self-update without real-supervisor trust skips the daemon restart, loudly', async () => {
  const newTag = 'v0.6.0';
  const fakeBody = new TextEncoder().encode(protocolCandidate);
  const sha256 = new Bun.CryptoHasher('sha256').update(fakeBody).digest('hex');
  const { assetName } = await import('./self-update');
  const asset = assetName();

  const sup = new FakeSupervisor();
  sup.state = { loaded: true, pid: 1234, running: true };
  const io = fakeIo();
  const d = deps(sup, {
    fetcher: (url: string) => {
      if (url.includes('/releases/latest')) {
        return Promise.resolve(
          new Response(null, {
            headers: { location: `https://github.com/dbtlr/mimir/releases/tag/${newTag}` },
            status: 302,
          }),
        );
      }
      if (url.includes(`/download/${newTag}/SHA256SUMS`)) {
        return Promise.resolve(new Response(`${sha256}  ${asset}\n`, { status: 200 }));
      }
      if (url.includes(`/download/${newTag}/${asset}`)) {
        return Promise.resolve(new Response(fakeBody, { status: 200 }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    },
    scope: { kind: 'none' },
    version: '0.5.0',
  });

  const code = await cmdSelfUpdate(io, d, {}, 'json');

  expect(code).toBe(0);
  expect(sup.calls).not.toContain('restart');
  expect(readFileSync(d.binPath)).toEqual(Buffer.from(fakeBody));
  const parsed = JSON.parse(io.out.join('\n'));
  expect(parsed).toMatchObject({ restarted: false, updated: true });
  // The update itself is logged; no restart event was ever attempted.
  expect(recentEvents(d.eventsFile, 10).map((e) => e.event)).toEqual(['self-update']);
  // The skip is surfaced, not silent — the loaded daemon is running stale code.
  expect(io.err.join('\n')).toContain('service not restarted');
});

// --- the narrowed fence (MMR-54): an installation drives only the units it owns ---

const SANDBOX_ID = '1234abcd-1234-4234-8234-123456789012';
const sandboxScope = { id: SANDBOX_ID, kind: 'sandbox' } as const;

/** A fetcher serving release `newTag` whose asset is a valid installation candidate. */
async function releaseFetcher(newTag: string): Promise<{
  fetcher: ServiceDeps['fetcher'];
  body: Uint8Array;
}> {
  const body = new TextEncoder().encode(protocolCandidate);
  const sha256 = new Bun.CryptoHasher('sha256').update(body).digest('hex');
  const { assetName } = await import('./self-update');
  const asset = assetName();
  const fetcher: ServiceDeps['fetcher'] = (url: string) => {
    if (url.includes('/releases/latest')) {
      return Promise.resolve(
        new Response(null, {
          headers: { location: `https://github.com/dbtlr/mimir/releases/tag/${newTag}` },
          status: 302,
        }),
      );
    }
    if (url.includes(`/download/${newTag}/SHA256SUMS`)) {
      return Promise.resolve(new Response(`${sha256}  ${asset}\n`, { status: 200 }));
    }
    if (url.includes(`/download/${newTag}/${asset}`)) {
      return Promise.resolve(new Response(body, { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  };
  return { body, fetcher };
}

// 13. a sandbox installation can never address the live unit names
test('a sandbox installation refuses every mutating verb on live unit names', async () => {
  for (const verb of ['install', 'uninstall', 'start', 'stop', 'restart']) {
    const sup = new FakeSupervisor();
    const d = deps(sup, { scope: sandboxScope });

    let thrown: unknown;
    try {
      await cmdService(['service', verb], {}, fakeIo(), d);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(MimirError);
    expect(thrown instanceof Error && thrown.message).toContain(
      `${SERVE_LABEL} belongs to another installation`,
    );
    expect(sup.calls).toEqual([]);
    expect(existsSync(d.units.serve.unitFile)).toBe(false);
    expect(existsSync(d.eventsFile)).toBe(false);
  }
});

// 13b. a live installation cannot be pointed at a sandbox's units either
test('a live installation refuses to drive sandbox-scoped units', async () => {
  const sup = new FakeSupervisor();
  const d = deps(sup);
  d.units.serve = { ...d.units.serve, label: unitLabels(sandboxScope).serve };
  let thrown: unknown;
  try {
    await cmdService(['service', 'restart'], {}, fakeIo(), d);
  } catch (e) {
    thrown = e;
  }
  expect(thrown instanceof Error && thrown.message).toContain('belongs to another installation');
  expect(sup.calls).toEqual([]);
});

// 13c. a sandbox installation drives the real supervisor for its own units
test('a sandbox installation drives its own sandbox-scoped units', async () => {
  const sup = new FakeSupervisor();
  const d = deps(sup, { scope: sandboxScope });
  d.units.serve = { ...d.units.serve, label: unitLabels(sandboxScope).serve };

  expect(await cmdService(['service', 'install', 'serve'], {}, fakeIo(), d)).toBe(0);
  expect(await cmdService(['service', 'restart'], {}, fakeIo(), d)).toBe(0);
  expect(sup.calls).toEqual(['install', 'restart']);
});

// 13d. self-update's restart honors the same ownership check
test('self-update from a sandbox never restarts a live-named daemon, and says so', async () => {
  const sup = new FakeSupervisor();
  sup.state = { loaded: true, pid: 1234, running: true };
  const io = fakeIo();
  const { fetcher } = await releaseFetcher('v0.6.0');
  const d = deps(sup, { fetcher, scope: sandboxScope, version: '0.5.0' });

  expect(await cmdSelfUpdate(io, d, {}, 'json')).toBe(0);
  expect(sup.calls).not.toContain('restart');
  expect(io.err.join('\n')).toContain('service not restarted');
});

// 13e. the systemd restart path: self-update restarts the daemon on Linux too
test('self-update on Linux restarts the loaded serve unit', async () => {
  const sup = new FakeSupervisor();
  sup.state = { loaded: true, pid: 1234, running: true };
  const { body, fetcher } = await releaseFetcher('v0.6.0');
  const d = deps(sup, { fetcher, platform: 'linux', version: '0.5.0' });

  const io = fakeIo();
  expect(await cmdSelfUpdate(io, d, {}, 'json')).toBe(0);
  expect(sup.calls).toEqual(['restart']);
  expect(readFileSync(d.binPath)).toEqual(Buffer.from(body));
  expect(JSON.parse(io.out.join('\n'))).toMatchObject({ restarted: true, updated: true });
});
