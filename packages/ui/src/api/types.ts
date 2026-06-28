import type {
  AttentionBand,
  Distribution,
  Hold,
  Lifecycle,
  NodeRef,
  Priority,
  Size,
  StatusWord,
  TransitionKind,
  Verdicts,
  ViewType,
} from "@mimir/contract";

/**
 * The wire shapes the resource envelope serves (`nodeToWire` in the binary):
 * the contract's `NodeView` rendered in the output-contract's snake_case field
 * names. Field *values* (status words, priorities, verdicts, refs…) are the
 * contract's types verbatim — only the casing of facet field names differs,
 * because the contract deliberately keeps the internal camelCase `NodeView`
 * separate from the rendered wire (see `@mimir/bin` core/format.ts).
 */

export interface WireDeps {
  depends_on: NodeRef[];
  blocking: NodeRef[];
}

export interface WireTag {
  tag: string;
  note: string | null;
  created_at: string;
}

export interface WireAnnotation {
  content: string;
  created_at: string;
}

/** A single transition_log entry — how the node moved (lifecycle/hold/dependency/move). */
export interface WireHistoryEntry {
  kind: TransitionKind;
  from: string | null;
  to: string | null;
  at: string;
  reason: string | null;
}

export interface WireArtifact {
  id: string;
  title: string;
  tags: string[];
  created_at: string;
}

/** A portfolio artifact-search row (`GET /api/artifacts`). */
export interface WireArtifactSummary {
  id: string;
  title: string;
  project: string;
  tags: string[];
  created_at: string;
}

/** A single artifact with its frozen body (`GET /api/artifacts/:id`). */
export interface WireArtifactDetail {
  id: string;
  title: string;
  project: string;
  links: string[];
  tags: string[];
  created_at: string;
  content?: string;
}

/** A project's derived attention-state (MMR-101) — the fleet-list facet, snake_case on the wire. */
export interface WireAttention {
  band: AttentionBand;
  last_activity: string;
  stale: boolean;
}

/** A rendered node record — bare fields always, facets when the route includes them. */
export interface WireNode {
  id: string;
  type: ViewType;
  title: string;
  status: StatusWord;
  parent: string | null;
  description: string | null;

  priority?: Priority | null;
  size?: Size | null;
  lifecycle?: Lifecycle;
  hold?: Hold;
  hold_reason?: string | null;
  external_ref?: string | null;
  target?: string | null;
  completed_at?: string | null;
  created_at: string;
  updated_at: string;

  deps?: WireDeps;
  children?: NodeRef[];
  distribution?: Distribution;
  /** Per-project leaf-task status tally (MMR-105) — the fleet card's vitals panel. */
  leaf_counts?: Distribution;
  tags?: WireTag[];
  annotations?: WireAnnotation[];
  artifacts?: WireArtifact[];
  history?: WireHistoryEntry[];
  verdicts?: Verdicts;
  attention?: WireAttention;
}

/** The nested whole-project tree (`/api/projects/:key/tree`) — children rank-ordered. */
export interface WireTreeNode extends Omit<WireNode, "children"> {
  children: WireTreeNode[];
}

/** The collection envelope with its count (ADR 0012 — never a bare array). */
export interface Collection<T> {
  total: number;
  items: T[];
}

/** The project key a rendered id belongs to (`MMR-16` → `MMR`, `MMR` → `MMR`). */
export function projectKeyOf(id: string): string {
  const dash = id.indexOf("-");
  return dash === -1 ? id : id.slice(0, dash);
}
