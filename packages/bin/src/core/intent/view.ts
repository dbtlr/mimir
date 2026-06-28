import type {
  AnnotationView,
  ArtifactDetail,
  ArtifactView,
  DepsFacet,
  FacetName,
  HistoryEntry,
  NodeRef,
  NodeView,
  TagView,
} from "@mimir/contract";
import type { Artifact, Node, Project } from "../../db/schema";
import { attentionOf } from "../attention";
import type { Db, Tx } from "../context";
import { childDistribution, nodeStatusWord, rootDistribution } from "../derive";
import { renderArtifactRef } from "../ids";
import { loadNode, renderNodeId } from "../lookup";
import { verdictsOf } from "../predicates";
import { interpret } from "../status";

/**
 * Projection assembly — build a {@link NodeView} from a node row plus the
 * requested facets. Bare fields are always populated (the row is in hand);
 * task-only / phase-only fields appear only for that type; each opt-in facet
 * costs its own query, so callers request only what they render.
 */

type Executor = Db | Tx;

async function toRef(tx: Executor, nodeId: number): Promise<NodeRef> {
  const node = await loadNode(tx, nodeId);
  const id = (await renderNodeId(tx, nodeId)) ?? "unknown";
  return node === undefined
    ? { id }
    : { id, title: node.title, status: await nodeStatusWord(tx, node) };
}

export async function buildNodeView(
  tx: Executor,
  node: Node,
  facets: ReadonlySet<FacetName> = new Set(),
): Promise<NodeView> {
  const view: NodeView = {
    id: (await renderNodeId(tx, node.id)) ?? "unknown",
    type: node.type,
    title: node.title,
    status: await nodeStatusWord(tx, node),
    parent: node.parent_id === null ? null : await renderNodeId(tx, node.parent_id),
    description: node.description,
    createdAt: node.created_at,
    updatedAt: node.updated_at,
  };

  if (node.type === "task") {
    view.priority = node.priority;
    view.size = node.size;
    view.lifecycle = node.lifecycle ?? undefined;
    view.hold = node.hold ?? undefined;
    view.holdReason = node.hold_reason;
    view.externalRef = node.external_ref;
    view.completedAt = node.completed_at;
  } else if (node.type === "phase") {
    view.target = node.target;
  }

  if (facets.has("deps")) {
    view.deps = await buildDeps(tx, node.id);
  }
  if (facets.has("children")) {
    view.children = await buildChildren(tx, node.id);
  }
  if (facets.has("distribution") && node.type !== "task") {
    view.distribution = await childDistribution(tx, node.id);
  }
  if (facets.has("tags")) {
    view.tags = await buildTags(tx, node.id);
  }
  if (facets.has("annotations")) {
    view.annotations = await buildAnnotations(tx, node.id);
  }
  if (facets.has("artifacts")) {
    view.artifacts = await buildArtifacts(tx, node.id);
  }
  if (facets.has("history")) {
    view.history = await buildHistory(tx, node.id);
  }
  if (facets.has("verdicts")) {
    view.verdicts = await verdictsOf(tx, node);
  }
  return view;
}

async function buildDeps(tx: Executor, nodeId: number): Promise<DepsFacet> {
  const prereqs = await tx
    .selectFrom("dependency")
    .select("depends_on_node_id")
    .where("node_id", "=", nodeId)
    .execute();
  const dependents = await tx
    .selectFrom("dependency")
    .select("node_id")
    .where("depends_on_node_id", "=", nodeId)
    .execute();
  return {
    dependsOn: await Promise.all(prereqs.map((r) => toRef(tx, r.depends_on_node_id))),
    blocking: await Promise.all(dependents.map((r) => toRef(tx, r.node_id))),
  };
}

async function buildChildren(tx: Executor, nodeId: number): Promise<NodeRef[]> {
  const rows = await tx
    .selectFrom("node")
    .select("id")
    .where("parent_id", "=", nodeId)
    .orderBy("seq", "asc")
    .execute();
  return Promise.all(rows.map((r) => toRef(tx, r.id)));
}

async function buildTags(tx: Executor, nodeId: number): Promise<TagView[]> {
  const rows = await tx
    .selectFrom("tag")
    .select(["tag", "note", "created_at"])
    .where("entity_type", "=", "node")
    .where("entity_id", "=", nodeId)
    .orderBy("created_at", "asc")
    .execute();
  return rows.map((r) => ({ tag: r.tag, note: r.note, createdAt: r.created_at }));
}

async function buildAnnotations(tx: Executor, nodeId: number): Promise<AnnotationView[]> {
  const rows = await tx
    .selectFrom("annotation")
    .select(["content", "created_at"])
    .where("node_id", "=", nodeId)
    .orderBy("created_at", "asc")
    .execute();
  return rows.map((r) => ({ content: r.content, createdAt: r.created_at }));
}

async function buildArtifacts(tx: Executor, nodeId: number): Promise<ArtifactView[]> {
  const rows = await tx
    .selectFrom("artifact_link")
    .innerJoin("artifact", "artifact.id", "artifact_link.artifact_id")
    .innerJoin("project", "project.id", "artifact.project_id")
    .select([
      "artifact.id as id",
      "artifact.seq as seq",
      "artifact.title as title",
      "artifact.created_at as createdAt",
      "project.key as key",
    ])
    .where("artifact_link.node_id", "=", nodeId)
    .orderBy("artifact.seq", "asc")
    .execute();
  const out: ArtifactView[] = [];
  for (const row of rows) {
    out.push({
      id: renderArtifactRef(row),
      title: row.title,
      createdAt: row.createdAt,
      tags: await tagsOf(tx, "artifact", row.id),
    });
  }
  return out;
}

async function tagsOf(
  tx: Executor,
  entityType: "project" | "node" | "artifact",
  entityId: number,
): Promise<string[]> {
  const rows = await tx
    .selectFrom("tag")
    .select("tag")
    .where("entity_type", "=", entityType)
    .where("entity_id", "=", entityId)
    .orderBy("created_at", "asc")
    .execute();
  return rows.map((r) => r.tag);
}

/** All of a project's artifacts — the inventory behind `get KEY --col artifacts` (MMR-32/34). */
async function buildProjectArtifacts(tx: Executor, project: Project): Promise<ArtifactView[]> {
  const rows = await tx
    .selectFrom("artifact")
    .select(["id", "seq", "title", "created_at as createdAt"])
    .where("project_id", "=", project.id)
    .orderBy("seq", "asc")
    .execute();
  const out: ArtifactView[] = [];
  for (const row of rows) {
    out.push({
      id: renderArtifactRef({ key: project.key, seq: row.seq }),
      title: row.title,
      createdAt: row.createdAt,
      tags: await tagsOf(tx, "artifact", row.id),
    });
  }
  return out;
}

/**
 * The whole-project view (`get KEY`, MMR-32) — the project rendered through the
 * same projection contract as a node: `type: "project"`, status = `interpret`
 * over its root nodes. Facets that don't apply to a project (deps,
 * annotations, history) are silently absent.
 */
export async function buildProjectView(
  tx: Executor,
  project: Project,
  facets: ReadonlySet<FacetName> = new Set(),
): Promise<NodeView> {
  const distribution = await rootDistribution(tx, project.id);
  const view: NodeView = {
    id: project.key,
    type: "project",
    title: project.name,
    status: interpret(distribution),
    parent: null,
    description: project.description,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  };
  if (facets.has("children")) {
    const roots = await tx
      .selectFrom("node")
      .select("id")
      .where("project_id", "=", project.id)
      .where("parent_id", "is", null)
      .orderBy("seq", "asc")
      .execute();
    view.children = await Promise.all(roots.map((r) => toRef(tx, r.id)));
  }
  if (facets.has("distribution")) {
    view.distribution = distribution;
  }
  if (facets.has("attention")) {
    view.attention = await attentionOf(tx, project);
  }
  if (facets.has("tags")) {
    const rows = await tx
      .selectFrom("tag")
      .select(["tag", "note", "created_at"])
      .where("entity_type", "=", "project")
      .where("entity_id", "=", project.id)
      .orderBy("created_at", "asc")
      .execute();
    view.tags = rows.map((r) => ({ tag: r.tag, note: r.note, createdAt: r.created_at }));
  }
  if (facets.has("artifacts")) {
    view.artifacts = await buildProjectArtifacts(tx, project);
  }
  return view;
}

/**
 * A standalone artifact record (`get KEY-aN`, MMR-32/34) — metadata + linked
 * nodes + tags; the frozen body only when opted in (`--col content`).
 */
export async function buildArtifactDetail(
  tx: Executor,
  artifact: Artifact,
  projectKey: string,
  opts: { content?: boolean } = {},
): Promise<ArtifactDetail> {
  const links = await tx
    .selectFrom("artifact_link")
    .select("node_id")
    .where("artifact_id", "=", artifact.id)
    .orderBy("node_id", "asc")
    .execute();
  const linkIds: string[] = [];
  for (const link of links) {
    linkIds.push((await renderNodeId(tx, link.node_id)) ?? "unknown");
  }
  const detail: ArtifactDetail = {
    id: renderArtifactRef({ key: projectKey, seq: artifact.seq }),
    title: artifact.title,
    project: projectKey,
    links: linkIds,
    tags: await tagsOf(tx, "artifact", artifact.id),
    createdAt: artifact.created_at,
  };
  if (opts.content === true) {
    detail.content = artifact.content;
  }
  return detail;
}

async function buildHistory(tx: Executor, nodeId: number): Promise<HistoryEntry[]> {
  const rows = await tx
    .selectFrom("transition_log")
    .select(["kind", "from_value", "to_value", "at", "reason"])
    .where("node_id", "=", nodeId)
    .orderBy("id", "asc")
    .execute();
  return rows.map((r) => ({
    kind: r.kind,
    from: r.from_value,
    to: r.to_value,
    at: r.at,
    reason: r.reason,
  }));
}
