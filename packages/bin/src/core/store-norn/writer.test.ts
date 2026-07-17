import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProject, createTask } from '../create';
import {
  abandonTask,
  annotate,
  archiveProject,
  blockTask,
  completeTask,
  moveNode,
  parkTask,
  reopenTask,
  reorder,
  returnTask,
  submitTask,
  tagEntities,
  unarchiveProject,
  unblockTask,
  unparkTask,
  untagEntities,
  updateNode,
  updateProject,
} from '../mutations';
import { depend, undepend } from '../mutations/dependency';
import { startTask } from '../mutations/lifecycle';
import type { Store } from '../store';
import { expectMimirError } from '../testing';
import type { NornClient, NornDocument } from './client';
import type { MigrationOp, MigrationPlan } from './plan';
import { createNornWriteStore } from './writer';

/**
 * Writer unit coverage without a live `norn` (MMR-153): a fake client serves a
 * scripted snapshot for `find` and captures the `MigrationPlan` handed to
 * `vault.apply`, so the coalescing, CAS old-value, apply-report identity resolution,
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

/** A fake `NornClient`: `find` returns the scripted snapshot docs. Each `applyPlan` captures the plan and
 * yields the next scripted outcome (default: a bare success report). */
function fakeClient(
  docs: NornDocument[],
  outcomes: ApplyOutcome[] = [],
  reloadDocs?: NornDocument[] | ((plans: MigrationPlan[]) => NornDocument[]),
): {
  client: NornClient;
  plans: MigrationPlan[];
  findCount: () => number;
  getCount: () => number;
  getCols: () => (string | undefined)[];
} {
  const plans: MigrationPlan[] = [];
  let finds = 0;
  let gets = 0;
  const getCols: (string | undefined)[] = [];
  let applies = 0;
  const currentDocs = (): NornDocument[] => {
    if (applies === 0) {
      return docs;
    }
    return typeof reloadDocs === 'function' ? reloadDocs(plans) : (reloadDocs ?? docs);
  };
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
    find: (args: { eq?: string[] }): Promise<NornDocument[]> => {
      finds += 1;
      const current = currentDocs();
      return Promise.resolve(
        (args.eq ?? []).reduce((matches, token) => {
          const separator = token.indexOf(':');
          const field = token.slice(0, separator);
          const value = token.slice(separator + 1);
          return matches.filter((doc) => doc.frontmatter?.[field] === value);
        }, current),
      );
    },
    get: (targets: string[], col?: string): Promise<NornDocument[]> => {
      gets += 1;
      getCols.push(col);
      const current = currentDocs();
      return Promise.resolve(
        targets.flatMap((target) => {
          const matches = current.filter((doc) => {
            const base = doc.path.slice(doc.path.lastIndexOf('/') + 1);
            const stem = base.endsWith('.md') ? base.slice(0, -3) : base;
            return target === doc.path || target === stem;
          });
          // Real Norn returns no record when a stem is missing or ambiguous.
          return matches.length === 1 ? matches : [];
        }),
      );
    },
  } as unknown as NornClient;
  return { client, findCount: () => finds, getCols: () => getCols, getCount: () => gets, plans };
}

const projectDoc = (): NornDocument => ({
  frontmatter: { created: TS, key: 'MMR', name: 'Mimir', type: 'project', updated_at: TS },
  path: 'MMR/MMR.md',
});

const createdTaskDoc = (): NornDocument => ({
  frontmatter: {
    created: TS,
    lifecycle: 'todo',
    parent: '[[MMR-1]]',
    project: '[[MMR]]',
    title: 'New',
    type: 'task',
    updated_at: TS,
  },
  path: 'MMR/MMR-2.md',
});

/** Materialize the exact create payload captured by the fake apply. */
function createdDocFromPlan(plans: MigrationPlan[], path: string): NornDocument {
  const create = plans[0]?.operations.find((op) => op.kind === 'create_document');
  const value = create?.fields.new_value as { body?: unknown; frontmatter?: unknown } | undefined;
  if (
    value === undefined ||
    typeof value.body !== 'string' ||
    typeof value.frontmatter !== 'object' ||
    value.frontmatter === null ||
    Array.isArray(value.frontmatter)
  ) {
    throw new Error('fake apply did not capture a complete create payload');
  }
  return { body: value.body, frontmatter: value.frontmatter as Record<string, unknown>, path };
}

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
  const taskId = ws.nodes[0]?.id ?? '';
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

test('a relocated document keeps its stem identity and writes through the snapshot path locator', async () => {
  const docs: NornDocument[] = [
    projectDoc(),
    {
      frontmatter: {
        created: TS,
        lifecycle: 'todo',
        parent: '[[MMR]]',
        rank: 65536,
        title: 'Relocated task',
        type: 'task',
        updated_at: TS,
      },
      path: 'relocated/MMR-1.md',
    },
  ];
  const { client, plans } = fakeClient(docs);
  const store = createNornWriteStore(client, ROOT);

  const ws = await store.loadWorkingSet();
  expect(ws.nodes[0]?.id).toBe('MMR-1');
  await startTask(store, 'MMR-1');

  const paths = plans[0]?.operations.map((op) => op.fields.path);
  expect(paths).toEqual(['relocated/MMR-1.md', 'relocated/MMR-1.md', 'relocated/MMR-1.md']);
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
  const taskId = ws.nodes[0]?.id ?? '';
  await store.transact(async (w) => {
    await w.insertAnnotation({
      content: 'a load-bearing note',
      created_at: '2026-01-02T03:04:05.678Z',
      node_id: taskId,
    });
    // The co-written stamp every production annotate carries — the append alone
    // is unguarded and the writer now refuses a guard-less plan (MMR-303).
    await w.updateNode(taskId, { updated_at: '2026-01-02T03:04:05.678Z' });
  });

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
      w.insertAnnotation({
        content: 'x',
        created_at: '2026-01-02T03:04:05.678Z',
        node_id: 'MMR-999',
      }),
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
  const id = ws.nodes[0]?.id ?? '';

  await store.transact(async (w) => {
    await w.updateNode(id, { title: 'first' });
    await w.updateNode(id, { title: 'second' });
  });

  const titleOps = plans[0]?.operations.filter((op) => op.fields.field === 'title') ?? [];
  expect(titleOps).toHaveLength(1);
  expect(titleOps[0]?.fields.new_value).toBe('second');
});

test('a create resolves its final echo from the apply report without a post-apply snapshot reload', async () => {
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
  // apply resolves {{seq}} to MMR-2 through the structured report stem.
  const { client, findCount, getCols, getCount, plans } = fakeClient(
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
    (captured) => [...docs, createdDocFromPlan(captured, 'MMR/MMR-2.md')],
  );
  const store = createNornWriteStore(client, ROOT);
  const ws = await store.loadWorkingSet();
  const initiativeId = ws.nodes[0]?.id ?? '';

  const task = await createTask(store, { parentId: initiativeId, priority: 'p1', title: 'New' });

  // The pending writer handle never crosses Store.transact: the returned domain
  // object carries only the final canonical stem and allocated numeric sequence.
  expect(task.seq).toBe(2);
  expect(task.id).toBe('MMR-2');
  expect(findCount()).toBe(3); // explicit load + transaction snapshot + targeted project query
  expect(getCount()).toBe(1); // targeted created-stem + project survivor verification
  expect(getCols()).toEqual(['.body']);

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

test('creation tags are set values with deterministic order', async () => {
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
  const { client, plans } = fakeClient(
    docs,
    [
      {
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
              },
            ],
            outcome: 'applied',
          },
        },
      },
    ],
    (captured) => [...docs, createdDocFromPlan(captured, 'MMR/MMR-2.md')],
  );
  const store = createNornWriteStore(client, ROOT);

  await createTask(store, {
    parentId: 'MMR-1',
    tags: ['zeta', 'alpha', 'zeta', 'alpha'],
    title: 'Tagged',
  });

  const create = plans[0]?.operations.find((op) => op.kind === 'create_document');
  const newValue = create?.fields.new_value as { frontmatter: Record<string, unknown> };
  expect(newValue.frontmatter.tags).toEqual(['alpha', 'zeta']);
});

test('a created node is not returned when its owning project disappears after apply', async () => {
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
  const createdWithoutProject: NornDocument[] = [
    docs[1]!,
    {
      frontmatter: {
        created: TS,
        lifecycle: 'todo',
        parent: '[[MMR-1]]',
        project: '[[MMR]]',
        title: 'New',
        type: 'task',
        updated_at: TS,
      },
      path: 'MMR/MMR-2.md',
    },
  ];
  const { client, findCount, getCount } = fakeClient(
    docs,
    [
      {
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
              },
            ],
            outcome: 'applied',
          },
        },
      },
    ],
    createdWithoutProject,
  );
  const store = createNornWriteStore(client, ROOT);

  let message = '';
  try {
    await createTask(store, { parentId: 'MMR-1', title: 'New' });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toContain('created node did not survive with one owning project');
  expect(findCount()).toBe(2); // transaction snapshot + targeted owning-project query
  expect(getCount()).toBe(0); // missing owner fails before the node payload read
});

test('a created node is not returned when its stem is replaced with a different payload', async () => {
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
  const replacement = createdTaskDoc();
  replacement.frontmatter = { ...replacement.frontmatter, title: 'Concurrent replacement' };
  replacement.body = '## History\n\nreplacement body\n';
  const { client } = fakeClient(
    docs,
    [
      {
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
              },
            ],
            outcome: 'applied',
          },
        },
      },
    ],
    [...docs, replacement],
  );
  const store = createNornWriteStore(client, ROOT);

  let message = '';
  try {
    await createTask(store, { parentId: 'MMR-1', priority: 'p1', title: 'New' });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toContain('created node did not survive with its complete payload');
});

test('a created node is not returned when its owner disappears between verification reads', async () => {
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
  let postApplyReads = 0;
  const { client } = fakeClient(
    docs,
    [
      {
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
              },
            ],
            outcome: 'applied',
          },
        },
      },
    ],
    (captured) => {
      const created = createdDocFromPlan(captured, 'MMR/MMR-2.md');
      postApplyReads += 1;
      return postApplyReads === 1 ? [...docs, created] : [docs[1]!, created];
    },
  );
  const store = createNornWriteStore(client, ROOT);

  let message = '';
  try {
    await createTask(store, { parentId: 'MMR-1', title: 'New' });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toContain('created node did not survive with one owning project');
});

test('a created project is not returned when its frontmatter key is ambiguous after apply', async () => {
  const collidingProjects: NornDocument[] = [
    {
      frontmatter: { created: TS, key: 'NEW', name: 'New', type: 'project', updated_at: TS },
      path: 'NEW/NEW.md',
    },
    {
      frontmatter: { created: TS, key: 'NEW', name: 'Concurrent', type: 'project', updated_at: TS },
      path: 'relocated/OTHER.md',
    },
  ];
  const { client, findCount, getCount } = fakeClient(
    [],
    [{ report: { report: { applied: 1, failed: 0, operations: [], outcome: 'applied' } } }],
    collidingProjects,
  );
  const store = createNornWriteStore(client, ROOT);

  let message = '';
  try {
    await createProject(store, { key: 'NEW', name: 'New' });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toContain('created project did not survive uniquely after apply');
  expect(findCount()).toBe(2); // transaction snapshot + targeted type/key uniqueness query
  expect(getCount()).toBe(0); // ambiguity fails before any survivor payload read
});

test('a created project is not returned when its key is replaced with a different payload', async () => {
  const replacement: NornDocument = {
    body: '## History\n\nreplacement body\n',
    frontmatter: {
      created: TS,
      key: 'NEW',
      name: 'Concurrent replacement',
      project: '[[NEW]]',
      type: 'project',
      updated_at: TS,
    },
    path: 'NEW/NEW.md',
  };
  const { client } = fakeClient(
    [],
    [{ report: { report: { applied: 1, failed: 0, operations: [], outcome: 'applied' } } }],
    [replacement],
  );
  const store = createNornWriteStore(client, ROOT);

  let message = '';
  try {
    await createProject(store, { description: 'Expected description', key: 'NEW', name: 'New' });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toContain('created project did not survive with its complete payload');
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
  const id = ws.nodes[0]?.id ?? '';

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
  const id = ws.nodes[0]?.id ?? '';

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
  const id = ws.nodes[0]?.id ?? '';

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
  const id = ws.nodes[0]?.id ?? '';

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
  const id = ws.nodes[0]?.id ?? '';

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
test('a create whose apply report omits the create op throws (no leaked pending handle)', async () => {
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
  const initiativeId = ws.nodes[0]?.id ?? '';

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
// plan) still fails loud rather than leaking a pending create.
test('a create op with no resolved stem throws (no leaked pending handle)', async () => {
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
  const initiativeId = ws.nodes[0]?.id ?? '';

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
  const id = ws.nodes[0]?.id ?? '';

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
test('appendTransition against a node absent from the snapshot throws (History not dropped)', async () => {
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
        node_id: 'MMR-999',
        reason: null,
        to_value: 'in_progress',
      }),
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('a transition targets a node absent from the snapshot');
});

/**
 * MMR-186: the validator prunes a dangling/cycle-broken `depends_on` edge on load,
 * so the working set omits it. A later `transact` that rewrites `depends_on` must
 * re-merge the pruned ref rather than silently erasing corruption `mimir doctor`
 * surfaces — repair stays the deliberate `doctor --fix` decision (ADR 0017 / MMR-183).
 */

test('adding a dep preserves a validator-pruned dangling depends_on ref (MMR-186)', async () => {
  const docs: NornDocument[] = [
    projectDoc(),
    {
      frontmatter: {
        created: TS,
        lifecycle: 'todo',
        parent: '[[MMR]]',
        rank: 65536,
        title: 'Prereq',
        type: 'task',
        updated_at: TS,
      },
      path: 'MMR/MMR-1.md',
    },
    {
      frontmatter: {
        created: TS,
        depends_on: ['[[MMR-999]]'],
        lifecycle: 'todo',
        parent: '[[MMR]]',
        rank: 131072,
        title: 'Dependent',
        type: 'task',
        updated_at: TS,
      },
      path: 'MMR/MMR-2.md',
    },
  ];
  const { client, plans } = fakeClient(docs);
  const store = createNornWriteStore(client, ROOT);
  const ws = await store.loadWorkingSet();
  const prereqId = ws.nodes.find((n) => n.title === 'Prereq')?.id ?? '';
  const dependentId = ws.nodes.find((n) => n.title === 'Dependent')?.id ?? '';

  // The working set omits [[MMR-999]] (pruned as dangling); adding a real dep
  // rewrites depends_on from survivors — the dangling ref must survive the write.
  await depend(store, dependentId, [prereqId]);

  const plan = plans[0];
  if (plan === undefined) {
    throw new Error('no plan captured');
  }
  const op = findOp(plan, 'set_frontmatter', 'depends_on');
  expect(op?.fields.path).toBe('MMR/MMR-2.md');
  // CAS baseline is the raw on-disk value (dangler present); the new value keeps it.
  expect(op?.fields.expected_old_value).toEqual(['[[MMR-999]]']);
  expect(op?.fields.new_value).toEqual(['[[MMR-1]]', '[[MMR-999]]']);
});

test('removing the only visible dep still preserves a pruned dangling ref (MMR-186)', async () => {
  const docs: NornDocument[] = [
    projectDoc(),
    {
      frontmatter: {
        created: TS,
        lifecycle: 'todo',
        parent: '[[MMR]]',
        rank: 65536,
        title: 'Prereq',
        type: 'task',
        updated_at: TS,
      },
      path: 'MMR/MMR-1.md',
    },
    {
      frontmatter: {
        created: TS,
        depends_on: ['[[MMR-1]]', '[[MMR-999]]'],
        lifecycle: 'todo',
        parent: '[[MMR]]',
        rank: 131072,
        title: 'Dependent',
        type: 'task',
        updated_at: TS,
      },
      path: 'MMR/MMR-2.md',
    },
  ];
  const { client, plans } = fakeClient(docs);
  const store = createNornWriteStore(client, ROOT);
  const ws = await store.loadWorkingSet();
  const prereqId = ws.nodes.find((n) => n.title === 'Prereq')?.id ?? '';
  const dependentId = ws.nodes.find((n) => n.title === 'Dependent')?.id ?? '';

  await undepend(store, dependentId, [prereqId]);

  const plan = plans[0];
  if (plan === undefined) {
    throw new Error('no plan captured');
  }
  // The dangler is preserved as a set_frontmatter — NOT erased to a remove_frontmatter.
  expect(findOp(plan, 'remove_frontmatter', 'depends_on')).toBeUndefined();
  const op = findOp(plan, 'set_frontmatter', 'depends_on');
  expect(op?.fields.expected_old_value).toEqual(['[[MMR-1]]', '[[MMR-999]]']);
  expect(op?.fields.new_value).toEqual(['[[MMR-999]]']);
});

test('a dangling depends_on is left untouched when a different field is edited (MMR-186)', async () => {
  const docs: NornDocument[] = [
    projectDoc(),
    {
      frontmatter: {
        created: TS,
        depends_on: ['[[MMR-999]]'],
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
  const id = ws.nodes[0]?.id ?? '';

  // Only lifecycle/updated_at are dirtied — depends_on is never rewritten, so the
  // dangler is neither preserved nor erased: it is left entirely alone (blast radius).
  await startTask(store, id);

  const plan = plans[0];
  if (plan === undefined) {
    throw new Error('no plan captured');
  }
  expect(findOp(plan, 'set_frontmatter', 'depends_on')).toBeUndefined();
  expect(findOp(plan, 'remove_frontmatter', 'depends_on')).toBeUndefined();
});

test('editing a node preserves its cycle-broken depends_on edge (MMR-186)', async () => {
  // MMR-1 ⇄ MMR-2 form a depends_on cycle; the validator cuts one edge to keep a
  // valid acyclic subgraph. Adding an unrelated dep to the cut node must preserve
  // the cut edge so doctor keeps reporting the cycle.
  const docs: NornDocument[] = [
    projectDoc(),
    {
      frontmatter: {
        created: TS,
        depends_on: ['[[MMR-2]]'],
        lifecycle: 'todo',
        parent: '[[MMR]]',
        rank: 65536,
        title: 'A',
        type: 'task',
        updated_at: TS,
      },
      path: 'MMR/MMR-1.md',
    },
    {
      frontmatter: {
        created: TS,
        depends_on: ['[[MMR-1]]'],
        lifecycle: 'todo',
        parent: '[[MMR]]',
        rank: 131072,
        title: 'B',
        type: 'task',
        updated_at: TS,
      },
      path: 'MMR/MMR-2.md',
    },
    {
      frontmatter: {
        created: TS,
        lifecycle: 'todo',
        parent: '[[MMR]]',
        rank: 196608,
        title: 'C',
        type: 'task',
        updated_at: TS,
      },
      path: 'MMR/MMR-3.md',
    },
  ];
  const { client, plans } = fakeClient(docs);
  const store = createNornWriteStore(client, ROOT);
  const ws = await store.loadWorkingSet();

  const cycleNodes = ws.nodes.filter((n) => n.title === 'A' || n.title === 'B');
  const cutNode = cycleNodes.find((n) => !ws.edges.some((e) => e.node_id === n.id));
  const partner = cycleNodes.find((n) => n.id !== cutNode?.id);
  const cId = ws.nodes.find((n) => n.title === 'C')?.id ?? '';
  if (cutNode === undefined || partner === undefined) {
    throw new Error('expected exactly one cut edge in the 2-cycle');
  }

  await depend(store, cutNode.id, [cId]);

  const plan = plans[0];
  if (plan === undefined) {
    throw new Error('no plan captured');
  }
  const op = findOp(plan, 'set_frontmatter', 'depends_on');
  // The cut partner survives alongside the newly added dep (MMR-3).
  expect(op?.fields.new_value).toContain(`[[MMR-${partner.seq}]]`);
  expect(op?.fields.new_value).toContain('[[MMR-3]]');
});

/**
 * MMR-194 — the write-path CAS co-write invariant (a regression guard).
 *
 * The write path sends no `document_hash`, so a mutation's only whole-document
 * drift protection is that every verb co-writes at least one CAS-guarded field
 * (a `set_frontmatter` / `remove_frontmatter` carrying `expected_old_value`) on
 * every document it touches — usually the `updated_at` stamp, but `reorder` is
 * guarded by `rank` and `untag` by `tags`. A future verb that wrote a field
 * without a co-written guard, whose legality read a field it does not write,
 * would apply against a stale read with no drift error and no replay.
 *
 * Since MMR-303 the writer enforces guard presence at runtime
 * (`assertCoWriteGuards` refuses an unguarded plan before apply). The two tests
 * below still hold the line per verb: the first drives the real plan-assembly
 * seam for every mutation verb and asserts the guard is present — pinning that
 * each verb satisfies the runtime assertion rather than trips it — and the
 * second asserts the driven set matches the exported mutation surface, so a
 * newly added verb that carries no driver fails the suite loudly rather than
 * slipping past uncovered. See the CO-WRITE INVARIANT note on
 * `Accumulator.emitFieldOps` in `writer.ts`.
 */

const casTask = (stem: string, fm: Record<string, unknown>): NornDocument => ({
  frontmatter: { created: TS, parent: '[[MMR]]', title: stem, type: 'task', updated_at: TS, ...fm },
  path: `MMR/${stem}.md`,
});

const archivedProjectDoc = (): NornDocument => ({
  frontmatter: {
    archived_at: TS,
    created: TS,
    key: 'ARC',
    name: 'Archived',
    type: 'project',
    updated_at: TS,
  },
  path: 'ARC/ARC.md',
});

/**
 * One driver per mutation verb: a scripted snapshot plus the invocation that
 * exercises its plan. Each verb's touched document must carry a CAS guard —
 * either the field the verb writes (legality derives from it) or the co-written
 * `updated_at` stamp. Fixtures put the guarded field on disk (present) so the
 * emitted op is a value-CAS `set_frontmatter`, not an unguarded `add_frontmatter`.
 */
const CAS_PLAN_VERBS: Record<
  string,
  { docs: () => NornDocument[]; run: (s: Store) => Promise<unknown> }
> = {
  abandonTask: {
    docs: () => [projectDoc(), casTask('MMR-1', { lifecycle: 'todo', rank: 65536 })],
    run: (s) => abandonTask(s, 'MMR-1'),
  },
  annotate: {
    // The pure stamp case: the append carries no CAS, so only the `updated_at`
    // co-write guards the document — removing that stamp turns this test red.
    docs: () => [projectDoc(), casTask('MMR-1', { lifecycle: 'todo', rank: 65536 })],
    run: (s) => annotate(s, 'MMR-1', 'a load-bearing note'),
  },
  archiveProject: {
    docs: () => [projectDoc()],
    run: (s) => archiveProject(s, 'MMR'),
  },
  blockTask: {
    docs: () => [projectDoc(), casTask('MMR-1', { lifecycle: 'todo', rank: 65536 })],
    run: (s) => blockTask(s, 'MMR-1', 'waiting'),
  },
  completeTask: {
    docs: () => [projectDoc(), casTask('MMR-1', { lifecycle: 'in_progress', rank: 65536 })],
    run: (s) => completeTask(s, 'MMR-1'),
  },
  depend: {
    docs: () => [
      projectDoc(),
      casTask('MMR-1', { lifecycle: 'todo', rank: 65536 }),
      casTask('MMR-2', { lifecycle: 'todo', rank: 131072 }),
    ],
    run: (s) => depend(s, 'MMR-2', ['MMR-1']),
  },
  moveNode: {
    docs: () => [
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
      {
        frontmatter: {
          created: TS,
          parent: '[[MMR-1]]',
          title: 'Phase',
          type: 'phase',
          updated_at: TS,
        },
        path: 'MMR/MMR-2.md',
      },
      casTask('MMR-3', { lifecycle: 'todo', parent: '[[MMR-1]]', rank: 65536 }),
    ],
    run: (s) => moveNode(s, 'MMR-3', 'MMR-2'),
  },
  parkTask: {
    docs: () => [projectDoc(), casTask('MMR-1', { lifecycle: 'todo', rank: 65536 })],
    run: (s) => parkTask(s, 'MMR-1', 'later'),
  },
  reopenTask: {
    docs: () => [projectDoc(), casTask('MMR-1', { completed_at: TS, lifecycle: 'done' })],
    run: (s) => reopenTask(s, 'MMR-1'),
  },
  reorder: {
    // No stamp: the guard is `rank`, the field it writes (present → value-CAS).
    docs: () => [projectDoc(), casTask('MMR-1', { lifecycle: 'todo', rank: 65536 })],
    run: (s) => reorder(s, 'MMR-1', 'bottom'),
  },
  returnTask: {
    docs: () => [projectDoc(), casTask('MMR-1', { lifecycle: 'under_review' })],
    run: (s) => returnTask(s, 'MMR-1'),
  },
  startTask: {
    docs: () => [projectDoc(), casTask('MMR-1', { lifecycle: 'todo', rank: 65536 })],
    run: (s) => startTask(s, 'MMR-1'),
  },
  submitTask: {
    docs: () => [projectDoc(), casTask('MMR-1', { lifecycle: 'in_progress', rank: 65536 })],
    run: (s) => submitTask(s, 'MMR-1'),
  },
  tagEntities: {
    // The once-unguarded path (MMR-303): a first tag on an untagged entity is an
    // absent → present `add_frontmatter`, which carries no CAS — the co-written
    // `updated_at` stamp is the guard. Removing that stamp turns this test red.
    docs: () => [projectDoc(), casTask('MMR-1', { lifecycle: 'todo', rank: 65536 })],
    run: (s) => tagEntities(s, [{ entityId: 'MMR-1', entityType: 'node' }], ['beta']),
  },
  unarchiveProject: {
    docs: () => [archivedProjectDoc()],
    run: (s) => unarchiveProject(s, 'ARC'),
  },
  unblockTask: {
    docs: () => [projectDoc(), casTask('MMR-1', { hold: 'blocked', lifecycle: 'todo' })],
    run: (s) => unblockTask(s, 'MMR-1'),
  },
  undepend: {
    docs: () => [
      projectDoc(),
      casTask('MMR-1', { lifecycle: 'todo', rank: 65536 }),
      casTask('MMR-2', { depends_on: ['[[MMR-1]]'], lifecycle: 'todo', rank: 131072 }),
    ],
    run: (s) => undepend(s, 'MMR-2', ['MMR-1']),
  },
  unparkTask: {
    docs: () => [projectDoc(), casTask('MMR-1', { hold: 'parked', lifecycle: 'todo' })],
    run: (s) => unparkTask(s, 'MMR-1'),
  },
  untagEntities: {
    docs: () => [
      projectDoc(),
      casTask('MMR-1', { lifecycle: 'todo', rank: 65536, tags: ['alpha', 'beta'] }),
    ],
    run: (s) => untagEntities(s, [{ entityId: 'MMR-1', entityType: 'node' }], ['beta']),
  },
  updateNode: {
    docs: () => [projectDoc(), casTask('MMR-1', { lifecycle: 'todo', rank: 65536 })],
    run: (s) => updateNode(s, 'MMR-1', { title: 'Renamed' }),
  },
  updateProject: {
    docs: () => [projectDoc()],
    run: (s) => updateProject(s, 'MMR', { name: 'Renamed' }),
  },
};

/**
 * Mutation-surface exports that emit no drift-guarded document plan, each with
 * the reason it is out of scope. Kept beside {@link CAS_PLAN_VERBS} so the
 * coverage assertion below fails loudly when a NEW verb lands in neither set.
 */
const NON_PLAN_MUTATION_EXPORTS: Record<string, string> = {
  assertProjectActive: 'shared archive write-lock guard, not a verb',
  attachArtifact: 'artifact-seam write; the node transaction only validates',
  releasedByArchive: 'read-only projection — issues no write plan',
  updateArtifact: 'artifact-seam write; the node transaction only validates',
};

/**
 * The structural (necessary, not sufficient) half of the co-write invariant:
 * every driven verb's plan carries at least one `expected_old_value` guard per
 * touched document. Guard *presence* is checkable mechanically; guard
 * *relevance* — that the guarded field co-moves with the verb's legality
 * reads — is semantic and lives in the rule comment on `emitFieldOps` for the
 * verb author and reviewer. A verb guarding only an incidental field would
 * pass here and still be stale-unsound; this test is the tripwire, not the
 * whole fence.
 */
test('every mutation verb co-writes a CAS guard on each touched document (MMR-194)', async () => {
  const violations: string[] = [];
  for (const [name, verb] of Object.entries(CAS_PLAN_VERBS)) {
    const { client, plans } = fakeClient(verb.docs());
    const store = createNornWriteStore(client, ROOT);
    await verb.run(store);
    if (plans.length !== 1) {
      violations.push(`${name}: expected exactly one plan, got ${plans.length}`);
      continue;
    }
    const plan = plans[0];
    if (plan === undefined) {
      violations.push(`${name}: no plan captured`);
      continue;
    }
    // Group ops by the document they touch. A `create_document` births a new
    // document (guarded by create-exclusivity, not CAS-drift), so it is not a
    // mutated document; every other op targets a document that must be guarded.
    const mutatedPaths = new Set<string>();
    const guardedPaths = new Set<string>();
    for (const op of plan.operations) {
      if (op.kind === 'create_document') {
        continue;
      }
      const path = String(op.fields.path);
      mutatedPaths.add(path);
      if ('expected_old_value' in op.fields) {
        guardedPaths.add(path);
      }
    }
    if (mutatedPaths.size === 0) {
      violations.push(`${name}: emitted no document mutation to guard`);
    }
    for (const path of mutatedPaths) {
      if (!guardedPaths.has(path)) {
        violations.push(`${name}: ${path} carries no expected_old_value CAS guard`);
      }
    }
  }
  expect(violations).toEqual([]);
});

test('the CAS-guard invariant covers every exported mutation verb (MMR-194)', async () => {
  // Enumerate the mutation surface at runtime from the index module (dynamic
  // import so no wildcard `import *`): type-only exports erase, so filtering to
  // `typeof … === 'function'` yields exactly the verbs and shared helpers.
  // Scope: the `core/mutations` index IS the sanctioned mutation surface (one
  // core, thin transports), so this equality catches every verb added through
  // it. A write verb wired around the index would escape both tests — that is
  // an architecture violation to catch in review, not here.
  const mutationSurface: Record<string, unknown> = await import('../mutations');
  const exportedFns = Object.entries(mutationSurface)
    .filter(([, value]) => typeof value === 'function')
    .map(([name]) => name)
    .toSorted();
  const covered = [
    ...Object.keys(CAS_PLAN_VERBS),
    ...Object.keys(NON_PLAN_MUTATION_EXPORTS),
  ].toSorted();
  // A new verb added to the mutation index appears in `exportedFns` but neither
  // set, so this fails loudly — forcing a driver (guarded) or an explicit
  // out-of-scope entry (with its reason) rather than silently going uncovered.
  expect(exportedFns).toEqual(covered);
});

test('transact refuses a plan whose touched document carries no CAS guard (MMR-303)', async () => {
  const { client, plans } = fakeClient([
    projectDoc(),
    casTask('MMR-1', { lifecycle: 'todo', rank: 65536 }),
  ]);
  const store = createNornWriteStore(client, ROOT);
  // Drive the writer primitive directly, skipping the verb's co-written stamp: a
  // first tag on an untagged node emits only an unguarded `add_frontmatter`, the
  // exact shape a guard-less future verb would produce. The runtime assertion
  // must refuse it before anything reaches `vault.apply`.
  await expectMimirError('invariant', () =>
    store.transact((w) => w.insertTag({ entity_id: 'MMR-1', entity_type: 'node', tag: 'alpha' })),
  );
  expect(plans).toHaveLength(0);
});

test('a first tag on an untagged entity rides the co-written updated_at guard (MMR-303)', async () => {
  const { client, plans } = fakeClient([
    projectDoc(),
    casTask('MMR-1', { lifecycle: 'todo', rank: 65536 }),
  ]);
  const store = createNornWriteStore(client, ROOT);
  await tagEntities(store, [{ entityId: 'MMR-1', entityType: 'node' }], ['alpha']);
  const plan = plans[0];
  if (plan === undefined) {
    throw new Error('expected one applied plan');
  }
  // The tags write itself is absent → present, so it carries no CAS…
  expect(findOp(plan, 'add_frontmatter', 'tags')?.fields.new_value).toEqual(['alpha']);
  // …and the co-written stamp is the guard that lets the plan through.
  expect(findOp(plan, 'set_frontmatter', 'updated_at')?.fields.expected_old_value).toBe(TS);
});
