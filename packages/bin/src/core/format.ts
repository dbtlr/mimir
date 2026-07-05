import type {
  ArtifactDetail,
  ArtifactSummary,
  NodeView,
  SetResult,
  StatusView,
  TreeView,
} from '@mimir/contract';

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
    description: node.description,
    id: node.id,
    parent: node.parent,
    status: node.status,
    title: node.title,
    type: node.type,
  };
  if (node.summary !== undefined) {
    wire.summary = node.summary;
  }
  if (node.priority !== undefined) {
    wire.priority = node.priority;
  }
  if (node.size !== undefined) {
    wire.size = node.size;
  }
  if (node.lifecycle !== undefined) {
    wire.lifecycle = node.lifecycle;
  }
  if (node.hold !== undefined) {
    wire.hold = node.hold;
  }
  if (node.holdReason !== undefined) {
    wire.hold_reason = node.holdReason;
  }
  if (node.externalRef !== undefined) {
    wire.external_ref = node.externalRef;
  }
  if (node.target !== undefined) {
    wire.target = node.target;
  }
  if (node.completedAt !== undefined) {
    wire.completed_at = node.completedAt;
  }
  if (node.archivedAt !== undefined) {
    wire.archived_at = node.archivedAt;
  }
  wire.created_at = node.createdAt;
  wire.updated_at = node.updatedAt;

  if (node.deps !== undefined) {
    wire.deps = {
      awaiting_on: node.deps.awaitingOn,
      blocking: node.deps.blocking,
      depends_on: node.deps.dependsOn,
    };
  }
  if (node.children !== undefined) {
    wire.children = node.children;
  }
  if (node.distribution !== undefined) {
    wire.distribution = node.distribution;
  }
  if (node.leafCounts !== undefined) {
    wire.leaf_counts = node.leafCounts;
  }
  if (node.tags !== undefined) {
    wire.tags = node.tags.map((t) => ({ created_at: t.createdAt, note: t.note, tag: t.tag }));
  }
  if (node.annotations !== undefined) {
    wire.annotations = node.annotations.map((a) => ({
      content: a.content,
      created_at: a.createdAt,
    }));
  }
  if (node.artifacts !== undefined) {
    wire.artifacts = node.artifacts.map((a) => ({
      created_at: a.createdAt,
      id: a.id,
      tags: a.tags,
      title: a.title,
    }));
  }
  if (node.history !== undefined) {
    wire.history = node.history.map((h) => ({
      at: h.at,
      from: h.from,
      kind: h.kind,
      reason: h.reason,
      to: h.to,
    }));
  }
  if (node.verdicts !== undefined) {
    wire.verdicts = node.verdicts;
  }
  if (node.attention !== undefined) {
    wire.attention = {
      lane: node.attention.lane,
      last_activity: node.attention.lastActivity,
      stale: node.attention.stale,
    };
  }
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
  return items.map((n) => n.id).join('\n');
}

/**
 * `json` for a set — the count-led envelope `{ total, returned, starts_at,
 * <unit>: [...] }`. Warnings stay out by default (the CLI renders them on
 * stderr); MCP — no stderr — folds them in beside the result.
 */
export function formatSetJson(
  result: SetResult<NodeView>,
  unit = 'tasks',
  opts: { includeWarnings?: boolean } = {},
): string {
  const wrapper: Record<string, unknown> = {
    returned: result.returned,
    starts_at: result.startsAt,
    total: result.total,
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
  return items.map((n) => emitWire(nodeToWire(n), false)).join('\n');
}

/** `json` for a single node — the bare wire object (no set wrapper; `get` / mutation echo). */
export function formatNodeJson(node: NodeView): string {
  return emitWire(nodeToWire(node), true);
}

/** `json` for `status_of` — id, label, and distribution together. */
export function formatStatusJson(status: StatusView): string {
  return emitWire(
    { distribution: status.distribution, id: status.id, status: status.status },
    true,
  );
}

/** Map a standalone artifact to its wire object — metadata + links, contract field names. */
export function artifactToWire(artifact: ArtifactDetail): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    created_at: artifact.createdAt,
    id: artifact.id,
    links: artifact.links,
    project: artifact.project,
    tags: artifact.tags,
    title: artifact.title,
  };
  if (artifact.content !== undefined) {
    wire.content = artifact.content;
  }
  return wire;
}

/** `json` for a standalone artifact (`get KEY-aN`). */
export function formatArtifactJson(artifact: ArtifactDetail): string {
  return emitWire(artifactToWire(artifact), true);
}

/** Map an {@link ArtifactSummary} to its wire object — metadata only, no content. */
export function artifactSummaryToWire(a: ArtifactSummary): Record<string, unknown> {
  return {
    created_at: a.createdAt,
    id: a.id,
    project: a.project,
    tags: a.tags,
    title: a.title,
  };
}
