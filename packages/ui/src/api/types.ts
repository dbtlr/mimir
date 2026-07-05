import type {
  AwaitingRef,
  Distribution,
  Hold,
  Lane,
  Lifecycle,
  NodeRef,
  Priority,
  Size,
  StatusWord,
  TransitionKind,
  Verdicts,
  ViewType,
} from '@mimir/contract';

/**
 * The wire shapes the resource envelope serves (`nodeToWire` in the binary):
 * the contract's `NodeView` rendered in the output-contract's snake_case field
 * names. Field *values* (status words, priorities, verdicts, refs…) are the
 * contract's types verbatim — only the casing of facet field names differs,
 * because the contract deliberately keeps the internal camelCase `NodeView`
 * separate from the rendered wire (see `@mimir/bin` core/format.ts).
 */

export type WireDeps = {
  depends_on: NodeRef[];
  awaiting_on?: AwaitingRef[];
  blocking: NodeRef[];
};

export type WireTag = {
  tag: string;
  note: string | null;
  created_at: string;
};

export type WireAnnotation = {
  content: string;
  created_at: string;
};

/** A single transition_log entry — how the node moved (lifecycle/hold/dependency/move). */
export type WireHistoryEntry = {
  kind: TransitionKind;
  from: string | null;
  to: string | null;
  at: string;
  reason: string | null;
};

export type WireArtifact = {
  id: string;
  title: string;
  tags: string[];
  created_at: string;
};

/** A portfolio artifact-search row (`GET /api/artifacts`). */
export type WireArtifactSummary = {
  id: string;
  title: string;
  project: string;
  tags: string[];
  created_at: string;
};

/** A single artifact with its frozen body (`GET /api/artifacts/:id`). */
export type WireArtifactDetail = {
  id: string;
  title: string;
  project: string;
  links: string[];
  tags: string[];
  created_at: string;
  content?: string;
};

/** A project's derived attention-state (MMR-101) — the project-list facet, snake_case on the wire. */
export type WireAttention = {
  lane: Lane;
  last_activity: string;
  stale: boolean;
};

/** A rendered node record — bare fields always, facets when the route includes them. */
export type WireNode = {
  id: string;
  type: ViewType;
  title: string;
  status: StatusWord;
  parent: string | null;

  /** Facet — only present on the detail fetch, not list/board responses. */
  description?: string | null;
  /** Short single-line lede for list/board views (all-node, optional). */
  summary?: string | null;

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
  /** Per-project leaf-task status tally (MMR-105) — the project card's vitals panel. */
  leaf_counts?: Distribution;
  tags?: WireTag[];
  annotations?: WireAnnotation[];
  artifacts?: WireArtifact[];
  history?: WireHistoryEntry[];
  verdicts?: Verdicts;
  attention?: WireAttention;
};

/** The nested whole-project tree (`/api/projects/:key/tree`) — children rank-ordered. */
export type WireTreeNode = {
  children: WireTreeNode[];
} & Omit<WireNode, 'children'>;

/** The collection envelope with its count (ADR 0012 — never a bare array). */
export type Collection<T> = {
  total: number;
  items: T[];
};

/** The project key a rendered id belongs to (`MMR-16` → `MMR`, `MMR` → `MMR`). */
export function projectKeyOf(id: string): string {
  const dash = id.indexOf('-');
  return dash === -1 ? id : id.slice(0, dash);
}
