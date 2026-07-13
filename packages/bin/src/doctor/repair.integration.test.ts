import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { fakeIo } from '../cli/testing';
import { createInitiative, createProject } from '../core/create';
import type { MigrationPlan } from '../norn/plan';
import { createTestStore } from '../testing/store';
import type { TestStore } from '../testing/store';
import { cmdDoctor } from './commands';
import type { DoctorDeps } from './commands';

const NORN = Bun.which('norn') !== null;

let fixture: TestStore;

beforeEach(async () => {
  fixture = await createTestStore();
});

afterEach(async () => {
  await fixture.close();
});

function replaceBodyAndProject(raw: string, body: string, project: string): string {
  const close = raw.indexOf('\n---\n', 4);
  if (close === -1) {
    throw new Error('expected a frontmatter close delimiter');
  }
  const frontmatter = raw.slice(0, close).replace(/^project:.*$/m, `project: '[[${project}]]'`);
  return `${frontmatter}\n---\n${body}`;
}

function addFrontmatter(raw: string, line: string): string {
  const close = raw.indexOf('\n---\n', 4);
  if (close === -1) {
    throw new Error('expected a frontmatter close delimiter');
  }
  return `${raw.slice(0, close)}\n${line}${raw.slice(close)}`;
}

async function jsonDoctor(scope: string): Promise<Record<string, unknown>[]> {
  const io = fakeIo();
  expect(await cmdDoctor(io, fixture.doctor, 'json', scope)).toBe(0);
  return JSON.parse(io.out.join('')) as Record<string, unknown>[];
}

describe.skipIf(!NORN)('doctor deterministic repair over isolated real Norn', () => {
  test('detects, previews without writes, repairs only canonical scope, verifies, and is idempotent', async () => {
    await createProject(fixture.store, { key: 'MMR', name: 'Mimir' });
    const supported = await createInitiative(fixture.store, {
      projectId: 'MMR',
      title: 'Supported corruption',
    });
    const skipped = await createInitiative(fixture.store, {
      projectId: 'MMR',
      title: 'Skipped corruption',
    });
    await createProject(fixture.store, { key: 'OTH', name: 'Other' });
    await createInitiative(fixture.store, { projectId: 'OTH', title: 'Orphaned work' });

    const supportedPath = `MMR/${supported.id}.md`;
    const skippedPath = `MMR/${skipped.id}.md`;
    fixture.corruptDocument(supportedPath, (raw) =>
      replaceBodyAndProject(raw, '## Task Description\r\nkept prose\r\n', 'OTH'),
    );
    fixture.corruptDocument(skippedPath, (raw) => addFrontmatter(raw, 'open_ended: maybe'));
    fixture.removeDocument('OTH/OTH.md');

    const detected = await jsonDoctor('MMR');
    expect(
      detected.map((entry) => entry.code).toSorted((a, b) => String(a).localeCompare(String(b))),
    ).toEqual([
      'crlf-body',
      'invalid-open-ended',
      'missing-project',
      'section-annotations-unreadable',
      'section-history-unreadable',
      'stem-project-divergence',
    ]);
    const beforeSupported = fixture.readDocument(supportedPath);
    const beforeSkipped = fixture.readDocument(skippedPath);

    let applyCalls = 0;
    const doctor: DoctorDeps = {
      ...fixture.doctor,
      repair: {
        applyPlan: (plan: MigrationPlan, confirm: boolean) => {
          applyCalls += 1;
          return (
            fixture.doctor.repair?.applyPlan(plan, confirm) ??
            Promise.reject(new Error('test fixture repair seam missing'))
          );
        },
        vaultRoot: fixture.doctor.repair?.vaultRoot ?? '',
      },
    };
    const preview = fakeIo();
    expect(await cmdDoctor(preview, doctor, 'json', 'MMR', { dryRun: true, fix: true })).toBe(0);
    expect(applyCalls).toBe(1);
    expect(fixture.readDocument(supportedPath)).toBe(beforeSupported);
    expect(fixture.readDocument(skippedPath)).toBe(beforeSkipped);
    expect(() => fixture.readDocument('OTH/OTH.md')).toThrow();

    const applied = fakeIo();
    expect(await cmdDoctor(applied, doctor, 'json', 'MMR', { dryRun: false, fix: true })).toBe(0);
    expect(applyCalls).toBe(2);
    const repaired = fixture.readDocument(supportedPath);
    expect(repaired).not.toContain('\r\n');
    expect(repaired).toContain("project: '[[MMR]]'");
    expect(repaired.match(/^## History$/gm)).toHaveLength(1);
    expect(repaired.match(/^## Annotations$/gm)).toHaveLength(1);
    expect(fixture.readDocument(skippedPath)).toBe(beforeSkipped);
    expect(() => fixture.readDocument('OTH/OTH.md')).toThrow();

    const post = await jsonDoctor('MMR');
    expect(
      post.map((entry) => entry.code).toSorted((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(['invalid-open-ended', 'missing-project']);
    const second = fakeIo();
    expect(await cmdDoctor(second, doctor, 'json', 'MMR', { dryRun: false, fix: true })).toBe(0);
    expect(applyCalls).toBe(2);
    expect(fixture.readDocument(supportedPath)).toBe(repaired);
    expect(fixture.readDocument(skippedPath)).toBe(beforeSkipped);

    const recover = fakeIo();
    expect(await cmdDoctor(recover, doctor, 'json', 'OTH', { dryRun: false, fix: true })).toBe(0);
    const recovered = fixture.readDocument('OTH/OTH.md');
    expect(recovered).toContain('name: Recovered OTH');
    expect(recovered).toContain('archived_at:');
    expect(recovered).toContain('— archive');
    expect(recovered).toContain('active → archived');
    expect((await jsonDoctor('OTH')).map((entry) => entry.code)).not.toContain('missing-project');
  });

  test('a concurrent byte change causes CAS refusal and no repair write', async () => {
    await createProject(fixture.store, { key: 'MMR', name: 'Mimir' });
    const node = await createInitiative(fixture.store, { projectId: 'MMR', title: 'Drift' });
    const path = `MMR/${node.id}.md`;
    fixture.corruptDocument(path, (raw) => raw.replaceAll('\n', '\r\n'));

    const baseRepair = fixture.doctor.repair;
    if (baseRepair === undefined) {
      throw new Error('test fixture repair seam missing');
    }
    let drifted = false;
    const doctor: DoctorDeps = {
      ...fixture.doctor,
      repair: {
        applyPlan: (plan, confirm) => {
          if (!drifted) {
            fixture.corruptDocument(path, (raw) => `${raw}\r\nconcurrent edit`);
            drifted = true;
          }
          return baseRepair.applyPlan(plan, confirm);
        },
        vaultRoot: baseRepair.vaultRoot,
      },
    };
    const io = fakeIo();
    expect(await cmdDoctor(io, doctor, 'json', 'MMR', { dryRun: false, fix: true })).toBe(1);
    const after = fixture.readDocument(path);
    expect(after).toContain('concurrent edit');
    expect(after).toContain('\r\n');
    const report = JSON.parse(io.out.join('')) as {
      details: { code: string }[];
      failed: { code: string }[];
    };
    expect(report.details[0]?.code).toBe('apply-refused');
    expect(report.failed[0]?.code).toBe('verification-failed');
  });

  test('missing-project recovery skips an occupied corrupt canonical path byte-for-byte', async () => {
    await createProject(fixture.store, { key: 'MMR', name: 'Mimir' });
    await createInitiative(fixture.store, { projectId: 'MMR', title: 'Hidden work' });
    fixture.corruptDocument('MMR/MMR.md', (raw) => raw.replace('type: project', 'type: note'));
    const before = fixture.readDocument('MMR/MMR.md');
    const io = fakeIo();
    expect(await cmdDoctor(io, fixture.doctor, 'json', 'MMR', { dryRun: false, fix: true })).toBe(
      0,
    );
    expect(fixture.readDocument('MMR/MMR.md')).toBe(before);
    const report = JSON.parse(io.out.join('')) as {
      skipped: Record<string, unknown>[];
    };
    expect(report.skipped).toContainEqual({
      code: 'missing-project',
      reason: 'canonical-path-occupied',
      scopeKey: 'MMR',
      stem: 'MMR-1',
    });
  });
});
