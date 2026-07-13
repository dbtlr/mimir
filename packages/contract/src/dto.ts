import type {
  Hold,
  Lifecycle,
  NodeType,
  Priority,
  SeedKind,
  SeedLifecycle,
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

/**
 * A resolved seed record (MMR-245) — the verb-facing projection of a
 * `KEY-sN` grooming-queue seed. Read through the shared resolving seam
 * (`listSeeds`/`getSeed`), so `requester` and `spawned` are already what a
 * validated read keeps: an unknown `requester` reads as `null` (self-filed) and
 * a `spawned` list is pruned to the work nodes that still resolve.
 * `readyToResolve` is derived live (never stored, house rule): a `promoted`
 * seed whose surviving spawned work is all settled.
 */
export type SeedView = {
  /** Rendered `KEY-sN` id (MMR-244). */
  id: string;
  /** The owning (target) project key. */
  project: string;
  title: string;
  kind: SeedKind;
  lifecycle: SeedLifecycle;
  /** Requester-side project key; `null` = self-filed (or an unknown project, nulled on read). */
  requester: string | null;
  /** Surviving spawned work-node stems (`KEY-seq`) — dangling refs pruned on read. */
  spawned: string[];
  /** Derived: a promoted seed whose (surviving) spawned work is all settled. */
  readyToResolve: boolean;
  createdAt: string;
  updatedAt: string;
  /** The `## Seed Description` prose — opt-in (content read); `null` when empty. */
  description?: string | null;
  /** The bounded, read-time preview of the description prose (MMR-263) — derived
   * on the LIVE queue read (never stored); absent on settled list rows and on the
   * detail read (which carries the full `description`). `null` when the seed has
   * no body. */
  lede?: string | null;
};

/**
 * One requester-side task whose `upstream` seed went terminal (MMR-246, triage
 * check c) — the record the triage pass appends an idempotent annotation for and
 * suggests unblocking. `annotated` / `alreadyRecorded` are mutually exclusive per
 * run: a first pass writes the annotation (`annotated`), a re-run recognizes its
 * own marker and skips (`alreadyRecorded`); under `--dry-run` neither is true for
 * a not-yet-recorded task (it would be annotated). `blocked` mirrors the task's
 * `hold` — triage never transitions, so unblock stays an operator suggestion.
 */
export type UpstreamResolution = {
  /** The requester-side task stem (`KEY-seq`). */
  task: string;
  /** The upstream seed id (`KEY-sN`) — may point at another board. */
  upstream: string;
  /** The seed's terminal lifecycle (`resolved` | `rejected`). */
  lifecycle: SeedLifecycle;
  /** The resolution reason, pulled from the seed's `## History` terminal record;
   * `null` when the seed carries no terminal reason (degrades gracefully). */
  reason: string | null;
  /** An annotation was written this run (false under `--dry-run` and when already recorded). */
  annotated: boolean;
  /** The task already carried this terminal's annotation before the run (idempotent skip). */
  alreadyRecorded: boolean;
  /** The task is currently `blocked` — triage suggests unblock (never transitions). */
  blocked: boolean;
};

/**
 * One check-(c) task the triage pass could NOT reconcile (MMR-246) — skipped so a
 * single bad task never aborts the board pass. Two causes: a corrupt
 * `## Annotations` anchor (a duplicate/missing heading norn cannot resolve —
 * appending would refuse), or a per-task read fault (e.g. a flaky cross-board
 * seed read). The pass records it here and continues; `mimir doctor` diagnoses
 * the corruption class.
 */
export type TriageFailure = {
  /** The requester-side task stem (`KEY-seq`) that was skipped. */
  task: string;
  /** Why it was skipped — human-facing; a corrupt-anchor message points at `mimir doctor`. */
  message: string;
};

/**
 * The `mimir triage [KEY]` report (MMR-246) — one board's explicit-run
 * reconciliation pass over three checks: (a) `untriaged` new seeds, (b)
 * `readyToResolve` promoted seeds whose spawned work has all settled, and (c)
 * `upstreamResolutions` over the board's OWN tasks whose `upstream` seed went
 * terminal. Writes the check-(c) annotations by default; `dryRun` previews with
 * no writes. A report, never a gate — it always succeeds (exit 0).
 *
 * Idempotency is scoped to SERIAL re-runs: a re-run recognizes its own marker and
 * is a no-op. Concurrent runs can duplicate a check-(c) annotation (read-then-
 * append with no content CAS), so the pass is single-writer per board.
 */
export type TriageReport = {
  /** The board this pass reconciled. */
  board: string;
  /** True when previewed with `--dry-run` (no annotations written). */
  dryRun: boolean;
  /** Check (a): the board's new/untriaged seeds (the `untriaged` lane). */
  untriaged: SeedView[];
  /** Check (b): the board's promoted seeds whose spawned work has all settled. */
  readyToResolve: SeedView[];
  /** Check (c): the board's tasks whose `upstream` seed went terminal. */
  upstreamResolutions: UpstreamResolution[];
  /** Check (c) tasks skipped (corrupt anchor / read fault) — the pass never aborts. */
  failures: TriageFailure[];
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

/**
 * `home` — where a row lives (MMR-228): the owning project's KEY plus the
 * parent container's rendered id, title, and open-endedness, resolved
 * server-side so portfolio list surfaces can render `project › parent ∞`
 * without a per-parent fetch. Parent fields are null for a root-level node.
 */
export type HomeFacet = {
  projectKey: string;
  parentId: string | null;
  parentTitle: string | null;
  parentOpenEnded: boolean | null;
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
  /** The requester-side seed pointer (`KEY-sN`, MMR-244/245) — reference-only. */
  upstream?: string | null;
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
  /** Per-project artifact tally (MMR-125) — the archived shelf's count line; the
   * list-facet address for a count the archived-404 detail route can't serve. */
  artifactCount?: number;
  verdicts?: Verdicts;
  attention?: AttentionState;
  /** Where the row lives (MMR-228) — project KEY + parent container ref. */
  home?: HomeFacet;
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
  'artifactCount',
  'verdicts',
  'attention',
  'home',
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

/**
 * The write-echo facet set (ADR 0003): the CLI and MCP mutation echoes — node
 * and project alike — project the affected record through this set (HTTP's
 * echoes request their own broader detail sets, which carry these fields too).
 * `description` so a mutation that set it echoes the value back rather than
 * dropping the field it just wrote (MMR-162); `children` + `distribution` so a
 * container's echoed status line rolls up over its real children instead of
 * reading as an unloaded, childless node (MMR-242) — the same rollup sources
 * `get`'s `CHEAP_FACETS` draws on (both, because a transparent open-ended
 * child tallies in `children` but not `distribution`, MMR-204), kept lean
 * rather than pulling `get`'s full facet set into every write echo.
 */
export const WRITE_ECHO_FACETS: readonly FacetName[] = ['description', 'children', 'distribution'];

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
