import type { Dependency, Node, Project } from '../model';
import type { NodeTag, WorkingSet } from '../store';
import type { NodeRow, ProjectRow } from './schema';
import type { Executor } from './tx';

/**
 * The bulk read path (ADR 0016 Phase 0) — the projections every derivation view
 * starts from, as SQL.
 *
 * There is no tolerant-reader pass here and nothing to drop. The Norn reader
 * exists partly to survive corruption a markdown vault can hold (an orphan, a
 * dangling edge, a duplicate identity); the relational schema forbids each of
 * those with a key or a foreign key, so the read is the rows. That is also why
 * {@link WorkingSet.issueCount} is absent: there is no drop tally to report.
 */

/** The node columns the working set projects; `description` rides bodySections. */
export function toNode(row: NodeRow): Node {
  return {
    branch: row.branch,
    completed_at: row.completed_at,
    created_at: row.created_at,
    // Body-authoritative since MMR-162: the working set leaves it null and the
    // prose is read on demand through `bodySections.readDescription`.
    description: null,
    external_ref: row.external_ref,
    harness: row.harness,
    hold: row.hold,
    hold_reason: row.hold_reason,
    host: row.host,
    id: row.id,
    lifecycle: row.lifecycle,
    open_ended: row.open_ended,
    parent_id: row.parent_id,
    priority: row.priority,
    project_id: row.project_key,
    rank: row.rank,
    seq: row.seq,
    session: row.session,
    size: row.size,
    summary: row.summary,
    target: row.target,
    title: row.title,
    type: row.type,
    updated_at: row.updated_at,
    upstream: row.upstream,
  };
}

export function toProject(row: ProjectRow): Project {
  return {
    archived_at: row.archived_at,
    created_at: row.created_at,
    description: row.description,
    key: row.key,
    name: row.name,
    updated_at: row.updated_at,
  };
}

/** Every project, key-ordered, archived included. */
export async function loadProjects(ex: Executor): Promise<Project[]> {
  const rows = await ex.selectFrom('project').selectAll().orderBy('key').execute();
  return rows.map(toProject);
}

/**
 * The nodes of the named projects, intersected with the caller's already-
 * validated project-key set (MMR-251). An empty key list reads as no nodes
 * without a query.
 */
export async function loadNodesForProjects(
  ex: Executor,
  projectKeys: readonly string[],
  validProjectKeys: ReadonlySet<string>,
): Promise<Node[]> {
  const keys = [...new Set(projectKeys)].filter((key) => validProjectKeys.has(key));
  if (keys.length === 0) {
    return [];
  }
  const rows = await ex
    .selectFrom('node')
    .selectAll()
    .where('project_key', 'in', keys)
    .orderBy('project_key')
    .orderBy('seq')
    .execute();
  return rows.map(toNode);
}

/**
 * A tag set as the seam's tag records. A tag application carries no timestamp
 * of its own (ADR 0005): the seam synthesizes one from the OWNING entity's
 * `created_at`, which is the fact the Norn backend reads off the document and
 * the transfer document preserves.
 */
function tagRecords(tags: readonly string[], createdAt: string): NodeTag[] {
  return tags.map((tag) => ({ created_at: createdAt, tag }));
}

/** Group tag rows of one entity kind by entity, tag-sorted, stamped by owner. */
async function tagsByEntity(
  ex: Executor,
  entityType: 'node' | 'project',
  createdAtByEntity: ReadonlyMap<string, string>,
): Promise<Map<string, NodeTag[]>> {
  const rows = await ex
    .selectFrom('tag')
    .select(['entity_id', 'tag'])
    .where('entity_type', '=', entityType)
    .orderBy('entity_id')
    .orderBy('tag')
    .execute();
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    if (!createdAtByEntity.has(row.entity_id)) {
      continue;
    }
    grouped.set(row.entity_id, [...(grouped.get(row.entity_id) ?? []), row.tag]);
  }
  return new Map(
    [...grouped].map(([id, tags]) => [id, tagRecords(tags, createdAtByEntity.get(id) ?? '')]),
  );
}

/** The whole store's derivation inputs in one consistent projection. */
export async function loadWorkingSet(ex: Executor): Promise<WorkingSet> {
  const projects = await loadProjects(ex);
  const nodeRows = await ex
    .selectFrom('node')
    .selectAll()
    .orderBy('project_key')
    .orderBy('seq')
    .execute();
  const edges = await ex
    .selectFrom('dependency')
    .select(['node_id', 'depends_on_node_id'])
    .orderBy('node_id')
    .orderBy('depends_on_node_id')
    .execute();
  const nodeTags = await tagsByEntity(
    ex,
    'node',
    new Map(nodeRows.map((row) => [row.id, row.created_at])),
  );
  const projectTags = await tagsByEntity(
    ex,
    'project',
    new Map(projects.map((project) => [project.key, project.created_at])),
  );
  return {
    edges: edges.map(
      (edge): Dependency => ({
        depends_on_node_id: edge.depends_on_node_id,
        node_id: edge.node_id,
      }),
    ),
    nodeTags,
    nodes: nodeRows.map(toNode),
    projectTags,
    projects,
  };
}
