import type { Hold, Lifecycle, NodeType, Priority, Size, StateWord, TransitionKind } from "./enums";

/**
 * The projection DTOs — the shape the intent layer produces and the CLI/MCP/UI
 * render (output-contract reference). One vocabulary on every selection
 * front-end: **bare fields** (scalars, always cheap) + **dot-facets** (sets /
 * sub-objects, opt-in because they cost extra queries).
 *
 * Identity is the rendered `KEY-seq` id; the surrogate int is never exposed
 * (ADR 0006). `rank` is deliberately **not** a field — array order carries the
 * intent (ADR 0007).
 */

/** A non-leaf node's rollup breakdown — counts of each State word among its direct children. */
export type Distribution = Partial<Record<StateWord, number>>;

/** A light reference to another node — its id, optionally its State word. */
export interface NodeRef {
  id: string;
  state?: StateWord;
}

/** `.deps` — prerequisites of this node plus the derived `blocking` reverse set. */
export interface DepsFacet {
  dependsOn: NodeRef[];
  blocking: NodeRef[];
}

/** `.annotations` — freeform in-flight notes. */
export interface AnnotationView {
  content: string;
  createdAt: string;
}

/** `.tags` — tags on this node. */
export interface TagView {
  tag: string;
  note: string | null;
  createdAt: string;
}

/** `.artifacts` — attached artifacts (metadata only; bodies fetched separately, byte-faithful). */
export interface ArtifactView {
  id: number;
  tags: string[];
  createdAt: string;
}

/** `.history` — a transition-log entry (heavy; opt-in even on `get`). */
export interface HistoryEntry {
  kind: TransitionKind;
  from: string | null;
  to: string | null;
  at: string;
  reason: string | null;
}

/**
 * The projected view of a node. Bare fields are always populated (one row);
 * task-only / phase-only fields are present only for that type; facets are
 * present only when requested.
 */
export interface NodeView {
  // bare — all nodes
  id: string;
  type: NodeType;
  title: string;
  state: StateWord;
  parent: string | null;
  description: string | null;
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

  // facets — opt-in
  deps?: DepsFacet;
  annotations?: AnnotationView[];
  artifacts?: ArtifactView[];
  history?: HistoryEntry[];
  tags?: TagView[];
  children?: NodeRef[];
  distribution?: Distribution;
}

/** A node's `status_of`: the rollup distribution and its single `interpret` label together. */
export interface StatusView {
  id: string;
  state: StateWord;
  distribution: Distribution;
}

/** The dot-facet names, for `--col` parsing and the cheap-vs-heavy default sets. */
export const FACET_NAMES = [
  "deps",
  "annotations",
  "artifacts",
  "history",
  "tags",
  "children",
  "distribution",
] as const;
export type FacetName = (typeof FACET_NAMES)[number];

/** Cheap facets included by default on a targeted `get`; `history` stays opt-in. */
export const CHEAP_FACETS: readonly FacetName[] = [
  "deps",
  "tags",
  "children",
  "distribution",
  "annotations",
  "artifacts",
];

/** The lean bare-field set for broad selection (`next`/`list`). */
export const LEAN_COLS = ["id", "title", "state", "priority", "size"] as const;

/**
 * A count-led set result. The JSON format renders `items` under a unit key
 * (`tasks`), and `truncated` is derivable (`returned < total`) so it is not
 * carried.
 */
export interface SetResult<T> {
  total: number;
  returned: number;
  startsAt: number;
  items: T[];
}
