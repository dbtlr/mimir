import type {
  Hold,
  Lifecycle,
  NodeType,
  Priority,
  Size,
  StatusWord,
  TransitionKind,
} from './enums';
import type { ValueWarning } from './query';

/**
 * The projection DTOs — the shape the intent layer produces and the CLI/MCP/UI
 * render (output-contract reference). One vocabulary on every selection
 * front-end: **bare fields** (scalars, always cheap) + **set-valued columns** (sets /
 * sub-objects, opt-in because they cost extra queries).
 *
 * Identity is the rendered `KEY-seq` id; the surrogate int is never exposed
 * (ADR 0006). `rank` is deliberately **not** a field — array order carries the
 * intent (ADR 0007).
 */

/** A non-leaf node's rollup breakdown — counts of each Status word among its direct children. */
export type Distribution = Partial<Record<StatusWord, number>>;

/** The projected `type` vocabulary — the three tree-node types plus the project itself (MMR-32). */
export type ViewType = NodeType | 'project';

/** A light reference to another node — its id, title, and optionally its Status word. */
export type NodeRef = {
  id: string;
  title?: string;
  status?: StatusWord;
};

/**
 * An unsettled **effective** prerequisite gating this node — a {@link NodeRef}
 * plus, when the edge is inherited from an ancestor rather than declared on the
 * node itself, the ancestor that carries it (`via`).
 */
export type AwaitingRef = NodeRef & { via?: string };

/**
 * `deps` — the node's declared prerequisites (`dependsOn`, direct edges only),
 * the derived `blocking` reverse set, and `awaitingOn`: the still-unsettled
 * effective prerequisites (own *or inherited*), each tagged with its `via`
 * ancestor when inherited (ADR 0001 Refinement).
 */
export type DepsFacet = {
  dependsOn: NodeRef[];
  awaitingOn: AwaitingRef[];
  blocking: NodeRef[];
};

/** `annotations` — freeform in-flight notes. */
export type AnnotationView = {
  content: string;
  createdAt: string;
};

/** `tags` — tags on this node. */
export type TagView = {
  tag: string;
  note: string | null;
  createdAt: string;
};

/** A portfolio artifact-search result row (`listArtifacts`) — metadata, no body. */
export type ArtifactSummary = {
  id: string;
  title: string;
  project: string;
  tags: string[];
  createdAt: string;
};

/** `artifacts` — attached artifacts (metadata only; bodies fetched separately, byte-faithful). */
export type ArtifactView = {
  /** Rendered `KEY-aN` id (MMR-32) — the surrogate int never crosses the surface. */
  id: string;
  /** Required human handle (MMR-34). */
  title: string;
  tags: string[];
  createdAt: string;
};

/**
 * A standalone artifact record (`get KEY-aN`, MMR-32) — metadata plus the
 * nodes it links to. The frozen body stays out of the default projection
 * (the deliberately-heavy `content` column, MMR-34).
 */
export type ArtifactDetail = {
  id: string;
  title: string;
  project: string;
  links: string[];
  tags: string[];
  createdAt: string;
  /** The frozen body — the one deliberately heavy column, opt-in always (MMR-34). */
  content?: string;
};

/** `history` — a transition-log entry (heavy; opt-in even on `get`). */
export type HistoryEntry = {
  kind: TransitionKind;
  from: string | null;
  to: string | null;
  at: string;
  reason: string | null;
};

/**
 * `verdicts` — the derived-predicate verdicts that aren't Status words
 * (the `--is` vocabulary, MMR-33), as one read. `stale`/`orphaned` are
 * task-only and read `false` on containers; `blocking` applies to any node.
 */
export type Verdicts = {
  stale: boolean;
  blocking: boolean;
  orphaned: boolean;
};

/**
 * The Lanes (MMR-101) — the four exclusive, highest-wins standings the Overview
 * groups a project into, ordered by *how much the operator's action moves it*:
 * `awaiting_you` (a review only you can clear) over `live` (work in motion) over
 * `needs_unsticking` (blocked/awaiting, often on something external) over
 * `at_rest` (nothing actionable). The operator-facing sibling of the container
 * rollup word: projects store no status, so the Overview derives a coarse
 * standing over their leaves the way `interpret()` derives a word over a
 * container's children — same spine, a 4-value vocabulary instead of the status
 * words. `going cold` (stale) is a modifier that rides a lane, not a lane.
 */
export type Lane = 'awaiting_you' | 'live' | 'needs_unsticking' | 'at_rest';

/**
 * `attention` — a project's derived attention-state (MMR-101): its highest-wins
 * {@link Lane}, the recency of its most-recent task touch (`lastActivity` =
 * `max(updated_at)` over leaf tasks; the project's own `updatedAt` when empty),
 * and the `going cold` modifier (`stale` = ≥1 leaf task is stale). Project-only;
 * intra-lane recency ordering is the consumer's (MMR-102), never cross-lane.
 */
export type AttentionState = {
  lane: Lane;
  lastActivity: string;
  stale: boolean;
};

/** A cross-cutting transition-log read (`/api/transitions`) — `node` is the rendered id. */
export type TransitionView = {
  node: string;
  kind: TransitionKind;
  from: string | null;
  to: string | null;
  at: string;
  reason: string | null;
};

/** A transitions page: entries after the caller's cursor, plus the cursor to resume from. */
export type TransitionsResult = {
  items: TransitionView[];
  /** Opaque resume cursor — present when any items were returned. */
  nextCursor?: string;
};

/**
 * The projected view of a node. Bare fields are always populated (one row);
 * task-only / phase-only fields are present only for that type; facets are
 * present only when requested.
 */
export type NodeView = {
  // bare — all nodes (and the project view, MMR-32)
  id: string;
  type: ViewType;
  title: string;
  status: StatusWord;
  parent: string | null;
  /** The short list lede (MMR-162) — all-node, never type-gated, bulk-cheap. */
  summary?: string | null;
  createdAt: string;
  updatedAt: string;

  // bare — task-only
  priority?: Priority | null;
  size?: Size | null;
  lifecycle?: Lifecycle;
  hold?: Hold;
  holdReason?: string | null;
  externalRef?: string | null;
  completedAt?: string | null;

  // bare — phase-only
  target?: string | null;

  // bare — container-only (phase/initiative): purposefully open-ended, opts out
  // of done-rollup (MMR-204). Reflects the stored value (true/false/null).
  open_ended?: boolean | null;

  // bare — project-only: the archived operator axis (ADR 0015). Present and
  // non-null only when the project is archived (surfaced via the archived door).
  archivedAt?: string | null;

  // facets — opt-in
  /**
   * Full description prose — the `## Task Description` body section,
   * authoritative since MMR-162 (ADR 0016 Refinement). A facet, not a bare
   * field: read per node on a detail `get` (in {@link CHEAP_FACETS}), absent
   * from bulk `list`/`next` rows. For a project view it carries the project's
   * (still frontmatter) description.
   */
  description?: string | null;
  deps?: DepsFacet;
  annotations?: AnnotationView[];
  artifacts?: ArtifactView[];
  history?: HistoryEntry[];
  tags?: TagView[];
  children?: NodeRef[];
  distribution?: Distribution;
  /** Per-project leaf-task status tally (MMR-105) — the project card's vitals panel. */
  leafCounts?: Distribution;
  verdicts?: Verdicts;
  attention?: AttentionState;
};

/**
 * A node in the nested whole-project tree (`/api/projects/:key/tree`) — the
 * same record shape everywhere, with `children` carrying full nested records
 * instead of light refs. Children arrive rank-ordered (rank carries as array
 * order, never a field — ADR 0007), containers by seq.
 */
export type TreeView = {
  children: TreeView[];
} & Omit<NodeView, 'children'>;

/** A node's `status_of`: the rollup distribution and its single `interpret` label together. */
export type StatusView = {
  id: string;
  /** The node's type — used by renderers to distinguish containers from leaf tasks. */
  type: ViewType;
  status: StatusWord;
  distribution: Distribution;
};

/** The set-valued column names (flat, MMR-38), for `--col` parsing and the cheap-vs-heavy default sets. */
export const FACET_NAMES = [
  'deps',
  'description',
  'annotations',
  'artifacts',
  'history',
  'tags',
  'children',
  'distribution',
  'leafCounts',
  'verdicts',
  'attention',
] as const;
export type FacetName = (typeof FACET_NAMES)[number];

/** Cheap facets included by default on a targeted `get`; `history` stays opt-in.
 * `description` (the body prose, MMR-162) is here — a detail `get` shows it, but
 * bulk `list`/`next` (which pass no facets) omit it, so they never pay the
 * per-node body read. */
export const CHEAP_FACETS: readonly FacetName[] = [
  'deps',
  'description',
  'tags',
  'children',
  'distribution',
  'annotations',
  'artifacts',
];

/** The lean bare-field set for broad selection (`next`/`list`); `parent` is the row's hierarchy anchor (MMR-87). */
export const LEAN_COLS = ['id', 'title', 'status', 'priority', 'size', 'parent'] as const;

/**
 * A count-led set result. The JSON format renders `items` under a unit key
 * (`tasks`), and `truncated` is derivable (`returned < total`) so it is not
 * carried. `warnings` carries value faults (MMR-33) — the CLI renders them on
 * stderr; MCP folds them into the payload.
 */
export type SetResult<T> = {
  total: number;
  returned: number;
  startsAt: number;
  items: T[];
  warnings?: ValueWarning[];
};
