import type {
  ArtifactDetail,
  ArtifactSummary,
  NodeView,
  SetResult,
  StatusView,
  TreeView,
} from "@mimir/contract";

/**
 * The **structural** output formats — `ids` / `json` / `jsonl` — a versioned
 * promise, shared by every transport and never styled (no ANSI). The wire shape
 * is emitted explicitly in the output-contract's field names (snake_case), kept
 * deliberately separate from the camelCase internal {@link NodeView} so the
 * contract is intentional, not an accident of the internal type.
 */

/** Map a NodeView to its wire object — only defined fields, contract field names. */
export function nodeToWire(node: NodeView): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    id: node.id,
    type: node.type,
    title: node.title,
    status: node.status,
    parent: node.parent,
    description: node.description,
  };
  if (node.priority !== undefined) wire.priority = node.priority;
  if (node.size !== undefined) wire.size = node.size;
  if (node.lifecycle !== undefined) wire.lifecycle = node.lifecycle;
  if (node.hold !== undefined) wire.hold = node.hold;
  if (node.holdReason !== undefined) wire.hold_reason = node.holdReason;
  if (node.externalRef !== undefined) wire.external_ref = node.externalRef;
  if (node.target !== undefined) wire.target = node.target;
  if (node.completedAt !== undefined) wire.completed_at = node.completedAt;
  wire.created_at = node.createdAt;
  wire.updated_at = node.updatedAt;

  if (node.deps !== undefined) {
    wire.deps = { depends_on: node.deps.dependsOn, blocking: node.deps.blocking };
  }
  if (node.children !== undefined) wire.children = node.children;
  if (node.distribution !== undefined) wire.distribution = node.distribution;
  if (node.tags !== undefined) {
    wire.tags = node.tags.map((t) => ({ tag: t.tag, note: t.note, created_at: t.createdAt }));
  }
  if (node.annotations !== undefined) {
    wire.annotations = node.annotations.map((a) => ({
      content: a.content,
      created_at: a.createdAt,
    }));
  }
  if (node.artifacts !== undefined) {
    wire.artifacts = node.artifacts.map((a) => ({
      id: a.id,
      title: a.title,
      tags: a.tags,
      created_at: a.createdAt,
    }));
  }
  if (node.history !== undefined) {
    wire.history = node.history.map((h) => ({
      kind: h.kind,
      from: h.from,
      to: h.to,
      at: h.at,
      reason: h.reason,
    }));
  }
  if (node.verdicts !== undefined) wire.verdicts = node.verdicts;
  return wire;
}

/** Map a nested {@link TreeView} to its wire object — the node record + nested `children`. */
export function treeToWire(tree: TreeView): Record<string, unknown> {
  const { children, ...node } = tree;
  return { ...nodeToWire(node), children: children.map(treeToWire) };
}

/**
 * Emit a wire object as the `json` form (pretty, 2-space) or the compact
 * `jsonl`/single-line form. The one place the structural serialization shape
 * is decided, so every transport's `json`/`jsonl` stays byte-identical.
 */
export function emitWire(wire: Record<string, unknown>, pretty: boolean): string {
  return pretty ? JSON.stringify(wire, null, 2) : JSON.stringify(wire);
}

/** `ids` — one `KEY-seq` per line (the pipe default). */
export function formatIds(items: readonly NodeView[]): string {
  return items.map((n) => n.id).join("\n");
}

/**
 * `json` for a set — the count-led envelope `{ total, returned, starts_at,
 * <unit>: [...] }`. Warnings stay out by default (the CLI renders them on
 * stderr); MCP — no stderr — folds them in beside the result.
 */
export function formatSetJson(
  result: SetResult<NodeView>,
  unit = "tasks",
  opts: { includeWarnings?: boolean } = {},
): string {
  const wrapper: Record<string, unknown> = {
    total: result.total,
    returned: result.returned,
    starts_at: result.startsAt,
    [unit]: result.items.map(nodeToWire),
  };
  if (
    opts.includeWarnings === true &&
    result.warnings !== undefined &&
    result.warnings.length > 0
  ) {
    wrapper.warnings = result.warnings;
  }
  return emitWire(wrapper, true);
}

/** `jsonl` for a set — one wire object per line, no wrapper (streaming). */
export function formatSetJsonl(items: readonly NodeView[]): string {
  return items.map((n) => emitWire(nodeToWire(n), false)).join("\n");
}

/** `json` for a single node — the bare wire object (no set wrapper; `get` / mutation echo). */
export function formatNodeJson(node: NodeView): string {
  return emitWire(nodeToWire(node), true);
}

/** `json` for `status_of` — id, label, and distribution together. */
export function formatStatusJson(status: StatusView): string {
  return emitWire(
    { id: status.id, status: status.status, distribution: status.distribution },
    true,
  );
}

/** Map a standalone artifact to its wire object — metadata + links, contract field names. */
export function artifactToWire(artifact: ArtifactDetail): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    id: artifact.id,
    title: artifact.title,
    project: artifact.project,
    links: artifact.links,
    tags: artifact.tags,
    created_at: artifact.createdAt,
  };
  if (artifact.content !== undefined) wire.content = artifact.content;
  return wire;
}

/** `json` for a standalone artifact (`get KEY-aN`). */
export function formatArtifactJson(artifact: ArtifactDetail): string {
  return emitWire(artifactToWire(artifact), true);
}

/** Map an {@link ArtifactSummary} to its wire object — metadata only, no content. */
export function artifactSummaryToWire(a: ArtifactSummary): Record<string, unknown> {
  return {
    id: a.id,
    title: a.title,
    project: a.project,
    tags: a.tags,
    created_at: a.createdAt,
  };
}
