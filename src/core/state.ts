import type { Hold, Lifecycle, StateWord, TaskStateWord } from "../contract/enums";

/**
 * The State word machinery (ADR 0008): every node reduces to one canonical word
 * from a closed vocabulary, so rollup recurses (a phase tallies task words, an
 * initiative tallies phase words). Two pure functions:
 *
 * - `taskState` — a leaf task's two axes + readiness → its word.
 * - `interpret` — a non-leaf's child distribution → its word.
 */

/** The inputs a task's word is projected from. `awaiting` is consulted only in the `todo`+`none` case. */
export interface TaskStateInput {
  lifecycle: Lifecycle;
  hold: Hold;
  /** `true` iff the task has ≥1 incomplete dependency. Only meaningful when `lifecycle=todo` and `hold=none`. */
  awaiting: boolean;
}

/**
 * Project a task to its State word. Precedence, highest wins:
 *
 *   abandoned → done → blocked → parked → in_progress → awaiting → ready
 *
 * The one judgment call (ADR 0008): a started-but-held task reads as the *hold*
 * word, not `in_progress` — "set aside" is the salient glance-fact; the
 * in_progress position survives in the stored axis underneath.
 */
export function taskState({ lifecycle, hold, awaiting }: TaskStateInput): TaskStateWord {
  if (lifecycle === "abandoned") return "abandoned";
  if (lifecycle === "done") return "done";
  if (hold === "blocked") return "blocked";
  if (hold === "parked") return "parked";
  if (lifecycle === "in_progress") return "in_progress";
  // lifecycle === "todo", hold === "none"
  return awaiting ? "awaiting" : "ready";
}

/** A non-leaf node's rollup breakdown — counts of each State word among its direct children. */
export type Distribution = Partial<Record<StateWord, number>>;

/** Tally an iterable of State words into a {@link Distribution}. */
export function tally(words: Iterable<StateWord>): Distribution {
  const dist: Distribution = {};
  for (const word of words) {
    dist[word] = (dist[word] ?? 0) + 1;
  }
  return dist;
}

/** Total count across a distribution. */
export function distributionTotal(dist: Distribution): number {
  let total = 0;
  for (const count of Object.values(dist)) {
    total += count;
  }
  return total;
}

/**
 * Reduce a child distribution to the parent's State word (ADR 0008). A
 * precedence cascade — first non-empty bucket wins:
 *
 *   1. no children    → new          (empty-guard: never vacuously done)
 *   2. any in_progress → in_progress  (live work beats all)
 *   3. any ready       → ready        (actionable now)
 *   4. any awaiting     → awaiting     (actionable soon — deps self-clear)
 *   5. any blocked      → blocked      (externally stuck)
 *   6. any parked       → parked       (deliberately shelved)
 *   7. any new          → new          (only undefined sub-chunks remain)
 *   8. all terminal     → done if any done, else abandoned
 *
 * The load-bearing order is the middle `awaiting > blocked > parked`, by
 * distance to motion.
 */
export function interpret(dist: Distribution): StateWord {
  if (distributionTotal(dist) === 0) return "new";

  const has = (word: StateWord): boolean => (dist[word] ?? 0) > 0;

  if (has("in_progress")) return "in_progress";
  if (has("ready")) return "ready";
  if (has("awaiting")) return "awaiting";
  if (has("blocked")) return "blocked";
  if (has("parked")) return "parked";
  if (has("new")) return "new";
  // Only terminal words remain.
  return has("done") ? "done" : "abandoned";
}
