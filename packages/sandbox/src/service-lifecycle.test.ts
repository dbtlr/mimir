import { expect, test } from 'bun:test';

import { verifyServiceLifecycle } from './service-lifecycle';
import type { LifecycleOptions, ServiceHost } from './service-lifecycle';

const VERSION = '0.20.0-next';
const PORT = 55123;
const MARKER = 'com.dbtlr.mimir.sandbox-1234abcd-1234-4234-8234-123456789012.';

/**
 * A supervisor that behaves like launchd/systemd from the CLI's point of view:
 * units install and load, a killed serve process respawns under a new pid, and
 * stop/uninstall take the daemon (and its health endpoint) down. Each knob
 * breaks one behaviour the lifecycle must catch.
 */
class FakeSupervisorHost implements ServiceHost {
  calls: string[] = [];
  files = new Set<string>();
  serve = { loaded: false, pid: 0 };
  snapshot = { loaded: false };
  nextPid = 100;
  unitDirectory = `/sandbox/data/LaunchAgents/${MARKER}`;
  respawnAfterKill = true;

  mimir(args: string[]): Promise<string> {
    const flags = args.findIndex((a) => a.startsWith('--'));
    this.calls.push((flags === -1 ? args : args.slice(0, flags)).join(' '));
    const [, sub] = args;
    const serveFile = `${this.unitDirectory}serve.plist`;
    const snapshotFile = `${this.unitDirectory}snapshot.plist`;
    switch (sub) {
      case 'install': {
        this.files.add(serveFile).add(snapshotFile);
        this.serve = { loaded: true, pid: this.spawn() };
        this.snapshot = { loaded: true };
        return Promise.resolve(
          JSON.stringify({
            actions: [
              { action: 'install', ok: true, paths: { plist: serveFile }, unit: 'serve' },
              { action: 'install', ok: true, paths: { plist: snapshotFile }, unit: 'snapshot' },
            ],
          }),
        );
      }
      case 'restart': {
        this.serve.pid = this.spawn();
        return Promise.resolve('{"actions":[]}');
      }
      case 'stop': {
        this.serve = { loaded: false, pid: 0 };
        return Promise.resolve('{"actions":[]}');
      }
      case 'start': {
        this.serve = { loaded: true, pid: this.spawn() };
        return Promise.resolve('{"actions":[]}');
      }
      case 'uninstall': {
        this.files.clear();
        this.serve = { loaded: false, pid: 0 };
        this.snapshot = { loaded: false };
        return Promise.resolve('{"actions":[]}');
      }
      case 'status': {
        return Promise.resolve(
          JSON.stringify({
            units: [
              {
                health: this.serve.pid > 0 ? { running_version: VERSION } : null,
                loaded: this.serve.loaded,
                pid: this.serve.pid > 0 ? this.serve.pid : null,
                running: this.serve.pid > 0,
                unit: 'serve',
              },
              { loaded: this.snapshot.loaded, pid: null, running: false, unit: 'snapshot' },
            ],
          }),
        );
      }
      default: {
        return Promise.reject(new Error(`unexpected mimir ${args.join(' ')}`));
      }
    }
  }
  health(port: number): Promise<string | undefined> {
    return Promise.resolve(port === PORT && this.serve.pid > 0 ? VERSION : undefined);
  }
  kill(pid: number): Promise<void> {
    this.calls.push(`kill ${String(pid)}`);
    if (pid === this.serve.pid) {
      this.serve.pid = this.respawnAfterKill ? this.spawn() : 0;
    }
    return Promise.resolve();
  }
  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }
  private spawn(): number {
    this.nextPid += 1;
    return this.nextPid;
  }
}

function options(overrides: Partial<LifecycleOptions> = {}): LifecycleOptions {
  return {
    attempts: 3,
    liveState: () => Promise.resolve('serve: absent'),
    pause: () => Promise.resolve(),
    port: PORT,
    unitFileMarker: MARKER,
    version: VERSION,
    ...overrides,
  };
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'unexpected success';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

test('the lifecycle drives install through uninstall and proves each transition', async () => {
  const host = new FakeSupervisorHost();
  const steps = await verifyServiceLifecycle(host, options());
  expect(steps.map((s) => s.step)).toEqual([
    'install',
    'health',
    'status',
    'restart',
    'kill-and-recover',
    'stop',
    'start',
    'uninstall',
    'live-untouched',
  ]);
  expect(host.calls).toEqual([
    'service install all',
    'service status',
    'service restart serve',
    'service status',
    'kill 102',
    'service status',
    'service stop serve',
    'service status',
    'service start serve',
    'service status',
    'service uninstall',
    'service status',
  ]);
});

test('a unit file outside the installation-scoped names fails the run', async () => {
  const host = new FakeSupervisorHost();
  host.unitDirectory = '/Users/op/Library/LaunchAgents/com.dbtlr.mimir.';
  expect(await failure(verifyServiceLifecycle(host, options()))).toContain(
    'is not one of this installation',
  );
});

test('a daemon that does not come back after a kill fails the run', async () => {
  const host = new FakeSupervisorHost();
  host.respawnAfterKill = false;
  expect(await failure(verifyServiceLifecycle(host, options()))).toContain('kill-and-recover');
});

test('any change to the live units fails the run', async () => {
  const host = new FakeSupervisorHost();
  const states = ['serve: pid 7', 'serve: pid 8'];
  const liveState = () => Promise.resolve(states.shift() ?? 'gone');
  expect(await failure(verifyServiceLifecycle(host, options({ liveState })))).toContain(
    'live units changed',
  );
});

test('unit files left behind by uninstall fail the run', async () => {
  const host = new FakeSupervisorHost();
  const original = host.mimir.bind(host);
  host.mimir = async (args) => {
    const kept = new Set(host.files);
    const result = await original(args);
    if (args[1] === 'uninstall') {
      host.files = kept;
    }
    return result;
  };
  expect(await failure(verifyServiceLifecycle(host, options()))).toContain('still on disk');
});
