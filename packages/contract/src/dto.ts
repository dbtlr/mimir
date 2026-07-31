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
import type { ExecutionHandles } from './fields';
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
  /** The optional lede (MMR-319) — omitted when the artifact carries none. */
  summary?: string;
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
  /** The optional lede (MMR-319) — omitted when the artifact carries none. */
  summary?: string;
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
  /** The optional lede (MMR-319) — omitted when the artifact carries none. */
  summary?: string;
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
  /**
   * The resume handles in play at this transition (ADR 0026 Decision 3) —
   * present only on the boundary rows that move them: `start` echoes the CLAIM
   * STATE the task carries once claimed (which includes a handle pre-seeded at
   * `create`, not only what its own flags stamped), and a terminal/hold row
   * echoes what it cleared. So the append-only log preserves claim succession.
   * Absent everywhere else, never partially empty.
   */
  handles?: ExecutionHandles;
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
  /**
   * The in-flight resume handles (ADR 0026 Decision 3, MMR-320) — where the work
   * is happening and how to pick it back up. Task-only and free-form; they ride
   * like every other task scalar (null when unset), and the lifecycle verbs clear
   * them at terminal transitions and holds.
   */
  host?: string | null;
  harness?: string | null;
  session?: string | null;
  branch?: string | null;
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
  /**
   * The owned direction narrative — the `## Next` body section (MMR-321, ADR
   * 0026 Decision 2). Project and container (initiative/phase) docs only; a
   * task's prose homes are `description` and its annotations. Re-authored whole
   * on each write, never appended. Omitted entirely when the section is absent,
   * so an empty section and a missing one read alike.
   */
  next?: string;
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

/** An `overview` section carrying a capped task list plus its TRUE total (MMR-278):
 * the `count` is the full population even when `tasks` is capped (next/awaiting cap
 * at 5), so counts-before-contents holds regardless of the cap. */
export type OverviewSection = {
  /** The section's full population — may exceed `tasks.length` when capped. */
  count: number;
  /** The lean projection (as `list`/`next` emit), capped where the section caps. */
  tasks: NodeView[];
};

/** An `overview` awaiting row (MMR-278): a lean task plus the upstream ids it awaits
 * — the still-unsettled effective prerequisites (the `deps` facet's awaiting-on ids). */
export type OverviewAwaitingTask = {
  task: NodeView;
  /** The upstream node ids (`KEY-seq`) this task awaits — own or inherited edges. */
  awaitingOn: string[];
};

/**
 * One needs-attention row (MMR-322): a lean task plus the derived standing the
 * Overview's project cards already speak — the {@link Lane} its Status word falls
 * in, and the `going cold` modifier. Same vocabulary as {@link AttentionState},
 * one rung down: a lane over ONE leaf rather than the highest-wins lane over a
 * project's leaves.
 */
export type OverviewAttentionTask = {
  task: NodeView;
  lane: Lane;
  /** The `going cold` modifier — this task is past the stale threshold. */
  stale: boolean;
};

/** One untriaged-seed row in the hygiene listing (MMR-322) — the grooming queue's
 * own lean projection: id, title, and the derived `## Seed Description` lede
 * (MMR-263), `null` when the seed carries no body. */
export type OverviewSeed = {
  id: string;
  title: string;
  lede: string | null;
};

/** The capped listings behind the hygiene counts (MMR-322) — the head of each
 * attention lane, 5 rows apiece against the TRUE counts alongside them. `dropped`
 * has no listing by design: it is a load byproduct (MMR-184), not a set of tasks. */
export type OverviewHygieneListings = {
  blocked: OverviewAttentionTask[];
  stale: OverviewAttentionTask[];
  untriaged: OverviewSeed[];
};

/** The `overview` hygiene block (MMR-278, listings added MMR-322): the four counts,
 * each with its capped listing where one exists. Each nonzero count names a
 * follow-up command in the human render (`untriaged` → `mimir triage`,
 * `dropped` → `mimir doctor`, `blocked`/`stale` → the matching `mimir list`). */
export type OverviewHygiene = {
  /** New (untriaged) seeds on the board. */
  untriaged: number;
  /** Tasks whose status word is `blocked` (a manual hold). */
  blocked: number;
  /** Tasks that have gone quiet past the stale threshold. */
  stale: number;
  /** Records the tolerant reader dropped building the working set (MMR-184) —
   * `WorkingSet.issueCount`, the free validate byproduct, never a doctor pass. */
  dropped: number;
  /** The capped heads of the three task/seed-shaped counts (MMR-322). */
  listings: OverviewHygieneListings;
};

/** The `session_summary` artifact joined onto a recent-sessions entry (MMR-322) —
 * its id, title, and the MMR-319 lede when it carries one. */
export type OverviewSessionArtifact = {
  id: string;
  title: string;
  /** The artifact's `summary` lede — omitted when it carries none. */
  summary?: string;
};

/**
 * One recent-sessions entry (MMR-322, ADR 0026 Decision 4). The mechanical layer
 * is derived: transition-log rows grouped by the `session` resume handle they
 * echoed (MMR-320), which yields the session id, its activity window, the tasks
 * it touched, and how many boundaries it crossed. A `session_summary`-tagged
 * artifact joins on by linked-task overlap and supplies the retrospective lede.
 *
 * An entry with no `id` is a summary-only (knowledge-only) session: an artifact
 * whose links overlap no derived group — nothing crossed a boundary, so the log
 * has nothing to group. Its window is the artifact's `created_at` and its
 * `transitions` count is 0.
 */
export type OverviewSession = {
  /** The session id the grouped rows carried; `null` on a summary-only entry. */
  id: string | null;
  /** The activity window over the grouped rows (ISO-ms-Z). */
  from: string;
  to: string;
  /** How many transition rows carried this session id; `0` on a summary-only entry. */
  transitions: number;
  /** The tasks the session touched, in first-touch order. */
  tasks: NodeRef[];
  /** The joined session summary, when one matched. */
  artifact?: OverviewSessionArtifact;
};

/** The `overview` recent-sessions section (MMR-322) — entries newest-first, capped
 * at 5 against the TRUE total, exactly like `next`/`awaiting`. */
export type OverviewSessions = {
  count: number;
  entries: OverviewSession[];
};

/** One container's owned direction prose on the overview (MMR-322) — the `## Next`
 * body section (MMR-321) of an initiative or phase that parents live work. */
export type OverviewDirectionContainer = {
  id: string;
  title: string;
  next: string;
};

/**
 * The `overview` direction block (MMR-322) — the owned `## Next` prose (ADR 0026
 * Decision 2) rendered verbatim: the project's own narrative, plus the narrative
 * of every container parenting an in-flight or ready-head task. A dormant
 * container's prose stays one `mimir get` away rather than crowding the boot
 * surface. Spelled `direction` because the overview's `next` key is already the
 * ready-queue head; the node-level field keeps its `next` spelling.
 */
export type OverviewDirection = {
  /** The project doc's prose; `null` when the section is absent. */
  project: string | null;
  /** Containers with live work AND prose set — deduped, in board order. */
  containers: OverviewDirectionContainer[];
};

/**
 * The `mimir overview` composite (MMR-278, expanded MMR-322) — one project's
 * session-boot orientation surface, a `report`-kind read (ADR 0024). The
 * attention-ordered sections: the project header (id, status word, rollup
 * distribution — what `status KEY` answers), `direction` (the owned `## Next`
 * prose of the project and of the containers holding live work), `inFlight`
 * tasks (`in_progress` + `under_review`, uncapped), `next` (the ready-queue
 * head, top 5), `awaiting` (dependency-gated tasks, top 5, each carrying the
 * upstream ids it awaits), `sessions` (recent session activity with its joined
 * summary ledes, top 5), and `hygiene` counts with their capped listings.
 * Derived from ONE working-set load plus the bounded body-section and artifact
 * reads the composed sections need; renders as styled sections on a TTY and one
 * JSON envelope when piped.
 */
export type OverviewReport = {
  project: { id: string; status: StatusWord; distribution: Distribution };
  direction: OverviewDirection;
  inFlight: OverviewSection;
  next: OverviewSection;
  awaiting: { count: number; tasks: OverviewAwaitingTask[] };
  sessions: OverviewSessions;
  hygiene: OverviewHygiene;
};

/** The set-valued column names (flat, MMR-38), for `--col` parsing and the cheap-vs-heavy default sets. */
export const FACET_NAMES = [
  'deps',
  'description',
  'next',
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
 * per-node body read. `next` (the direction narrative, MMR-321) joins it: on a
 * NODE it costs nothing extra, riding the same batched section read
 * `description` already pays for; on a PROJECT — whose `description` is
 * frontmatter, not a body section — it is one additional document read. Bulk
 * `list`/`next`/`tree` pass their own facet lists, which exclude it. */
export const CHEAP_FACETS: readonly FacetName[] = [
  'deps',
  'description',
  'next',
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
 * rather than pulling `get`'s full facet set into every write echo. `next`
 * (MMR-321) rides for the same reason `description` does — a write that
 * re-authored the section echoes it back instead of dropping it. Free on a node
 * (it shares `description`'s batched section read); one extra document read on
 * a PROJECT echo, whose `description` is frontmatter and reads no body at all.
 */
export const WRITE_ECHO_FACETS: readonly FacetName[] = [
  'description',
  'next',
  'children',
  'distribution',
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
  /** How many records the tolerant reader dropped/noted while building the
   * working set this selection was read over (MMR-184) — the load's own
   * byproduct, not a fresh `mimir doctor` pass. The CLI nudges toward `mimir
   * doctor` on stderr when this is non-zero; absent when the load carried no
   * count (e.g. the value-fault short-circuit, which never reaches the store). */
  issueCount?: number;
};
