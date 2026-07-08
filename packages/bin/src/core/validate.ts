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
 * threw on at `prereqId === n.id`). It also owns the *field-validity* rules
 * (MMR-177) — a task's `lifecycle`/`hold`/`priority`/`size` frontmatter — run as
 * pass 0 before the referential passes so a field node-drop cascades through them.
 * With that pass the valid subgraph is fully throw-free: every referential and
 * field corruption the loader once threw on is now a {@link Drop}, so the tolerant
 * reader (MMR-181) builds only over survivors and never fails loud on vault data.
 */
import {
  HOLD_VALUES,
  LIFECYCLE_VALUES,
  PRIORITY_VALUES,
  SEED_KIND_VALUES,
  SEED_LIFECYCLE_VALUES,
  SIZE_VALUES,
} from '@mimir/contract';
import { isMember } from '@mimir/helpers';

import { parseId, parseSeedRef } from './ids';
import type { NodeRefs, VaultGraph } from './store-norn';

/**
 * One dropped element, with the reason it was dropped — doctor's source of
 * truth. A `node` drop hides the node entirely (its container is missing, or a
 * load-bearing field is unusable); an `edge` drop loosens one relation (the node
 * stays, floated to root for a `parent`, or minus one prereq for a `depends_on`);
 * a `field` drop nulls one optional field but keeps the node (MMR-177). A node
 * drop for a bad `lifecycle`/`hold` carries the offending `value` (or `null` when
 * the field is absent) so doctor can name it; a `field` drop always names its
 * offending value.
 */
export type Drop =
  | { kind: 'node'; rule: 'missing-project'; stem: string; key: string }
  | { kind: 'node'; rule: 'invalid-lifecycle'; stem: string; key: string; value: string | null }
  | { kind: 'node'; rule: 'invalid-hold'; stem: string; key: string; value: string | null }
  | { kind: 'edge'; rule: 'dangling-parent'; stem: string; ref: string }
  | { kind: 'edge'; rule: 'dangling-depends-on'; stem: string; ref: string }
  | { kind: 'edge'; rule: 'cycle-parent'; stem: string; ref: string }
  | { kind: 'edge'; rule: 'cycle-depends-on'; stem: string; ref: string }
  | { kind: 'field'; rule: 'invalid-priority'; stem: string; value: string }
  | { kind: 'field'; rule: 'invalid-size'; stem: string; value: string }
  | { kind: 'field'; rule: 'invalid-open-ended'; stem: string; value: string }
  // Seeds (MMR-244). A missing own-project drops the seed RECORD (hidden on read,
  // mirroring a node's missing-container); kind/lifecycle are load-bearing → the
  // seed record drops too; requester nulls the FIELD (seed survives); a dangling
  // `spawned` edge is pruned (seed survives); a task `upstream` that is malformed
  // grammar or dangles nulls that FIELD (task survives).
  | { kind: 'node'; rule: 'orphaned-seed'; stem: string; key: string }
  | { kind: 'node'; rule: 'invalid-seed-kind'; stem: string; key: string; value: string | null }
  | {
      kind: 'node';
      rule: 'invalid-seed-lifecycle';
      stem: string;
      key: string;
      value: string | null;
    }
  | { kind: 'field'; rule: 'unknown-requester'; stem: string; value: string }
  // An archived requester is a KNOWN project that the reader still nulls (the seam's
  // active-only visibility), so it is a WARN distinct from unknown-requester's error —
  // the value reverts on unarchive, it is not corruption (MMR-245/B1d).
  | { kind: 'field'; rule: 'archived-requester'; stem: string; value: string }
  | { kind: 'edge'; rule: 'dangling-spawned'; stem: string; ref: string }
  | { kind: 'field'; rule: 'malformed-upstream'; stem: string; value: string }
  | { kind: 'field'; rule: 'dangling-upstream'; stem: string; value: string };

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
 * it there. Passes over the nodes, in input order:
 *
 * 0. **Field validity (MMR-177).** Task-only, and skipped for a node with no
 *    `raw` (a referential-only caller). Runs FIRST so a node dropped here is gone
 *    before the referential passes and its drop cascades exactly like a missing
 *    container. Tiered by whether the field is load-bearing for correctness: a
 *    task whose `lifecycle` is missing or foreign (it drives status derivation,
 *    with no safe absent value) or whose `hold` is foreign (it drives
 *    blocked/parked, and coercing to the `none` default would be silently wrong)
 *    drops the NODE; a foreign `priority`/`size` (optional — null is a truthful
 *    "unset") drops only the FIELD (a `field` {@link Drop}) and the node survives.
 *    The reader nulls the field over the same vocabulary; the tiering RULE lives
 *    only here.
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
  // The reader's ACTIVE-only visibility, for the seed `requester` check ONLY — an
  // archived project is present (its nodes survive, hidden) but its key is NOT
  // active, so a requester naming it is nulled on read (MMR-245/B1d). Every other
  // pass (node containers included) resolves against `present`, so archived
  // projects' nodes are never dropped.
  const archived = new Set(graph.archivedProjectKeys);
  const survivors = new Set<string>();
  const dropped: Drop[] = [];

  // Pass 0: field validity (MMR-177). Task-only; skipped when a node carries no
  // `raw` (referential-only callers). A load-bearing field (lifecycle/hold) drops
  // the NODE — recorded here and collected so the referential passes below exclude
  // it, exactly as a missing-project node is excluded; an optional field
  // (priority/size) drops only the FIELD and the node stays.
  const fieldDropped = new Set<string>();
  for (const node of graph.nodes) {
    const raw = node.raw;
    if (raw === undefined) {
      continue;
    }
    if (node.type !== 'task') {
      // open_ended: container-only optional field (MMR-204), same tiering as
      // priority/size — a surviving container with a present, non-null, non-boolean
      // value nulls the FIELD (the node stays). Absent/null is a truthful unset, and
      // the reader's `boolFieldOrNull` accepts a real boolean or the strings
      // 'true'/'false' (Norn's undeclared-field serialization).
      if (present.has(node.key) && raw.open_ended != null && !isBoolish(raw.open_ended)) {
        dropped.push({
          kind: 'field',
          rule: 'invalid-open-ended',
          stem: node.stem,
          value: show(raw.open_ended),
        });
      }
      continue;
    }
    // lifecycle: missing (absent) OR foreign → node-drop. `member` is false for
    // both, so one check covers the tier; `value` is null when absent.
    if (!member(raw.lifecycle, LIFECYCLE_VALUES)) {
      const value = raw.lifecycle === undefined ? null : show(raw.lifecycle);
      dropped.push({
        key: node.key,
        kind: 'node',
        rule: 'invalid-lifecycle',
        stem: node.stem,
        value,
      });
      fieldDropped.add(node.stem);
      continue;
    }
    // hold: absent is valid (reconstructs to 'none'); only a PRESENT foreign value
    // drops the node — coercing it to the default would be silently wrong.
    if (raw.hold !== undefined && !member(raw.hold, HOLD_VALUES)) {
      dropped.push({
        key: node.key,
        kind: 'node',
        rule: 'invalid-hold',
        stem: node.stem,
        value: show(raw.hold),
      });
      fieldDropped.add(node.stem);
      continue;
    }
    // priority/size: optional. Only a would-be-SURVIVING node (present project)
    // emits a field-drop — a node headed for a container drop in pass 1 is gone,
    // so it must not also raise field noise (its field is never read). And a null
    // or absent value is a truthful "unset" the reader keeps identically (its
    // `enumFieldOrNull` maps both to null), so it is NOT foreign — only a present,
    // non-null value that fails the vocabulary nulls the field.
    if (present.has(node.key)) {
      if (raw.priority != null && !member(raw.priority, PRIORITY_VALUES)) {
        dropped.push({
          kind: 'field',
          rule: 'invalid-priority',
          stem: node.stem,
          value: show(raw.priority),
        });
      }
      if (raw.size != null && !member(raw.size, SIZE_VALUES)) {
        dropped.push({
          kind: 'field',
          rule: 'invalid-size',
          stem: node.stem,
          value: show(raw.size),
        });
      }
    }
  }

  // Pass 1: partition nodes by container presence. A missing project hides the
  // node; the rest are the surviving set every edge resolves against. A node
  // already dropped in pass 0 is gone — it emits no further (referential) drop.
  const kept: NodeRefs[] = [];
  for (const node of graph.nodes) {
    if (fieldDropped.has(node.stem)) {
      continue;
    }
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

  // Pass 4: seeds + task upstream (MMR-244). Runs ONLY when the caller loaded
  // seeds (`graph.seeds` present) — the node-only resolving loader and the
  // transitions feed pass none, so their validate is unchanged. Tiered like the
  // node passes: a missing own-project drops the seed RECORD (the container rule,
  // mirroring pass 1 for nodes); kind/lifecycle are load-bearing (a foreign/missing
  // value drops the record too, hidden on read); `requester` nulls the FIELD (seed
  // survives); a dangling `spawned` prunes that EDGE; a task `upstream` that is
  // malformed grammar or resolves to no surviving seed nulls the FIELD.
  if (graph.seeds !== undefined) {
    const seedSurvivors = new Set<string>();
    for (const seed of graph.seeds) {
      if (!member(seed.kind, SEED_KIND_VALUES)) {
        dropped.push({
          key: seed.key,
          kind: 'node',
          rule: 'invalid-seed-kind',
          stem: seed.stem,
          value: seed.kind === undefined ? null : show(seed.kind),
        });
        continue;
      }
      if (!member(seed.lifecycle, SEED_LIFECYCLE_VALUES)) {
        dropped.push({
          key: seed.key,
          kind: 'node',
          rule: 'invalid-seed-lifecycle',
          stem: seed.stem,
          value: seed.lifecycle === undefined ? null : show(seed.lifecycle),
        });
        continue;
      }
      // container (record): a seed whose own project has no document has no valid
      // place to live — drop the record and exclude it from the survivors, so an
      // inbound task `upstream` correctly dangles (mirrors pass 1 for nodes).
      if (!present.has(seed.key)) {
        dropped.push({ key: seed.key, kind: 'node', rule: 'orphaned-seed', stem: seed.stem });
        continue;
      }
      // requester (field): a present, non-empty value the reader keeps only when it
      // names an ACTIVE project. Two honest dispositions, matching the seam:
      //  - names no project at all → unknown-requester (error; corruption, nulled on read)
      //  - names an ARCHIVED project → archived-requester (warn; nulled on read, reverts
      //    on unarchive) — NOT flagged before B1d, so doctor under-reported.
      if (seed.requester !== null && seed.requester !== '') {
        if (!present.has(seed.requester)) {
          dropped.push({
            kind: 'field',
            rule: 'unknown-requester',
            stem: seed.stem,
            value: seed.requester,
          });
        } else if (archived.has(seed.requester)) {
          dropped.push({
            kind: 'field',
            rule: 'archived-requester',
            stem: seed.stem,
            value: seed.requester,
          });
        }
      }
      // spawned (edge): each ref must resolve to a surviving work node.
      for (const ref of seed.spawned) {
        if (!survivors.has(ref)) {
          dropped.push({ kind: 'edge', ref, rule: 'dangling-spawned', stem: seed.stem });
        }
      }
      seedSurvivors.add(seed.stem);
    }
    // task upstream (field): only a would-be-surviving TASK emits noise — the
    // reader reads `upstream` only for a task (like `external_ref`), so the pass is
    // task-gated exactly like pass 0, or doctor would flag a non-task drop the
    // reader never made. A malformed grammar or a dangling (no surviving seed)
    // upstream nulls the field.
    for (const node of kept) {
      if (node.type !== 'task') {
        continue;
      }
      const up = node.upstream;
      if (up == null || up === '') {
        continue;
      }
      if (parseSeedRef(up) === null) {
        dropped.push({ kind: 'field', rule: 'malformed-upstream', stem: node.stem, value: up });
      } else if (!seedSurvivors.has(up)) {
        dropped.push({ kind: 'field', rule: 'dangling-upstream', stem: node.stem, value: up });
      }
    }
  }

  return { dropped, nodes, projectKeys: graph.projectKeys };
}

/**
 * True when `value` is a string in the closed vocabulary `values`. Field validity
 * (MMR-177) reads raw frontmatter (`unknown`), so a non-string or an
 * out-of-vocabulary value is not a member — the single test both the "missing OR
 * foreign" lifecycle tier and the "present foreign" hold/priority/size tiers share.
 */
function member(value: unknown, values: readonly string[]): boolean {
  return typeof value === 'string' && isMember(value, values);
}

/**
 * True when `value` is a valid `open_ended` (MMR-204): a real boolean or the
 * strings `'true'`/`'false'` (Norn serializes the undeclared field as a string).
 * Anything else present is foreign — the field-validity pass nulls it.
 */
function isBoolish(value: unknown): boolean {
  return typeof value === 'boolean' || value === 'true' || value === 'false';
}

/**
 * Render a raw (`unknown`) frontmatter value as the offending `value` doctor
 * names — a string verbatim, else its JSON form (so a number/bool/object reads
 * legibly, never `[object Object]`). Only reached for a PRESENT foreign value.
 */
function show(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
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
 * breaks every cycle (nested and interlocking included) with a deterministic
 * feedback-edge set (one back edge per cycle in DFS order — not a minimum feedback
 * arc set, which is NP-hard), fixed by the visit + out-edge order. A
 * self-dependency (A → A)
 * is the degenerate length-1 cycle: A is on the stack when its own out-edge is
 * examined, so the self-edge is a back edge, dropped the same way. The relations
 * are detected SEPARATELY — a path mixing `parent` and `depends_on` is not a cycle.
 */
function breakCycles(nodes: NodeRefs[], relation: 'parent' | 'depends-on', dropped: Drop[]): void {
  const byStem = new Map(nodes.map((n) => [n.stem, n]));
  // Canonical visit order: `(key, seq)`, matching the loader's node allocation, so
  // the chosen back edge — and thus the surviving subgraph — is deterministic
  // regardless of the raw document order the graph arrived in.
  // `toSorted` returns a fresh array (no in-place mutation of `nodes`). Stems are
  // guaranteed `KEY-seq` here (the loader/readVaultGraph only admit parseable
  // stems), so the seq parse always succeeds — the `?? 0` is a type guard, not a
  // reachable fallback.
  const order = nodes.toSorted((a, b) => {
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
  // Iterative with an explicit frame stack — NOT recursion — so a deep but valid
  // chain (a long linear `depends_on`/`parent` graph) can never overflow the JS
  // call stack and crash the never-throw read path (ADR 0017). Frames process
  // out-edges in frontmatter order via a cursor, so the traversal — and thus the
  // chosen back edge — is byte-for-byte identical to the recursive form.
  const color = new Map<string, 'gray' | 'black'>();
  const backEdges: { from: string; to: string }[] = [];
  const edgesOf = (stem: string): string[] => {
    const node = byStem.get(stem);
    return node === undefined ? [] : outEdges(node);
  };
  for (const root of order) {
    if (color.get(root.stem) !== undefined) {
      continue;
    }
    color.set(root.stem, 'gray');
    const stack: { stem: string; edges: string[]; cursor: number }[] = [
      { cursor: 0, edges: edgesOf(root.stem), stem: root.stem },
    ];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) {
        break;
      }
      if (frame.cursor >= frame.edges.length) {
        color.set(frame.stem, 'black'); // out-edges exhausted → finished
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
        backEdges.push({ from: frame.stem, to }); // closes a cycle
      } else if (seen === undefined) {
        color.set(to, 'gray');
        stack.push({ cursor: 0, edges: edgesOf(to), stem: to });
      }
      // 'black': a forward/cross edge into a finished node — not a cycle.
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
