import { expect, test } from 'bun:test';

import { collapse } from '../norn/decode';
import { parseId } from './ids';
import type { NodeRefs, VaultGraph } from './store-norn';
import { validate } from './validate';

/**
 * Build a {@link VaultGraph} from node refs, mirroring production
 * `readVaultGraph`: `projectKeys` defaults to every key present among the nodes'
 * stems, so a node is orphaned only when a test deliberately omits its key.
 */
function graphOf(nodes: Omit<NodeRefs, 'key'>[], projectKeys?: string[]): VaultGraph {
  const withKey: NodeRefs[] = nodes.map((n) => ({ ...n, key: parseKey(n.stem) }));
  return { nodes: withKey, projectKeys: projectKeys ?? [...new Set(withKey.map((n) => n.key))] };
}

function parseKey(stem: string): string {
  const key = parseId(stem)?.key;
  if (key === undefined) {
    throw new Error(`test stem is not a KEY-seq: ${stem}`);
  }
  return key;
}

/** The surviving subgraph as `stem → { parent, dependsOn }` for terse assertions. */
function subgraph(g: VaultGraph): Record<string, { parent: string | null; dependsOn: string[] }> {
  const out: Record<string, { parent: string | null; dependsOn: string[] }> = {};
  for (const n of validate(g).nodes) {
    out[n.stem] = { dependsOn: n.dependsOn, parent: n.parent };
  }
  return out;
}

test('a clean graph — resolved parent + depends_on and a bare-KEY root — drops nothing', () => {
  const g = graphOf([
    { dependsOn: [], parent: 'MMR', stem: 'MMR-1' }, // root: bare project KEY, not an edge
    { dependsOn: ['MMR-1'], parent: 'MMR-1', stem: 'MMR-2' }, // both resolve
  ]);
  const result = validate(g);
  expect(result.dropped).toEqual([]);
  expect(result.nodes).toHaveLength(2);
  expect(result.projectKeys).toEqual(['MMR']);
});

test('a dangling parent drops the edge; the node survives floated to root', () => {
  const g = graphOf([{ dependsOn: [], parent: 'MMR-99', stem: 'MMR-2' }]);
  const result = validate(g);
  expect(result.dropped).toEqual([
    { kind: 'edge', ref: 'MMR-99', rule: 'dangling-parent', stem: 'MMR-2' },
  ]);
  // Node survives; its parent edge is gone (null = floats to project root).
  expect(subgraph(g)).toEqual({ 'MMR-2': { dependsOn: [], parent: null } });
});

test('a dangling depends_on drops the edge; the prereq is pruned, node survives', () => {
  const g = graphOf([{ dependsOn: ['MMR-1', 'MMR-99'], parent: null, stem: 'MMR-2' }], ['MMR']);
  // MMR-1 does not exist as a node either — both prereqs dangle.
  const result = validate(g);
  expect(result.dropped).toEqual([
    { kind: 'edge', ref: 'MMR-1', rule: 'dangling-depends-on', stem: 'MMR-2' },
    { kind: 'edge', ref: 'MMR-99', rule: 'dangling-depends-on', stem: 'MMR-2' },
  ]);
  expect(subgraph(g)['MMR-2']).toEqual({ dependsOn: [], parent: null });
});

// ── Aliased wikilink decode (MMR-190) ─────────────────────────────────────────
// `collapse` de-aliases `[[STEM|display]]` to `STEM` before the graph reaches the
// validator, so an aliased ref resolves through the SAME valid/dangling path as a
// bare wikilink — a valid target resolves; a dangling one drops with the STEM ref,
// never the `|`-laden literal (which used to slip the parseId gate and float to root).

test('an aliased parent resolves cleanly to its real target (MMR-190)', () => {
  const g = graphOf([
    { dependsOn: [], parent: 'MMR', stem: 'MMR-1' },
    { dependsOn: [], parent: collapse('[[MMR-1|Some Title]]'), stem: 'MMR-2' },
  ]);
  const result = validate(g);
  expect(result.dropped).toEqual([]);
  expect(subgraph(g)['MMR-2']).toEqual({ dependsOn: [], parent: 'MMR-1' });
});

test('a dangling aliased parent drops with the de-aliased ref, not the |-literal (MMR-190)', () => {
  const g = graphOf([{ dependsOn: [], parent: collapse('[[MMR-99|Some Title]]'), stem: 'MMR-2' }]);
  const result = validate(g);
  expect(result.dropped).toEqual([
    { kind: 'edge', ref: 'MMR-99', rule: 'dangling-parent', stem: 'MMR-2' },
  ]);
  expect(subgraph(g)).toEqual({ 'MMR-2': { dependsOn: [], parent: null } });
});

test('a dangling aliased depends_on drops with the de-aliased ref (MMR-190)', () => {
  const g = graphOf(
    [{ dependsOn: [collapse('[[MMR-99|Some Title]]') ?? ''], parent: null, stem: 'MMR-2' }],
    ['MMR'],
  );
  const result = validate(g);
  expect(result.dropped).toEqual([
    { kind: 'edge', ref: 'MMR-99', rule: 'dangling-depends-on', stem: 'MMR-2' },
  ]);
  expect(subgraph(g)['MMR-2']).toEqual({ dependsOn: [], parent: null });
});

test('a doubled depends_on is collapsed to one edge — matching the loader (SQLite PK)', () => {
  const g = graphOf(
    [
      { dependsOn: ['MMR-1', 'MMR-1'], parent: null, stem: 'MMR-2' }, // resolved, doubled
      { dependsOn: [], parent: null, stem: 'MMR-1' },
    ],
    ['MMR'],
  );
  const result = validate(g);
  expect(result.dropped).toEqual([]);
  expect(subgraph(g)['MMR-2']).toEqual({ dependsOn: ['MMR-1'], parent: null }); // one edge, not two
});

test('a doubled *dangling* depends_on yields exactly one drop, not two', () => {
  const g = graphOf([{ dependsOn: ['MMR-99', 'MMR-99'], parent: null, stem: 'MMR-2' }], ['MMR']);
  const result = validate(g);
  expect(result.dropped).toEqual([
    { kind: 'edge', ref: 'MMR-99', rule: 'dangling-depends-on', stem: 'MMR-2' },
  ]);
});

test('a self-dependency is the degenerate cycle — dropped by acyclicity (MMR-174)', () => {
  const g = graphOf([{ dependsOn: ['MMR-2'], parent: null, stem: 'MMR-2' }]);
  const result = validate(g);
  expect(result.dropped).toEqual([
    { kind: 'edge', ref: 'MMR-2', rule: 'cycle-depends-on', stem: 'MMR-2' },
  ]);
  expect(subgraph(g)['MMR-2']).toEqual({ dependsOn: [], parent: null });
});

test('a bare-project-KEY parent is a root marker, never a dropped edge', () => {
  const g = graphOf([{ dependsOn: [], parent: 'MMR', stem: 'MMR-1' }]);
  expect(validate(g).dropped).toEqual([]);
  // The root marker is preserved verbatim; the reader reads a non-KEY-seq parent as root.
  expect(subgraph(g)['MMR-1']).toEqual({ dependsOn: [], parent: 'MMR' });
});

test('a node whose project has no document is dropped (missing container)', () => {
  const g = graphOf([{ dependsOn: [], parent: null, stem: 'MMR-2' }], []); // project MMR absent
  const result = validate(g);
  expect(result.dropped).toEqual([
    { key: 'MMR', kind: 'node', rule: 'missing-project', stem: 'MMR-2' },
  ]);
  expect(result.nodes).toEqual([]); // hidden
});

test('every node under a missing project is dropped — one node-drop each', () => {
  const g = graphOf(
    [
      { dependsOn: [], parent: null, stem: 'MMR-2' },
      { dependsOn: [], parent: null, stem: 'MMR-3' },
    ],
    [], // MMR absent
  );
  const result = validate(g);
  expect(result.dropped).toEqual([
    { key: 'MMR', kind: 'node', rule: 'missing-project', stem: 'MMR-2' },
    { key: 'MMR', kind: 'node', rule: 'missing-project', stem: 'MMR-3' },
  ]);
  expect(result.nodes).toEqual([]);
});

test('cascade: a depends_on pointing at a node hidden by a missing project drops', () => {
  // OTH-1 depends on MMR-2, but project MMR is absent → MMR-2 is dropped, so the
  // edge OTH-1 → MMR-2 dangles against the SURVIVING set. Two parallel detectors
  // could not see this; one validator does.
  const g = graphOf(
    [
      { dependsOn: ['MMR-2'], parent: null, stem: 'OTH-1' },
      { dependsOn: [], parent: null, stem: 'MMR-2' },
    ],
    ['OTH'], // MMR absent
  );
  const result = validate(g);
  expect(result.dropped).toEqual([
    { key: 'MMR', kind: 'node', rule: 'missing-project', stem: 'MMR-2' },
    { kind: 'edge', ref: 'MMR-2', rule: 'dangling-depends-on', stem: 'OTH-1' },
  ]);
  expect(subgraph(g)).toEqual({ 'OTH-1': { dependsOn: [], parent: null } });
});

test('cascade: a parent pointing at a node hidden by a missing project drops', () => {
  const g = graphOf(
    [
      { dependsOn: [], parent: 'MMR-1', stem: 'OTH-2' },
      { dependsOn: [], parent: null, stem: 'MMR-1' },
    ],
    ['OTH'], // MMR absent → MMR-1 hidden
  );
  const result = validate(g);
  expect(result.dropped).toEqual([
    { key: 'MMR', kind: 'node', rule: 'missing-project', stem: 'MMR-1' },
    { kind: 'edge', ref: 'MMR-1', rule: 'dangling-parent', stem: 'OTH-2' },
  ]);
  expect(subgraph(g)).toEqual({ 'OTH-2': { dependsOn: [], parent: null } });
});

test('a missing-project node with its own dangling parent yields only the node-drop', () => {
  // The node is hidden, so its dangling parent edge is moot — no separate edge drop.
  const g = graphOf([{ dependsOn: [], parent: 'MMR-99', stem: 'MMR-2' }], []); // MMR absent
  const result = validate(g);
  expect(result.dropped).toEqual([
    { key: 'MMR', kind: 'node', rule: 'missing-project', stem: 'MMR-2' },
  ]);
  expect(result.nodes).toEqual([]);
});

// ── Acyclicity (MMR-174) ──────────────────────────────────────────────────────
// The cycle pass runs over the surviving subgraph, breaking every `parent` and
// `depends_on` cycle by dropping its back edge (the edge that closes the cycle in
// a canonical `(key, seq)` DFS). The two relations are broken independently.

test('a 2-node depends_on cycle drops the back edge; the forward edge survives', () => {
  const g = graphOf([
    { dependsOn: ['MMR-2'], parent: null, stem: 'MMR-1' },
    { dependsOn: ['MMR-1'], parent: null, stem: 'MMR-2' },
  ]);
  const result = validate(g);
  // Canonical order MMR-1, MMR-2: the DFS reaches MMR-1 (on the stack) via MMR-2.
  expect(result.dropped).toEqual([
    { kind: 'edge', ref: 'MMR-1', rule: 'cycle-depends-on', stem: 'MMR-2' },
  ]);
  expect(subgraph(g)).toEqual({
    'MMR-1': { dependsOn: ['MMR-2'], parent: null },
    'MMR-2': { dependsOn: [], parent: null },
  });
});

test('a 3-node depends_on cycle drops exactly the cycle-closing edge', () => {
  const g = graphOf([
    { dependsOn: ['MMR-2'], parent: null, stem: 'MMR-1' },
    { dependsOn: ['MMR-3'], parent: null, stem: 'MMR-2' },
    { dependsOn: ['MMR-1'], parent: null, stem: 'MMR-3' },
  ]);
  const result = validate(g);
  expect(result.dropped).toEqual([
    { kind: 'edge', ref: 'MMR-1', rule: 'cycle-depends-on', stem: 'MMR-3' },
  ]);
  expect(subgraph(g)).toEqual({
    'MMR-1': { dependsOn: ['MMR-2'], parent: null },
    'MMR-2': { dependsOn: ['MMR-3'], parent: null },
    'MMR-3': { dependsOn: [], parent: null },
  });
});

test('a 2-node parent cycle drops the back edge; the node floats to root', () => {
  const g = graphOf([
    { dependsOn: [], parent: 'MMR-2', stem: 'MMR-1' },
    { dependsOn: [], parent: 'MMR-1', stem: 'MMR-2' },
  ]);
  const result = validate(g);
  expect(result.dropped).toEqual([
    { kind: 'edge', ref: 'MMR-1', rule: 'cycle-parent', stem: 'MMR-2' },
  ]);
  expect(subgraph(g)).toEqual({
    'MMR-1': { dependsOn: [], parent: 'MMR-2' },
    'MMR-2': { dependsOn: [], parent: null }, // dropped parent → floats to root
  });
});

test('a 3-node parent cycle drops exactly the cycle-closing parent edge', () => {
  const g = graphOf([
    { dependsOn: [], parent: 'MMR-2', stem: 'MMR-1' },
    { dependsOn: [], parent: 'MMR-3', stem: 'MMR-2' },
    { dependsOn: [], parent: 'MMR-1', stem: 'MMR-3' },
  ]);
  const result = validate(g);
  expect(result.dropped).toEqual([
    { kind: 'edge', ref: 'MMR-1', rule: 'cycle-parent', stem: 'MMR-3' },
  ]);
  expect(subgraph(g)).toEqual({
    'MMR-1': { dependsOn: [], parent: 'MMR-2' },
    'MMR-2': { dependsOn: [], parent: 'MMR-3' },
    'MMR-3': { dependsOn: [], parent: null },
  });
});

test('parent and depends_on cycles are broken independently (both drop)', () => {
  // A parent cycle over MMR-1/MMR-2 AND a depends_on cycle over the same pair —
  // two relations, two independent back-edge drops. Parent pass runs first.
  const g = graphOf([
    { dependsOn: ['MMR-2'], parent: 'MMR-2', stem: 'MMR-1' },
    { dependsOn: ['MMR-1'], parent: 'MMR-1', stem: 'MMR-2' },
  ]);
  const result = validate(g);
  expect(result.dropped).toEqual([
    { kind: 'edge', ref: 'MMR-1', rule: 'cycle-parent', stem: 'MMR-2' },
    { kind: 'edge', ref: 'MMR-1', rule: 'cycle-depends-on', stem: 'MMR-2' },
  ]);
  expect(subgraph(g)).toEqual({
    'MMR-1': { dependsOn: ['MMR-2'], parent: 'MMR-2' },
    'MMR-2': { dependsOn: [], parent: null },
  });
});

test('a mixed parent+depends_on path is NOT a cycle — nothing is dropped', () => {
  // MMR-1 --depends_on--> MMR-2 --parent--> MMR-1 traverses two DIFFERENT
  // relations, so neither the parent DFS nor the depends_on DFS sees a cycle.
  const g = graphOf([
    { dependsOn: ['MMR-2'], parent: null, stem: 'MMR-1' },
    { dependsOn: [], parent: 'MMR-1', stem: 'MMR-2' },
  ]);
  const result = validate(g);
  expect(result.dropped).toEqual([]);
  expect(subgraph(g)).toEqual({
    'MMR-1': { dependsOn: ['MMR-2'], parent: null },
    'MMR-2': { dependsOn: [], parent: 'MMR-1' },
  });
});

test('two interlocking depends_on cycles sharing a node — both broken, minimally', () => {
  // Cycles MMR-1↔MMR-2 and MMR-2↔MMR-3 share node MMR-2 but no edge. A minimal
  // feedback set is 2 edges; the canonical DFS drops exactly the two back edges.
  const g = graphOf([
    { dependsOn: ['MMR-2'], parent: null, stem: 'MMR-1' },
    { dependsOn: ['MMR-1', 'MMR-3'], parent: null, stem: 'MMR-2' },
    { dependsOn: ['MMR-2'], parent: null, stem: 'MMR-3' },
  ]);
  const result = validate(g);
  expect(result.dropped).toEqual([
    { kind: 'edge', ref: 'MMR-1', rule: 'cycle-depends-on', stem: 'MMR-2' },
    { kind: 'edge', ref: 'MMR-2', rule: 'cycle-depends-on', stem: 'MMR-3' },
  ]);
  expect(subgraph(g)).toEqual({
    'MMR-1': { dependsOn: ['MMR-2'], parent: null },
    'MMR-2': { dependsOn: ['MMR-3'], parent: null }, // MMR-1 back edge pruned
    'MMR-3': { dependsOn: [], parent: null }, // MMR-2 back edge pruned
  });
});

test('a diamond depends_on DAG is not a cycle — a shared descendant drops nothing', () => {
  // MMR-1 → {MMR-2, MMR-3} → MMR-4. MMR-4 is reached twice but is never on the
  // DFS stack when re-reached (a cross edge, not a back edge) — no drop.
  const g = graphOf([
    { dependsOn: ['MMR-2', 'MMR-3'], parent: null, stem: 'MMR-1' },
    { dependsOn: ['MMR-4'], parent: null, stem: 'MMR-2' },
    { dependsOn: ['MMR-4'], parent: null, stem: 'MMR-3' },
    { dependsOn: [], parent: null, stem: 'MMR-4' },
  ]);
  const result = validate(g);
  expect(result.dropped).toEqual([]);
  expect(subgraph(g)['MMR-4']).toEqual({ dependsOn: [], parent: null });
});

test('a deep acyclic chain does not overflow the stack (iterative DFS, ADR 0017)', () => {
  // A linear depends_on chain far deeper than the JS recursion limit: MMR-1 →
  // MMR-2 → … → MMR-N. A recursive DFS would throw RangeError here and crash the
  // never-throw read path; the iterative traversal must handle it and, since the
  // chain is acyclic, drop nothing.
  const N = 100_000;
  const nodes: Omit<NodeRefs, 'key'>[] = [];
  for (let i = 1; i <= N; i += 1) {
    nodes.push({
      dependsOn: i < N ? [`MMR-${String(i + 1)}`] : [],
      parent: null,
      stem: `MMR-${String(i)}`,
    });
  }
  const result = validate(graphOf(nodes));
  expect(result.dropped).toEqual([]);
  expect(result.nodes).toHaveLength(N);
});

test('the dropped back edge is canonical — chosen by (key, seq), not input order', () => {
  // Same 2-cycle as above but with the nodes supplied in REVERSED input order.
  // The DFS visits in canonical (key, seq) order, so the SAME edge is dropped —
  // determinism is a property of the graph, not of how the nodes arrived.
  const g = graphOf([
    { dependsOn: ['MMR-1'], parent: null, stem: 'MMR-2' },
    { dependsOn: ['MMR-2'], parent: null, stem: 'MMR-1' },
  ]);
  const result = validate(g);
  expect(result.dropped).toEqual([
    { kind: 'edge', ref: 'MMR-1', rule: 'cycle-depends-on', stem: 'MMR-2' },
  ]);
});

// ── Field validity (MMR-177) ──────────────────────────────────────────────────
// Pass 0, run BEFORE the referential passes so node-drops cascade. Task-only, and
// skipped when a node carries no `raw` (referential-only callers), so every test
// above stays green. A load-bearing field (lifecycle/hold) missing or foreign
// drops the NODE; an optional field (priority/size) foreign drops just the FIELD.

const validRaw = { hold: undefined, lifecycle: 'todo', priority: undefined, size: undefined };

test('a task missing its lifecycle is dropped — the node is hidden (invalid-lifecycle)', () => {
  const g = graphOf([
    {
      dependsOn: [],
      parent: null,
      raw: { ...validRaw, lifecycle: undefined },
      stem: 'MMR-1',
      type: 'task',
    },
  ]);
  const result = validate(g);
  expect(result.dropped).toEqual([
    { key: 'MMR', kind: 'node', rule: 'invalid-lifecycle', stem: 'MMR-1', value: null },
  ]);
  expect(result.nodes).toEqual([]); // hidden, like a missing-project node
});

test('a task with a foreign lifecycle is dropped — the offending value is carried', () => {
  const g = graphOf([
    {
      dependsOn: [],
      parent: null,
      raw: { ...validRaw, lifecycle: 'bogus' },
      stem: 'MMR-1',
      type: 'task',
    },
  ]);
  const result = validate(g);
  expect(result.dropped).toEqual([
    { key: 'MMR', kind: 'node', rule: 'invalid-lifecycle', stem: 'MMR-1', value: 'bogus' },
  ]);
  expect(result.nodes).toEqual([]);
});

test('a task with a foreign hold is dropped (hold drives blocked/parked — no safe coercion)', () => {
  const g = graphOf([
    {
      dependsOn: [],
      parent: null,
      raw: { ...validRaw, hold: 'bogus' },
      stem: 'MMR-1',
      type: 'task',
    },
  ]);
  const result = validate(g);
  expect(result.dropped).toEqual([
    { key: 'MMR', kind: 'node', rule: 'invalid-hold', stem: 'MMR-1', value: 'bogus' },
  ]);
  expect(result.nodes).toEqual([]);
});

test('a task with a foreign priority keeps the node — only the field is dropped', () => {
  const g = graphOf([
    {
      dependsOn: [],
      parent: null,
      raw: { ...validRaw, priority: 'p9' },
      stem: 'MMR-1',
      type: 'task',
    },
  ]);
  const result = validate(g);
  expect(result.dropped).toEqual([
    { kind: 'field', rule: 'invalid-priority', stem: 'MMR-1', value: 'p9' },
  ]);
  expect(subgraph(g)).toEqual({ 'MMR-1': { dependsOn: [], parent: null } }); // node survives
});

test('a task with a foreign size keeps the node — only the field is dropped', () => {
  const g = graphOf([
    {
      dependsOn: [],
      parent: null,
      raw: { ...validRaw, size: 'huge' },
      stem: 'MMR-1',
      type: 'task',
    },
  ]);
  const result = validate(g);
  expect(result.dropped).toEqual([
    { kind: 'field', rule: 'invalid-size', stem: 'MMR-1', value: 'huge' },
  ]);
  expect(subgraph(g)).toEqual({ 'MMR-1': { dependsOn: [], parent: null } });
});

test('a null (or absent) priority/size is a truthful unset — not foreign, no drop', () => {
  // A hand edit can write `priority: null`. The reader maps null and absent
  // identically to a null field, so validate must NOT flag it — else doctor
  // reports a drop the reader never made (the "one validator, two views" drift).
  const g = graphOf([
    {
      dependsOn: [],
      parent: null,
      raw: { hold: undefined, lifecycle: 'todo', priority: null, size: null },
      stem: 'MMR-1',
      type: 'task',
    },
  ]);
  const result = validate(g);
  expect(result.dropped).toEqual([]);
  expect(subgraph(g)).toEqual({ 'MMR-1': { dependsOn: [], parent: null } });
});

test('a foreign priority on a node whose project is missing yields only the node-drop', () => {
  // The node is container-dropped (pass 1), so it never loads — its optional field
  // is never read, and must not raise a second, misleading field finding.
  const g = graphOf(
    [
      {
        dependsOn: [],
        parent: null,
        raw: { ...validRaw, priority: 'p9' },
        stem: 'MMR-1',
        type: 'task',
      },
    ],
    [], // project MMR absent
  );
  const result = validate(g);
  expect(result.dropped).toEqual([
    { key: 'MMR', kind: 'node', rule: 'missing-project', stem: 'MMR-1' },
  ]);
  expect(result.nodes).toEqual([]);
});

test('a non-string foreign field value renders cleanly (no [object Object])', () => {
  const g = graphOf([
    {
      dependsOn: [],
      parent: null,
      raw: { ...validRaw, priority: 3, size: { nested: true } },
      stem: 'MMR-1',
      type: 'task',
    },
  ]);
  const result = validate(g);
  expect(result.dropped).toEqual([
    { kind: 'field', rule: 'invalid-priority', stem: 'MMR-1', value: '3' },
    { kind: 'field', rule: 'invalid-size', stem: 'MMR-1', value: '{"nested":true}' },
  ]);
});

test('a task with all valid fields drops nothing', () => {
  const g = graphOf([
    {
      dependsOn: [],
      parent: null,
      raw: { hold: 'blocked', lifecycle: 'in_progress', priority: 'p1', size: 'medium' },
      stem: 'MMR-1',
      type: 'task',
    },
  ]);
  const result = validate(g);
  expect(result.dropped).toEqual([]);
  expect(result.nodes).toHaveLength(1);
});

test('field validity is task-only — a non-task node with foreign enums is not checked', () => {
  // A phase carries frontmatter that would be foreign FOR A TASK, but none of the
  // four is a task-only column here, so the field pass skips it and it survives.
  const g = graphOf([
    {
      dependsOn: [],
      parent: null,
      raw: { hold: 'bogus', lifecycle: 'bogus', priority: 'bogus', size: 'bogus' },
      stem: 'MMR-1',
      type: 'phase',
    },
  ]);
  const result = validate(g);
  expect(result.dropped).toEqual([]);
  expect(result.nodes).toHaveLength(1);
});

test('a node dropped for lifecycle cascades — a dependent edge dangles (like missing-project)', () => {
  const g = graphOf([
    {
      dependsOn: [],
      parent: null,
      raw: { ...validRaw, lifecycle: undefined },
      stem: 'MMR-1',
      type: 'task',
    }, // dropped
    { dependsOn: ['MMR-1'], parent: null, raw: validRaw, stem: 'MMR-2', type: 'task' }, // depends on the dropped node
  ]);
  const result = validate(g);
  expect(result.dropped).toEqual([
    { key: 'MMR', kind: 'node', rule: 'invalid-lifecycle', stem: 'MMR-1', value: null },
    { kind: 'edge', ref: 'MMR-1', rule: 'dangling-depends-on', stem: 'MMR-2' },
  ]);
  expect(subgraph(g)).toEqual({ 'MMR-2': { dependsOn: [], parent: null } });
});

test('cycle drops are appended AFTER the pass-1/pass-2 drops', () => {
  // A missing-project node-drop, a dangling depends_on edge-drop, and a cycle: the
  // dropped[] order is node-drops, then dangling edges, then cycle back edges.
  const g = graphOf(
    [
      { dependsOn: ['MMR-2', 'MMR-99'], parent: null, stem: 'MMR-1' }, // MMR-99 dangles
      { dependsOn: ['MMR-1'], parent: null, stem: 'MMR-2' }, // closes a cycle with MMR-1
      { dependsOn: [], parent: null, stem: 'ZZZ-1' }, // project ZZZ absent
    ],
    ['MMR'], // ZZZ omitted
  );
  const result = validate(g);
  expect(result.dropped).toEqual([
    { key: 'ZZZ', kind: 'node', rule: 'missing-project', stem: 'ZZZ-1' },
    { kind: 'edge', ref: 'MMR-99', rule: 'dangling-depends-on', stem: 'MMR-1' },
    { kind: 'edge', ref: 'MMR-1', rule: 'cycle-depends-on', stem: 'MMR-2' },
  ]);
});

test('a container with a foreign open_ended keeps the node — only the field is dropped', () => {
  const g = graphOf([
    {
      dependsOn: [],
      parent: null,
      raw: { ...validRaw, open_ended: 'yes' },
      stem: 'MMR-1',
      type: 'phase',
    },
  ]);
  const result = validate(g);
  expect(result.dropped).toEqual([
    { kind: 'field', rule: 'invalid-open-ended', stem: 'MMR-1', value: 'yes' },
  ]);
  expect(subgraph(g)).toEqual({ 'MMR-1': { dependsOn: [], parent: null } }); // node survives
});

test("a container's 'true'/'false' open_ended is valid — no drop", () => {
  const g = graphOf([
    {
      dependsOn: [],
      parent: null,
      raw: { ...validRaw, open_ended: 'true' },
      stem: 'MMR-1',
      type: 'initiative',
    },
    {
      dependsOn: [],
      parent: null,
      raw: { ...validRaw, open_ended: 'false' },
      stem: 'MMR-2',
      type: 'phase',
    },
  ]);
  expect(validate(g).dropped).toEqual([]);
});

test('an absent/null open_ended is a truthful unset — not foreign, no drop', () => {
  const g = graphOf([
    {
      dependsOn: [],
      parent: null,
      raw: { ...validRaw, open_ended: null },
      stem: 'MMR-1',
      type: 'phase',
    },
    { dependsOn: [], parent: null, raw: validRaw, stem: 'MMR-2', type: 'initiative' },
  ]);
  expect(validate(g).dropped).toEqual([]);
});
