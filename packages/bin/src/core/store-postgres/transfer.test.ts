import { expect, setDefaultTimeout, test } from 'bun:test';

import type { StoreExport } from '../export';
import { STORE_EXPORT_SCHEMA_VERSION } from '../export';
import type { Node } from '../model';
import { rowsPerStatement } from './batch';
import { createPgliteTestStore } from './testing';

/**
 * The Postgres-only half of the export/import contract (MMR-380) — the batched
 * write. The behavior itself is pinned by the backend-neutral conformance suite
 * (`core/store-conformance.test.ts`); what cannot live there is the CHUNKING,
 * because it is one backend's answer to one backend's bind-parameter ceiling
 * and the fixture the seam suite shares is far too small to cross it.
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
    await store_.store.import(wideDocument(count), { mode: 'fresh' });

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

const STAMP = '2026-09-01T00:00:00.000Z';

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
