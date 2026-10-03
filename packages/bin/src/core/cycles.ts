/**
 * Relational cycle detection (MMR-174) over the work hierarchy's two node
 * relations, `parent` and `depends_on`. The store refuses a cycle on every
 * write path, but a transfer document is untrusted input, so import asks this
 * module for the cycle-closing edges and refuses the document when there are
 * any (`transfer-validate.ts`).
 */
import { parseId } from './ids';

/** One node's relational refs — its stem, project `key`, and parent + prerequisite stems. */
export type GraphNode = {
  stem: string;
  key: string;
  /** A `KEY-seq` parent is an edge; a bare project `KEY` or null is a root marker. */
  parent: string | null;
  dependsOn: readonly string[];
};

/** One cycle-closing edge: `stem` reaches `ref`, which was already on the path. */
export type CycleEdge = {
  rule: 'cycle-parent' | 'cycle-depends-on';
  stem: string;
  ref: string;
};

/**
 * Every cycle-closing edge in the graph: the `parent` relation first, then
 * `depends_on`. The relations are detected separately — a path mixing `parent`
 * and `depends_on` is not a cycle.
 */
export function cycleEdges(nodes: readonly GraphNode[]): CycleEdge[] {
  return [
    ...backEdges(nodes, 'parent').map(({ from, to }) => ({
      ref: to,
      rule: 'cycle-parent' as const,
      stem: from,
    })),
    ...backEdges(nodes, 'depends-on').map(({ from, to }) => ({
      ref: to,
      rule: 'cycle-depends-on' as const,
      stem: from,
    })),
  ];
}

/**
 * The back edges of one relation, in DFS-discovery order.
 *
 * A single DFS over the nodes in canonical `(key, seq)` order, following each
 * node's out-edges in listed order. When traversal reaches a node already on
 * the DFS stack, the edge that reached it *closes a cycle* — a back edge; an
 * edge into an already-finished node is a forward/cross edge and is not.
 * Removing every back edge yields a DAG, so the set names every cycle (nested
 * and interlocking included) with one edge per cycle, fixed by the visit
 * order rather than the order the nodes arrived in. A self-dependency (A → A)
 * is the degenerate length-1 cycle: A is on the stack when its own out-edge is
 * examined.
 */
function backEdges(
  nodes: readonly GraphNode[],
  relation: 'parent' | 'depends-on',
): { from: string; to: string }[] {
  const byStem = new Map(nodes.map((n) => [n.stem, n]));
  // Stems are `KEY-seq` here (the transfer schema admits nothing else), so the
  // seq parse always succeeds — the `?? 0` is a type guard, not a fallback.
  const order = nodes.toSorted((a, b) => {
    if (a.key !== b.key) {
      return a.key < b.key ? -1 : 1;
    }
    return (parseId(a.stem)?.seq ?? 0) - (parseId(b.stem)?.seq ?? 0);
  });

  const edgesOf = (stem: string): readonly string[] => {
    const node = byStem.get(stem);
    if (node === undefined) {
      return [];
    }
    if (relation === 'parent') {
      return node.parent !== null && parseId(node.parent) !== null ? [node.parent] : [];
    }
    // A transfer document may list one prerequisite twice; one edge reports once.
    return [...new Set(node.dependsOn)];
  };

  // Three-color DFS: white = unvisited, gray = on the current stack, black = done.
  // Iterative with an explicit frame stack — NOT recursion — so a deep but valid
  // chain (a long linear `depends_on`/`parent` graph) cannot overflow the JS
  // call stack.
  const color = new Map<string, 'gray' | 'black'>();
  const found: { from: string; to: string }[] = [];
  for (const root of order) {
    if (color.get(root.stem) !== undefined) {
      continue;
    }
    color.set(root.stem, 'gray');
    const stack: { stem: string; edges: readonly string[]; cursor: number }[] = [
      { cursor: 0, edges: edgesOf(root.stem), stem: root.stem },
    ];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) {
        break;
      }
      if (frame.cursor >= frame.edges.length) {
        color.set(frame.stem, 'black');
        stack.pop();
        continue;
      }
      const to = frame.edges[frame.cursor];
      frame.cursor += 1;
      if (to === undefined) {
        continue;
      }
      const seen = color.get(to);
      if (seen === 'gray') {
        found.push({ from: frame.stem, to });
      } else if (seen === undefined) {
        color.set(to, 'gray');
        stack.push({ cursor: 0, edges: edgesOf(to), stem: to });
      }
    }
  }
  return found;
}
