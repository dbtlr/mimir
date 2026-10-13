import type {
  AwaitingRef,
  BlockOwner,
  Distribution,
  Grooming,
  Hold,
  Lifecycle,
  NodeRef,
  Priority,
  SearchKind,
  SearchLink,
  SearchMatch,
  SeedKind,
  SeedLane,
  SeedLifecycle,
  Size,
  StatusWord,
  TransitionKind,
  Verdicts,
  ViewType,
  WorkNeedsYouReason,
  WorkScope,
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
  /** The resume handles this transition set or cleared (MMR-320) — present only
   * on the boundary rows that move them (`start`, and the terminal/hold verbs). */
  handles?: Partial<Record<'branch' | 'harness' | 'host' | 'session', string>>;
};

export type WireArtifact = {
  id: string;
  title: string;
  summary?: string;
  tags: string[];
  created_at: string;
};

/**
 * One cross-record search hit (`GET /api/search`, MMR-447). `lifecycle` is the
 * stored one, `null` for kinds without it; `link` rides on `link` hits and
 * `snippet` on `description` hits.
 */
export type WireSearchHit = {
  kind: SearchKind;
  id: string;
  project: string;
  title: string;
  updated_at: string;
  lifecycle: Lifecycle | SeedLifecycle | null;
  finished: boolean;
  match: SearchMatch;
  link?: SearchLink;
  snippet?: string;
};

/** A portfolio artifact-search row (`GET /api/artifacts`). */
export type WireArtifactSummary = {
  id: string;
  title: string;
  /** The optional lede (MMR-319) — absent when the artifact carries none. */
  summary?: string;
  project: string;
  tags: string[];
  /** The ids of the records the artifact is attached to (MMR-454), sorted. */
  links: string[];
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
  /** The optional lede (MMR-319) — absent when the artifact carries none. */
  summary?: string;
  project: string;
  links: WireArtifactLink[];
  tags: string[];
  created_at: string;
  content?: string;
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

  /** Facet — only present on the detail fetch, not list responses. */
  description?: string | null;
  /** Facet (MMR-321) — the owned `## Next` direction narrative on a project,
   * initiative, or phase. Absent entirely when the section is unset. */
  next?: string;
  /** Short single-line lede for list/board views (all-node, optional). */
  summary?: string | null;
  /** Facet (MMR-454) — the list row's one-line preview: the stored summary when
   * set, else derived from the description (ADR 0021). Only on reads that ask
   * for it (`col=lede`); null when there is nothing to show or the read failed. */
  lede?: string | null;

  priority?: Priority | null;
  size?: Size | null;
  lifecycle?: Lifecycle;
  /** The stored grooming judgment (ADR 0033) — task-only; views read it for todo tasks only. */
  grooming?: Grooming;
  hold?: Hold;
  hold_reason?: string | null;
  /** Who can clear a block (ADR 0001, MMR-438) — `you` or `others`; set only while `hold` is `blocked`. */
  block_owner?: BlockOwner | null;
  external_ref?: string | null;
  /** The in-flight resume handles (MMR-320) — task-only; cleared at terminal
   * transitions and holds, kept through the under-review gate. */
  host?: string | null;
  harness?: string | null;
  session?: string | null;
  branch?: string | null;
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
  /** The derived body lede (MMR-263) — a bounded preview served on LIVE queue rows
   * (never stored); absent on settled rows and on the detail read (which carries the
   * full `description`). `null` when the seed has no body. */
  lede?: string | null;
};

/** The nested whole-project tree (`/api/projects/:key/tree`) — children rank-ordered. */
export type WireTreeNode = {
  children: WireTreeNode[];
} & Omit<WireNode, 'children'>;

/** An active Scratchpad row (`GET /api/scratchpads`) — the work it is anchored to rides along. */
export type WireScratchpadRow = {
  id: string;
  project: string;
  title: string;
  linked_work: string[];
  open_agenda: number;
  state: 'active' | 'freezing';
  updated_at: string;
};

/**
 * The work page's rows (`GET /api/projects/:key/work`, `GET /api/nodes/:id/work`,
 * MMR-469) — each is the lean node object with its section's fields folded on,
 * snake_case as `workToWire` in `@mimir/bin` core/format.ts renders them. A row
 * can be stale in any section but Shipped, which only ever carries `false`.
 */
export type WireWorkNow = {
  started_at: string;
  latest_note: { content: string; created_at: string } | null;
  scratchpads: { id: string; title: string }[];
  stale: boolean;
} & WireNode;

export type WireWorkNeedsYou = {
  reason: WorkNeedsYouReason;
  /** The latest note's text for a needs-answers row, otherwise null. */
  question: string | null;
  stale: boolean;
} & WireNode;

/** A frontier task, or in `to_groom` a container that reads to break down. */
export type WireWorkFrontier = {
  /** The unsettled prerequisite ids, empty when ready. */
  awaiting_on: string[];
  break_down: boolean;
  stale: boolean;
} & WireNode;

export type WireWorkUnlockGroup = {
  prerequisite: NodeRef;
  tasks: WireWorkFrontier[];
};

export type WireWorkWaiting = {
  block_reason: string | null;
  stale: boolean;
} & WireNode;

export type WireWorkShipped = {
  finished_at: string;
  /** The reason an abandoned task carries; null for a done task. */
  abandon_reason: string | null;
  stale: boolean;
} & WireNode;

/** The work page for a project or one container's subtree. */
export type WireWorkReport = {
  scope: WorkScope;
  now: WireWorkNow[];
  needs_you: WireWorkNeedsYou[];
  frontier: {
    runnable: WireWorkFrontier[];
    next_to_unlock: WireWorkUnlockGroup[];
    to_groom: WireWorkFrontier[];
    waiting_on_others: WireWorkWaiting[];
  };
  shipped: WireWorkShipped[];
  going_cold: WireNode[];
};

/** A project as the review page names it. */
export type WireReviewProjectRef = { key: string; name: string };

/** One row of the review page's project list. */
export type WireReviewProject = WireReviewProjectRef & {
  decisions: number;
  /** Untriaged seeds, plus tasks going cold, plus `doctor` findings. */
  triage: number;
  in_flight: number;
};

/** One project's triage: untriaged seeds oldest first, and the going-cold and findings counts. */
export type WireReviewTriage = {
  project: WireReviewProjectRef;
  seeds: WireSeed[];
  going_cold: number;
  findings: number;
};

/**
 * The cross-project review page (`GET /api/review`, MMR-477). `decisions` and
 * `projects` share one project order; `queue` is every decision's id in
 * focus-queue order, so its length is the decision count.
 */
export type WireReviewReport = {
  decisions: { project: WireReviewProjectRef; rows: WireWorkNeedsYou[] }[];
  queue: string[];
  triage: WireReviewTriage[];
  projects: WireReviewProject[];
  /** The newest done or abandoned task across active projects; null when none has finished. */
  last_finished: WireWorkShipped | null;
};

/** The collection envelope with its count (ADR 0012 — never a bare array). */
export type Collection<T> = {
  total: number;
  items: T[];
};

/** `/api/health` — the daemon's build + store schema (MMR-260 stale-binary signal). */
export type WireHealth = {
  status: 'ok';
  version: string;
  schema: number;
};

/** One `mimir doctor` finding on the `/api/doctor` wire (MMR-185) — its cause
 * chip, the row's `<table>/<key>` locator, the offending column and value when
 * the finding names one, and the finding's structured evidence. */
export type WireDoctorRecord = {
  id: string;
  cause: string;
  severity: 'error' | 'warn';
  locator: string;
  field: string | null;
  value: string | null;
  evidence: Record<string, unknown>;
  note: string;
};

/** One project's findings. */
export type WireDoctorGroup = {
  project: string;
  finding_count: number;
  records: WireDoctorRecord[];
};

/** `/api/doctor` (MMR-185) — the record-health facet: `mimir doctor` findings
 * grouped by project, with the scan time the panel derives "last scan Ns ago" from.
 * `scope` is null on an unscoped scan; a scoped one reports how many records the
 * project holds, so an unknown key (zero) never reads as a clean board. */
export type WireDoctorFacet = {
  scanned_at: string;
  finding_total: number;
  groups: WireDoctorGroup[];
  scope: { key: string; matched_records: number } | null;
};

/** The project key a rendered id belongs to (`MMR-16` → `MMR`, `MMR` → `MMR`). */
export function projectKeyOf(id: string): string {
  const dash = id.indexOf('-');
  return dash === -1 ? id : id.slice(0, dash);
}
