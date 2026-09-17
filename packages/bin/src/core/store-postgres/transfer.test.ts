import { expect, setDefaultTimeout, test } from 'bun:test';

import type { StoreExport } from '../export';
import { STORE_EXPORT_SCHEMA_VERSION } from '../export';
import type { Node } from '../model';
import { insertBatched, rowsPerStatement } from './batch';
import { createPgliteTestStore } from './testing';

/**
 * The Postgres-only half of the export/import contract (MMR-380) — the batched
 * write, the deferred constraints a preview has to fire by hand, and the two
 * document shapes only a relational target can get wrong. The behavior itself is
 * pinned by the backend-neutral conformance suite
 * (`core/store-conformance.test.ts`); what cannot live there is what belongs to
 * this backend alone — the CHUNKING against one backend's bind-parameter
 * ceiling (the shared fixture is far too small to cross it), and a constraint
 * only a relational schema has.
 */

// A whole PGlite store plus a four-figure node collection.
setDefaultTimeout(60_000);

test('a chunk stays under the statement bind-parameter ceiling at every row width', () => {
  // PostgreSQL binds at most 65535 parameters per statement, and a row spends
  // one per column. The widest row the import writes is a node's (~26 columns).
  for (let columns = 1; columns <= 128; columns += 1) {
    expect(rowsPerStatement(columns) * columns).toBeLessThanOrEqual(65_535);
    expect(rowsPerStatement(columns)).toBeGreaterThanOrEqual(1);
  }
});

test('an import round-trips a collection wider than one statement', async () => {
  // Deliberately past the node chunk: a node row is ~26 columns, so a chunk
  // holds ~1200 rows and this collection takes more than one statement. A
  // document that fits in one chunk would pass whether the import chunked or
  // not, and the failure this pins — a 65535-parameter statement — only appears
  // past the boundary.
  const count = rowsPerStatement(26) + 10;
  const store_ = await createPgliteTestStore();
  try {
    await store_.store.import(wideDocument(count), { dryRun: false, mode: 'fresh' });

    const exported = await store_.store.export();
    expect(exported.nodes).toHaveLength(count);
    expect(exported.nodes.at(0)?.id).toBe('WIDE-1');
    expect(exported.nodes.at(-1)?.id).toBe(`WIDE-${String(count)}`);
    expect(exported.nodes.at(-1)?.title).toBe(`Task ${String(count)}`);
    expect(exported.projects.at(0)?.counters.node).toBe(count);
  } finally {
    await store_.close();
  }
});

test('a batched insert refuses rows of differing width', async () => {
  // The chunk size is computed from the FIRST row, so a batch built with a
  // conditional key would chunk against the wrong width and blow the ceiling on
  // a big import — a fault that never shows on a small one.
  let statements = 0;
  const insert = (): Promise<unknown> => {
    statements += 1;
    return Promise.resolve();
  };
  const ragged = insertBatched([{ a: 1, b: 2 }, { a: 1, b: 2 }, { a: 1 }], insert);
  expect(await errorText(ragged)).toContain('row 2 has 1 columns');
  // Refused before a single statement ran.
  expect(statements).toBe(0);
});

const STAMP = '2026-09-01T00:00:00.000Z';

/** The message an awaited rejection carries, whatever its class. */
async function errorText(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the call to be refused, but it completed');
}

/** One task node of project `MMR`, with whatever the case needs overridden. */
function task(seq: number, overrides: Partial<Node> = {}): Node {
  return {
    branch: null,
    completed_at: null,
    created_at: STAMP,
    description: null,
    external_ref: null,
    harness: null,
    hold: null,
    hold_reason: null,
    host: null,
    id: `MMR-${String(seq)}`,
    lifecycle: 'todo',
    open_ended: null,
    parent_id: null,
    priority: null,
    project_id: 'MMR',
    rank: null,
    seq,
    session: null,
    size: null,
    summary: null,
    target: null,
    title: `Task ${String(seq)}`,
    type: 'task',
    updated_at: STAMP,
    upstream: null,
    ...overrides,
  };
}

/** A whole document holding project `MMR` and whatever collections the case sets. */
function document(overrides: Partial<StoreExport> = {}): StoreExport {
  return {
    annotations: [],
    artifacts: [],
    bodySections: [],
    edges: [],
    exported_at: STAMP,
    nodes: [],
    projects: [
      {
        archived_at: null,
        counters: { artifact: 0, node: 1, seed: 0 },
        created_at: STAMP,
        description: null,
        key: 'MMR',
        name: 'Mimir',
        updated_at: STAMP,
      },
    ],
    schema_version: STORE_EXPORT_SCHEMA_VERSION,
    scratchpads: [],
    seeds: [],
    tags: [],
    transitions: [],
    ...overrides,
  };
}

test('a preview refuses a dangling parent, with the error the apply raises', async () => {
  // `node.parent_id` is DEFERRABLE INITIALLY DEFERRED, so the check runs at
  // COMMIT — which a preview, ended by a rollback, never reaches. Without the
  // preview firing the deferred checks itself, this document previews clean and
  // then dies on the apply the operator ran because the preview was clean.
  const orphan = document({ nodes: [task(1, { parent_id: 'MMR-777' })] });
  const store_ = await createPgliteTestStore();
  try {
    const previewed = await errorText(store_.store.import(orphan, { dryRun: true, mode: 'fresh' }));
    expect(previewed).toContain('parent_id');
    // Nothing written: the preview is still a rolled-back transaction.
    expect((await store_.store.export()).nodes).toEqual([]);
    expect((await store_.store.export()).projects).toEqual([]);

    const applied = await errorText(store_.store.import(orphan, { dryRun: false, mode: 'fresh' }));
    expect(previewed).toBe(applied);
  } finally {
    await store_.close();
  }
});

test("an import keeps a node's annotation order, timestamps notwithstanding", async () => {
  // Document order per node is the stored fact, the same reasoning
  // `canonicalTransitionOrder` spells out. A hand-edited or backfilled
  // `## Annotations` section need not be timestamp-monotonic, and a re-export
  // that sorted by `created_at` would reorder it on the way through — after
  // which the document refuses its own resume.
  const shuffled = document({
    annotations: [
      {
        content: 'written second, stamped later',
        created_at: '2026-09-03T00:00:00.000Z',
        node_id: 'MMR-1',
      },
      {
        content: 'written third, stamped earlier',
        created_at: '2026-09-02T00:00:00.000Z',
        node_id: 'MMR-1',
      },
    ],
    nodes: [task(1)],
  });
  const store_ = await createPgliteTestStore();
  try {
    await store_.store.import(shuffled, { dryRun: false, mode: 'fresh' });
    const exported = await store_.store.export();
    expect(exported.annotations).toEqual(shuffled.annotations);

    const resumed = await store_.store.import(shuffled, { dryRun: false, mode: 'resume' });
    expect(resumed).toEqual({ applied: true, created: 0, mode: 'resume', skipped: 2 });
  } finally {
    await store_.close();
  }
});

test('a transition that omits its reason resumes as a no-op', async () => {
  // `reason` is optional on the record, so a document may OMIT it — and the
  // target stores, and re-exports, an explicit null. A resume comparing the two
  // deeply reads absent and null as different records, which made a document
  // refuse the resume of its own import (MMR-380).
  const reasonless = document({
    nodes: [task(1)],
    transitions: [
      { at: STAMP, from_value: 'todo', kind: 'lifecycle', node_id: 'MMR-1', to_value: 'active' },
    ],
  });
  const store_ = await createPgliteTestStore();
  try {
    const first = await store_.store.import(reasonless, { dryRun: false, mode: 'fresh' });
    expect(first.applied).toBe(true);
    // The project and the node are both present and identical; the transition
    // rides the node's bundle, which is the comparison that used to refuse.
    const resumed = await store_.store.import(reasonless, { dryRun: false, mode: 'resume' });
    expect(resumed).toEqual({ applied: true, created: 0, mode: 'resume', skipped: 2 });
    expect((await store_.store.export()).transitions.at(0)?.reason).toBeNull();
  } finally {
    await store_.close();
  }
});

/** One project holding `count` root tasks — the smallest document that crosses
 * the node chunk boundary. */
function wideDocument(count: number): StoreExport {
  const nodes: Node[] = [];
  for (let seq = 1; seq <= count; seq += 1) {
    nodes.push({
      branch: null,
      completed_at: null,
      created_at: STAMP,
      description: null,
      external_ref: null,
      harness: null,
      hold: null,
      hold_reason: null,
      host: null,
      id: `WIDE-${String(seq)}`,
      lifecycle: 'todo',
      open_ended: null,
      parent_id: null,
      priority: null,
      project_id: 'WIDE',
      rank: null,
      seq,
      session: null,
      size: null,
      summary: null,
      target: null,
      title: `Task ${String(seq)}`,
      type: 'task',
      updated_at: STAMP,
      upstream: null,
    });
  }
  return {
    annotations: [],
    artifacts: [],
    bodySections: [],
    edges: [],
    exported_at: STAMP,
    nodes,
    projects: [
      {
        archived_at: null,
        counters: { artifact: 0, node: count, seed: 0 },
        created_at: STAMP,
        description: null,
        key: 'WIDE',
        name: 'Wide',
        updated_at: STAMP,
      },
    ],
    schema_version: STORE_EXPORT_SCHEMA_VERSION,
    scratchpads: [],
    seeds: [],
    tags: [],
    transitions: [],
  };
}
