import { wikilink } from './ids';
import type { Node, Project } from './model';
import type { NodeTag } from './store';

/**
 * The node/project → frontmatter projection (ADR 0016) — the inverse of the
 * `loadWorkingSetOverNorn` reader in {@link ./store-norn}. It is the single
 * definition of the vault's frontmatter field contract, shared by the Phase-2b
 * seed ({@link ../vault/node-seed}) and the MMR-153 node write path
 * ({@link ../norn/writer}), so a document a create writes reads back identically
 * to one the seed writes. Lives in `core/` so both the `vault/` seed and the
 * `norn/` writer can consume it without a layering cycle.
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
  // last_seq / last_artifact_seq were allocation counters from the old backend,
  // deliberately dropped: Phase 2b derives seq as max(seq)+1 over the vault
  // (ADR 0016 fork #1).
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
  // `description` is NOT frontmatter (MMR-162, ADR 0016 Refinement): the full
  // prose is authoritative in the `## Task Description` body section. Only the
  // short `summary` lede rides frontmatter.
  put(fm, 'summary', node.summary);
  if (rel.parentStem !== null) {
    fm.parent = wikilink(rel.parentStem);
  }
  if (rel.dependsOn.length > 0) {
    fm.depends_on = rel.dependsOn.map(wikilink);
  }
  if (rel.tags.length > 0) {
    fm.tags = rel.tags.map((t) => t.tag);
  }
  put(fm, 'lifecycle', node.lifecycle);
  // `hold: 'none'` is the neutral default — omit it (and null) so a task carries
  // a hold only when actually held; the reader defaults absent → 'none'.
  put(fm, 'hold', node.hold === 'none' ? null : node.hold);
  put(fm, 'hold_reason', node.hold_reason);
  put(fm, 'priority', node.priority);
  put(fm, 'size', node.size);
  put(fm, 'rank', node.rank);
  put(fm, 'external_ref', node.external_ref);
  // The requester-side pointer at a seed (`KEY-sN`), nullable (MMR-244) — a plain
  // scalar like `external_ref`, omitted when null.
  put(fm, 'upstream', node.upstream);
  put(fm, 'completed_at', node.completed_at);
  put(fm, 'target', node.target);
  // Container-only (MMR-204). Type-gated to non-task to match the reader
  // (`store-norn` decodes it only for containers) and the view projection — a
  // stray task-level value never reaches frontmatter, so the two backends can't
  // diverge on it. Norn has no boolean field_type, so it rides undeclared and
  // serializes as the strings 'true'/'false' (the reader's `boolFieldOrNull`
  // decodes them back). Emit both states explicitly — a deliberate `false` must
  // round-trip as `false`, not collapse to absent/null, so parity agrees.
  if (node.type !== 'task') {
    put(fm, 'open_ended', node.open_ended === null ? null : String(node.open_ended));
  }
  return fm;
}
