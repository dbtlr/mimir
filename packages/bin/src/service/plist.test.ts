import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SERVE_LABEL, SNAPSHOT_LABEL, plistFor, plistForSnapshot, plistPathFor } from './plist';

test('plist runs serve --no-hunt with no port and supervises it', () => {
  const xml = plistFor('/Users/op/.local/bin/mimir', {});
  expect(xml).toContain(`<string>${SERVE_LABEL}</string>`);
  expect(xml).toContain('<string>/Users/op/.local/bin/mimir</string>');
  expect(xml).toContain('<string>serve</string>');
  expect(xml).toContain('<string>--no-hunt</string>');
  expect(xml).not.toContain('--port'); // the port lives in config, never the plist
  expect(xml).toContain('<key>KeepAlive</key>');
  expect(xml).toContain('<key>RunAtLoad</key>');
  // serve.log must appear exactly twice: once for StandardOutPath and once for StandardErrorPath
  expect(xml.split('serve.log').length - 1).toBe(2);
  expect(xml).not.toContain('MIMIR_DB');
  // ProgramArguments array must appear in order with exact whitespace
  expect(xml).toContain(
    [
      '  <array>',
      '    <string>/Users/op/.local/bin/mimir</string>',
      '    <string>serve</string>',
      '    <string>--no-hunt</string>',
      '  </array>',
    ].join('\n'),
  );
});

test('MIMIR_DB present at install time is baked into the environment', () => {
  const xml = plistFor('/usr/local/bin/mimir', { dbPath: '/data/mimir.db' });
  expect(xml).toContain('<key>MIMIR_DB</key>');
  expect(xml).toContain('<string>/data/mimir.db</string>');
});

test('the Norn backend bakes MIMIR_NORN + MIMIR_VAULT as absolute paths', () => {
  // launchd gives the daemon a minimal PATH and does no `~`/`$VAR` expansion, so
  // the norn binary and vault are baked as resolved absolutes (ADR 0018).
  const xml = plistFor('/Users/op/.local/bin/mimir', {
    nornPath: '/Users/op/.cargo/bin/norn',
    vaultPath: '/Users/op/.local/share/mimir/vault',
  });
  expect(xml).toContain('<key>MIMIR_NORN</key>');
  expect(xml).toContain('<string>/Users/op/.cargo/bin/norn</string>');
  expect(xml).toContain('<key>MIMIR_VAULT</key>');
  expect(xml).toContain('<string>/Users/op/.local/share/mimir/vault</string>');
  // absolute entries only — a literal `~` would be dead (launchd does not expand it)
  expect(xml).not.toContain('~/');
});

test('with no env baked, the serve unit carries no EnvironmentVariables', () => {
  const xml = plistFor('/Users/op/.local/bin/mimir', {});
  expect(xml).not.toContain('EnvironmentVariables');
});

test("plistPathFor lands the serve unit in the user's LaunchAgents", () => {
  expect(plistPathFor(SERVE_LABEL)).toMatch(
    /Library\/LaunchAgents\/com\.dbtlr\.mimir\.serve\.plist$/,
  );
});

test('plistPathFor names the snapshot unit', () => {
  expect(plistPathFor(SNAPSHOT_LABEL)).toMatch(
    /Library\/LaunchAgents\/com\.dbtlr\.mimir\.snapshot\.plist$/,
  );
});

test('the snapshot plist runs `vault snapshot` on a StartInterval and does not KeepAlive', () => {
  const xml = plistForSnapshot('/Users/op/.local/bin/mimir', { intervalSeconds: 900 });
  expect(xml).toContain(`<string>${SNAPSHOT_LABEL}</string>`);
  expect(xml).toContain(['    <string>vault</string>', '    <string>snapshot</string>'].join('\n'));
  expect(xml).toContain('<key>StartInterval</key>');
  expect(xml).toContain('<integer>900</integer>');
  // A periodic command is never kept alive, and does not run at load.
  expect(xml).not.toContain('KeepAlive');
  expect(xml).not.toContain('RunAtLoad');
  expect(xml).not.toContain('MIMIR_VAULT');
  expect(xml.split('snapshot.log').length - 1).toBe(2);
});

test('MIMIR_VAULT present at install time is baked into the snapshot environment', () => {
  const xml = plistForSnapshot('/usr/local/bin/mimir', {
    intervalSeconds: 300,
    vaultPath: '~/vaults/mimir',
  });
  expect(xml).toContain('<key>MIMIR_VAULT</key>');
  expect(xml).toContain('<string>~/vaults/mimir</string>');
});

// XML-escape tests — launchctl rejects malformed plists loudly but the error
// message never points at the offending character, making this class of bug
// very hard to diagnose after the fact.
test('special XML characters in binPath and dbPath are escaped', () => {
  const xml = plistFor('/Users/op/Drew & Co/bin/mimir', {
    dbPath: '/data/a<b/m.db',
  });
  expect(xml).toContain('Drew &amp; Co');
  expect(xml).toContain('a&lt;b');
  // must not contain the raw characters inside element content
  expect(xml).not.toContain('Drew & Co');
  expect(xml).not.toContain('a<b');
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mimir-plist-'));
});
afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

// plutil is macOS-only — the escaping is asserted on the string above for
// every platform; this adds real plist validation where the tool exists (dev
// + the macOS release runner), and is skipped on Linux CI.
test.skipIf(process.platform !== 'darwin')('escaped plist passes plutil -lint', () => {
  const xml = plistFor('/Users/op/Drew & Co/bin/mimir', {
    dbPath: '/data/a<b/m.db',
  });
  const file = join(dir, 'test.plist');
  writeFileSync(file, xml, 'utf8');
  const result = Bun.spawnSync(['plutil', '-lint', file]);
  expect(result.exitCode).toBe(0);
});

test.skipIf(process.platform !== 'darwin')('snapshot plist passes plutil -lint', () => {
  const xml = plistForSnapshot('/Users/op/Drew & Co/bin/mimir', {
    intervalSeconds: 900,
    vaultPath: '~/a<b',
  });
  const file = join(dir, 'snapshot.plist');
  writeFileSync(file, xml, 'utf8');
  const result = Bun.spawnSync(['plutil', '-lint', file]);
  expect(result.exitCode).toBe(0);
});
