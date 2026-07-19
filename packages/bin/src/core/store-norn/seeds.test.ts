import { expect, test } from 'bun:test';

import { MimirError } from '../errors';
import type { NornClient, NornDocument } from './client';
import type { MigrationOp, MigrationPlan } from './plan';
import { createNornSeedStore } from './seeds';

/**
 * Seed store guard coverage without a live `norn` (MMR-313): a fake client serves
 * one scripted seed doc for `get` and captures the `MigrationPlan` handed to
 * `vault.apply`, so the co-write drift guard (a missing/null `updated_at` refuses
 * before apply; a healthy seed writes with the stamp's CAS old value) is
 * exercised in isolation. The live end-to-end parity lives in
 * `seeds.integration.test.ts`.
 */

const TS = '2026-06-01T00:00:00.000Z';
const ROOT = '/vault';
const PATH = 'MMR/seeds/MMR-s1.md';

/** One seed doc at `MMR-s1`; `fm` overrides let a test drop or null `updated_at`. */
const seedDoc = (fm: Record<string, unknown> = {}): NornDocument => ({
  frontmatter: {
    created: TS,
    kind: 'feature',
    lifecycle: 'new',
    project: '[[MMR]]',
    title: 'seed',
    type: 'seed',
    updated_at: TS,
    ...fm,
  },
  path: PATH,
});

/** A fake `NornClient`: `get` returns the scripted seed doc; each `applyPlan`
 * captures the plan and yields a bare `applied` report. */
function fakeClient(doc: NornDocument): { client: NornClient; plans: MigrationPlan[] } {
  const plans: MigrationPlan[] = [];
  const client = {
    applyPlan: (plan: MigrationPlan): Promise<unknown> => {
      plans.push(plan);
      return Promise.resolve({ report: { failed: 0, operations: [], outcome: 'applied' } });
    },
    get: (): Promise<NornDocument[]> => Promise.resolve([doc]),
  } as unknown as NornClient;
  return { client, plans };
}

const findOp = (plan: MigrationPlan, field: string): MigrationOp | undefined =>
  plan.operations.find((op) => op.kind === 'set_frontmatter' && op.fields.field === field);

const DEGRADED_HINT =
  "the document was hand-edited or predates mimir management — run 'mimir doctor --fix' to repair it";

/** Assert `run` rejects with the shared degraded-vault refusal and wrote nothing. */
async function expectDegradedRefusal(
  plans: MigrationPlan[],
  run: () => Promise<unknown>,
): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof MimirError)) {
    throw new Error(`expected a MimirError(validation), got ${String(caught)}`, { cause: caught });
  }
  expect(caught.code).toBe('validation');
  expect(caught.message).toContain("carries no usable updated_at for the write's drift guard");
  expect(caught.hint).toBe(DEGRADED_HINT);
  expect(plans).toHaveLength(0);
}

test('patch on a healthy seed writes the updated_at stamp guarded by its CAS old value (MMR-313)', async () => {
  const { client, plans } = fakeClient(seedDoc());
  const store = createNornSeedStore(client, ROOT);
  await store.patch('MMR', 1, { title: 'renamed' });
  const plan = plans[0];
  if (plan === undefined) {
    throw new Error('expected one applied plan');
  }
  expect(findOp(plan, 'title')?.fields.expected_old_value).toBe('seed');
  expect(findOp(plan, 'updated_at')?.fields.expected_old_value).toBe(TS);
});

test('patch on a seed missing updated_at refuses as degraded vault state (MMR-313)', async () => {
  const { client, plans } = fakeClient(seedDoc({ updated_at: undefined }));
  const store = createNornSeedStore(client, ROOT);
  await expectDegradedRefusal(plans, () => store.patch('MMR', 1, { title: 'renamed' }));
});

test('patch on a seed with an explicitly null updated_at refuses as degraded vault state (MMR-313)', async () => {
  const { client, plans } = fakeClient(seedDoc({ updated_at: null }));
  const store = createNornSeedStore(client, ROOT);
  await expectDegradedRefusal(plans, () => store.patch('MMR', 1, { title: 'renamed' }));
});

test('transition on a healthy seed writes the updated_at stamp guarded by its CAS old value (MMR-313)', async () => {
  const { client, plans } = fakeClient(seedDoc());
  const store = createNornSeedStore(client, ROOT);
  await store.transition('MMR', 1, 'promoted', 'why');
  const plan = plans[0];
  if (plan === undefined) {
    throw new Error('expected one applied plan');
  }
  expect(findOp(plan, 'lifecycle')?.fields.expected_old_value).toBe('new');
  expect(findOp(plan, 'updated_at')?.fields.expected_old_value).toBe(TS);
});

test('transition on a seed missing updated_at refuses as degraded vault state (MMR-313)', async () => {
  const { client, plans } = fakeClient(seedDoc({ updated_at: undefined }));
  const store = createNornSeedStore(client, ROOT);
  await expectDegradedRefusal(plans, () => store.transition('MMR', 1, 'promoted', 'why'));
});

test('transition on a seed with an explicitly null updated_at refuses as degraded vault state (MMR-313)', async () => {
  const { client, plans } = fakeClient(seedDoc({ updated_at: null }));
  const store = createNornSeedStore(client, ROOT);
  await expectDegradedRefusal(plans, () => store.transition('MMR', 1, 'promoted', 'why'));
});

test('germinate on a healthy seed writes the updated_at stamp guarded by its CAS old value (MMR-313)', async () => {
  const { client, plans } = fakeClient(seedDoc());
  const store = createNornSeedStore(client, ROOT);
  await store.germinate('MMR', 1, 'MMR-42');
  const plan = plans[0];
  if (plan === undefined) {
    throw new Error('expected one applied plan');
  }
  expect(findOp(plan, 'updated_at')?.fields.expected_old_value).toBe(TS);
});

test('germinate on a seed missing updated_at refuses as degraded vault state (MMR-313)', async () => {
  const { client, plans } = fakeClient(seedDoc({ updated_at: undefined }));
  const store = createNornSeedStore(client, ROOT);
  await expectDegradedRefusal(plans, () => store.germinate('MMR', 1, 'MMR-42'));
});

test('germinate on a seed with an explicitly null updated_at refuses as degraded vault state (MMR-313)', async () => {
  const { client, plans } = fakeClient(seedDoc({ updated_at: null }));
  const store = createNornSeedStore(client, ROOT);
  await expectDegradedRefusal(plans, () => store.germinate('MMR', 1, 'MMR-42'));
});
