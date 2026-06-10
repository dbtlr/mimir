import type {
  AnnotationView,
  ArtifactView,
  DepsFacet,
  FacetName,
  HistoryEntry,
  NodeRef,
  NodeView,
  TagView,
} from "../../contract/dto";
import type { Node } from "../../db/schema";
import type { Db, Tx } from "../context";
import { childDistribution, nodeStatusWord } from "../derive";
import { loadNode, renderNodeId } from "../lookup";

/**
 * Projection assembly — build a {@link NodeView} from a node row plus the
 * requested facets. Bare fields are always populated (the row is in hand);
 * task-only / phase-only fields appear only for that type; each opt-in facet
 * costs its own query, so callers request only what they render.
 */

type Executor = Db | Tx;

async function toRef(tx: Executor, nodeId: number): Promise<NodeRef> {
  const node = await loadNode(tx, nodeId);
  const id = (await renderNodeId(tx, nodeId)) ?? `#${String(nodeId)}`;
  return node === undefined ? { id } : { id, status: await nodeStatusWord(tx, node) };
}

export async function buildNodeView(
  tx: Executor,
  node: Node,
  facets: ReadonlySet<FacetName> = new Set(),
): Promise<NodeView> {
  const view: NodeView = {
    id: (await renderNodeId(tx, node.id)) ?? `#${String(node.id)}`,
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
    .select(["artifact.id as id", "artifact.created_at as createdAt"])
    .where("artifact_link.node_id", "=", nodeId)
    .orderBy("artifact.id", "asc")
    .execute();
  const out: ArtifactView[] = [];
  for (const row of rows) {
    const tags = await tx
      .selectFrom("tag")
      .select("tag")
      .where("entity_type", "=", "artifact")
      .where("entity_id", "=", row.id)
      .execute();
    out.push({ id: row.id, createdAt: row.createdAt, tags: tags.map((t) => t.tag) });
  }
  return out;
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
