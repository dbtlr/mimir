import { emitDataFields } from './field-spec';
import { wikilink } from './ids';
import type { Node, Project } from './model';
import type { NodeTag } from './store';

/**
 * The node/project → frontmatter projection (ADR 0016) — the inverse of the
 * `loadWorkingSetOverNorn` reader in {@link ./store-norn}. It is the single
 * definition of the vault's frontmatter field contract, consumed by the node
 * write path ({@link ./store-norn/writer}), so every document a create writes
 * reads back identically. Lives in `core/` so the `store-norn/` writer can
 * consume it without a layering cycle.
 *
 * Field names are the model's snake_case store vocabulary; `created` is the
 * creation timestamp (the artifact precedent and the reader agree). Every field
 * is omit-when-empty except the always-present identity/type/timestamps — the
 * reader defaults an absent field (a task's absent `hold` → `none`, etc.).
 */

/** Set `key` only when `value` is a non-null scalar — the omit-empty shape. */
function put(fm: Record<string, unknown>, key: string, value: string | number | null): void {
  if (value !== null) {
    fm[key] = value;
  }
}

/** Project → frontmatter record. `key`/`name`/`type` always; the rest omit-when-empty. */
export function projectFrontmatter(
  project: Project,
  tags: readonly NodeTag[],
): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    created: project.created_at,
    key: project.key,
    name: project.name,
    type: 'project',
    updated_at: project.updated_at,
  };
  // The project-scope key every work-state doc carries (self-referential on the
  // project doc), so `vault.find --eq project:KEY` scopes the whole subtree —
  // project + all its nodes — in one query (MMR-170). A wikilink like the
  // artifact `project` field and `parent`: Norn collapses brackets in matching.
  fm.project = wikilink(project.key);
  put(fm, 'description', project.description);
  put(fm, 'archived_at', project.archived_at);
  if (tags.length > 0) {
    fm.tags = tags.map((t) => t.tag);
  }
  return fm;
}

/** Node → frontmatter record. Relations arrive resolved to stems by the caller. */
export function nodeFrontmatter(
  node: Node,
  rel: {
    projectKey: string;
    parentStem: string | null;
    dependsOn: readonly string[];
    tags: readonly NodeTag[];
  },
): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    created: node.created_at,
    title: node.title,
    type: node.type,
    updated_at: node.updated_at,
  };
  // The owning project's key, so `vault.find --eq project:KEY` can scope nodes
  // (MMR-170). A node's project is authoritatively its `KEY-seq` stem — the
  // reader derives it from the path and ignores this field; it exists purely to
  // make Norn's frontmatter-only `find` able to scope by project. A wikilink to
  // the project doc, mirroring `parent` (Norn collapses brackets in matching).
  fm.project = wikilink(rel.projectKey);
  if (rel.parentStem !== null) {
    fm.parent = wikilink(rel.parentStem);
  }
  if (rel.dependsOn.length > 0) {
    fm.depends_on = rel.dependsOn.map(wikilink);
  }
  if (rel.tags.length > 0) {
    fm.tags = rel.tags.map((t) => t.tag);
  }
  // Structural, task-only scalars (topology/timestamps): `rank` is the invisible
  // ordering key and `completed_at` a lifecycle-driven timestamp — both stay
  // bespoke, outside the data-plane spec (ADR 0025 Decision 1).
  put(fm, 'rank', node.rank);
  put(fm, 'completed_at', node.completed_at);
  // The data plane is one generic loop over the field spec (ADR 0025): every
  // updatable/queryable scalar fact — `summary`, the status axes, priority/size,
  // external_ref/upstream, target, open_ended — is type-gated and emitted by its
  // kind, the inverse of `decodeDataFields`. `description` is NOT frontmatter
  // (MMR-162): the prose lives in the `## Task Description` body section, and only
  // its short `summary` lede rides frontmatter (a spec field).
  emitDataFields(fm, node);
  return fm;
}
