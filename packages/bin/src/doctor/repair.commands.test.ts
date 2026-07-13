import { expect, test } from 'bun:test';

import { runCli } from '../cli/run';
import { fakeIo } from '../cli/testing';
import type { Store } from '../core';
import type { MigrationPlan } from '../norn/plan';
import { cmdDoctor } from './commands';
import type { DoctorDeps } from './commands';
import type { DoctorSnapshot } from './snapshot';

const neverStore = (): Promise<Store> => Promise.reject(new Error('store should not be read'));

function repairSnapshot(body: string): DoctorSnapshot {
  return {
    documents: [
      {
        body,
        documentHash: body.includes('\r\n') ? 'before-hash' : 'after-hash',
        frontmatter: { project: '[[MMR]]', type: 'task' },
        path: 'MMR/MMR-1.md',
        stem: 'MMR-1',
      },
    ],
    graph: {
      nodes: [{ dependsOn: [], key: 'MMR', parent: 'MMR-99', stem: 'MMR-1' }],
      projectKeys: ['MMR'],
    },
    sectionFailures: [],
    validateFindings: [],
  };
}

function twoRepairSnapshots(body1: string, body2: string): DoctorSnapshot {
  return {
    documents: [
      { body: body1, documentHash: 'hash-1', path: 'MMR/MMR-1.md', stem: 'MMR-1' },
      { body: body2, documentHash: 'hash-2', path: 'MMR/MMR-2.md', stem: 'MMR-2' },
    ],
    graph: {
      nodes: [
        { dependsOn: [], key: 'MMR', parent: null, stem: 'MMR-1' },
        { dependsOn: [], key: 'MMR', parent: null, stem: 'MMR-2' },
      ],
      projectKeys: ['MMR'],
    },
    sectionFailures: [],
    validateFindings: [],
  };
}

function projectProjectionSnapshot(key: string, project: string): DoctorSnapshot {
  const path = 'relocated/OTH.md';
  return {
    documents: [
      {
        body: '## History\n',
        documentHash: 'hash',
        frontmatter: { key, project: `[[${project}]]`, type: 'project' },
        path,
        stem: 'OTH',
      },
    ],
    graph: {
      declarations: [{ kind: 'project', path, project, stem: key }],
      nodes: [],
      projectKeys: [key],
      sources: [{ kind: 'project', path, stem: key }],
    },
    sectionFailures: [],
    validateFindings: [],
  };
}

test('doctor --fix --dry-run emits a stable composite JSON report and never confirms', async () => {
  const confirms: boolean[] = [];
  const plans: MigrationPlan[] = [];
  const deps: DoctorDeps = {
    readSnapshot: () => Promise.resolve(repairSnapshot('plain\r\nbody\r\n')),
    repair: {
      applyPlan: (plan, confirm) => {
        plans.push(plan);
        confirms.push(confirm);
        return Promise.resolve({ report: { dry_run: true, outcome: 'applied' } });
      },
      vaultRoot: '/vault',
    },
  };
  const io = fakeIo();
  const code = await cmdDoctor(io, deps, 'json', 'MMR', { dryRun: true, fix: true });
  expect(code).toBe(0);
  expect(confirms).toEqual([false]);
  expect(plans[0]?.operations).toEqual([
    {
      fields: {
        document_hash: 'before-hash',
        new_value: 'plain\nbody\n',
        path: 'MMR/MMR-1.md',
      },
      kind: 'replace_body',
    },
  ]);
  expect(JSON.parse(io.out.join(''))).toEqual({
    failed: [],
    fixed: [],
    mode: 'dry-run',
    outcome: 'preview',
    planned: [
      {
        code: 'crlf-body',
        recipe: 'normalize-crlf',
        scopeKey: 'MMR',
        stem: 'MMR-1',
      },
    ],
    skipped: [
      {
        code: 'dangling-parent',
        reason: 'semantic-reference',
        scopeKey: 'MMR',
        stem: 'MMR-1',
      },
    ],
    summary: { failed: 0, fixed: 0, planned: 1, skipped: 1 },
  });
});

test('doctor --fix applies once, rediagnoses, and treats residual skips as success', async () => {
  let reads = 0;
  let applies = 0;
  const deps: DoctorDeps = {
    readSnapshot: () => {
      reads += 1;
      return Promise.resolve(repairSnapshot(reads === 1 ? 'plain\r\nbody\r\n' : 'plain\nbody\n'));
    },
    repair: {
      applyPlan: (_plan, confirm) => {
        applies += 1;
        expect(confirm).toBe(true);
        return Promise.resolve({ report: { dry_run: false, outcome: 'applied' } });
      },
      vaultRoot: '/vault',
    },
  };
  const io = fakeIo();
  expect(await cmdDoctor(io, deps, 'records', 'MMR', { dryRun: false, fix: true })).toBe(0);
  expect(applies).toBe(1);
  expect(reads).toBe(2);
  expect(io.out).toContain('[fixed] crlf-body MMR-1: normalize-crlf');
  expect(io.out).toContain('[skipped] dangling-parent MMR-1: semantic-reference');
  expect(io.out.at(-1)).toBe('doctor repair applied: 0 planned, 1 fixed, 1 skipped, 0 failed');
});

test('a CAS refusal is a nonzero operational failure in stable JSONL output', async () => {
  const deps: DoctorDeps = {
    readSnapshot: () => Promise.resolve(repairSnapshot('plain\r\nbody\r\n')),
    repair: {
      applyPlan: () => Promise.resolve({ report: { outcome: 'refused' } }),
      vaultRoot: '/vault',
    },
  };
  const io = fakeIo();
  expect(await cmdDoctor(io, deps, 'jsonl', 'MMR', { dryRun: false, fix: true })).toBe(1);
  const records = io.out
    .join('')
    .split('\n')
    .map((line) => JSON.parse(line)) as Record<string, unknown>[];
  expect(records).toContainEqual({
    code: 'apply-refused',
    message: 'norn apply outcome: refused',
    status: 'detail',
  });
  expect(records).toContainEqual({
    code: 'verification-failed',
    issueCode: 'crlf-body',
    message: 'issue remains after apply',
    scopeKey: 'MMR',
    status: 'failed',
    stem: 'MMR-1',
  });
  expect(records.at(-1)).toEqual({
    failed: 1,
    fixed: 0,
    mode: 'apply',
    outcome: 'failed',
    planned: 0,
    skipped: 1,
    status: 'summary',
  });
});

test('mixed planning failure partitions every repair issue exclusively into failed', async () => {
  const deps: DoctorDeps = {
    readSnapshot: () =>
      Promise.resolve({
        ...twoRepairSnapshots('one\r\n', 'two\r\n'),
        documents: [
          { body: 'one\r\n', documentHash: null, path: 'MMR/MMR-1.md', stem: 'MMR-1' },
          { body: 'two\r\n', documentHash: 'hash-2', path: 'MMR/MMR-2.md', stem: 'MMR-2' },
        ],
      }),
    repair: {
      applyPlan: () => Promise.reject(new Error('planning failures must not apply')),
      vaultRoot: '/vault',
    },
  };
  const io = fakeIo();
  expect(await cmdDoctor(io, deps, 'json', 'MMR', { dryRun: true, fix: true })).toBe(1);
  const report = JSON.parse(io.out.join('')) as {
    failed: { issueCode?: string; stem?: string }[];
    planned: unknown[];
    summary: { failed: number; planned: number };
  };
  expect(report.planned).toEqual([]);
  expect(report.failed.map(({ issueCode, stem }) => [issueCode, stem])).toEqual([
    ['crlf-body', 'MMR-1'],
    ['crlf-body', 'MMR-2'],
  ]);
  expect(report.summary).toMatchObject({ failed: 2, planned: 0 });
});

test('indeterminate post-apply diagnosis preserves every planned issue identity', async () => {
  let reads = 0;
  const deps: DoctorDeps = {
    readSnapshot: () => {
      reads += 1;
      return reads === 1
        ? Promise.resolve(twoRepairSnapshots('one\r\n', 'two\r\n'))
        : Promise.reject(new Error('snapshot unavailable'));
    },
    repair: {
      applyPlan: () => Promise.resolve({ report: { outcome: 'applied' } }),
      vaultRoot: '/vault',
    },
  };
  const io = fakeIo();
  expect(await cmdDoctor(io, deps, 'json', 'MMR', { dryRun: false, fix: true })).toBe(1);
  const report = JSON.parse(io.out.join('')) as {
    details: Record<string, unknown>[];
    failed: { issueCode?: string; stem?: string }[];
    summary: { failed: number };
  };
  expect(report.failed.map(({ issueCode, stem }) => [issueCode, stem])).toEqual([
    ['crlf-body', 'MMR-1'],
    ['crlf-body', 'MMR-2'],
  ]);
  expect(report.details).toEqual([
    {
      code: 'verification-failed',
      message: 'post-apply diagnosis failed: snapshot unavailable',
    },
  ]);
  expect(report.summary.failed).toBe(2);
});

test('post-apply verification failure is nonzero and never rendered as fixed', async () => {
  const deps: DoctorDeps = {
    readSnapshot: () => Promise.resolve(repairSnapshot('plain\r\nbody\r\n')),
    repair: {
      applyPlan: () => Promise.resolve({ report: { outcome: 'applied' } }),
      vaultRoot: '/vault',
    },
  };
  const io = fakeIo();
  expect(await cmdDoctor(io, deps, 'json', 'MMR', { dryRun: false, fix: true })).toBe(1);
  const report = JSON.parse(io.out.join('')) as {
    failed: Record<string, unknown>[];
    fixed: unknown[];
  };
  expect(report.fixed).toEqual([]);
  expect(report.failed).toEqual([
    {
      code: 'verification-failed',
      issueCode: 'crlf-body',
      message: 'issue remains after apply',
      scopeKey: 'MMR',
      stem: 'MMR-1',
    },
  ]);
});

test('project verification follows the exact repaired path when its logical key changes', async () => {
  let reads = 0;
  const deps: DoctorDeps = {
    readSnapshot: () =>
      Promise.resolve(projectProjectionSnapshot(++reads === 1 ? 'MMR' : 'ABC', 'WRONG')),
    repair: {
      applyPlan: () => Promise.resolve({ report: { outcome: 'applied' } }),
      vaultRoot: '/vault',
    },
  };
  const io = fakeIo();
  expect(await cmdDoctor(io, deps, 'json', 'MMR', { dryRun: false, fix: true })).toBe(1);
  const report = JSON.parse(io.out.join('')) as {
    failed: Record<string, unknown>[];
    fixed: unknown[];
  };
  expect(report.fixed).toEqual([]);
  expect(report.failed).toContainEqual({
    code: 'verification-failed',
    issueCode: 'stem-project-divergence',
    message: 'issue remains after apply',
    scopeKey: 'MMR',
    stem: 'MMR',
  });
});

test('doctor --dry-run without --fix is a usage error before any vault read', async () => {
  let reads = 0;
  const io = fakeIo();
  expect(
    await runCli(['doctor', '--dry-run'], neverStore, io, {
      doctor: {
        readSnapshot: () => {
          reads += 1;
          return Promise.resolve(repairSnapshot('body'));
        },
      },
    }),
  ).toBe(2);
  expect(reads).toBe(0);
  expect(io.err.join('')).toContain('doctor --dry-run requires --fix');
});

test('a thrown apply error becomes a stable failed report and rediagnoses safely', async () => {
  let reads = 0;
  const deps: DoctorDeps = {
    readSnapshot: () => {
      reads += 1;
      return Promise.resolve(repairSnapshot('plain\r\nbody\r\n'));
    },
    repair: {
      applyPlan: () => Promise.reject(new Error('transport died after dispatch')),
      vaultRoot: '/vault',
    },
  };
  const io = fakeIo();
  expect(await cmdDoctor(io, deps, 'json', 'MMR', { dryRun: false, fix: true })).toBe(1);
  expect(reads).toBe(2);
  const report = JSON.parse(io.out.join('')) as Record<string, unknown>;
  expect(report).toMatchObject({ mode: 'apply', outcome: 'failed', planned: [] });
  expect(report.details).toEqual([
    {
      code: 'apply-failed',
      message: 'norn apply threw: transport died after dispatch',
    },
  ]);
  expect(report.failed).toEqual([
    {
      code: 'verification-failed',
      issueCode: 'crlf-body',
      message: 'issue remains after apply',
      scopeKey: 'MMR',
      stem: 'MMR-1',
    },
  ]);
});

test('applied JSONL partitions each issue exclusively into fixed, never planned plus fixed', async () => {
  let reads = 0;
  const deps: DoctorDeps = {
    readSnapshot: () =>
      Promise.resolve(repairSnapshot(++reads === 1 ? 'plain\r\nbody\r\n' : 'plain\nbody\n')),
    repair: {
      applyPlan: () => Promise.resolve({ report: { outcome: 'applied' } }),
      vaultRoot: '/vault',
    },
  };
  const io = fakeIo();
  expect(await cmdDoctor(io, deps, 'jsonl', 'MMR', { dryRun: false, fix: true })).toBe(0);
  const records = io.out
    .join('')
    .split('\n')
    .map((line) => JSON.parse(line)) as {
    status: string;
    planned?: number;
  }[];
  expect(records.filter((record) => record.status === 'planned')).toEqual([]);
  expect(records.filter((record) => record.status === 'fixed')).toHaveLength(1);
  expect(records.at(-1)?.planned).toBe(0);
});

test('a failed partial apply rediagnoses and reports fixed and residual issues exclusively', async () => {
  let reads = 0;
  const deps: DoctorDeps = {
    readSnapshot: () =>
      Promise.resolve(
        ++reads === 1
          ? twoRepairSnapshots('one\r\n', 'two\r\n')
          : twoRepairSnapshots('one\n', 'two\r\n'),
      ),
    repair: {
      applyPlan: () =>
        Promise.resolve({
          report: {
            operations: [
              { index: 0, outcome: 'applied' },
              { index: 1, outcome: 'failed' },
            ],
            outcome: 'failed',
          },
        }),
      vaultRoot: '/vault',
    },
  };
  const io = fakeIo();
  expect(await cmdDoctor(io, deps, 'json', 'MMR', { dryRun: false, fix: true })).toBe(1);
  const report = JSON.parse(io.out.join('')) as {
    details: Record<string, unknown>[];
    failed: Record<string, unknown>[];
    fixed: Record<string, unknown>[];
    planned: unknown[];
    summary: { failed: number; fixed: number };
  };
  expect(report.planned).toEqual([]);
  expect(report.fixed).toEqual([
    { code: 'crlf-body', recipe: 'normalize-crlf', scopeKey: 'MMR', stem: 'MMR-1' },
  ]);
  expect(report.failed).toContainEqual({
    code: 'verification-failed',
    issueCode: 'crlf-body',
    message: 'issue remains after apply',
    scopeKey: 'MMR',
    stem: 'MMR-2',
  });
  expect(report.details).toContainEqual({
    code: 'apply-failed',
    message: expect.stringContaining('operations'),
  });
  expect(report.summary).toMatchObject({ failed: 1, fixed: 1 });
});
