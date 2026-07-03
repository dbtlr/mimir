import { HOLD_VALUES, LIFECYCLE_VALUES, PRIORITY_VALUES, SIZE_VALUES } from '@mimir/contract';
import type { NodeType } from '@mimir/contract';
import { isMember } from '@mimir/helpers';

import type { NornClient } from '../norn/client';
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

/** A frontmatter value narrowed to one of an enum's members, or null when absent/foreign. */
function enumField<T extends string>(value: unknown, values: readonly T[]): T | null {
  const s = str(value);
  return s !== null && isMember(s, values) ? s : null;
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

export async function loadWorkingSetOverNorn(client: NornClient): Promise<WorkingSet> {
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
  for (const n of nodeDocs) {
    const projectId = projectIdByKey.get(n.key);
    if (projectId === undefined) {
      continue; // a node whose owning project isn't in the vault — an orphan, skip.
    }

    // parent: a `KEY-seq` stem is a node parent; a bare `KEY` is the project
    // root, which the int-keyed model represents as parent_id = null.
    const parentStem = collapse(n.fm.parent);
    const parentId =
      parentStem !== null && parseId(parentStem) !== null
        ? (nodeIdByStem.get(parentStem) ?? null)
        : null;

    nodes.push({
      completed_at: str(n.fm.completed_at),
      created_at: str(n.fm.created) ?? '',
      description: str(n.fm.description),
      external_ref: str(n.fm.external_ref),
      hold: enumField(n.fm.hold, HOLD_VALUES),
      hold_reason: str(n.fm.hold_reason),
      id: n.id,
      lifecycle: enumField(n.fm.lifecycle, LIFECYCLE_VALUES),
      parent_id: parentId,
      priority: enumField(n.fm.priority, PRIORITY_VALUES),
      project_id: projectId,
      rank: num(n.fm.rank),
      seq: n.seq,
      size: enumField(n.fm.size, SIZE_VALUES),
      target: str(n.fm.target),
      title: str(n.fm.title) ?? '',
      type: n.type,
      updated_at: str(n.fm.updated_at) ?? '',
    });

    for (const prereqStem of linkStems(n.fm.depends_on)) {
      const prereqId = nodeIdByStem.get(prereqStem);
      if (prereqId !== undefined) {
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

  return { edges, nodeTags, nodes, projectTags, projects };
}
