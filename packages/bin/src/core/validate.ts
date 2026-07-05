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
 * loader ({@link loadNornSnapshot}) throws on today: a node whose owning project
 * has no document (missing container), and a `parent`/`depends_on` that resolves
 * to no surviving node (dangling edge). Acyclicity (MMR-174) and node-field
 * validity (MMR-177) slot in later as further rules over the same seam.
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
  | { kind: 'edge'; rule: 'dangling-depends-on'; stem: string; ref: string };

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
 *    survives) and is left for the acyclicity rule (MMR-174); a bare project `KEY`
 *    parent is a root marker, not an edge, and is preserved verbatim.
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

    const dependsOn: string[] = [];
    for (const ref of node.dependsOn) {
      if (survivors.has(ref)) {
        dependsOn.push(ref);
      } else {
        dropped.push({ kind: 'edge', ref, rule: 'dangling-depends-on', stem: node.stem });
      }
    }

    return { dependsOn, key: node.key, parent, stem: node.stem };
  });

  return { dropped, nodes, projectKeys: graph.projectKeys };
}
