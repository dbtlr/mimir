import { expect, test } from 'bun:test';

import { cycleEdges } from './cycles';
import type { GraphNode } from './cycles';

/** Nodes from `{ stem, parent, dependsOn }` refs, each keyed by its stem's project. */
function graphOf(nodes: Omit<GraphNode, 'key'>[]): GraphNode[] {
  return nodes.map((n) => ({ ...n, key: n.stem.split('-')[0] ?? '' }));
}

test('an acyclic graph with a bare-KEY root has no cycle edges', () => {
  const g = graphOf([
    { dependsOn: [], parent: 'MMR', stem: 'MMR-1' },
    { dependsOn: ['MMR-1'], parent: 'MMR-1', stem: 'MMR-2' },
  ]);
  expect(cycleEdges(g)).toEqual([]);
});

test('a self-dependency is the degenerate cycle', () => {
  const g = graphOf([{ dependsOn: ['MMR-2'], parent: null, stem: 'MMR-2' }]);
  expect(cycleEdges(g)).toEqual([{ ref: 'MMR-2', rule: 'cycle-depends-on', stem: 'MMR-2' }]);
});

test('a 3-node depends_on cycle names exactly the cycle-closing edge', () => {
  const g = graphOf([
    { dependsOn: ['MMR-2'], parent: null, stem: 'MMR-1' },
    { dependsOn: ['MMR-3'], parent: null, stem: 'MMR-2' },
    { dependsOn: ['MMR-1'], parent: null, stem: 'MMR-3' },
  ]);
  expect(cycleEdges(g)).toEqual([{ ref: 'MMR-1', rule: 'cycle-depends-on', stem: 'MMR-3' }]);
});

test('parent and depends_on cycles are reported separately, parent first', () => {
  const g = graphOf([
    { dependsOn: ['MMR-2'], parent: 'MMR-2', stem: 'MMR-1' },
    { dependsOn: ['MMR-1'], parent: 'MMR-1', stem: 'MMR-2' },
  ]);
  expect(cycleEdges(g)).toEqual([
    { ref: 'MMR-1', rule: 'cycle-parent', stem: 'MMR-2' },
    { ref: 'MMR-1', rule: 'cycle-depends-on', stem: 'MMR-2' },
  ]);
});

test('a mixed parent+depends_on path is not a cycle', () => {
  const g = graphOf([
    { dependsOn: ['MMR-2'], parent: null, stem: 'MMR-1' },
    { dependsOn: [], parent: 'MMR-1', stem: 'MMR-2' },
  ]);
  expect(cycleEdges(g)).toEqual([]);
});

test('two interlocking cycles sharing a node each name one edge', () => {
  const g = graphOf([
    { dependsOn: ['MMR-2'], parent: null, stem: 'MMR-1' },
    { dependsOn: ['MMR-1', 'MMR-3'], parent: null, stem: 'MMR-2' },
    { dependsOn: ['MMR-2'], parent: null, stem: 'MMR-3' },
  ]);
  expect(cycleEdges(g)).toEqual([
    { ref: 'MMR-1', rule: 'cycle-depends-on', stem: 'MMR-2' },
    { ref: 'MMR-2', rule: 'cycle-depends-on', stem: 'MMR-3' },
  ]);
});

test('a diamond is not a cycle — a shared descendant is a cross edge', () => {
  const g = graphOf([
    { dependsOn: ['MMR-2', 'MMR-3'], parent: null, stem: 'MMR-1' },
    { dependsOn: ['MMR-4'], parent: null, stem: 'MMR-2' },
    { dependsOn: ['MMR-4'], parent: null, stem: 'MMR-3' },
    { dependsOn: [], parent: null, stem: 'MMR-4' },
  ]);
  expect(cycleEdges(g)).toEqual([]);
});

test('the named edge is canonical — chosen by (key, seq), not input order', () => {
  const g = graphOf([
    { dependsOn: ['MMR-1'], parent: null, stem: 'MMR-2' },
    { dependsOn: ['MMR-2'], parent: null, stem: 'MMR-1' },
  ]);
  expect(cycleEdges(g)).toEqual([{ ref: 'MMR-1', rule: 'cycle-depends-on', stem: 'MMR-2' }]);
});

test('a deep acyclic chain does not overflow the stack (iterative DFS)', () => {
  const N = 100_000;
  const nodes: Omit<GraphNode, 'key'>[] = [];
  for (let i = 1; i <= N; i += 1) {
    nodes.push({
      dependsOn: i < N ? [`MMR-${String(i + 1)}`] : [],
      parent: null,
      stem: `MMR-${String(i)}`,
    });
  }
  expect(cycleEdges(graphOf(nodes))).toEqual([]);
});
