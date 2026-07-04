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
  put(fm, 'description', project.description);
  put(fm, 'archived_at', project.archived_at);
  if (tags.length > 0) {
    fm.tags = tags.map((t) => t.tag);
  }
  return fm;
  // last_seq / last_artifact_seq are SQLite allocation counters, deliberately
  // dropped: Phase 2b derives seq as max(seq)+1 over the vault (ADR 0016 fork #1).
}

/** Node → frontmatter record. Relations arrive resolved to stems by the caller. */
export function nodeFrontmatter(
  node: Node,
  rel: { parentStem: string | null; dependsOn: readonly string[]; tags: readonly NodeTag[] },
): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    created: node.created_at,
    title: node.title,
    type: node.type,
    updated_at: node.updated_at,
  };
  put(fm, 'description', node.description);
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
  put(fm, 'completed_at', node.completed_at);
  put(fm, 'target', node.target);
  return fm;
}
