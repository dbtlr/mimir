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
  expect(io.out.at(-1)).toBe('doctor repair applied: 1 planned, 1 fixed, 1 skipped, 0 failed');
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
  expect(records.at(-2)).toEqual({
    code: 'apply-refused',
    message: 'norn apply outcome: refused',
    status: 'failed',
  });
  expect(records.at(-1)).toEqual({
    failed: 1,
    fixed: 0,
    mode: 'apply',
    outcome: 'failed',
    planned: 1,
    skipped: 1,
    status: 'summary',
  });
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
