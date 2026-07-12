import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Store } from '../core';
import { createTestStore } from '../testing/store';
import { runCli } from './run';
import { SKILL_FILES, skillDirFor } from './skill-assets';
import { fakeIo } from './testing';

const NORN = Bun.which('norn') !== null;

let store: Store;
let closeStore: () => Promise<void>;
beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
});
afterEach(async () => {
  await closeStore();
});

test('the embedded skill carries the root + six references, all non-empty', () => {
  const paths = SKILL_FILES.map((f) => f.path);
  expect(paths).toEqual([
    'SKILL.md',
    'references/setup.md',
    'references/authoring.md',
    'references/querying.md',
    'references/status-model.md',
    'references/tags.md',
    'references/seeds.md',
  ]);
  for (const f of SKILL_FILES) {
    expect(f.content.length).toBeGreaterThan(200);
  }
  // The root must carry the frontmatter and the load-bearing discipline inline.
  const root = SKILL_FILES[0]?.content ?? '';
  expect(root).toContain('name: mimir');
  expect(root).toContain('transition');
  expect(root).toContain('KEY-seq');
});

test('skillDirFor encodes the per-agent host layout', () => {
  expect(skillDirFor('claude', '/home/x')).toBe('/home/x/.claude/skills/mimir');
  expect(skillDirFor('codex', '/home/x')).toBe('/home/x/.agents/skills/mimir');
});

test.skipIf(!NORN)('skill install --local writes the full tree into the working copy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mimir-skill-'));
  try {
    const io = fakeIo();
    expect(
      await runCli(['skill', 'install', '--local', '-f', 'ids'], () => store, io, { cwd: dir }),
    ).toBe(0);
    const root = join(dir, '.claude', 'skills', 'mimir');
    expect(io.out.join('')).toBe(root);
    for (const f of SKILL_FILES) {
      expect(existsSync(join(root, f.path))).toBe(true);
    }
    expect(readFileSync(join(root, 'SKILL.md'), 'utf8')).toContain('name: mimir');
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test.skipIf(!NORN)(
  'skill install --local --agent codex uses the .agents layout; reinstall overwrites',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mimir-skill-'));
    try {
      expect(
        await runCli(['skill', 'install', '--local', '--agent', 'codex'], () => store, fakeIo(), {
          cwd: dir,
        }),
      ).toBe(0);
      expect(existsSync(join(dir, '.agents', 'skills', 'mimir', 'SKILL.md'))).toBe(true);
      // Refresh-on-upgrade: a second install over the same target succeeds.
      expect(
        await runCli(['skill', 'install', '--local', '--agent', 'codex'], () => store, fakeIo(), {
          cwd: dir,
        }),
      ).toBe(0);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  },
);

test.skipIf(!NORN)('skill install rejects bad invocations (exit 2)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mimir-skill-'));
  try {
    expect(await runCli(['skill'], () => store, fakeIo(), { cwd: dir })).toBe(2);
    expect(
      await runCli(['skill', 'install', '--global', '--local'], () => store, fakeIo(), {
        cwd: dir,
      }),
    ).toBe(2);
    const io = fakeIo();
    expect(
      await runCli(['skill', 'install', '--local', '--agent', 'vim'], () => store, io, {
        cwd: dir,
      }),
    ).toBe(2);
    expect(io.err.join('')).toContain('unknown agent');
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
