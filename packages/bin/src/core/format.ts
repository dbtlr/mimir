import type {
  ArtifactDetail,
  ArtifactSummary,
  NodeView,
  SeedView,
  SetResult,
  StatusView,
  TreeView,
  TriageReport,
  UpstreamResolution,
} from '@mimir/contract';

import { seedLane } from './seeds/lane';

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
    parent: node.parent,
    status: node.status,
    title: node.title,
    type: node.type,
  };
  // `description` is a facet now (MMR-162) — present only when read (detail get),
  // like the other opt-in fields; absent from bulk list/next rows.
  if (node.description !== undefined) {
    wire.description = node.description;
  }
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
  if (node.upstream !== undefined) {
    wire.upstream = node.upstream;
  }
  if (node.target !== undefined) {
    wire.target = node.target;
  }
  if (node.open_ended !== undefined) {
    wire.open_ended = node.open_ended;
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
  if (node.artifactCount !== undefined) {
    wire.artifact_count = node.artifactCount;
  }
  if (node.tags !== undefined) {
    wire.tags = node.tags.map((t) => ({ created_at: t.createdAt, tag: t.tag }));
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
  if (node.home !== undefined) {
    wire.home = {
      parent_id: node.home.parentId,
      parent_open_ended: node.home.parentOpenEnded,
      parent_title: node.home.parentTitle,
      project_key: node.home.projectKey,
    };
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

/** Map a {@link SeedView} to its wire object — contract field names (snake_case),
 * `description` only when the content read populated it. */
export function seedToWire(seed: SeedView): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    created_at: seed.createdAt,
    id: seed.id,
    kind: seed.kind,
    // The exclusive lane (MMR-245), single-sourced so consumers derive nothing.
    lane: seedLane(seed),
    lifecycle: seed.lifecycle,
    project: seed.project,
    ready_to_resolve: seed.readyToResolve,
    requester: seed.requester,
    spawned: seed.spawned,
    title: seed.title,
    updated_at: seed.updatedAt,
  };
  if (seed.description !== undefined) {
    wire.description = seed.description;
  }
  // The derived list lede (MMR-263) — present on live queue rows, omitted on the
  // detail read (which carries the full `description`) and on settled rows.
  if (seed.lede !== undefined) {
    wire.lede = seed.lede;
  }
  return wire;
}

/** `json` for a single seed (`get KEY-sN` / a write echo) — the bare wire object. */
export function formatSeedJson(seed: SeedView): string {
  return emitWire(seedToWire(seed), true);
}

/** The promote echo wire (MMR-245): the seed wire plus a SIBLING `created` field —
 * the created task id in create mode, omitted in link mode. Kept a sibling (not a
 * re-wrap) so the top-level seed shape stays identical to get/update/reject/resolve;
 * the single source both MCP and HTTP render, so the two can't drift (B7). */
export function promoteToWire(seed: SeedView, created?: string): Record<string, unknown> {
  const wire = seedToWire(seed);
  if (created !== undefined) {
    wire.created = created;
  }
  return wire;
}

/** `json` string for the promote echo — {@link promoteToWire} emitted (MCP). */
export function formatPromoteJson(seed: SeedView, created?: string): string {
  return emitWire(promoteToWire(seed, created), true);
}

/** `json` for the seed queue — the count-led `{ total, seeds: [...] }` envelope. */
export function formatSeedsJson(seeds: readonly SeedView[]): string {
  return emitWire({ seeds: seeds.map(seedToWire), total: seeds.length }, true);
}

/** `jsonl` for the seed queue — one wire object per line, no wrapper (streaming). */
export function formatSeedsJsonl(seeds: readonly SeedView[]): string {
  return seeds.map((s) => emitWire(seedToWire(s), false)).join('\n');
}

/** Map an {@link UpstreamResolution} (MMR-246, triage check c) to its wire object. */
export function upstreamResolutionToWire(r: UpstreamResolution): Record<string, unknown> {
  return {
    already_recorded: r.alreadyRecorded,
    annotated: r.annotated,
    blocked: r.blocked,
    lifecycle: r.lifecycle,
    reason: r.reason,
    task: r.task,
    upstream: r.upstream,
  };
}

/** Map a {@link TriageReport} (MMR-246) to its wire object — the three checks as
 * sibling arrays, seeds through {@link seedToWire} so they carry the same shape as
 * the queue read. The single source both the CLI json render and the MCP tool emit. */
export function triageToWire(report: TriageReport): Record<string, unknown> {
  return {
    board: report.board,
    dry_run: report.dryRun,
    failures: report.failures.map((f) => ({ message: f.message, task: f.task })),
    ready_to_resolve: report.readyToResolve.map(seedToWire),
    untriaged: report.untriaged.map(seedToWire),
    upstream_resolutions: report.upstreamResolutions.map(upstreamResolutionToWire),
  };
}

/** `json` for the triage report — the pretty composite object. */
export function formatTriageJson(report: TriageReport): string {
  return emitWire(triageToWire(report), true);
}

/** `jsonl` for the triage report — the composite report as ONE compact line. The
 * report is a single heterogeneous object (not a flat set), so there is no
 * per-line record to stream; jsonl is json without the pretty-print. */
export function formatTriageJsonl(report: TriageReport): string {
  return emitWire(triageToWire(report), false);
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
