import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTask } from '../core/create';
import { startTask } from '../core/mutations/lifecycle';
import type { NornClient, NornDocument } from './client';
import type { MigrationOp, MigrationPlan } from './plan';
import { createNornWriteStore } from './writer';

/**
 * Writer unit coverage without a live `norn` (MMR-153): a fake client serves a
 * scripted snapshot for `find` and captures the `MigrationPlan` handed to
 * `apply_plan`, so the coalescing, CAS old-value, provisional-seq resolution,
 * and drift-retry logic are exercised in isolation. The live end-to-end parity
 * lives in `core/parity.integration.test.ts`.
 */

const TS = '2026-06-01T00:00:00.000Z';

// A real (empty) vault root: the writer ensures a create's directory on disk
// before apply, so the fake-client path still touches the filesystem there.
const ROOT = mkdtempSync(join(tmpdir(), 'writer-unit-'));
afterAll(() => rmSync(ROOT, { force: true, recursive: true }));

type ApplyOutcome = { report: unknown } | { throws: Error };

/** A fake `NornClient`: `find` returns `docs`; each `applyPlan` call captures the
 * plan and yields the next scripted outcome (default: a bare success report). */
function fakeClient(
  docs: NornDocument[],
  outcomes: ApplyOutcome[] = [],
): {
  client: NornClient;
  plans: MigrationPlan[];
  findCount: () => number;
} {
  const plans: MigrationPlan[] = [];
  let finds = 0;
  let applies = 0;
  const client = {
    applyPlan: (plan: MigrationPlan): Promise<unknown> => {
      plans.push(plan);
      const outcome = outcomes[applies] ?? {
        report: { failed: 0, operations: [] },
      };
      applies += 1;
      if ('throws' in outcome) {
        return Promise.reject(outcome.throws);
      }
      return Promise.resolve(outcome.report);
    },
    find: (): Promise<NornDocument[]> => {
      finds += 1;
      return Promise.resolve(docs);
    },
  } as unknown as NornClient;
  return { client, findCount: () => finds, plans };
}

const projectDoc = (): NornDocument => ({
  frontmatter: { created: TS, key: 'MMR', name: 'Mimir', type: 'project', updated_at: TS },
  path: 'MMR/MMR.md',
});

const findOp = (plan: MigrationPlan, kind: string, field?: string): MigrationOp | undefined =>
  plan.operations.find(
    (op) => op.kind === kind && (field === undefined || op.fields.field === field),
  );

test('a lifecycle mutation coalesces into per-field set_frontmatter + a History append', async () => {
  const docs: NornDocument[] = [
    projectDoc(),
    {
      frontmatter: {
        created: TS,
        lifecycle: 'todo',
        parent: '[[MMR]]',
        rank: 65536,
        title: 'Task',
        type: 'task',
        updated_at: TS,
      },
      path: 'MMR/MMR-1.md',
    },
  ];
  const { client, plans } = fakeClient(docs);
  const store = createNornWriteStore(client, ROOT);

  const ws = await store.loadWorkingSet();
  const taskId = ws.nodes[0]?.id ?? 0;
  await startTask(store, taskId);

  expect(plans).toHaveLength(1);
  const plan = plans[0];
  if (plan === undefined) {
    throw new Error('no plan captured');
  }
  // lifecycle todo → in_progress, carrying the snapshot value as the CAS old value
  const lifecycle = findOp(plan, 'set_frontmatter', 'lifecycle');
  expect(lifecycle?.fields).toMatchObject({
    expected_old_value: 'todo',
    field: 'lifecycle',
    new_value: 'in_progress',
    path: 'MMR/MMR-1.md',
  });
  // updated_at is stamped with its own CAS old value
  expect(findOp(plan, 'set_frontmatter', 'updated_at')?.fields.expected_old_value).toBe(TS);
  // the transition lands as one append under ## History
  const history = findOp(plan, 'append_to_section');
  expect(history?.fields.heading).toBe('History');
  expect(String(history?.fields.content)).toContain('todo → in_progress');
});

test('repeated writes to one field coalesce to a single op (last value wins)', async () => {
  const docs: NornDocument[] = [
    projectDoc(),
    {
      frontmatter: {
        created: TS,
        lifecycle: 'todo',
        parent: '[[MMR]]',
        title: 'Task',
        type: 'task',
        updated_at: TS,
      },
      path: 'MMR/MMR-1.md',
    },
  ];
  const { client, plans } = fakeClient(docs);
  const store = createNornWriteStore(client, ROOT);
  const ws = await store.loadWorkingSet();
  const id = ws.nodes[0]?.id ?? 0;

  await store.transact(async (w) => {
    await w.updateNode(id, { title: 'first' });
    await w.updateNode(id, { title: 'second' });
  });

  const titleOps = plans[0]?.operations.filter((op) => op.fields.field === 'title') ?? [];
  expect(titleOps).toHaveLength(1);
  expect(titleOps[0]?.fields.new_value).toBe('second');
});

test('a create emits one create_document with {{seq}} and stitches the resolved seq back', async () => {
  const docs: NornDocument[] = [
    projectDoc(),
    {
      frontmatter: {
        created: TS,
        parent: '[[MMR]]',
        title: 'Init',
        type: 'initiative',
        updated_at: TS,
      },
      path: 'MMR/MMR-1.md',
    },
  ];
  // apply resolves {{seq}} to MMR-2 (the report summary carries the real path)
  const { client, plans } = fakeClient(docs, [
    {
      report: {
        report: {
          failed: 0,
          operations: [{ kind: 'create_document', summary: 'create MMR/MMR-2.md' }],
        },
      },
    },
  ]);
  const store = createNornWriteStore(client, ROOT);
  const ws = await store.loadWorkingSet();
  const initiativeId = ws.nodes[0]?.id ?? 0;

  const task = await createTask(store, { parentId: initiativeId, priority: 'p1', title: 'New' });

  // the created node echoes the apply-time-resolved seq, not the sentinel
  expect(task.seq).toBe(2);

  const plan = plans[0];
  const create = plan?.operations.find((op) => op.kind === 'create_document');
  expect(create?.fields.path).toBe('MMR/MMR-{{seq}}.md');
  const newValue = create?.fields.new_value as {
    frontmatter: Record<string, unknown>;
    body: string;
  };
  expect(newValue.frontmatter).toMatchObject({
    lifecycle: 'todo',
    parent: '[[MMR-1]]',
    priority: 'p1',
    title: 'New',
    type: 'task',
  });
  expect(newValue.frontmatter.rank).toBeTypeOf('number');
  // the body seeds ## History so later mutations can append under it
  expect(newValue.body).toContain('## History');
});

test('a drift refusal reloads the snapshot and replays the verb', async () => {
  const docs: NornDocument[] = [
    projectDoc(),
    {
      frontmatter: {
        created: TS,
        lifecycle: 'todo',
        parent: '[[MMR]]',
        title: 'Task',
        type: 'task',
        updated_at: TS,
      },
      path: 'MMR/MMR-1.md',
    },
  ];
  const { client, plans, findCount } = fakeClient(docs, [
    {
      throws: new Error(
        'norn vault.apply_plan: stale repair plan for MMR/MMR-1.md field lifecycle: expected "todo", found "done"; regenerate',
      ),
    },
    { report: { failed: 0, operations: [] } },
  ]);
  const store = createNornWriteStore(client, ROOT);
  const ws = await store.loadWorkingSet();
  const id = ws.nodes[0]?.id ?? 0;

  const findsBefore = findCount();
  await startTask(store, id);

  // one apply refused (drift) → one replay: two applies, and a fresh find per attempt
  expect(plans).toHaveLength(2);
  expect(findCount() - findsBefore).toBe(2);
});

test('a non-drift apply failure propagates without a replay', async () => {
  const docs: NornDocument[] = [
    projectDoc(),
    {
      frontmatter: {
        created: TS,
        lifecycle: 'todo',
        parent: '[[MMR]]',
        title: 'Task',
        type: 'task',
        updated_at: TS,
      },
      path: 'MMR/MMR-1.md',
    },
  ];
  const { client, plans } = fakeClient(docs, [
    { throws: new Error('norn vault.apply_plan: some other failure') },
  ]);
  const store = createNornWriteStore(client, ROOT);
  const ws = await store.loadWorkingSet();
  const id = ws.nodes[0]?.id ?? 0;

  let message = '';
  try {
    await startTask(store, id);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('some other failure');
  expect(plans).toHaveLength(1); // no replay
});
