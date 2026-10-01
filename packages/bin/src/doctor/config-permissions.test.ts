import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkConfigPermissions, withConfigFindings } from './config-permissions';
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
