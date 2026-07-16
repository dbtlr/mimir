import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeIo } from '../cli/testing';
import { MimirError } from '../core';
import { PROD_PORT } from '../env';
import type { ServiceDeps } from './commands';
import { cmdSelfUpdate, cmdService } from './commands';
import { readServeConfig } from './config';
import { recentEvents } from './events';
import type { ServiceInfo, Supervisor } from './launchd';
import { plistFor, plistForSnapshot } from './plist';

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

function deps(
  sup: FakeSupervisor,
  extra: Partial<ServiceDeps> = {},
  snapSup: FakeSupervisor = new FakeSupervisor(),
): ServiceDeps {
  return {
    allowRealSupervisor: true,
    binPath: join(dir, 'mimir'),
    configFile: join(dir, 'config.toml'),
    eventsFile: join(dir, 'service-events.jsonl'),
    fetcher: () => Promise.reject(new Error('no network in tests')),
    health: () => Promise.resolve(undefined),
    platform: 'darwin',
    units: {
      serve: {
        logFile: join(dir, 'serve.log'),
        plistFile: join(dir, 'com.dbtlr.mimir.serve.plist'),
        render: () => plistFor(join(dir, 'mimir'), {}),
        supervisor: sup,
      },
      snapshot: {
        logFile: join(dir, 'snapshot.log'),
        plistFile: join(dir, 'com.dbtlr.mimir.snapshot.plist'),
        render: () => plistForSnapshot(join(dir, 'mimir'), { intervalSeconds: 900 }),
        supervisor: snapSup,
      },
    },
    version: '0.5.0',
    ...extra,
  };
}

// 1. install serve writes the plist, delegates, logs, and --port writes config
test('install serve writes the plist, delegates, logs, and --port writes config', async () => {
  const sup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(sup);

  const code = await cmdService(['service', 'install', 'serve'], { port: '55440' }, io, d);

  expect(code).toBe(0);
  expect(existsSync(d.units.serve.plistFile)).toBe(true);
  const plistContent = readFileSync(d.units.serve.plistFile, 'utf8');
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

// 2b. snapshot is opt-in: a bare `install` sets up only serve
test('install with no unit installs only serve (snapshot is opt-in)', async () => {
  const serveSup = new FakeSupervisor();
  const snapSup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(serveSup, {}, snapSup);

  const code = await cmdService(['service', 'install'], {}, io, d);

  expect(code).toBe(0);
  expect(serveSup.calls).toEqual(['install']);
  expect(snapSup.calls).toEqual([]);
  expect(existsSync(d.units.serve.plistFile)).toBe(true);
  expect(existsSync(d.units.snapshot.plistFile)).toBe(false);
  expect(recentEvents(d.eventsFile, 10).map((e) => e.event)).toEqual(['install']);
});

// 2b-all. `install all` opts into both units
test('install all installs both serve and snapshot', async () => {
  const serveSup = new FakeSupervisor();
  const snapSup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(serveSup, {}, snapSup);

  const code = await cmdService(['service', 'install', 'all'], {}, io, d);

  expect(code).toBe(0);
  expect(serveSup.calls).toEqual(['install']);
  expect(snapSup.calls).toEqual(['install']);
  expect(existsSync(d.units.serve.plistFile)).toBe(true);
  expect(existsSync(d.units.snapshot.plistFile)).toBe(true);
  expect(recentEvents(d.eventsFile, 10).map((e) => e.event)).toEqual(['install', 'install']);
});

// 2c. a single-unit selector touches only that unit
test('install snapshot installs only the snapshot unit', async () => {
  const serveSup = new FakeSupervisor();
  const snapSup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(serveSup, {}, snapSup);

  const code = await cmdService(['service', 'install', 'snapshot'], {}, io, d);

  expect(code).toBe(0);
  expect(serveSup.calls).toEqual([]);
  expect(snapSup.calls).toEqual(['install']);
  expect(existsSync(d.units.serve.plistFile)).toBe(false);
  expect(existsSync(d.units.snapshot.plistFile)).toBe(true);
  const plist = readFileSync(d.units.snapshot.plistFile, 'utf8');
  expect(plist).toContain('StartInterval');
});

// 2d. an unknown unit selector is a usage error
test('an unknown unit is a usage error', async () => {
  const io = fakeIo();
  const d = deps(new FakeSupervisor());
  let thrown: unknown;
  try {
    await cmdService(['service', 'install', 'nope'], {}, io, d);
  } catch (e) {
    thrown = e;
  }
  expect(thrown instanceof Error && thrown.message).toMatch(/unknown unit/);
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
  expect(existsSync(d.units.serve.plistFile)).toBe(false);
});

/** A serve render that fails the serve-env preflight (e.g. missing vault). */
const boomRender = (): string => {
  throw new Error('service install: the configured vault does not exist');
};

// 3b. a render that throws (bad Norn env preflight) aborts before mutating config
test('a failing render aborts install before --port is persisted or the unit installs', async () => {
  const sup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(sup, {
    units: {
      serve: {
        logFile: join(dir, 'serve.log'),
        plistFile: join(dir, 'com.dbtlr.mimir.serve.plist'),
        render: boomRender,
        supervisor: sup,
      },
      snapshot: {
        logFile: join(dir, 'snapshot.log'),
        plistFile: join(dir, 'com.dbtlr.mimir.snapshot.plist'),
        render: () => plistForSnapshot(join(dir, 'mimir'), { intervalSeconds: 900 }),
        supervisor: new FakeSupervisor(),
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
  expect(existsSync(d.units.serve.plistFile)).toBe(false);
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

// 4b. a bare lifecycle verb sweeps only INSTALLED units — it must not hard-fail
// on a unit that was never set up (regression: default-all threw on snapshot).
test('restart with no selector skips a not-installed unit instead of throwing', async () => {
  const serveSup = new FakeSupervisor();
  // A supervisor that throws on restart, mirroring launchctl kickstart on a
  // not-loaded/not-installed service.
  class ThrowingSupervisor extends FakeSupervisor {
    override restart(): Promise<void> {
      this.calls.push('restart');
      return Promise.reject(new Error('kickstart: service not found'));
    }
  }
  const snapSup = new ThrowingSupervisor();
  const io = fakeIo();
  const d = deps(serveSup, {}, snapSup);
  // serve is installed; snapshot is NOT (no plist on disk).
  await cmdService(['service', 'install', 'serve'], {}, io, d);

  const code = await cmdService(['service', 'restart'], {}, io, d);

  expect(code).toBe(0);
  expect(serveSup.calls).toContain('restart');
  expect(snapSup.calls).toEqual([]); // the not-installed unit was never touched
});

// 4c. an explicit `all` (or a named not-installed unit) must ALSO skip an
// uninstalled unit — the installed()-guard applies to every selector.
test('restart all skips a not-installed unit instead of throwing', async () => {
  const serveSup = new FakeSupervisor();
  class ThrowingSupervisor extends FakeSupervisor {
    override restart(): Promise<void> {
      this.calls.push('restart');
      return Promise.reject(new Error('kickstart: service not found'));
    }
  }
  const snapSup = new ThrowingSupervisor();
  const io = fakeIo();
  const d = deps(serveSup, {}, snapSup);
  await cmdService(['service', 'install', 'serve'], {}, io, d); // snapshot NOT installed

  const code = await cmdService(['service', 'restart', 'all'], {}, io, d);

  // `all` is a sweep like the bare verb: serve restarts, snapshot is a reported
  // no-op (never a throw), and the sweep still succeeds (exit 0) on the common
  // serve-only host where snapshot is simply not installed.
  expect(code).toBe(0);
  expect(serveSup.calls).toContain('restart');
  expect(snapSup.calls).toEqual([]); // never touched despite `all`
  expect(io.err.join('\n')).toContain('snapshot: not installed');
});

// 4e. exit-code contract: a lifecycle verb succeeds iff it acted on ≥1 unit, so
// a `&&`-chaining deploy step never proceeds on a no-op.
test('lifecycle exit code is 0 iff at least one unit was acted on', async () => {
  const serveSup = new FakeSupervisor();
  const snapSup = new FakeSupervisor();
  const d = deps(serveSup, {}, snapSup);

  // Nothing installed: a bare restart acted on nothing → nonzero, with guidance.
  const io1 = fakeIo();
  expect(await cmdService(['service', 'restart'], {}, io1, d)).toBe(1);
  expect(io1.out.join('\n')).toContain('no units installed');

  // `start all` when the serve daemon itself is absent acted on nothing → nonzero
  // (a deploy chain must not proceed against a daemon that never started).
  const io2 = fakeIo();
  expect(await cmdService(['service', 'start', 'all'], {}, io2, d)).toBe(1);

  // Explicitly starting a not-installed unit is a failed request → nonzero.
  const io3 = fakeIo();
  expect(await cmdService(['service', 'start', 'snapshot'], {}, io3, d)).toBe(1);
  expect(io3.err.join('\n')).toContain('snapshot: not installed');

  // Install serve, then `restart all`: serve is acted on → success, even though
  // the opt-in snapshot is absent.
  const io4 = fakeIo();
  await cmdService(['service', 'install', 'serve'], {}, io4, d);
  const io5 = fakeIo();
  expect(await cmdService(['service', 'restart', 'all'], {}, io5, d)).toBe(0);
  expect(serveSup.calls).toContain('restart');
});

// 4f. uninstalling a not-installed unit is idempotent — no phantom teardown
// event, no "uninstalled" claim.
test('uninstall of a not-installed unit logs nothing and reports honestly', async () => {
  const io = fakeIo();
  const d = deps(new FakeSupervisor(), {}, new FakeSupervisor());

  const code = await cmdService(['service', 'uninstall', 'snapshot'], {}, io, d);

  expect(code).toBe(0);
  expect(io.out.join('\n')).toContain('not installed (nothing to remove)');
  expect(io.out.join('\n')).not.toContain('snapshot uninstalled');
  // No phantom 'uninstall' event was logged for a unit that never existed.
  expect(recentEvents(d.eventsFile, 10)).toEqual([]);
});

// 4g. a unit still loaded whose plist vanished is a REAL teardown — bootout
// runs and the event is logged, not silently mis-reported as "not installed".
test('uninstall of a loaded unit with no plist reports and logs a real teardown', async () => {
  const loadedSnap = new FakeSupervisor();
  loadedSnap.state = { loaded: true, pid: 999, running: true };
  const io = fakeIo();
  const d = deps(new FakeSupervisor(), {}, loadedSnap);
  // No snapshot plist on disk, but the unit is loaded/running.

  const code = await cmdService(['service', 'uninstall', 'snapshot'], {}, io, d);

  expect(code).toBe(0);
  expect(loadedSnap.calls).toContain('uninstall'); // bootout actually ran
  expect(io.out.join('\n')).toContain('snapshot uninstalled');
  expect(recentEvents(d.eventsFile, 10).map((e) => e.event)).toEqual(['uninstall']);
});

// 4d. a bare `uninstall` sweeps whatever is installed — it must not orphan the
// snapshot timer set up via `install all` (regression: uninstall defaulted to
// serve only, leaving the auto-push timer running).
test('uninstall with no selector tears down every installed unit', async () => {
  const serveSup = new FakeSupervisor();
  const snapSup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(serveSup, {}, snapSup);
  await cmdService(['service', 'install', 'all'], {}, io, d);

  const code = await cmdService(['service', 'uninstall'], {}, io, d);

  expect(code).toBe(0);
  expect(serveSup.calls).toContain('uninstall');
  expect(snapSup.calls).toContain('uninstall');
  expect(existsSync(d.units.serve.plistFile)).toBe(false);
  expect(existsSync(d.units.snapshot.plistFile)).toBe(false); // no orphan
});

// 5. unknown subcommand is usage; non-darwin is a loud operational error
test('unknown subcommand is usage; non-darwin is a loud operational error', async () => {
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

  // non-darwin
  {
    const sup = new FakeSupervisor();
    const d = deps(sup, { platform: 'linux' });
    let thrown: unknown;
    try {
      await cmdService(['service', 'start'], {}, io, d);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(thrown instanceof Error && thrown.message).toMatch(/macOS/);
  }
});

// 6. status reports running vs on-disk version and restart pending
test('status reports running vs on-disk version and restart pending', async () => {
  const sup = new FakeSupervisor();
  sup.state = { loaded: true, pid: 4242, running: true };
  const io = fakeIo();
  const d = deps(sup, {
    health: () => Promise.resolve({ status: 'ok', version: '0.5.0' }),
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
    health: () => Promise.resolve({ status: 'ok', version: '0.15.0-next.1' }),
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
  expect(io.err.join('\n')).toContain('[warn] config ignored (invalid-port)');
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
  const fakeBody = new TextEncoder().encode('fake-binary-content');
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
  const fakeBody = new TextEncoder().encode('fake-binary-content');
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
  expect(io.out.join('\n')).toContain('0.15.0-next.1 → 0.15.0');
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
    health: () => Promise.resolve({ status: 'ok', version: '0.5.0' }),
    version: '0.6.0',
  });

  const code = await cmdService(['service', 'status'], {}, io, d, 'json');

  expect(code).toBe(0);
  const parsed = JSON.parse(io.out.join('\n'));
  const serve = parsed.units.find((u: { unit: string }) => u.unit === 'serve');
  expect(serve).toMatchObject({
    health: { on_disk_version: '0.6.0', restart_pending: true, running_version: '0.5.0' },
    loaded: true,
    pid: 4242,
    port: PROD_PORT,
    running: true,
  });
  expect(serve.plist).toBe(d.units.serve.plistFile);
  // The snapshot unit is reported too, carrying its interval, not a port.
  const snap = parsed.units.find((u: { unit: string }) => u.unit === 'snapshot');
  expect(snap).toMatchObject({ interval_seconds: 900, unit: 'snapshot' });
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
  expect(parsed.actions[0].paths.plist).toBe(d.units.serve.plistFile);
  // The human path's detail lines must not leak into json mode.
  expect(io.out.join('\n')).not.toContain('plist:');
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
    const snapSup = new FakeSupervisor();
    const io = fakeIo();
    const d = deps(sup, { allowRealSupervisor: false }, snapSup);

    let thrown: unknown;
    try {
      await cmdService(['service', verb], {}, io, d);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(MimirError);
    expect(thrown instanceof Error && thrown.message).toMatch(/dev\/from-source/);
    expect(thrown instanceof Error && thrown.message).toContain(verb);
    expect(thrown instanceof MimirError && thrown.hint).toContain('MIMIR_ALLOW_REAL_SERVICE');
    expect(sup.calls).toEqual([]);
    expect(snapSup.calls).toEqual([]);
    expect(existsSync(d.units.serve.plistFile)).toBe(false);
    expect(existsSync(d.eventsFile)).toBe(false);
  }
});

// 12b. status is a read — it stays available without trust.
test('status stays available without real-supervisor trust', async () => {
  const sup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(sup, { allowRealSupervisor: false });

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
  const fakeBody = new TextEncoder().encode('fake-binary-content');
  const sha256 = new Bun.CryptoHasher('sha256').update(fakeBody).digest('hex');
  const { assetName } = await import('./self-update');
  const asset = assetName();

  const sup = new FakeSupervisor();
  sup.state = { loaded: true, pid: 1234, running: true };
  const io = fakeIo();
  const d = deps(sup, {
    allowRealSupervisor: false,
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
