/**
 * The shared graph validator (MMR-180, ADR 0017) — the single source of truth
 * for what is *invalid* in a Norn-backed vault. Under ADR 0016 the durable
 * record is hand-editable markdown with no database enforcing integrity, so
 * corruption (a dangling reference, a missing project) is a real possibility. A
 * fail-loud reader turns one bad record into a total outage; instead the reader
 * (MMR-181) consumes {@link validate}'s **valid subgraph** and never throws, and
 * `mimir doctor` (MMR-182) renders its {@link Drop}s. One validator, two views —
 * never two parallel detectors that can drift.
 *
 * This validator owns the *referential* rules — the corruptions the resolving
 * loader ({@link loadNornSnapshot}) would otherwise mishandle: a node whose owning
 * project has no document (missing container), a `parent`/`depends_on` that
 * resolves to no surviving node (dangling edge), and a `parent`/`depends_on` cycle
 * (acyclicity, MMR-174 — including the degenerate self-dependency the loader once
 * threw on at `prereqId === n.id`). One throw class remains NOT yet covered and
 * slots in later as a further rule over the same seam: a field-malformed node
 * (MMR-177 — a task missing its `lifecycle`, or a foreign enum value). Until that
 * lands the valid subgraph can still contain such a node, so the tolerant reader
 * (MMR-181) must account for that throw class itself (or depend on MMR-177) — this
 * validator alone does not yet make the read throw-free.
 */
import { parseId } from './ids';
import type { NodeRefs, VaultGraph } from './store-norn';

/**
 * One dropped element, with the reason it was dropped — doctor's source of
 * truth. A `node` drop hides the node entirely (its container is missing); an
 * `edge` drop loosens one relation (the node stays, floated to root for a
 * `parent`, or minus one prereq for a `depends_on`).
 */
export type Drop =
  | { kind: 'node'; rule: 'missing-project'; stem: string; key: string }
  | { kind: 'edge'; rule: 'dangling-parent'; stem: string; ref: string }
  | { kind: 'edge'; rule: 'dangling-depends-on'; stem: string; ref: string }
  | { kind: 'edge'; rule: 'cycle-parent'; stem: string; ref: string }
  | { kind: 'edge'; rule: 'cycle-depends-on'; stem: string; ref: string };

/**
 * The result of validation: the valid, self-consistent subgraph the reader
 * consumes, plus the {@link Drop}s doctor renders. `nodes` holds only surviving
 * nodes — those whose project is present — each with its edges pruned to the
 * survivors (a dropped `parent` becomes `null`, floating the node to its project
 * root; a dropped `depends_on` is removed). `projectKeys` is carried through
 * unchanged.
 */
export type ValidatedGraph = {
  nodes: NodeRefs[];
  projectKeys: string[];
  dropped: Drop[];
};

/**
 * Validate the raw relational graph into a valid subgraph + the drops that got
 * it there. Two passes over the nodes, in input order:
 *
 * 1. **Missing container.** A node whose project `key` is absent from
 *    `projectKeys` has no valid place to live — it is dropped (a `node` drop) and
 *    excluded from the surviving set. This subsumes the standalone missing-project
 *    detector (MMR-178).
 * 2. **Dangling edges.** For each *surviving* node, a `parent` that is a `KEY-seq`
 *    resolving to no survivor drops (the node floats to root); each `depends_on`
 *    resolving to no survivor drops (the prereq is pruned). Resolving against the
 *    *survivors* — not the raw set — is what makes the cascade correct: an edge
 *    pointing at a node hidden by rule 1 drops too. This subsumes the standalone
 *    dangling-reference detector (MMR-169). A self-dependency resolves (its target
 *    survives) and is left for the acyclicity rule (rule 3); a bare project `KEY`
 *    parent is a root marker, not an edge, and is preserved verbatim.
 * 3. **Cycles (acyclicity, MMR-174).** Over the surviving subgraph — whose edges
 *    are already pruned by rule 2, so acyclicity sees only real edges — break every
 *    `parent` and `depends_on` cycle by dropping its back edge (see
 *    {@link breakCycles}). The two relations are broken independently (a mixed
 *    parent+depends_on path is not a cycle), parent first. A dropped `parent` back
 *    edge nulls the node's parent (floats to root, like a dangling parent); a
 *    dropped `depends_on` back edge is pruned from the prereq list. A
 *    self-dependency is the degenerate length-1 cycle, dropped the same way. Cycle
 *    drops append AFTER the pass-1/pass-2 drops, so a cycle-free vault is
 *    unaffected.
 */
export function validate(graph: VaultGraph): ValidatedGraph {
  const present = new Set(graph.projectKeys);
  const survivors = new Set<string>();
  const dropped: Drop[] = [];

  // Pass 1: partition nodes by container presence. A missing project hides the
  // node; the rest are the surviving set every edge resolves against.
  const kept: NodeRefs[] = [];
  for (const node of graph.nodes) {
    if (present.has(node.key)) {
      survivors.add(node.stem);
      kept.push(node);
    } else {
      dropped.push({ key: node.key, kind: 'node', rule: 'missing-project', stem: node.stem });
    }
  }

  // Pass 2: validate each survivor's edges against the surviving set.
  const nodes: NodeRefs[] = kept.map((node) => {
    // parent: only a `KEY-seq` is an edge; a bare project `KEY` (or null) is a
    // root marker, preserved verbatim so the reader reads it as parent_id = null.
    let parent = node.parent;
    if (parent !== null && parseId(parent) !== null && !survivors.has(parent)) {
      dropped.push({ kind: 'edge', ref: parent, rule: 'dangling-parent', stem: node.stem });
      parent = null;
    }

    // Dedup by stem, mirroring the loader's collapse to SQLite's
    // (node_id, depends_on_node_id) primary key — a doubled wikilink is one edge.
    // Deduping here (not in the reader) keeps the valid subgraph the single truth:
    // a doubled prereq yields one output edge and, when dangling, one drop.
    const dependsOn: string[] = [];
    const seen = new Set<string>();
    for (const ref of node.dependsOn) {
      if (seen.has(ref)) {
        continue;
      }
      seen.add(ref);
      if (survivors.has(ref)) {
        dependsOn.push(ref);
      } else {
        dropped.push({ kind: 'edge', ref, rule: 'dangling-depends-on', stem: node.stem });
      }
    }

    return { dependsOn, key: node.key, parent, stem: node.stem };
  });

  // Pass 3: break relational cycles in the surviving subgraph. The two relations
  // are independent, parent first — the drop order within the cycle pass.
  breakCycles(nodes, 'parent', dropped);
  breakCycles(nodes, 'depends-on', dropped);

  return { dropped, nodes, projectKeys: graph.projectKeys };
}

/**
 * Break every cycle in one relation of the surviving subgraph (acyclicity,
 * MMR-174, ADR 0017) by dropping its cycle-closing (back) edge, mutating `nodes`
 * in place and appending a {@link Drop} per broken edge to `dropped`.
 *
 * A single DFS over the survivors in the loader's stable `(key, seq)` order,
 * following each node's out-edges in frontmatter order (`depends_on` as listed
 * post-dedup; `parent` is the single edge, and only a `KEY-seq` parent is an edge
 * — a bare project `KEY` root marker is skipped). When traversal reaches a node
 * already on the DFS stack, the edge that reached it *closes a cycle* → it is the
 * back edge and is dropped; an edge into an already-finished node is a
 * forward/cross edge and is kept. Removing every back edge yields a DAG — this
 * breaks every cycle (nested and interlocking included) with a minimal edge set,
 * deterministic given the fixed visit + out-edge order. A self-dependency (A → A)
 * is the degenerate length-1 cycle: A is on the stack when its own out-edge is
 * examined, so the self-edge is a back edge, dropped the same way. The relations
 * are detected SEPARATELY — a path mixing `parent` and `depends_on` is not a cycle.
 */
function breakCycles(nodes: NodeRefs[], relation: 'parent' | 'depends-on', dropped: Drop[]): void {
  const byStem = new Map(nodes.map((n) => [n.stem, n]));
  // Canonical visit order: `(key, seq)`, matching the loader's node allocation, so
  // the chosen back edge — and thus the surviving subgraph — is deterministic
  // regardless of the raw document order the graph arrived in.
  const order = [...nodes].toSorted((a, b) => {
    if (a.key !== b.key) {
      return a.key < b.key ? -1 : 1;
    }
    return (parseId(a.stem)?.seq ?? 0) - (parseId(b.stem)?.seq ?? 0);
  });

  const outEdges = (node: NodeRefs): string[] => {
    if (relation === 'parent') {
      // Only a surviving `KEY-seq` parent is an edge; a bare project `KEY` (or
      // null) is a root marker and never part of a cycle.
      return node.parent !== null && parseId(node.parent) !== null ? [node.parent] : [];
    }
    return node.dependsOn;
  };

  // Three-color DFS: white = unvisited, gray = on the current stack, black = done.
  const color = new Map<string, 'gray' | 'black'>();
  const backEdges: { from: string; to: string }[] = [];
  const visit = (stem: string): void => {
    color.set(stem, 'gray');
    const node = byStem.get(stem);
    if (node !== undefined) {
      for (const to of outEdges(node)) {
        const seen = color.get(to);
        if (seen === 'gray') {
          backEdges.push({ from: stem, to }); // closes a cycle
        } else if (seen === undefined) {
          visit(to);
        }
        // 'black': a forward/cross edge into a finished node — not a cycle.
      }
    }
    color.set(stem, 'black');
  };
  for (const node of order) {
    if (color.get(node.stem) === undefined) {
      visit(node.stem);
    }
  }

  // Apply the drops in DFS-discovery order: record each, then prune it from the
  // surviving subgraph (a parent back edge floats the node to root; a depends_on
  // back edge is removed from the prereq list).
  for (const { from, to } of backEdges) {
    const node = byStem.get(from);
    if (relation === 'parent') {
      dropped.push({ kind: 'edge', ref: to, rule: 'cycle-parent', stem: from });
      if (node !== undefined) {
        node.parent = null;
      }
    } else {
      dropped.push({ kind: 'edge', ref: to, rule: 'cycle-depends-on', stem: from });
      if (node !== undefined) {
        node.dependsOn = node.dependsOn.filter((prereq) => prereq !== to);
      }
    }
  }
}
