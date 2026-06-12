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
export const NODE_TYPE_VALUES = ["initiative", "phase", "task"] as const;
export type NodeType = (typeof NODE_TYPE_VALUES)[number];

/** Lifecycle axis (ADR 0001) — pure progress, mutually exclusive, verb-driven. */
export const LIFECYCLE_VALUES = ["todo", "in_progress", "done", "abandoned"] as const;
export type Lifecycle = (typeof LIFECYCLE_VALUES)[number];

/** Hold overlay (ADR 0001) — why a task is set aside, orthogonal to lifecycle. */
export const HOLD_VALUES = ["none", "blocked", "parked"] as const;
export type Hold = (typeof HOLD_VALUES)[number];

/** Priority signal (ADR 0007) — filters/advises, never the sort. Null = untriaged. */
export const PRIORITY_VALUES = ["p0", "p1", "p2", "p3"] as const;
export type Priority = (typeof PRIORITY_VALUES)[number];

/** Size signal — `medium` ~ one session. Null = unsized; feeds stale policy. */
export const SIZE_VALUES = ["small", "medium", "large"] as const;
export type Size = (typeof SIZE_VALUES)[number];

/**
 * The closed **Status word** vocabulary (ADR 0008) — one canonical label per
 * node, the unit both the per-task projection and the rollup distribution use.
 *
 * `new` is non-leaf-only (an empty container); a task never projects to it.
 * The shared (task-reachable) subset is everything except `new`.
 */
export const STATUS_WORD_VALUES = [
  "ready",
  "awaiting",
  "blocked",
  "parked",
  "in_progress",
  "done",
  "abandoned",
  "new",
] as const;
export type StatusWord = (typeof STATUS_WORD_VALUES)[number];

/** The status words a leaf task can project to — the closed set `interpret` recurses over, minus `new`. */
export const TASK_STATUS_WORD_VALUES = [
  "ready",
  "awaiting",
  "blocked",
  "parked",
  "in_progress",
  "done",
  "abandoned",
] as const;
export type TaskStatusWord = (typeof TASK_STATUS_WORD_VALUES)[number];

/** Kinds of entity a tag (or artifact link) may attach to. */
export const TAG_ENTITY_TYPE_VALUES = ["project", "node", "artifact"] as const;
export type TagEntityType = (typeof TAG_ENTITY_TYPE_VALUES)[number];

/** Transition-log row kinds (ADR 0003) — which axis/edge changed. */
export const TRANSITION_KIND_VALUES = ["lifecycle", "hold", "dependency", "move"] as const;
export type TransitionKind = (typeof TRANSITION_KIND_VALUES)[number];
