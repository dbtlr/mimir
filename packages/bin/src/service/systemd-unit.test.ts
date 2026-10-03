import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readServeUnitPort, serveUnitFor, systemdUnitPathFor } from './systemd-unit';
import { SERVE_LABEL } from './units';

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

test('with no env baked, the serve unit carries no Environment lines', () => {
  expect(serveUnitFor(SERVE_LABEL, '/home/op/.local/bin/mimir', {})).not.toContain('Environment=');
});

test('a sandbox service bakes its resolved port as MIMIR_PORT and it round-trips', () => {
  const file = join(dir, 'serve.service');
  writeFileSync(file, serveUnitFor(SANDBOX_LABEL, '/sandbox/bin/mimir', { port: 55440 }));
  expect(readFileSync(file, 'utf8')).toContain('Environment="MIMIR_PORT=55440"\n');
  expect(readServeUnitPort(file)).toBe(55440);
  expect(readServeUnitPort(join(dir, 'missing.service'))).toBeUndefined();
  expect(readServeUnitPort(dir)).toBeUndefined();
});

test('an uninstalled build keeps unit files in its isolated data directory', () => {
  expect(systemdUnitPathFor(`${SERVE_LABEL}.service`)).toMatch(
    /\.dev\/systemd\/com\.dbtlr\.mimir\.serve\.service$/,
  );
});

// systemd expands specifiers (%) in every value and variables ($) in ExecStart;
// an unescaped one silently changes the command the manager runs.
test('quotes, backslashes, specifiers, and variables in the binary path are escaped', () => {
  const unit = serveUnitFor(SERVE_LABEL, String.raw`/opt/Drew "&" Co/50%/$HOME\bin/mimir`, {});
  expect(unit).toContain(String.raw`ExecStart="/opt/Drew \"&\" Co/50%%/$$HOME\\bin/mimir" serve`);
});

test('a value with a line break is refused rather than splitting the unit file', () => {
  expect(() => serveUnitFor(SERVE_LABEL, '/opt/mimir\nExecStartPre=/bin/false', {})).toThrow(
    'line break',
  );
  expect(() => serveUnitFor(SERVE_LABEL, '/opt/mimir\r\nx', {})).toThrow('line break');
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mimir-unit-'));
});
afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});
