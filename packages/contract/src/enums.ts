/**
 * The closed vocabularies of the model — the enum leaf. These string-literal
 * unions are the *stored* values (the DB persists them verbatim; there is no
 * mapping layer) and the *external* vocabulary the CLI/MCP/UI speak. Defined
 * here once so `db`, `core`, and the transports share one definition.
 *
 * Each union ships with a runtime tuple of its members (`*_VALUES`) for
 * validation and iteration; the type is derived from the tuple so the two
 * cannot drift.
 */

/** The three node types in the work tree. `project` is a separate table, not a node. */
export const NODE_TYPE_VALUES = ['initiative', 'phase', 'task'] as const;
export type NodeType = (typeof NODE_TYPE_VALUES)[number];

/**
 * Lifecycle axis (ADR 0001) — pure progress, mutually exclusive, verb-driven.
 * `under_review` is an optional ship-readiness gate between `in_progress` and
 * `done` (MMR-84): the doer submits, a human approves (→done) or returns
 * (→in_progress). Optional — `in_progress → done` directly stays legal.
 */
export const LIFECYCLE_VALUES = [
  'todo',
  'in_progress',
  'under_review',
  'done',
  'abandoned',
] as const;
export type Lifecycle = (typeof LIFECYCLE_VALUES)[number];

/** Hold overlay (ADR 0001) — why a task is set aside, orthogonal to lifecycle. */
export const HOLD_VALUES = ['none', 'blocked', 'parked'] as const;
export type Hold = (typeof HOLD_VALUES)[number];

/** Priority signal (ADR 0007) — filters/advises, never the sort. Null = untriaged. */
export const PRIORITY_VALUES = ['p0', 'p1', 'p2', 'p3'] as const;
export type Priority = (typeof PRIORITY_VALUES)[number];

/** Size signal — `medium` ~ one session. Null = unsized; feeds stale policy. */
export const SIZE_VALUES = ['small', 'medium', 'large'] as const;
export type Size = (typeof SIZE_VALUES)[number];

/**
 * The closed **Status word** vocabulary (ADR 0008) — one canonical label per
 * node, the unit both the per-task projection and the rollup distribution use.
 *
 * `new` is non-leaf-only (an empty container); a task never projects to it.
 * The shared (task-reachable) subset is everything except `new`.
 */
export const STATUS_WORD_VALUES = [
  'ready',
  'awaiting',
  'blocked',
  'parked',
  'in_progress',
  'under_review',
  'done',
  'abandoned',
  'new',
] as const;
export type StatusWord = (typeof STATUS_WORD_VALUES)[number];

/** The status words a leaf task can project to — the closed set `interpret` recurses over, minus `new`. */
export const TASK_STATUS_WORD_VALUES = [
  'ready',
  'awaiting',
  'blocked',
  'parked',
  'in_progress',
  'under_review',
  'done',
  'abandoned',
] as const;
export type TaskStatusWord = (typeof TASK_STATUS_WORD_VALUES)[number];

/** Kinds of entity a tag (or artifact link) may attach to. */
export const TAG_ENTITY_TYPE_VALUES = ['project', 'node', 'artifact'] as const;
export type TagEntityType = (typeof TAG_ENTITY_TYPE_VALUES)[number];

/**
 * Seed kind (MMR-244) — the grooming-queue record's intrinsic classification, a
 * REQUIRED closed field, not a tag. The feature interprets it (capture pills,
 * promote home-suggestion, queue chips), so it is intrinsic, not a cross-cutting
 * grouping — ADR 0005 does not apply. Closed enum gives the validator real coverage.
 */
export const SEED_KIND_VALUES = ['idea', 'bug', 'feature'] as const;
export type SeedKind = (typeof SEED_KIND_VALUES)[number];

/**
 * Seed lifecycle (MMR-244) — triage progress: `new → promoted | resolved | rejected`
 * and `promoted → resolved | rejected`. The terminal states (`resolved`/`rejected`)
 * are set only by explicit triager verbs, never derived from spawned work (all
 * spawned tasks can be abandoned without satisfying the request). "Later" is
 * staying `new`; `resolved` is honest across all three kinds.
 */
export const SEED_LIFECYCLE_VALUES = ['new', 'promoted', 'resolved', 'rejected'] as const;
export type SeedLifecycle = (typeof SEED_LIFECYCLE_VALUES)[number];

/**
 * Seed lane (MMR-245) — the exclusive, highest-wins standing a seed view groups
 * into, the seed sibling of the node attention {@link Lane}. `untriaged` (new,
 * awaiting a decision), `ready` (promoted + all spawned work settled — ready to
 * resolve), `promoted` (in flight, work outstanding), `settled` (resolved/rejected).
 * `ready` wins over `promoted` so the attention signal is never buried. Exposed on
 * the wire so consumers derive nothing.
 */
export const SEED_LANE_VALUES = ['untriaged', 'ready', 'promoted', 'settled'] as const;
export type SeedLane = (typeof SEED_LANE_VALUES)[number];

/**
 * The seed queue `--status` universe (MMR-245): a lifecycle word, or the `live`
 * (new + promoted, the default) / `all` unions — the seed sibling of
 * {@link STATUS_SELECTOR_VALUES}. Single-sourced here so all three transports and
 * the {@link SeedStatusSelector} type derive from one vocabulary.
 */
export const SEED_STATUS_SELECTOR_VALUES = [...SEED_LIFECYCLE_VALUES, 'live', 'all'] as const;
export type SeedStatusSelector = (typeof SEED_STATUS_SELECTOR_VALUES)[number];

/** Transition-log row kinds (ADR 0003) — which axis/edge changed. `archive` is project-keyed (ADR 0015); the rest are node-keyed. */
export const TRANSITION_KIND_VALUES = [
  'lifecycle',
  'hold',
  'dependency',
  'move',
  'archive',
] as const;
export type TransitionKind = (typeof TRANSITION_KIND_VALUES)[number];
