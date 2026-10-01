import { expect, test } from 'bun:test';

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
const SERVE = 'com.dbtlr.mimir.serve.service';
const TIMER = 'com.dbtlr.mimir.snapshot.timer';

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
  await new SystemdSupervisor(exec, SERVE).install(`/home/op/.config/systemd/user/${SERVE}`);
  expect(calls).toEqual([
    ['systemctl', '--user', 'enable', `/home/op/.config/systemd/user/${SERVE}`],
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'restart', SERVE],
  ]);
});

test('install links companion unit files before enabling the primary unit', async () => {
  // The snapshot timer activates a oneshot service of the same name; an
  // out-of-search-path service file must be linked for the timer to find it.
  const { exec, calls } = fakeExec(ok);
  const sup = new SystemdSupervisor(exec, TIMER, ['/sandbox/data/systemd/x.service']);
  await sup.install('/sandbox/data/systemd/x.timer');
  expect(calls).toEqual([
    ['systemctl', '--user', 'link', '/sandbox/data/systemd/x.service'],
    ['systemctl', '--user', 'enable', '/sandbox/data/systemd/x.timer'],
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'restart', TIMER],
  ]);
});

test('install fails fast when enable fails, never restarting a unit it could not install', async () => {
  const { exec, calls } = fakeExec((argv) =>
    argv[2] === 'enable' ? { code: 1, stderr: 'Unit file is masked.', stdout: '' } : ok(),
  );
  const err = await failure(new SystemdSupervisor(exec, SERVE).install('/tmp/x.service'));
  expect(err.message).toMatch(/systemctl enable failed \(1\)/);
  expect(calls.map((c) => c[2])).toEqual(['enable']);
});

test('a failing restart during install surfaces with the stderr hint', async () => {
  const { exec } = fakeExec((argv) =>
    argv[2] === 'restart' ? { code: 5, stderr: 'Unit not found.', stdout: '' } : ok(),
  );
  const err = await failure(new SystemdSupervisor(exec, SERVE).install('/tmp/x.service'));
  expect(err.message).toMatch(/systemctl restart failed \(5\)/);
});

test('uninstall disables and stops the unit and its companions, tolerating units already gone', async () => {
  const { exec, calls } = fakeExec(() => ({ code: 1, stdout: '' }));
  const sup = new SystemdSupervisor(exec, TIMER, ['/sandbox/data/systemd/x.service']);
  await sup.uninstall(); // must not throw: nothing installed is the expected no-op
  expect(calls).toEqual([
    ['systemctl', '--user', 'disable', '--now', TIMER],
    ['systemctl', '--user', 'disable', '--now', 'x.service'],
  ]);
});

test('start, stop, and restart address the unit by name', async () => {
  const { exec, calls } = fakeExec(ok);
  const sup: Supervisor = new SystemdSupervisor(exec, SERVE);
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
  const sup = new SystemdSupervisor(exec, SERVE);
  expect((await failure(sup.stop())).message).toMatch(/systemctl stop failed \(5\)/);
  expect((await failure(sup.restart())).message).toMatch(/is the service installed\?/);
});

test('info reads load, activity, and the main pid from systemctl show', async () => {
  const { exec, calls } = fakeExec(() => ({
    code: 0,
    stdout: 'MainPID=4242\nLoadState=loaded\nActiveState=active\nSubState=running\n',
  }));
  expect(await new SystemdSupervisor(exec, SERVE).info()).toEqual({
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
  expect(await new SystemdSupervisor(exec, SERVE).info()).toEqual({
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
    expect(await new SystemdSupervisor(exec, SERVE).info()).toEqual({
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
  expect(await new SystemdSupervisor(exec, TIMER).info()).toEqual({
    loaded: true,
    running: false,
  });
});

test('info: an unreachable user manager reads as not loaded', async () => {
  const { exec } = fakeExec(() => ({ code: 1, stdout: '' }));
  expect(await new SystemdSupervisor(exec, SERVE).info()).toEqual({
    loaded: false,
    running: false,
  });
});
