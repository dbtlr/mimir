import type {
  AwaitingRef,
  Distribution,
  Hold,
  Lane,
  Lifecycle,
  NodeRef,
  Priority,
  SeedKind,
  SeedLane,
  SeedLifecycle,
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

/**
 * A linked node on the artifact-detail wire (MMR-229) — title and status are
 * resolved server-side at read time; both absent when the node no longer
 * resolves (the link degrades to its bare id).
 */
export type WireArtifactLink = {
  id: string;
  title?: string;
  status?: StatusWord;
};

/** A single artifact with its frozen body (`GET /api/artifacts/:id`). */
export type WireArtifactDetail = {
  id: string;
  title: string;
  project: string;
  links: WireArtifactLink[];
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

/**
 * Where a row lives (MMR-228) — the owning project's KEY plus the parent
 * container's rendered id, title, and open-endedness (`∞` on standing homes).
 * Parent fields are null for a root-level node.
 */
export type WireHome = {
  project_key: string;
  parent_id: string | null;
  parent_title: string | null;
  parent_open_ended: boolean | null;
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
  /** Container-only (MMR-204): purposefully open-ended, opts out of done-rollup. */
  open_ended?: boolean | null;
  completed_at?: string | null;
  /** Project-only (ADR 0015): present and non-null only when archived — the shelf's ❄ date. */
  archived_at?: string | null;
  created_at: string;
  updated_at: string;

  deps?: WireDeps;
  children?: NodeRef[];
  distribution?: Distribution;
  /** Per-project leaf-task status tally (MMR-105) — the project card's vitals panel. */
  leaf_counts?: Distribution;
  /** Per-project artifact tally (MMR-125) — the archived shelf's count line. */
  artifact_count?: number;
  tags?: WireTag[];
  annotations?: WireAnnotation[];
  artifacts?: WireArtifact[];
  history?: WireHistoryEntry[];
  verdicts?: Verdicts;
  attention?: WireAttention;
  /** Where the row lives (MMR-228) — rides node-list responses. */
  home?: WireHome;
};

/**
 * A grooming-queue seed (MMR-247) as the wire serves it — the contract's
 * `SeedView` in snake_case (mirrors `seedToWire` in `@mimir/bin` core/format.ts).
 * `lane` is served, not derived: consume it directly (MMR-245). `requester` is
 * null when self-filed (rendered "you"); `spawned` lists surviving work-node
 * stems; `ready_to_resolve` is the derived promoted-and-all-work-settled flag.
 * `description` rides only the detail read (list rows omit it).
 */
export type WireSeed = {
  id: string;
  project: string;
  title: string;
  kind: SeedKind;
  lifecycle: SeedLifecycle;
  lane: SeedLane;
  requester: string | null;
  spawned: string[];
  ready_to_resolve: boolean;
  created_at: string;
  updated_at: string;
  /** The seed body prose — present on the detail fetch, absent on list rows. */
  description?: string | null;
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

/** `/api/health` — the daemon's build + vault schema (MMR-260 stale-binary signal). */
export type WireHealth = {
  status: 'ok';
  version: string;
  schema: number;
};

/** The project key a rendered id belongs to (`MMR-16` → `MMR`, `MMR` → `MMR`). */
export function projectKeyOf(id: string): string {
  const dash = id.indexOf('-');
  return dash === -1 ? id : id.slice(0, dash);
}
