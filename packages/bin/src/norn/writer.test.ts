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
 * `vault.apply`, so the coalescing, CAS old-value, provisional-seq resolution,
 * and drift-retry logic are exercised in isolation. Drift is a norn 0.45 in-band
 * `outcome: 'refused'` report (isError: false), not a thrown error. The live
 * end-to-end parity lives in `core/parity.integration.test.ts`.
 */

const TS = '2026-06-01T00:00:00.000Z';

// A real (empty) vault root, threaded into the plan's `vault_root`. The writer
// issues no direct filesystem writes (create parents come from `vault.apply`'s
// `parents: true`, NRN-174), so nothing is written under it on the fake path.
const ROOT = mkdtempSync(join(tmpdir(), 'writer-unit-'));
afterAll(() => rmSync(ROOT, { force: true, recursive: true }));

type ApplyOutcome = { report: unknown } | { throws: Error };

/** A norn 0.45 CAS-drift refusal report (in-band, isError: false): outcome
 * 'refused' with a structured `error.code` on the failed op — the signal the
 * write path reloads and replays on. */
const driftRefusal = (field = 'lifecycle'): ApplyOutcome => ({
  report: {
    report: {
      applied: 0,
      failed: 1,
      operations: [
        {
          error: {
            code: 'expected-old-value-mismatch',
            message: `stale repair plan for MMR/MMR-1.md field ${field}: expected "todo", found "done"`,
            path: 'MMR/MMR-1.md',
          },
          kind: 'set_frontmatter',
          status: 'failed',
        },
      ],
      outcome: 'refused',
    },
  },
});

/** A fake `NornClient`: `find` returns `docs` for the snapshot read and, once at
 * least one `applyPlan` has run, `reloadDocs` (the post-apply reload a create's
 * seq/id resolution issues) when supplied. Each `applyPlan` captures the plan and
 * yields the next scripted outcome (default: a bare success report). */
function fakeClient(
  docs: NornDocument[],
  outcomes: ApplyOutcome[] = [],
  reloadDocs?: NornDocument[],
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
        report: { report: { failed: 0, operations: [], outcome: 'applied' } },
      };
      applies += 1;
      if ('throws' in outcome) {
        return Promise.reject(outcome.throws);
      }
      return Promise.resolve(outcome.report);
    },
    find: (): Promise<NornDocument[]> => {
      finds += 1;
      return Promise.resolve(applies > 0 ? (reloadDocs ?? docs) : docs);
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

test('an annotation lands as one append under ## Annotations with a stamped created-at', async () => {
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
  await store.transact((w) =>
    w.insertAnnotation({
      content: 'a load-bearing note',
      created_at: '2026-01-02T03:04:05.678Z',
      node_id: taskId,
    }),
  );

  const plan = plans[0];
  if (plan === undefined) {
    throw new Error('no plan captured');
  }
  const annotation = findOp(plan, 'append_to_section');
  expect(annotation?.fields).toMatchObject({ heading: 'Annotations', path: 'MMR/MMR-1.md' });
  const content = String(annotation?.fields.content);
  expect(content).toContain('a load-bearing note');
  // the core-supplied created-at renders as the record's ISO heading (`### <iso>`)
  expect(content).toContain('### 2026-01-02T03:04:05.678Z');
});

test('an annotation against a node absent from the snapshot fails loud (not dropped)', async () => {
  const { client } = fakeClient([projectDoc()]);
  const store = createNornWriteStore(client, ROOT);

  let message = '';
  try {
    await store.transact((w) =>
      w.insertAnnotation({ content: 'x', created_at: '2026-01-02T03:04:05.678Z', node_id: 999 }),
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('an annotation targets a node absent from the snapshot');
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
  // apply resolves {{seq}} to MMR-2 (the report summary carries the real path);
  // the post-apply reload then surfaces the persisted MMR-2 with a real id/seq.
  const reloadDocs: NornDocument[] = [
    ...docs,
    {
      frontmatter: {
        created: TS,
        lifecycle: 'todo',
        parent: '[[MMR-1]]',
        priority: 'p1',
        rank: 65536,
        title: 'New',
        type: 'task',
        updated_at: TS,
      },
      path: 'MMR/MMR-2.md',
    },
  ];
  const { client, plans } = fakeClient(
    docs,
    [
      {
        // a real norn 0.45 applied create report: outcome + the create op's
        // `op_id` (its plan position) and resolved `stem`, which the writer
        // correlates and reads structurally (NRN-175).
        report: {
          report: {
            applied: 1,
            failed: 0,
            operations: [
              {
                kind: 'create_document',
                op_id: '0',
                path: 'MMR/MMR-2.md',
                status: 'applied',
                stem: 'MMR-2',
                summary: 'create MMR/MMR-2.md',
              },
            ],
            outcome: 'applied',
          },
        },
      },
    ],
    reloadDocs,
  );
  const store = createNornWriteStore(client, ROOT);
  const ws = await store.loadWorkingSet();
  const initiativeId = ws.nodes[0]?.id ?? 0;

  const task = await createTask(store, { parentId: initiativeId, priority: 'p1', title: 'New' });

  // the created node echoes the apply-time-resolved seq and a real positive id,
  // never the negative provisional sentinel
  expect(task.seq).toBe(2);
  expect(task.id).toBeGreaterThan(0);

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
    driftRefusal('lifecycle'),
    { report: { report: { failed: 0, operations: [], outcome: 'applied' } } },
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

test('a thrown tool/connection error propagates without a replay', async () => {
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
    { throws: new Error('norn vault.apply: some other failure') },
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

test('an in-band non-drift refusal (deterministic code) propagates without a replay', async () => {
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
  // outcome: 'refused' but the code is NOT a CAS drift → deterministic, a blind
  // retry can't change it, so it must terminate (not replay).
  const { client, plans } = fakeClient(docs, [
    {
      report: {
        report: {
          applied: 0,
          failed: 1,
          operations: [
            {
              error: {
                code: 'post-image-verification-failed',
                message: 'refused: MMR/MMR-1.md would not round-trip',
                path: 'MMR/MMR-1.md',
              },
              kind: 'set_frontmatter',
              status: 'failed',
            },
          ],
          outcome: 'refused',
        },
      },
    },
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
  expect(message).toContain('apply did not complete');
  expect(plans).toHaveLength(1); // deterministic refusal — no replay
});

test('a mixed refusal (a CAS op plus a code-less failed op) is terminal, not replayed', async () => {
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
  // outcome 'refused' with ONE CAS-drift op AND one code-less failed op. A blind
  // replay can't clear the second failure, so the whole refusal is terminal — the
  // CAS op must not let the code-less op ride along into the replay path.
  const { client, plans } = fakeClient(docs, [
    {
      report: {
        report: {
          applied: 0,
          failed: 2,
          operations: [
            {
              error: {
                code: 'expected-old-value-mismatch',
                message: 'stale repair plan for MMR/MMR-1.md field lifecycle',
                path: 'MMR/MMR-1.md',
              },
              kind: 'set_frontmatter',
              status: 'failed',
            },
            {
              error: { message: 'section edit refused', path: 'MMR/MMR-1.md' },
              kind: 'append_to_section',
              status: 'failed',
            },
          ],
          outcome: 'refused',
        },
      },
    },
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
  expect(message).toContain('apply did not complete');
  expect(plans).toHaveLength(1); // NOT blind-replayed on the CAS op alone
});

test('an unrecognized apply report (no outcome) is terminal, never a silent success', async () => {
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
  // A degraded/shape-changed report with no `outcome`: a write we cannot confirm
  // as applied must fail loud, never be swallowed as success.
  const { client, plans } = fakeClient(docs, [{ report: { report: { operations: [] } } }]);
  const store = createNornWriteStore(client, ROOT);
  const ws = await store.loadWorkingSet();
  const id = ws.nodes[0]?.id ?? 0;

  let message = '';
  try {
    await startTask(store, id);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('apply did not complete');
  expect(plans).toHaveLength(1);
});

// F1+F2 — a create must resolve a real seq/id from the apply report, or throw.
test('a create whose apply report omits the create op throws (no leaked provisional)', async () => {
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
  // the apply "succeeds" but the report carries no create_document op
  const { client, plans } = fakeClient(docs, [
    { report: { report: { applied: 1, failed: 0, operations: [], outcome: 'applied' } } },
  ]);
  const store = createNornWriteStore(client, ROOT);
  const ws = await store.loadWorkingSet();
  const initiativeId = ws.nodes[0]?.id ?? 0;

  let message = '';
  try {
    await createTask(store, { parentId: initiativeId, priority: 'p1', title: 'New' });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('no create_document report op at op_id 0');
  expect(plans).toHaveLength(1); // the write applied; only the echo resolution failed
});

// F1+F2 — a create op present but carrying no resolved stem (norn reports a
// `skipped` op with no `stem`, e.g. two same-`{{seq}}`-template creates in one
// plan) still fails loud rather than leaking the negative provisional seq.
test('a create op with no resolved stem throws (no leaked provisional)', async () => {
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
  const { client } = fakeClient(docs, [
    {
      report: {
        report: {
          applied: 0,
          failed: 0,
          operations: [{ kind: 'create_document', op_id: '0', status: 'skipped' }],
          outcome: 'applied',
          skipped: 1,
        },
      },
    },
  ]);
  const store = createNornWriteStore(client, ROOT);
  const ws = await store.loadWorkingSet();
  const initiativeId = ws.nodes[0]?.id ?? 0;

  let message = '';
  try {
    await createTask(store, { parentId: initiativeId, priority: 'p1', title: 'New' });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('no resolved stem');
  expect(message).toContain('status: skipped');
});

// F6 — exhausting the drift retries throws a clear exhaustion error, never the raw drift.
test('repeated drift across every attempt throws the exhaustion error after MAX_ATTEMPTS applies', async () => {
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
  // more drift outcomes than attempts — the loop must stop itself, not run out of script
  const driftOutcomes: ApplyOutcome[] = Array.from({ length: 6 }, () => driftRefusal('lifecycle'));
  const { client, plans } = fakeClient(docs, driftOutcomes);
  const store = createNornWriteStore(client, ROOT);
  const ws = await store.loadWorkingSet();
  const id = ws.nodes[0]?.id ?? 0;

  let message = '';
  try {
    await startTask(store, id);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('exhausted its drift retries');
  expect(plans).toHaveLength(5); // exactly MAX_ATTEMPTS applies, then it gives up
});

// F10 — a transition against a non-positive (same-transact create) id fails loud, not silently dropped.
test('appendTransition against a negative provisional node id throws (History not dropped)', async () => {
  const docs: NornDocument[] = [projectDoc()];
  const { client } = fakeClient(docs);
  const store = createNornWriteStore(client, ROOT);

  let message = '';
  try {
    await store.transact((w) =>
      w.appendTransition({
        at: '2026-01-02T03:04:05.678Z',
        from_value: 'todo',
        kind: 'lifecycle',
        node_id: -1,
        reason: null,
        to_value: 'in_progress',
      }),
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('a transition targets a node absent from the snapshot');
});
