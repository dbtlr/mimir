import { HOLD_VALUES, LIFECYCLE_VALUES, PRIORITY_VALUES, SIZE_VALUES } from '@mimir/contract';
import type { Lifecycle, NodeType } from '@mimir/contract';
import { isMember } from '@mimir/helpers';

import type { NornClient } from '../norn/client';
import { invariant } from './errors';
import { parseId } from './ids';
import type { Dependency, Node, Project } from './model';
import type { NodeTag, WorkingSet } from './store';

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

/** Collapse `[[STEM]]` (or a bare stem) to the stem text; null when unusable. */
function collapse(link: unknown): string | null {
  if (typeof link !== 'string') {
    return null;
  }
  const inner = link.startsWith('[[') && link.endsWith(']]') ? link.slice(2, -2) : link;
  return inner === '' ? null : inner;
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

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** The document stem — the canonical id. `MMR/MMR-2.md` → `MMR-2`, `MMR/MMR.md` → `MMR`. */
function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.endsWith('.md') ? base.slice(0, -3) : base;
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

  // Synthetic-int allocation — stable and deterministic. Projects key-ordered,
  // nodes (key, seq)-ordered; independent int spaces mirroring SQLite's separate
  // project/node tables. Identity across the seam is always the stem.
  projectDocs.sort((a, b) => cmpStr(a.key, b.key));
  rawNodes.sort((a, b) => (a.key === b.key ? a.seq - b.seq : cmpStr(a.key, b.key)));

  const projectIdByKey = new Map<string, number>();
  projectDocs.forEach((p, i) => projectIdByKey.set(p.key, i + 1));
  const nodeDocs: NodeDoc[] = rawNodes.map((n, i) => ({
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
    // Referential integrity is Norn's job (the design seam); this reader enforces
    // SQLite's CHECK/FK invariants at the boundary and fails loud rather than
    // silently projecting a corrupt WorkingSet. Each throw below is a violation a
    // well-formed vault cannot produce.
    const projectId = projectIdByKey.get(n.key);
    if (projectId === undefined) {
      throw invariant(
        `node ${n.stem} references project ${n.key}, which is not in the vault`,
        'every node document must belong to a project document',
      );
    }

    // parent: a `KEY-seq` stem must resolve to another node; a bare project `KEY`
    // is the root, which the int-keyed model represents as parent_id = null.
    const parentStem = collapse(n.fm.parent);
    let parentId: number | null = null;
    if (parentStem !== null && parseId(parentStem) !== null) {
      const resolved = nodeIdByStem.get(parentStem);
      if (resolved === undefined) {
        throw invariant(
          `node ${n.stem} has parent ${parentStem}, which is not in the vault`,
          'a node parent must resolve to another node',
        );
      }
      parentId = resolved;
    }

    // Task-only columns (SQLite CHECK: NULL for non-task) are read only for a
    // task; a stray value on another type is ignored, never projected.
    const isTask = n.type === 'task';
    let lifecycle: Lifecycle | null = null;
    if (isTask) {
      // A task's lifecycle has no safe default (unlike hold) — derivation depends
      // on it, so an absent/foreign value is a hard read error, not a guess.
      // A foreign value throws inside the helper; an absent one returns null and
      // is caught here — a task's lifecycle has no safe default (unlike hold).
      lifecycle = enumFieldStrict(n.fm.lifecycle, LIFECYCLE_VALUES, n.stem, 'lifecycle');
      if (lifecycle === null) {
        throw invariant(
          `task ${n.stem} is missing a lifecycle`,
          'a task document must carry a lifecycle frontmatter value',
        );
      }
    }

    nodes.push({
      completed_at: isTask ? str(n.fm.completed_at) : null,
      created_at: str(n.fm.created) ?? '',
      description: str(n.fm.description),
      external_ref: isTask ? str(n.fm.external_ref) : null,
      // A task always carries a hold (SQLite CHECK: type='task' ⟺ hold NOT NULL,
      // default 'none'); the idiomatic vault omits the 'none' no-hold state, so an
      // absent hold on a task reconstructs to 'none'.
      hold: isTask ? (enumFieldStrict(n.fm.hold, HOLD_VALUES, n.stem, 'hold') ?? 'none') : null,
      hold_reason: isTask ? str(n.fm.hold_reason) : null,
      id: n.id,
      lifecycle,
      parent_id: parentId,
      priority: isTask ? enumFieldStrict(n.fm.priority, PRIORITY_VALUES, n.stem, 'priority') : null,
      project_id: projectId,
      rank: isTask ? num(n.fm.rank) : null,
      seq: n.seq,
      size: isTask ? enumFieldStrict(n.fm.size, SIZE_VALUES, n.stem, 'size') : null,
      target: n.type === 'phase' ? str(n.fm.target) : null,
      title: str(n.fm.title) ?? '',
      type: n.type,
      updated_at: str(n.fm.updated_at) ?? '',
    });

    // Dedup to SQLite's (node_id, depends_on_node_id) primary key — a doubled
    // wikilink is one edge; an unresolvable prerequisite is a referential error.
    const prereqIds = new Set<number>();
    for (const prereqStem of linkStems(n.fm.depends_on)) {
      const prereqId = nodeIdByStem.get(prereqStem);
      if (prereqId === undefined) {
        throw invariant(
          `node ${n.stem} depends on ${prereqStem}, which is not in the vault`,
          'a prerequisite must resolve to another node',
        );
      }
      if (prereqId === n.id) {
        throw invariant(
          `node ${n.stem} depends on itself`,
          'a node cannot be its own prerequisite (SQLite dependency CHECK)',
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
