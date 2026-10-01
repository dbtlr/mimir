import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readServeUnitPort,
  serveUnitFor,
  snapshotServiceUnitFor,
  snapshotTimerUnitFor,
  systemdUnitPathFor,
} from './systemd-unit';
import { SERVE_LABEL, SNAPSHOT_LABEL } from './units';

const SANDBOX_LABEL = 'com.dbtlr.mimir.sandbox-1234abcd-1234-4234-8234-123456789012.serve';

test('the serve unit runs serve --no-hunt with no port and restarts it forever', () => {
  const unit = serveUnitFor(SERVE_LABEL, '/home/op/.local/bin/mimir', {});
  expect(unit).toContain(`Description=Mimir server (${SERVE_LABEL})`);
  expect(unit).toContain('ExecStart="/home/op/.local/bin/mimir" serve --no-hunt\n');
  expect(unit).not.toContain('--port'); // the port lives in config, never the unit
  // KeepAlive parity: always restart, about as often as launchd's throttle, never give up.
  expect(unit).toContain('Restart=always\n');
  expect(unit).toContain('RestartSec=10\n');
  expect(unit).toContain('StartLimitIntervalSec=0\n');
  // RunAtLoad parity: the enabled unit starts with the user manager.
  expect(unit).toContain('[Install]\nWantedBy=default.target\n');
  expect(unit.split('serve.log').length - 1).toBe(2);
  expect(unit).toMatch(/StandardOutput=append:\/\S+\/serve\.log\n/);
  expect(unit).toMatch(/StandardError=append:\/\S+\/serve\.log\n/);
});

test('the serve unit carries the installation-scoped label it was rendered for', () => {
  const unit = serveUnitFor(SANDBOX_LABEL, '/sandbox/bin/mimir', {});
  expect(unit).toContain(`Description=Mimir server (${SANDBOX_LABEL})`);
});

test('the Norn backend bakes MIMIR_NORN + MIMIR_VAULT as absolute paths', () => {
  const unit = serveUnitFor(SERVE_LABEL, '/home/op/.local/bin/mimir', {
    nornPath: '/home/op/.cargo/bin/norn',
    vaultPath: '/home/op/.local/share/mimir/vault',
  });
  expect(unit).toContain('Environment="MIMIR_NORN=/home/op/.cargo/bin/norn"\n');
  expect(unit).toContain('Environment="MIMIR_VAULT=/home/op/.local/share/mimir/vault"\n');
  expect(unit).not.toContain('~/');
});

test('with no env baked, the serve unit carries no Environment lines', () => {
  expect(serveUnitFor(SERVE_LABEL, '/home/op/.local/bin/mimir', {})).not.toContain('Environment=');
});

test('a sandbox service bakes its resolved port as MIMIR_PORT and it round-trips', () => {
  const file = join(dir, 'serve.service');
  writeFileSync(file, serveUnitFor(SANDBOX_LABEL, '/sandbox/bin/mimir', { port: 55440 }));
  expect(readServeUnitPort(file)).toBe(55440);
  expect(readServeUnitPort(join(dir, 'missing.service'))).toBeUndefined();
  expect(readServeUnitPort(dir)).toBeUndefined();
});

test('an uninstalled build keeps unit files in its isolated data directory', () => {
  expect(systemdUnitPathFor(`${SERVE_LABEL}.service`)).toMatch(
    /\.dev\/systemd\/com\.dbtlr\.mimir\.serve\.service$/,
  );
});

test('the snapshot service is a oneshot `vault snapshot` that is never restarted', () => {
  const unit = snapshotServiceUnitFor(SNAPSHOT_LABEL, '/home/op/.local/bin/mimir', {
    intervalSeconds: 900,
  });
  expect(unit).toContain('Type=oneshot\n');
  expect(unit).toContain('ExecStart="/home/op/.local/bin/mimir" vault snapshot\n');
  expect(unit).not.toContain('Restart=');
  // The timer pulls the service in; the service itself is never enabled.
  expect(unit).not.toContain('[Install]');
  expect(unit).not.toContain('MIMIR_VAULT');
  expect(unit.split('snapshot.log').length - 1).toBe(2);
});

test('the snapshot timer fires every interval after activation and after each run', () => {
  const timer = snapshotTimerUnitFor(SNAPSHOT_LABEL, { intervalSeconds: 900 });
  expect(timer).toContain('[Timer]\nOnActiveSec=900\nOnUnitActiveSec=900\n');
  expect(timer).toContain(`Unit=${SNAPSHOT_LABEL}.service\n`);
  expect(timer).toContain('[Install]\nWantedBy=timers.target\n');
});

test('MIMIR_VAULT present at install time is baked into the snapshot environment', () => {
  const unit = snapshotServiceUnitFor(SNAPSHOT_LABEL, '/usr/local/bin/mimir', {
    intervalSeconds: 300,
    vaultPath: '/srv/vaults/mimir',
  });
  expect(unit).toContain('Environment="MIMIR_VAULT=/srv/vaults/mimir"\n');
});

// systemd expands specifiers (%) in every value and variables ($) in ExecStart;
// an unescaped one silently changes the command the manager runs.
test('quotes, backslashes, specifiers, and variables in baked values are escaped', () => {
  const unit = serveUnitFor(SERVE_LABEL, String.raw`/opt/Drew "&" Co/50%/$HOME\bin/mimir`, {
    vaultPath: '/data/100%/"vault"',
  });
  expect(unit).toContain(String.raw`ExecStart="/opt/Drew \"&\" Co/50%%/$$HOME\\bin/mimir" serve`);
  expect(unit).toContain('Environment="MIMIR_VAULT=/data/100%%/\\"vault\\""\n');
});

test('a value with a line break is refused rather than splitting the unit file', () => {
  expect(() => serveUnitFor(SERVE_LABEL, '/opt/mimir\nExecStartPre=/bin/false', {})).toThrow(
    'line break',
  );
  expect(() =>
    snapshotServiceUnitFor(SNAPSHOT_LABEL, '/opt/mimir', {
      intervalSeconds: 60,
      vaultPath: '/v\r\nx',
    }),
  ).toThrow('line break');
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mimir-unit-'));
});
afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});
