import { expect, test } from 'bun:test';

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
  const key = /^([A-Z]{2,4})-\d+$/.exec(stem)?.[1];
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

test('a self-dependency resolves — it is NOT a dangling drop (acyclicity, MMR-174, owns it)', () => {
  const g = graphOf([{ dependsOn: ['MMR-2'], parent: null, stem: 'MMR-2' }]);
  const result = validate(g);
  expect(result.dropped).toEqual([]);
  expect(subgraph(g)['MMR-2']).toEqual({ dependsOn: ['MMR-2'], parent: null });
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
