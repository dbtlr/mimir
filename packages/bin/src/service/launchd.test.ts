import { expect, test } from 'bun:test';

import { LaunchdSupervisor } from './launchd';
import type { Exec } from './launchd';

function fakeExec(handler: (argv: string[]) => { code: number; stdout: string }) {
  const calls: string[][] = [];
  const exec: Exec = (argv) => {
    calls.push(argv);
    return Promise.resolve({ stderr: '', ...handler(argv) });
  };
  return { exec, calls };
}

const ok = () => ({ code: 0, stdout: '' });

test('install bootouts stale state then bootstraps the plist', async () => {
  const { exec, calls } = fakeExec(ok);
  const sup = new LaunchdSupervisor(exec, 501);
  await sup.install('/tmp/x.plist');
  expect(calls[0]?.slice(0, 2)).toEqual(['launchctl', 'bootout']);
  expect(calls[1]).toEqual(['launchctl', 'bootstrap', 'gui/501', '/tmp/x.plist']);
});

test('install tolerates bootout failure (nothing loaded) but not bootstrap failure', async () => {
  const { exec, calls } = fakeExec((argv) =>
    argv[1] === 'bootout' ? { code: 113, stdout: '' } : { code: 0, stdout: '' },
  );
  await new LaunchdSupervisor(exec, 501).install('/tmp/x.plist'); // must not throw
  expect(calls[1]?.[1]).toBe('bootstrap');
});

test('stop = bootout (KeepAlive would defeat a plain kill); start = bootstrap', async () => {
  const { exec, calls } = fakeExec(ok);
  const sup = new LaunchdSupervisor(exec, 501);
  await sup.stop();
  expect(calls[0]).toEqual(['launchctl', 'bootout', 'gui/501/com.dbtlr.mimir.serve']);
  await sup.start('/tmp/x.plist');
  expect(calls[1]).toEqual(['launchctl', 'bootstrap', 'gui/501', '/tmp/x.plist']);
});

test('restart kickstarts with -k', async () => {
  const { exec, calls } = fakeExec(ok);
  await new LaunchdSupervisor(exec, 501).restart();
  expect(calls[0]).toEqual(['launchctl', 'kickstart', '-k', 'gui/501/com.dbtlr.mimir.serve']);
});

test('info parses pid and running state from launchctl print', async () => {
  const { exec } = fakeExec(() => ({
    code: 0,
    stdout: 'com.dbtlr.mimir.serve = {\n\tpid = 4242\n\tstate = running\n}',
  }));
  expect(await new LaunchdSupervisor(exec, 501).info()).toEqual({
    loaded: true,
    running: true,
    pid: 4242,
  });
});

test('info: nonzero print means not loaded', async () => {
  const { exec } = fakeExec(() => ({ code: 113, stdout: '' }));
  expect(await new LaunchdSupervisor(exec, 501).info()).toEqual({
    loaded: false,
    running: false,
  });
});

test('a failing bootstrap surfaces as an error with the stderr hint', async () => {
  const { exec } = fakeExec((argv) =>
    argv[1] === 'bootstrap' ? { code: 5, stdout: '' } : { code: 0, stdout: '' },
  );
  // Use try/catch to avoid the await-thenable lint on .rejects.toThrow
  let err: unknown;
  try {
    await new LaunchdSupervisor(exec, 501).start('/tmp/x.plist');
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toMatch(/bootstrap/);
});
