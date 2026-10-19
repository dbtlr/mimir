// Distribution is re-exported AND used locally — a plain `export … from`
// wouldn't bind it in-file.
// oxlint-disable-next-line unicorn/prefer-export-from
import type { Distribution, Hold, Lifecycle, StatusWord, TaskStatusWord } from '@mimir/contract';

export type { Distribution };

/**
 * The Status word machinery (ADR 0008): every node reduces to one canonical word
 * from a closed vocabulary, so rollup recurses (a phase tallies task words, an
 * initiative tallies phase words). Two pure functions:
 *
 * - `taskStatus` — a leaf task's two axes + readiness → its word.
 * - `interpret` — a non-leaf's child distribution → its word.
 */

/** The inputs a task's word is projected from. `awaiting` is consulted only in the `todo`+`none` case. */
export type TaskStatusInput = {
  lifecycle: Lifecycle;
  hold: Hold;
  /** `true` iff the task has ≥1 incomplete dependency. Only meaningful when `lifecycle=todo` and `hold=none`. */
  awaiting: boolean;
};

/**
 * Project a task to its Status word. Precedence, highest wins:
 *
 *   abandoned → done → blocked → parked → in_progress → under_review → queued → awaiting → ready
 *
 * `under_review` and `in_progress` are mutually-exclusive lifecycle positions,
 * so their relative order is moot; both sit below the holds, so a held review
 * reads as the hold word (the same started-but-held judgment, below).
 *
 * The one judgment call (ADR 0008): a started-but-held task reads as the *hold*
 * word, not `in_progress` — "set aside" is the salient glance-fact; the
 * in_progress position survives in the stored axis underneath.
 */
export function taskStatus({ lifecycle, hold, awaiting }: TaskStatusInput): TaskStatusWord {
  if (lifecycle === 'abandoned') {
    return 'abandoned';
  }
  if (lifecycle === 'done') {
    return 'done';
  }
  if (hold === 'blocked') {
    return 'blocked';
  }
  if (hold === 'parked') {
    return 'parked';
  }
  if (lifecycle === 'in_progress') {
    return 'in_progress';
  }
  if (lifecycle === 'under_review') {
    return 'under_review';
  }
  if (lifecycle === 'queued') {
    return 'queued';
  }
  // lifecycle === "todo", hold === "none"
  return awaiting ? 'awaiting' : 'ready';
}

/** Tally an iterable of Status words into a {@link Distribution}. */
export function tally(words: Iterable<StatusWord>): Distribution {
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
 * Reduce a child distribution to the parent's Status word (ADR 0008). A
 * precedence cascade — first non-empty bucket wins:
 *
 *   no children → new (never vacuously done)
 *   in_progress > under_review > queued > awaiting > ready > blocked > parked > new
 *   all terminal → done if any done, else abandoned
 *
 * Active work and reservations take precedence over work awaiting prerequisites,
 * which takes precedence over ready tasks. Holds remain below actionable work.
 */
export function interpret(dist: Distribution): StatusWord {
  if (distributionTotal(dist) === 0) {
    return 'new';
  }

  const has = (word: StatusWord): boolean => (dist[word] ?? 0) > 0;

  if (has('in_progress')) {
    return 'in_progress';
  }
  if (has('under_review')) {
    return 'under_review';
  }
  if (has('queued')) {
    return 'queued';
  }
  if (has('awaiting')) {
    return 'awaiting';
  }
  if (has('ready')) {
    return 'ready';
  }
  if (has('blocked')) {
    return 'blocked';
  }
  if (has('parked')) {
    return 'parked';
  }
  if (has('new')) {
    return 'new';
  }
  // Only terminal words remain.
  return has('done') ? 'done' : 'abandoned';
}
