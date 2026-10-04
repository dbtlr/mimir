import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigPathStat } from '../service/config';
import {
  checkConfigPermissions,
  checkConfigReplaceable,
  warnConfigPermissions,
  withConfigFindings,
} from './config-permissions';
import type { DoctorDiagnosis } from './contract';

const WITH_URL = '[store]\nbackend = "postgres"\nurl = "postgres://u:secret@db.example/mimir"\n';
const WITHOUT_URL = '[serve]\nport = 4600\n';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mimir-doctor-config-'));
  file = join(dir, 'config.toml');
});
afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

function writeWithMode(content: string, mode: number): void {
  writeFileSync(file, content);
  chmodSync(file, mode);
}

test('warns, never errors, when [store] url sits in a world-readable file', () => {
  writeWithMode(WITH_URL, 0o644);
  const findings = checkConfigPermissions(file);
  expect(findings).toHaveLength(1);
  const [item] = findings;
  expect(item?.severity).toBe('warn');
  expect(item?.check).toBe('config-permissions');
  expect(item?.message).toContain(`chmod 600 ${file}`);
  expect(item?.message).not.toContain('secret');
  expect(item?.evidence.mode).toBe('0644');
});

test('warns when only the group can read the file', () => {
  writeWithMode(WITH_URL, 0o640);
  expect(checkConfigPermissions(file)).toHaveLength(1);
});

test('is silent when the file is owner-only', () => {
  writeWithMode(WITH_URL, 0o600);
  expect(checkConfigPermissions(file)).toEqual([]);
});

test('is silent when a readable file carries no [store] url', () => {
  writeWithMode(WITHOUT_URL, 0o644);
  expect(checkConfigPermissions(file)).toEqual([]);
});

test('is silent when the config file does not exist', () => {
  expect(checkConfigPermissions(file)).toEqual([]);
});

test('warns when the group can write the file, even with no [store] url', () => {
  writeWithMode(WITHOUT_URL, 0o620);
  const findings = checkConfigPermissions(file);
  expect(findings).toHaveLength(1);
  const [item] = findings;
  expect(item?.severity).toBe('warn');
  expect(item?.code).toBe('config-writable');
  expect(item?.message).toContain(`chmod 600 ${file}`);
  expect(item?.evidence.mode).toBe('0620');
});

test('warns when only others can write the file', () => {
  writeWithMode(WITH_URL, 0o602);
  expect(checkConfigPermissions(file).map((f) => f.code)).toEqual(['config-writable']);
});

test('reports both findings when a file carrying [store] url is readable and writable', () => {
  for (const mode of [0o664, 0o646]) {
    writeWithMode(WITH_URL, mode);
    expect(checkConfigPermissions(file).map((f) => f.code)).toEqual([
      'config-readable',
      'config-writable',
    ]);
  }
});

test('warns on a writable file it cannot parse', () => {
  writeWithMode('[store\nurl = ', 0o666);
  expect(checkConfigPermissions(file).map((f) => f.code)).toEqual(['config-writable']);
});

const CLEAN: DoctorDiagnosis = { findings: [], scope: null };

test('withConfigFindings appends the config warning to an unscoped diagnosis', () => {
  writeWithMode(WITH_URL, 0o644);
  const merged = withConfigFindings(CLEAN, undefined, file);
  expect(merged.findings.map((f) => f.check)).toEqual(['config-permissions']);
});

test('withConfigFindings leaves a project-scoped diagnosis alone', () => {
  writeWithMode(WITH_URL, 0o644);
  expect(withConfigFindings(CLEAN, 'MMR', file)).toBe(CLEAN);
});

test('warnConfigPermissions writes the finding as a stderr-style warning line', () => {
  writeWithMode(WITH_URL, 0o644);
  const lines: string[] = [];
  warnConfigPermissions(undefined, file, (text) => lines.push(text));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toStartWith('[warn] config: ');
  expect(lines[0]).toContain(`chmod 600 ${file}`);
  expect(lines[0]).not.toContain('secret');
});

test('warnConfigPermissions is silent for a project scope and for an owner-only file', () => {
  const lines: string[] = [];
  writeWithMode(WITH_URL, 0o644);
  warnConfigPermissions('MMR', file, (text) => lines.push(text));
  writeWithMode(WITH_URL, 0o600);
  warnConfigPermissions(undefined, file, (text) => lines.push(text));
  expect(lines).toEqual([]);
});

test('warnConfigPermissions writes one line per finding when the file is readable and writable', () => {
  writeWithMode(WITH_URL, 0o666);
  const lines: string[] = [];
  warnConfigPermissions(undefined, file, (text) => lines.push(text));
  expect(lines).toHaveLength(2);
  expect(lines.every((line) => line.startsWith('[warn] config: '))).toBe(true);
  expect(lines.join('\n')).not.toContain('secret');
});

const ME = 501;
const OTHER = 502;
const ROOT = 0;

function stat(path: string, mode: number, uid = ME, isDirectory = true): ConfigPathStat {
  return { isDirectory, mode, path, uid };
}

const FILE = stat('/home/me/.config/mimir/config.toml', 0o600, ME, false);

test('warns when a directory above the config is world-writable without the sticky bit', () => {
  const findings = checkConfigReplaceable([FILE, stat('/home/me/.config/mimir', 0o777)], ME);
  expect(findings).toHaveLength(1);
  const [item] = findings;
  expect(item?.severity).toBe('warn');
  expect(item?.check).toBe('config-permissions');
  expect(item?.code).toBe('config-dir-writable');
  expect(item?.locator).toBe('/home/me/.config/mimir');
  expect(item?.evidence.mode).toBe('0777');
  expect(item?.message).toContain('chmod go-w /home/me/.config/mimir');
});

test('warns on a group-writable ancestor, not only the immediate directory', () => {
  const stats = [FILE, stat('/home/me/.config/mimir', 0o700), stat('/home/me/.config', 0o770)];
  expect(checkConfigReplaceable(stats, ME).map((f) => f.locator)).toEqual(['/home/me/.config']);
});

test('is silent for owner-only, read-only, and sticky writable directories', () => {
  for (const mode of [0o700, 0o755, 0o1777, 0o1770]) {
    expect(checkConfigReplaceable([FILE, stat('/home/me/.config/mimir', mode)], ME)).toEqual([]);
  }
});

test('leaves the file mode to the read and write checks', () => {
  const loose = stat(FILE.path, 0o666, ME, false);
  expect(checkConfigReplaceable([loose], ME)).toEqual([]);
});

test('warns when another user owns the config file', () => {
  const findings = checkConfigReplaceable([stat(FILE.path, 0o600, OTHER, false)], ME);
  expect(findings).toHaveLength(1);
  const [item] = findings;
  expect(item?.code).toBe('config-foreign-owner');
  expect(item?.locator).toBe(FILE.path);
  expect(item?.evidence.owner).toBe(OTHER);
  expect(item?.message).toContain(FILE.path);
  // Never a chown hint: the owner may be a real user whose path this is.
  expect(item?.message).not.toContain('chown');
});

test('warns when another user owns a directory above the config', () => {
  const stats = [FILE, stat('/home/me/.config/mimir', 0o755, OTHER)];
  expect(checkConfigReplaceable(stats, ME).map((f) => f.code)).toEqual(['config-foreign-owner']);
});

test('trusts paths owned by root or by the current user', () => {
  const stats = [
    stat(FILE.path, 0o600, ROOT, false),
    stat('/etc/mimir', 0o755, ROOT),
    stat('/', 0o755, ROOT),
  ];
  expect(checkConfigReplaceable(stats, ME)).toEqual([]);
  expect(checkConfigReplaceable([FILE, stat('/home/me', 0o700)], ME)).toEqual([]);
});

test('reports both findings for a foreign-owned writable directory', () => {
  const stats = [FILE, stat('/home/me/.config/mimir', 0o777, OTHER)];
  expect(checkConfigReplaceable(stats, ME).map((f) => f.code)).toEqual([
    'config-dir-writable',
    'config-foreign-owner',
  ]);
});

test('is silent without a POSIX user id to compare owners against', () => {
  const stats = [stat(FILE.path, 0o600, OTHER, false), stat('/home/me/.config/mimir', 0o777)];
  expect(checkConfigReplaceable(stats, undefined)).toEqual([]);
});

test('checkConfigPermissions warns on a real world-writable config directory', () => {
  const nest = join(dir, 'mimir');
  mkdirSync(nest);
  const nested = join(nest, 'config.toml');
  writeFileSync(nested, WITH_URL);
  chmodSync(nested, 0o600);
  chmodSync(nest, 0o777);
  const findings = checkConfigPermissions(nested, { home: dir });
  expect(findings.map((f) => f.code)).toEqual(['config-dir-writable']);
  expect(findings.map((f) => f.message).join('\n')).not.toContain('secret');
  chmodSync(nest, 0o700);
  expect(checkConfigPermissions(nested, { home: dir })).toEqual([]);
});
