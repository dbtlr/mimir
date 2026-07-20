import { expect, test } from 'bun:test';

import { MimirError } from '../errors';
import { createNornArtifactStore } from './artifacts';
import type { NornClient, NornDocument } from './client';
import type { MigrationOp, MigrationPlan } from './plan';

/**
 * Artifact store guard coverage without a live `norn` (MMR-317): a fake client
 * serves one scripted artifact doc for `get` and captures the `MigrationPlan`
 * handed to `vault.apply`, so the co-write drift guard (a missing/null
 * `updated_at` refuses before apply; a healthy artifact writes with the stamp's
 * CAS old value) is exercised in isolation — mirroring `seeds.test.ts`. The live
 * end-to-end parity lives in `conformance.test.ts`.
 */

const TS = '2026-06-01T00:00:00.000Z';
const ROOT = '/vault';
const PATH = 'MMR/artifacts/MMR-a1.md';

/** One artifact doc at `MMR-a1`; `fm` overrides let a test drop or null
 * `updated_at` (or change the tag set). */
const artifactDoc = (fm: Record<string, unknown> = {}): NornDocument => ({
  frontmatter: {
    created: TS,
    project: '[[MMR]]',
    tags: ['a'],
    title: 'artifact',
    type: 'artifact',
    updated_at: TS,
    ...fm,
  },
  path: PATH,
});

/** A fake `NornClient`: `get` returns the scripted artifact doc; each `applyPlan`
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
  plan.operations.find(
    (op) =>
      (op.kind === 'set_frontmatter' || op.kind === 'add_frontmatter') && op.fields.field === field,
  );

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

test('applyTag on a healthy artifact writes the updated_at stamp guarded by its CAS old value (MMR-317)', async () => {
  const { client, plans } = fakeClient(artifactDoc());
  const store = createNornArtifactStore(client, ROOT);
  await store.applyTag('MMR', 1, 'b');
  const plan = plans[0];
  if (plan === undefined) {
    throw new Error('expected one applied plan');
  }
  expect(findOp(plan, 'tags')?.fields.new_value).toEqual(['a', 'b']);
  expect(findOp(plan, 'tags')?.fields.expected_old_value).toEqual(['a']);
  expect(findOp(plan, 'updated_at')?.fields.expected_old_value).toBe(TS);
});

test('applyTag that does not change the tag set writes nothing (no-op, MMR-303 posture)', async () => {
  const { client, plans } = fakeClient(artifactDoc());
  const store = createNornArtifactStore(client, ROOT);
  await store.applyTag('MMR', 1, 'a'); // already present
  expect(plans).toHaveLength(0);
});

test('applyTag on an artifact missing updated_at refuses as degraded vault state (MMR-317)', async () => {
  const { client, plans } = fakeClient(artifactDoc({ updated_at: undefined }));
  const store = createNornArtifactStore(client, ROOT);
  await expectDegradedRefusal(plans, () => store.applyTag('MMR', 1, 'b'));
});

test('applyTag on an artifact with an explicitly null updated_at refuses as degraded vault state (MMR-317)', async () => {
  const { client, plans } = fakeClient(artifactDoc({ updated_at: null }));
  const store = createNornArtifactStore(client, ROOT);
  await expectDegradedRefusal(plans, () => store.applyTag('MMR', 1, 'b'));
});

test('removeTags on a healthy artifact writes the updated_at stamp guarded by its CAS old value (MMR-317)', async () => {
  const { client, plans } = fakeClient(artifactDoc({ tags: ['a', 'b'] }));
  const store = createNornArtifactStore(client, ROOT);
  const removed = await store.removeTags('MMR', 1, ['a']);
  expect(removed).toBe(1);
  const plan = plans[0];
  if (plan === undefined) {
    throw new Error('expected one applied plan');
  }
  expect(findOp(plan, 'tags')?.fields.new_value).toEqual(['b']);
  expect(findOp(plan, 'updated_at')?.fields.expected_old_value).toBe(TS);
});

test('removeTags that removes nothing writes nothing (no-op, MMR-303 posture)', async () => {
  const { client, plans } = fakeClient(artifactDoc());
  const store = createNornArtifactStore(client, ROOT);
  const removed = await store.removeTags('MMR', 1, ['nope']);
  expect(removed).toBe(0);
  expect(plans).toHaveLength(0);
});

test('removeTags on an artifact missing updated_at refuses as degraded vault state (MMR-317)', async () => {
  const { client, plans } = fakeClient(artifactDoc({ updated_at: undefined }));
  const store = createNornArtifactStore(client, ROOT);
  await expectDegradedRefusal(plans, () => store.removeTags('MMR', 1, ['a']));
});

test('removeTags on an artifact with an explicitly null updated_at refuses as degraded vault state (MMR-317)', async () => {
  const { client, plans } = fakeClient(artifactDoc({ updated_at: null }));
  const store = createNornArtifactStore(client, ROOT);
  await expectDegradedRefusal(plans, () => store.removeTags('MMR', 1, ['a']));
});

test('updateTitle on a healthy artifact writes the updated_at stamp guarded by its CAS old value (MMR-317)', async () => {
  const { client, plans } = fakeClient(artifactDoc());
  const store = createNornArtifactStore(client, ROOT);
  expect(await store.updateTitle('MMR', 1, 'renamed')).toBe(true);
  const plan = plans[0];
  if (plan === undefined) {
    throw new Error('expected one applied plan');
  }
  expect(findOp(plan, 'title')?.fields.expected_old_value).toBe('artifact');
  expect(findOp(plan, 'updated_at')?.fields.expected_old_value).toBe(TS);
});

test('updateTitle on an artifact missing updated_at refuses as degraded vault state (MMR-317)', async () => {
  const { client, plans } = fakeClient(artifactDoc({ updated_at: undefined }));
  const store = createNornArtifactStore(client, ROOT);
  await expectDegradedRefusal(plans, () => store.updateTitle('MMR', 1, 'renamed'));
});

test('updateTitle on an artifact with an explicitly null updated_at refuses as degraded vault state (MMR-317)', async () => {
  const { client, plans } = fakeClient(artifactDoc({ updated_at: null }));
  const store = createNornArtifactStore(client, ROOT);
  await expectDegradedRefusal(plans, () => store.updateTitle('MMR', 1, 'renamed'));
});
