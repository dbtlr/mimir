import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Exec } from './launchd';
import type { Supervisor } from './supervisor';
import { SystemdSupervisor } from './systemd';

function fakeExec(handler: (argv: string[]) => { code: number; stdout: string; stderr?: string }) {
  const calls: string[][] = [];
  const exec: Exec = (argv) => {
    calls.push(argv);
    return Promise.resolve({ stderr: '', ...handler(argv) });
  };
  return { calls, exec };
}

const ok = () => ({ code: 0, stdout: '' });
/** Bun.spawn's failure when the executable is not on PATH. */
const missingSystemctl: Exec = () =>
  Promise.reject(new Error('Executable not found in $PATH: "systemctl"'));
const SERVE = 'com.dbtlr.mimir.serve.service';
const SERVE_FILE = `/home/op/.config/systemd/user/${SERVE}`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mimir-systemd-'));
});
afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
  }
  throw new Error('expected a rejection');
}

test('install enables the unit file, reloads the manager, then (re)starts the unit', async () => {
  const { exec, calls } = fakeExec(ok);
  await new SystemdSupervisor(exec, SERVE_FILE).install();
  expect(calls).toEqual([
    ['systemctl', '--user', 'enable', SERVE_FILE],
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'restart', SERVE],
  ]);
});

test('install fails fast when enable fails, never restarting a unit it could not install', async () => {
  const { exec, calls } = fakeExec((argv) =>
    argv[2] === 'enable' ? { code: 1, stderr: 'Unit file is masked.', stdout: '' } : ok(),
  );
  const err = await failure(new SystemdSupervisor(exec, SERVE_FILE).install());
  expect(err.message).toMatch(/systemctl enable failed \(1\)/);
  expect(calls.map((c) => c[2])).toEqual(['enable']);
});

test('a failing restart during install surfaces with the stderr hint', async () => {
  const { exec } = fakeExec((argv) =>
    argv[2] === 'restart' ? { code: 5, stderr: 'Unit not found.', stdout: '' } : ok(),
  );
  const err = await failure(new SystemdSupervisor(exec, SERVE_FILE).install());
  expect(err.message).toMatch(/systemctl restart failed \(5\)/);
});

/** `systemctl show` output for a unit, keyed by its ActiveState. */
function shown(active: string): string {
  return `MainPID=0\nLoadState=loaded\nActiveState=${active}\nSubState=x\n`;
}

test('uninstall stops a running unit, disables it, removes its file, then reloads', async () => {
  const serve = join(dir, SERVE);
  writeFileSync(serve, '[Service]\n');
  const { exec, calls } = fakeExec((argv) => {
    // disable needs the file; the reload must not find it.
    if (argv[2] === 'disable') {
      expect(existsSync(serve)).toBe(true);
    }
    if (argv[2] === 'daemon-reload') {
      expect(existsSync(serve)).toBe(false);
    }
    if (argv[2] === 'show') {
      return { code: 0, stdout: shown('active') };
    }
    return ok();
  });
  await new SystemdSupervisor(exec, serve).uninstall();
  expect(calls.filter((c) => c[2] !== 'show')).toEqual([
    ['systemctl', '--user', 'stop', SERVE],
    ['systemctl', '--user', 'disable', SERVE],
    ['systemctl', '--user', 'daemon-reload'],
  ]);
});

test('uninstall stops a unit that still runs after its unit file vanished', async () => {
  // `disable` fails on a missing unit file before anything is stopped, so the
  // stop must not depend on it: Restart=always would otherwise keep the daemon up.
  const { exec, calls } = fakeExec((argv) => {
    if (argv[2] === 'show') {
      return {
        code: 0,
        stdout: 'MainPID=4242\nLoadState=not-found\nActiveState=active\nSubState=running\n',
      };
    }
    if (argv[2] === 'disable') {
      return { code: 1, stderr: 'Unit file does not exist.', stdout: '' };
    }
    return ok();
  });
  await new SystemdSupervisor(exec, join(dir, SERVE)).uninstall();
  expect(calls.map((c) => c[2])).toEqual(['show', 'stop', 'disable', 'daemon-reload']);
});

test('uninstall fails loudly when a running unit will not stop, keeping its file', async () => {
  const serve = join(dir, SERVE);
  writeFileSync(serve, '[Service]\n');
  const { exec, calls } = fakeExec((argv) => {
    if (argv[2] === 'show') {
      return { code: 0, stdout: shown('active') };
    }
    return argv[2] === 'stop' ? { code: 1, stderr: 'Access denied', stdout: '' } : ok();
  });
  const err = await failure(new SystemdSupervisor(exec, serve).uninstall());
  expect(err.message).toMatch(/systemctl stop failed \(1\)/);
  expect(calls.map((c) => c[2])).toEqual(['show', 'stop']);
  expect(existsSync(serve)).toBe(true);
});

test('uninstall tolerates units that are already gone', async () => {
  const { exec, calls } = fakeExec((argv) =>
    argv[2] === 'show' ? { code: 0, stdout: shown('inactive') } : { code: 1, stdout: '' },
  );
  await new SystemdSupervisor(exec, join(dir, SERVE)).uninstall(); // must not throw
  expect(calls.map((c) => c[2])).not.toContain('stop');
});

test('uninstall on a host without systemctl only removes the files', async () => {
  const serve = join(dir, SERVE);
  writeFileSync(serve, '[Service]\n');
  await new SystemdSupervisor(missingSystemctl, serve).uninstall(); // must not throw
  expect(existsSync(serve)).toBe(false);
});

test('a host without systemctl reads as not loaded and fails installs loudly', async () => {
  const sup = new SystemdSupervisor(missingSystemctl, SERVE_FILE);
  expect(await sup.info()).toEqual({ loaded: false, running: false });
  expect((await failure(sup.install())).message).toMatch(/systemctl enable failed \(127\)/);
});

test('start, stop, and restart address the unit by name', async () => {
  const { exec, calls } = fakeExec(ok);
  const sup: Supervisor = new SystemdSupervisor(exec, SERVE_FILE);
  await sup.start('/tmp/x.service');
  await sup.stop();
  await sup.restart();
  expect(calls).toEqual([
    ['systemctl', '--user', 'start', SERVE],
    ['systemctl', '--user', 'stop', SERVE],
    ['systemctl', '--user', 'restart', SERVE],
  ]);
});

test('a failing stop or restart surfaces as an error', async () => {
  const { exec } = fakeExec(() => ({ code: 5, stdout: '' }));
  const sup = new SystemdSupervisor(exec, SERVE_FILE);
  expect((await failure(sup.stop())).message).toMatch(/systemctl stop failed \(5\)/);
  expect((await failure(sup.restart())).message).toMatch(/is the service installed\?/);
});

test('info reads load, activity, and the main pid from systemctl show', async () => {
  const { exec, calls } = fakeExec(() => ({
    code: 0,
    stdout: 'MainPID=4242\nLoadState=loaded\nActiveState=active\nSubState=running\n',
  }));
  expect(await new SystemdSupervisor(exec, SERVE_FILE).info()).toEqual({
    loaded: true,
    pid: 4242,
    running: true,
  });
  expect(calls[0]).toEqual([
    'systemctl',
    '--user',
    'show',
    SERVE,
    '--property=ActiveState,MainPID',
  ]);
});

test('info: a crash-looping unit is loaded but not running', async () => {
  const { exec } = fakeExec(() => ({
    code: 0,
    stdout: 'MainPID=0\nLoadState=loaded\nActiveState=activating\nSubState=auto-restart\n',
  }));
  expect(await new SystemdSupervisor(exec, SERVE_FILE).info()).toEqual({
    loaded: true,
    running: false,
  });
});

test('info: a stopped or unknown unit is not loaded', async () => {
  for (const stdout of [
    'MainPID=0\nLoadState=loaded\nActiveState=inactive\nSubState=dead\n',
    'MainPID=0\nLoadState=not-found\nActiveState=inactive\nSubState=dead\n',
  ]) {
    const { exec } = fakeExec(() => ({ code: 0, stdout }));
    expect(await new SystemdSupervisor(exec, SERVE_FILE).info()).toEqual({
      loaded: false,
      running: false,
    });
  }
});

test('info: a unit still running after its unit file vanished is loaded', async () => {
  // After a daemon-reload the manager keeps a running unit whose file is gone,
  // with LoadState=not-found; status must not report it as down.
  const { exec } = fakeExec(() => ({
    code: 0,
    stdout: 'MainPID=4242\nLoadState=not-found\nActiveState=active\nSubState=running\n',
  }));
  expect(await new SystemdSupervisor(exec, SERVE_FILE).info()).toEqual({
    loaded: true,
    pid: 4242,
    running: true,
  });
});

test('info: an unreachable user manager reads as not loaded', async () => {
  const { exec } = fakeExec(() => ({ code: 1, stdout: '' }));
  expect(await new SystemdSupervisor(exec, SERVE_FILE).info()).toEqual({
    loaded: false,
    running: false,
  });
});
