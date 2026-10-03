import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { plistFor, plistPathFor, readServePlistPort } from './plist';
import { SERVE_LABEL } from './units';

test('a sandbox plist carries the installation-scoped label it was rendered for', () => {
  const label = 'com.dbtlr.mimir.sandbox-1234abcd-1234-4234-8234-123456789012.serve';
  expect(plistFor(label, '/sandbox/bin/mimir', {})).toContain(`<string>${label}</string>`);
});

test('plist runs serve --no-hunt with no port and supervises it', () => {
  const xml = plistFor(SERVE_LABEL, '/Users/op/.local/bin/mimir', {});
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

test('with no env baked, the serve unit carries no EnvironmentVariables', () => {
  const xml = plistFor(SERVE_LABEL, '/Users/op/.local/bin/mimir', {});
  expect(xml).not.toContain('EnvironmentVariables');
});

test('an opted-in dev service can bake its resolved port as MIMIR_PORT', () => {
  const xml = plistFor(SERVE_LABEL, '/Users/op/workspaces/mimir/dev-bin', { port: 64747 });
  expect(xml).toContain('<key>MIMIR_PORT</key>');
  expect(xml).toContain('<string>64747</string>');
  expect(xml).not.toContain('--port');
});

test('the baked dev port round-trips from the installed plist', () => {
  const file = join(dir, 'serve.plist');
  writeFileSync(file, plistFor(SERVE_LABEL, '/Users/op/workspaces/mimir/dev-bin', { port: 55440 }));
  expect(readServePlistPort(file)).toBe(55440);
  expect(readServePlistPort(join(dir, 'missing.plist'))).toBeUndefined();
  expect(readServePlistPort(dir)).toBeUndefined();
});

test('uninstalled plistPathFor uses isolated LaunchAgents', () => {
  expect(plistPathFor(SERVE_LABEL)).toMatch(
    /\.dev\/LaunchAgents\/com\.dbtlr\.mimir\.serve\.plist$/,
  );
});

// XML-escape tests — launchctl rejects malformed plists loudly but the error
// message never points at the offending character, making this class of bug
// very hard to diagnose after the fact.
test('special XML characters in binPath are escaped', () => {
  const xml = plistFor(SERVE_LABEL, '/Users/op/Drew & <Co>/bin/mimir', {});
  expect(xml).toContain('Drew &amp; &lt;Co&gt;');
  // must not contain the raw characters inside element content
  expect(xml).not.toContain('Drew & <Co>');
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
  const xml = plistFor(SERVE_LABEL, '/Users/op/Drew & <Co>/bin/mimir', { port: 55440 });
  const file = join(dir, 'test.plist');
  writeFileSync(file, xml, 'utf8');
  const result = Bun.spawnSync(['plutil', '-lint', file]);
  expect(result.exitCode).toBe(0);
});
