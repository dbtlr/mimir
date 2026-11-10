import { Database } from 'bun:sqlite';
import { expect, setDefaultTimeout, test } from 'bun:test';

import { Kysely } from 'kysely';

import { createProject } from '../create';
import type { StoreExport } from '../export';
import { STORE_EXPORT_SCHEMA_VERSION } from '../export';
import type { Node } from '../model';
import { postgresDialect, upgradeSchema as upgradePostgresSchema } from '../store-postgres/dialect';
import { createPgliteDialect } from '../store-postgres/pglite';
import { createEmptyPglite, createPgliteTestStore } from '../store-postgres/testing';
import { sqliteDialect, upgradeSchema } from '../store-sqlite/dialect';
import { createBunSqliteDialect } from '../store-sqlite/driver';
import { inLists, insertBatched, rowsPerStatement } from './batch';
import type { DB } from './schema';
import { createSqlStore } from './store';

/** SQL-store batching and representation tests. Shared import validation is covered
 * by core/transfer-validate.test.ts, and its store refusal by
 * core/store-conformance.transfer.test.ts on both backends. */

// Whole PGlite stores.
setDefaultTimeout(60_000);

test('a chunk stays under the statement bind-parameter ceiling at every row width', () => {
  // PostgreSQL binds at most 65535 parameters per statement, and a row spends
  // one per column. The widest row the import writes is a node's (~26 columns).
  for (let columns = 1; columns <= 128; columns += 1) {
    expect(rowsPerStatement(columns, 65_535) * columns).toBeLessThanOrEqual(65_535);
    expect(rowsPerStatement(columns, 65_535)).toBeGreaterThanOrEqual(1);
  }
});

test('every Postgres import and export statement binds under the dialect ceiling', async () => {
  // The low-ceiling technique of the SQLite case below, on PGlite: a full-size
  // chunk at PostgreSQL's real 65535 would take thousands of nodes, so the
  // ceiling is set low and the statements are counted instead.
  const ceiling = 500;
  const bound: number[] = [];
  let recording = false;
  const db = new Kysely<DB>({
    dialect: createPgliteDialect(await createEmptyPglite()),
    log: (event) => {
      if (recording) {
        bound.push(event.query.parameters.length);
      }
    },
  });
  try {
    await upgradePostgresSchema(db);
    recording = true;
    const store = createSqlStore(db, { ...postgresDialect, maxParameters: ceiling });
    const count = 600;
    await store.import(wideDocument(count), { dryRun: false, mode: 'fresh' });
    const exported = await store.export();

    expect(exported.nodes).toHaveLength(count);
    expect(exported.nodes.at(0)?.id).toBe('WIDE-1');
    expect(exported.nodes.at(-1)?.id).toBe(`WIDE-${String(count)}`);
    expect(exported.nodes.at(-1)?.title).toBe(`Task ${String(count)}`);
    expect(exported.projects.at(0)?.counters.node).toBe(count);
    expect(Math.max(...bound)).toBeLessThanOrEqual(ceiling);
    // As below: 600 node rows of 27 columns could never fit one statement
    // under 500, so the cap held because the work was split.
    expect(Math.max(...bound)).toBeGreaterThan(ceiling / 4);
  } finally {
    await db.destroy();
  }
});

test('every import and export statement binds under the dialect ceiling', async () => {
  // The ceiling under test is the DIALECT's, set low here, not the engine's:
  // SQLite's real limit is a build option (the system SQLite on macOS accepts
  // far more than 32766), so only a ceiling the test controls proves that the
  // inserts and the export's IN-list reads chunk under whatever it is.
  const ceiling = 500;
  const bound: number[] = [];
  const db = new Kysely<DB>({
    dialect: createBunSqliteDialect(new Database(':memory:')),
    log: (event) => {
      bound.push(event.query.parameters.length);
    },
  });
  try {
    await upgradeSchema(db);
    const store = createSqlStore(db, { ...sqliteDialect, maxParameters: ceiling });
    const count = 600;
    await store.import(wideDocument(count), { dryRun: false, mode: 'fresh' });
    const exported = await store.export();

    expect(exported.nodes).toHaveLength(count);
    expect(exported.nodes.at(-1)?.id).toBe(`WIDE-${String(count)}`);
    expect(Math.max(...bound)).toBeLessThanOrEqual(ceiling);
    // 600 node rows of 27 columns, and the export's IN list of 601 owner stems,
    // could never fit one statement under 500, so the cap held because the
    // work was split.
    expect(Math.max(...bound)).toBeGreaterThan(ceiling / 4);
  } finally {
    await db.destroy();
  }
});

test('an IN list stays under the ceiling at every per-value cost', () => {
  const values = Array.from({ length: 100_000 }, (_, index) => index);
  for (const perValue of [1, 2, 3]) {
    const lists = inLists(values, 32_766, perValue);
    expect(lists.flat()).toEqual(values);
    for (const list of lists) {
      expect(list.length * perValue).toBeLessThanOrEqual(32_766);
    }
  }
  expect(inLists([], 32_766)).toEqual([]);
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
  const ragged = insertBatched([{ a: 1, b: 2 }, { a: 1, b: 2 }, { a: 1 }], 65_535, insert);
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
    block_owner: null,
    branch: null,
    completed_at: null,
    created_at: STAMP,
    description: null,
    external_ref: null,
    grooming: 'not_groomed',
    harness: null,
    hold: 'none',
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
    worker_harness: null,
    worker_session: null,
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
        pinned: false,
        remote: null,
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

test('a resume reads a store holding a legacy remote the stored form refuses (MMR-612)', async () => {
  // Before MMR-612 a host could hold `@`, so a store may carry `b@c.com/x`,
  // which `normalizeStoredRemote` would now rewrite. A resume compares the
  // target's own remotes as stored, so a project the document does not carry
  // must not make the resume refuse or re-create anything.
  const db = new Kysely<DB>({ dialect: createBunSqliteDialect(new Database(':memory:')) });
  try {
    await upgradeSchema(db);
    const store = createSqlStore(db, sqliteDialect);
    await createProject(store, { description: null, key: 'AAA', name: 'First' });
    const exported = await store.export();

    await createProject(store, {
      description: null,
      key: 'ODD',
      name: 'Odd',
      remote: 'https://github.com/org/odd',
    });
    await db.updateTable('project').set({ remote: 'b@c.com/x' }).where('key', '=', 'ODD').execute();

    const resumed = await store.import(exported, { dryRun: false, mode: 'resume' });
    expect(resumed.created).toBe(0);
  } finally {
    await db.destroy();
  }
});

/** One project holding `count` root tasks — the smallest document that crosses
 * the node chunk boundary. */
function wideDocument(count: number): StoreExport {
  const nodes: Node[] = [];
  for (let seq = 1; seq <= count; seq += 1) {
    nodes.push({
      block_owner: null,
      branch: null,
      completed_at: null,
      created_at: STAMP,
      description: null,
      external_ref: null,
      grooming: 'not_groomed',
      harness: null,
      hold: 'none',
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
      worker_harness: null,
      worker_session: null,
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
        pinned: false,
        remote: null,
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
