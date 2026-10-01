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
const TIMER = 'com.dbtlr.mimir.snapshot.timer';
const SERVE_FILE = `/home/op/.config/systemd/user/${SERVE}`;
const TIMER_FILE = `/sandbox/data/systemd/${TIMER}`;
const ONESHOT_FILE = '/sandbox/data/systemd/com.dbtlr.mimir.snapshot.service';

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

test('install links companion unit files before enabling the primary unit', async () => {
  // The snapshot timer activates a oneshot service of the same name; an
  // out-of-search-path service file must be linked for the timer to find it.
  const { exec, calls } = fakeExec(ok);
  await new SystemdSupervisor(exec, TIMER_FILE, [ONESHOT_FILE]).install();
  expect(calls).toEqual([
    ['systemctl', '--user', 'link', ONESHOT_FILE],
    ['systemctl', '--user', 'enable', TIMER_FILE],
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'restart', TIMER],
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

test('uninstall disables the unit and its companions, removes their files, then reloads', async () => {
  const timer = join(dir, TIMER);
  const oneshot = join(dir, 'com.dbtlr.mimir.snapshot.service');
  writeFileSync(timer, '[Timer]\n');
  writeFileSync(oneshot, '[Service]\n');
  const { exec, calls } = fakeExec((argv) => {
    // disable needs the files; the reload must not find them.
    if (argv[2] === 'disable') {
      expect(existsSync(timer)).toBe(true);
    }
    if (argv[2] === 'daemon-reload') {
      expect(existsSync(timer) || existsSync(oneshot)).toBe(false);
    }
    return ok();
  });
  await new SystemdSupervisor(exec, timer, [oneshot]).uninstall();
  expect(calls).toEqual([
    ['systemctl', '--user', 'disable', '--now', TIMER],
    ['systemctl', '--user', 'disable', '--now', 'com.dbtlr.mimir.snapshot.service'],
    ['systemctl', '--user', 'daemon-reload'],
  ]);
});

test('uninstall tolerates units that are already gone', async () => {
  const { exec } = fakeExec(() => ({ code: 1, stdout: '' }));
  await new SystemdSupervisor(exec, join(dir, SERVE)).uninstall(); // must not throw
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
    '--property=LoadState,ActiveState,SubState,MainPID',
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

test('info: an armed timer is loaded with no process of its own', async () => {
  const { exec } = fakeExec(() => ({
    code: 0,
    stdout: 'LoadState=loaded\nActiveState=active\nSubState=waiting\n',
  }));
  expect(await new SystemdSupervisor(exec, TIMER_FILE).info()).toEqual({
    loaded: true,
    running: false,
  });
});

test('info: an unreachable user manager reads as not loaded', async () => {
  const { exec } = fakeExec(() => ({ code: 1, stdout: '' }));
  expect(await new SystemdSupervisor(exec, SERVE_FILE).info()).toEqual({
    loaded: false,
    running: false,
  });
});
