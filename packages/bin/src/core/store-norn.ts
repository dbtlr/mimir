import { HOLD_VALUES, LIFECYCLE_VALUES, PRIORITY_VALUES, SIZE_VALUES } from '@mimir/contract';
import type { Lifecycle, NodeType } from '@mimir/contract';
import { isMember } from '@mimir/helpers';

import type { NornClient, NornDocument } from '../norn/client';
import { collapse, stemOf, stringList } from '../norn/decode';
import { invariant } from './errors';
import { parseId } from './ids';
import type { Dependency, Node, Project } from './model';
import type { NodeTag, WorkingSet } from './store';
import { validate } from './validate';

/**
 * The Norn-vault node read path (MMR-149, ADR 0016 Phase 2b) — the second
 * `Store.loadWorkingSet` backend, sibling to the SQLite one. One bulk
 * `vault.find` over the work-state document types projects the whole store,
 * then this assembles the same {@link WorkingSet} the SQLite path produces, so
 * derivation runs byte-identically over either backend (parity is the point).
 *
 * Deliberately harness/test-constructed only in 2b — not wired into
 * `buildStore` or any backend flag. No pushdown: the query is a flat "give me
 * every node/project", and every predicate/rollup stays in Mimir's in-memory
 * derivation pass.
 *
 * Two representational deltas from SQLite, both by design (the vault is the
 * system of record the migration targets, not a mirror of SQLite's rows):
 * - **Synthetic ints.** The vault has no surrogate ids (the stem *is* the id);
 *   ints are minted here, stable per load, so the int-keyed model is unchanged
 *   (the id→`KEY-seq` model migration is Phase 3). Identity that crosses the
 *   seam is always `KEY-seq`.
 * - **Tags are a plain set.** Vault `tags` frontmatter carries no per-tag note
 *   or timestamp (ADR 0005); {@link toTagRecords} synthesizes those fields.
 */

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/**
 * Narrow a frontmatter value to an enum member. Norn has no enum field_type, so
 * value legality can't be enforced at the vault layer — the reader is the guard.
 * An ABSENT field returns null (the caller applies the SQLite default / column
 * nullability); a PRESENT but out-of-vocabulary value throws, matching the
 * column CHECK that makes it unrepresentable in the SQLite backend.
 */
function enumFieldStrict<T extends string>(
  value: unknown,
  values: readonly T[],
  stem: string,
  field: string,
): T | null {
  if (value === undefined) {
    return null;
  }
  const s = str(value);
  if (s !== null && isMember(s, values)) {
    return s;
  }
  throw invariant(
    `node ${stem} has an invalid ${field} value`,
    `${field} must be one of: ${values.join(', ')}`,
  );
}

/**
 * The non-throwing enum narrow for the OPTIONAL task fields (`priority`/`size`,
 * MMR-177): absent → null, a valid member → the value, and a PRESENT foreign
 * value → null (no throw). Field validity keeps a node with a foreign
 * priority/size (null is a truthful "unset"), so a surviving node can still carry
 * one — this reads it as null rather than crashing the never-throw read path. The
 * tiering decision (null-the-field vs drop-the-node) lives only in {@link validate};
 * this is the mechanical "don't crash" over the SAME vocabulary. NOT used for
 * `lifecycle`/`hold`, whose bad nodes the validator already drops — those stay on
 * {@link enumFieldStrict} as a seam backstop.
 */
function enumFieldOrNull<T extends string>(value: unknown, values: readonly T[]): T | null {
  const s = str(value);
  return s !== null && isMember(s, values) ? s : null;
}

/** Ascending string compare without a nested ternary (deterministic tiebreaks). */
function cmpStr(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/** A wikilink field (scalar or list) → its collapsed stems, in frontmatter order. */
function linkStems(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  return raw.map(collapse).filter((s): s is string => s !== null);
}

/**
 * Vault tags are a plain string set — no per-tag note or timestamp the way
 * SQLite's tag rows have. Project each onto a {@link NodeTag} with `note=null`
 * and the document's own `created` as a uniform `created_at`, sorted by tag so
 * the order is deterministic and matches the SQLite path's `(created_at, tag)`
 * tiebreak (MMR-148). A transitional read delta, mirroring the artifact store's
 * tag-note rejection.
 */
function toTagRecords(tags: readonly string[], created: string): NodeTag[] {
  return tags.toSorted(cmpStr).map((tag) => ({ created_at: created, note: null, tag }));
}

type ProjectDoc = { key: string; fm: Record<string, unknown> };
type NodeDoc = {
  id: number;
  stem: string;
  key: string;
  seq: number;
  type: NodeType;
  fm: Record<string, unknown>;
};

/**
 * A load-time snapshot of the vault's work-state (MMR-153): the same
 * {@link WorkingSet} the read path derives over, plus the two by-id side maps
 * the *write* path needs and the reader discards — the raw frontmatter per
 * document (the `expected_old_value` CAS precondition set_frontmatter demands)
 * and the synthetic-int → document identity the writer resolves paths through.
 * The synthetic ints are the {@link WorkingSet}'s own (stable per load); a
 * later `transact` reloads and re-mints them, so they are handles WITHIN one
 * snapshot, never durable across applies.
 */
export type NornSnapshot = {
  workingSet: WorkingSet;
  /** Node id → its raw frontmatter record (presence + CAS old-value source). */
  nodeFm: ReadonlyMap<number, Record<string, unknown>>;
  /** Project id → its raw frontmatter record. */
  projectFm: ReadonlyMap<number, Record<string, unknown>>;
};

/** One node's raw relational refs — its stem, project `key`, and unresolved
 * parent + prerequisite stems. `key` is the parsed KEY-seq key, carried so no
 * consumer re-parses the stem (mirrors the loader's `rawNodes`).
 *
 * `type` and `raw` are the OPTIONAL field-validity inputs (MMR-177): the node's
 * type (field checks are task-only) and its raw enum frontmatter. Both are
 * omitted by referential-only callers (e.g. validate.test's `graphOf`), and
 * {@link validate} skips its field pass when `raw` is absent — so a caller that
 * cares only about referential rules is unaffected. */
export type NodeRefs = {
  stem: string;
  key: string;
  parent: string | null;
  dependsOn: string[];
  type?: NodeType;
  raw?: { lifecycle: unknown; hold: unknown; priority: unknown; size: unknown };
};

/**
 * The vault's relational graph, read raw and unresolved: the valid nodes' refs
 * plus the set of project `key`s present. Both `mimir doctor` referential checks
 * resolve against this one read.
 */
export type VaultGraph = { nodes: NodeRefs[]; projectKeys: string[] };

/**
 * Derive a node's referential refs from its frontmatter — the single derivation
 * the resolving reader ({@link loadNornSnapshot}) and {@link readVaultGraph}
 * share. Both feed the same {@link validate} pass, so the reader's drops and
 * doctor's findings must resolve over a byte-identical graph; one helper is what
 * makes that "one truth" a fact rather than a comment (MMR-181).
 */
function nodeRefsOf(
  fm: Record<string, unknown>,
  key: string,
  stem: string,
  type: NodeType,
): NodeRefs {
  return {
    dependsOn: linkStems(fm.depends_on),
    key,
    parent: collapse(fm.parent),
    // Field-validity inputs (MMR-177): the raw enum frontmatter, vetted in
    // validate's pass 0. Carried verbatim (unknown) — validate owns legality.
    raw: { hold: fm.hold, lifecycle: fm.lifecycle, priority: fm.priority, size: fm.size },
    stem,
    type,
  };
}

/**
 * Read the vault's relational graph WITHOUT resolving it (MMR-169, MMR-178). The
 * resolving loader ({@link loadNornSnapshot}) throws on the first dangling ref or
 * missing project, so it can never enumerate them — `mimir doctor` reads below it
 * here and reports every node whose parent/prerequisite points at an absent stem,
 * or whose owning project has no document.
 *
 * Partitions exactly as the loader does: `nodes` holds only the docs whose refs
 * the loader resolves — its `rawNodes` partition (a `task`/`phase`/`initiative`
 * with a valid `KEY-seq` stem) — and `projectKeys` holds the `key` of every
 * `type: project` doc that carries one (its `projectDocs` partition). A project
 * resolves no parent/depends_on and a non-`KEY-seq` stem is dropped, so surfacing
 * either's stray ref would flag a vault the loader loads fine.
 */
export async function readVaultGraph(client: NornClient): Promise<VaultGraph> {
  return vaultGraphFromDocs(
    await client.find({ in: ['type:project,task,phase,initiative'], no_limit: true }),
  );
}

/**
 * The pure core of {@link readVaultGraph} over an already-fetched document set —
 * split out (MMR-189) so a caller that has already run the `find` (the
 * transitions feed) derives the same graph from its one snapshot rather than
 * issuing a second identical query. Partitions exactly as the resolving loader
 * does; see {@link readVaultGraph}.
 */
export function vaultGraphFromDocs(docs: NornDocument[]): VaultGraph {
  const nodes: NodeRefs[] = [];
  const projectKeys: string[] = [];
  for (const doc of docs) {
    const fm = doc.frontmatter;
    if (fm === undefined) {
      continue;
    }
    const type = str(fm.type);
    if (type === 'project') {
      const key = str(fm.key);
      if (key !== null && key !== '') {
        projectKeys.push(key);
      }
      continue;
    }
    const stem = stemOf(doc.path);
    const ref = parseId(stem);
    if ((type !== 'task' && type !== 'phase' && type !== 'initiative') || ref === null) {
      continue;
    }
    nodes.push(nodeRefsOf(fm, ref.key, stem, type));
  }
  return { nodes, projectKeys };
}

export async function loadWorkingSetOverNorn(client: NornClient): Promise<WorkingSet> {
  return (await loadNornSnapshot(client)).workingSet;
}

export async function loadNornSnapshot(client: NornClient): Promise<NornSnapshot> {
  const docs = await client.find({
    in: ['type:project,task,phase,initiative'],
    no_limit: true,
  });

  // Partition documents by type; a doc without frontmatter, without a `key`
  // (project), or with a non-`KEY-seq` stem (node) is malformed and dropped.
  const projectDocs: ProjectDoc[] = [];
  const rawNodes: Omit<NodeDoc, 'id'>[] = [];
  for (const doc of docs) {
    const fm = doc.frontmatter;
    if (fm === undefined) {
      continue;
    }
    const type = str(fm.type);
    if (type === 'project') {
      const key = str(fm.key);
      if (key !== null && key !== '') {
        projectDocs.push({ fm, key });
      }
    } else if (type === 'task' || type === 'phase' || type === 'initiative') {
      const ref = parseId(stemOf(doc.path));
      if (ref !== null) {
        rawNodes.push({ fm, key: ref.key, seq: ref.seq, stem: stemOf(doc.path), type });
      }
    }
  }

  // Referential tolerance (ADR 0017, MMR-181): route the raw relational graph
  // through the shared validator and build only over the valid subgraph it
  // returns. The validator drops nodes whose project is absent and parent/
  // depends_on edges that resolve to no surviving node, so the referential
  // resolution below can no longer throw on vault corruption — a single bad
  // record degrades the read to a valid closed subgraph instead of taking the
  // whole load down. Deriving the graph exactly as {@link readVaultGraph} does
  // (collapse + linkStems) keeps the reader's and doctor's validity one truth.
  // The validator now covers every referential corruption — missing projects,
  // dangling edges, and cycles (acyclicity, MMR-174, including self-dependencies)
  // — AND field validity (MMR-177): it drops a task whose lifecycle/hold is
  // missing or foreign and nulls a foreign priority/size, so the build below can no
  // longer throw on vault data. Every SURVIVING node has a usable lifecycle/hold;
  // a foreign priority/size is nulled by {@link enumFieldOrNull} (the node stays).
  const validRefs = validate({
    nodes: rawNodes.map((n) => nodeRefsOf(n.fm, n.key, n.stem, n.type)),
    projectKeys: projectDocs.map((p) => p.key),
  }).nodes;
  const validByStem = new Map(validRefs.map((r) => [r.stem, r]));
  const survivingNodes = rawNodes.filter((n) => validByStem.has(n.stem));

  // Synthetic-int allocation — stable and deterministic. Projects key-ordered,
  // nodes (key, seq)-ordered; independent int spaces mirroring SQLite's separate
  // project/node tables. Identity across the seam is always the stem. Allocated
  // over the survivors only — a clean vault drops nothing, so the allocation
  // (and thus the whole WorkingSet) stays byte-identical to SQLite.
  projectDocs.sort((a, b) => cmpStr(a.key, b.key));
  survivingNodes.sort((a, b) => (a.key === b.key ? a.seq - b.seq : cmpStr(a.key, b.key)));

  const projectIdByKey = new Map<string, number>();
  projectDocs.forEach((p, i) => projectIdByKey.set(p.key, i + 1));
  const nodeDocs: NodeDoc[] = survivingNodes.map((n, i) => ({
    fm: n.fm,
    id: i + 1,
    key: n.key,
    seq: n.seq,
    stem: n.stem,
    type: n.type,
  }));
  const nodeIdByStem = new Map<string, number>();
  for (const n of nodeDocs) {
    nodeIdByStem.set(n.stem, n.id);
  }

  // last_seq is a write-path allocation counter (unused by read derivation, not
  // in the output contract) — derived as max(seq) so the Project is well-formed.
  const maxSeqByProject = new Map<string, number>();
  for (const n of nodeDocs) {
    maxSeqByProject.set(n.key, Math.max(maxSeqByProject.get(n.key) ?? 0, n.seq));
  }

  const projects: Project[] = projectDocs.map((p, i) => ({
    archived_at: str(p.fm.archived_at),
    created_at: str(p.fm.created) ?? '',
    description: str(p.fm.description),
    id: i + 1,
    key: p.key,
    last_artifact_seq: 0,
    last_seq: maxSeqByProject.get(p.key) ?? 0,
    name: str(p.fm.name) ?? '',
    updated_at: str(p.fm.updated_at) ?? '',
  }));

  const nodes: Node[] = [];
  const edges: Dependency[] = [];
  const nodeTags = new Map<number, NodeTag[]>();
  const nodeFm = new Map<number, Record<string, unknown>>();
  const projectFm = new Map<number, Record<string, unknown>>();
  projectDocs.forEach((p, i) => projectFm.set(i + 1, p.fm));
  for (const n of nodeDocs) {
    nodeFm.set(n.id, n.fm);
    // The validator already vetted this node's referential edges (its project is
    // present, parent/depends_on resolve to survivors), so the lookups below
    // cannot miss on vault data. A miss here would mean the validator and this
    // build disagree — an internal contract break, not vault corruption — so the
    // remaining invariants guard the seam, never the record. Field validity is now
    // the validator's too (MMR-177): the lifecycle/hold `enumFieldStrict` calls
    // never throw for a survivor (their bad nodes are dropped) — they stay strict
    // as a seam backstop — and a foreign priority/size is nulled, not thrown.
    const refs = validByStem.get(n.stem);
    const projectId = projectIdByKey.get(n.key);
    if (refs === undefined || projectId === undefined) {
      throw invariant(
        `node ${n.stem} survived validation but is unresolvable (project ${n.key})`,
        'the validator must only return nodes whose project and edges resolve',
      );
    }

    // parent: the validator's parent is null (a root, or a dropped edge floated to
    // root) or a surviving `KEY-seq` — so it always resolves to another node.
    const parentStem = refs.parent;
    let parentId: number | null = null;
    if (parentStem !== null && parseId(parentStem) !== null) {
      const resolved = nodeIdByStem.get(parentStem);
      if (resolved === undefined) {
        throw invariant(
          `node ${n.stem} has validated parent ${parentStem}, which is not in the subgraph`,
          'a validated parent must resolve to a surviving node',
        );
      }
      parentId = resolved;
    }

    // Task-only columns (SQLite CHECK: NULL for non-task) are read only for a
    // task; a stray value on another type is ignored, never projected.
    const isTask = n.type === 'task';
    let lifecycle: Lifecycle | null = null;
    if (isTask) {
      // Field validity (MMR-177) drops any task whose lifecycle is missing or
      // foreign, so a surviving task always carries a valid one. `enumFieldStrict`
      // returns it (never throws here) and the null branch is a seam invariant, not
      // a record error — a null would mean the validator failed to drop a
      // lifecycle-less task, an internal contract break.
      lifecycle = enumFieldStrict(n.fm.lifecycle, LIFECYCLE_VALUES, n.stem, 'lifecycle');
      if (lifecycle === null) {
        throw invariant(
          `task ${n.stem} survived validation without a lifecycle`,
          'field validity (MMR-177) must drop a task with a missing or foreign lifecycle before the reader',
        );
      }
    }

    nodes.push({
      completed_at: isTask ? str(n.fm.completed_at) : null,
      created_at: str(n.fm.created) ?? '',
      // `description` is not frontmatter (MMR-162): the WorkingSet leaves it null;
      // the prose is read on demand from the `## Task Description` body via the
      // BodySectionStore seam (`readDescription`), not carried in the bulk load.
      description: null,
      external_ref: isTask ? str(n.fm.external_ref) : null,
      // A task always carries a hold (SQLite CHECK: type='task' ⟺ hold NOT NULL,
      // default 'none'); the idiomatic vault omits the 'none' no-hold state, so an
      // absent hold on a task reconstructs to 'none'.
      hold: isTask ? (enumFieldStrict(n.fm.hold, HOLD_VALUES, n.stem, 'hold') ?? 'none') : null,
      hold_reason: isTask ? str(n.fm.hold_reason) : null,
      id: n.id,
      lifecycle,
      parent_id: parentId,
      // priority/size are optional (MMR-177): a foreign value nulls the field (the
      // node stays), so read them non-throwing — the validator keeps such a node.
      priority: isTask ? enumFieldOrNull(n.fm.priority, PRIORITY_VALUES) : null,
      project_id: projectId,
      rank: isTask ? num(n.fm.rank) : null,
      seq: n.seq,
      size: isTask ? enumFieldOrNull(n.fm.size, SIZE_VALUES) : null,
      summary: str(n.fm.summary),
      target: n.type === 'phase' ? str(n.fm.target) : null,
      title: str(n.fm.title) ?? '',
      type: n.type,
      updated_at: str(n.fm.updated_at) ?? '',
    });

    // The validator already dropped dangling prerequisites, self-dependencies, and
    // cycle-closing edges (acyclicity, MMR-174), and deduped the list, so every
    // stem here resolves to a *distinct* survivor. Both lookups below are seam
    // invariants, never record throws: a miss or a self-edge on validated data
    // would mean the validator and this build disagree, not that the vault is bad.
    // The prereqIds set keeps the reader's own idempotence against the SQLite
    // (node_id, depends_on_node_id) key.
    const prereqIds = new Set<number>();
    for (const prereqStem of refs.dependsOn) {
      const prereqId = nodeIdByStem.get(prereqStem);
      if (prereqId === undefined) {
        throw invariant(
          `node ${n.stem} has validated prerequisite ${prereqStem}, which is not in the subgraph`,
          'a validated prerequisite must resolve to a surviving node',
        );
      }
      if (prereqId === n.id) {
        throw invariant(
          `node ${n.stem} has a validated self-dependency`,
          'acyclicity validation (MMR-174) must drop a self-dependency before the reader',
        );
      }
      if (!prereqIds.has(prereqId)) {
        prereqIds.add(prereqId);
        edges.push({ depends_on_node_id: prereqId, node_id: n.id });
      }
    }

    const tags = stringList(n.fm.tags);
    if (tags.length > 0) {
      nodeTags.set(n.id, toTagRecords(tags, str(n.fm.created) ?? ''));
    }
  }

  const projectTags = new Map<number, NodeTag[]>();
  projectDocs.forEach((p, i) => {
    const tags = stringList(p.fm.tags);
    if (tags.length > 0) {
      projectTags.set(i + 1, toTagRecords(tags, str(p.fm.created) ?? ''));
    }
  });

  return {
    nodeFm,
    projectFm,
    workingSet: { edges, nodeTags, nodes, projectTags, projects },
  };
}
