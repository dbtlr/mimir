import type { Hold, Lifecycle } from './enums';

/**
 * The operation facts (ADR 0025 Decision 3/4) — the pure-fact half of the
 * operation registry, the verb analogue of {@link FIELD_FACTS}. The twelve
 * **uniform verbs** (six lifecycle, four hold, `archive`/`unarchive` — the
 * "subject id + optional reason" shape) declare their dispatch facts here once:
 * the subject id-kind, the reason policy, the (descriptive) state transition,
 * and one canonical summary sentence. From this one table the transports derive
 * their surfaces — the CLI's twelve switch arms collapse to one generic arm, MCP
 * registrations and HTTP routes loop-generate — while each keeps its own
 * invocation grammar. This module is data only: the `run` binding that delegates
 * to the core mutation fns lives in the core (`core/ops.ts`), which composes
 * these facts with that binding. All rendered text (CLI help + echo lines, MCP
 * tool descriptions) is a per-transport view **template** over these facts, not a
 * per-transport prose field here (ADR 0025 Decision 4 — strict derivation, no
 * per-transport override fields; a fact knob must serve ≥2 consumers, else it
 * belongs in a view template).
 *
 * The twenty-nine non-uniform verbs (create, depend, move, the seed verbs, …)
 * stay bespoke and never route through this registry — one way for the uniform
 * job, not one way forced onto every job (ADR 0025 Decision 3).
 */

/** The twelve uniform-verb names, in concern-grouped order (lifecycle → hold →
 * project), the order the transports iterate for grouped rendering. */
export const UNIFORM_VERBS = [
  'start',
  'submit',
  'return',
  'done',
  'abandon',
  'reopen',
  'park',
  'unpark',
  'block',
  'unblock',
  'archive',
  'unarchive',
] as const;
export type UniformVerb = (typeof UNIFORM_VERBS)[number];

/** The id-kind a uniform verb acts on: a work node (KEY-seq task) or a project (bare KEY). */
export type OpSubject = 'task' | 'project';

/** A uniform verb's reason policy — the only two the twelve span (ADR 0025): a
 * verb takes an optional reason (recorded on the transition log) or none. */
export type OpReason = 'none' | 'optional';

/** The two-valued archive axis a project moves along (`archive`/`unarchive`). */
export type ArchiveState = 'active' | 'archived';

/**
 * A uniform verb's **descriptive** state transition — a dispatch/rendering fact,
 * not a state machine: the imperative transition guards stay in the core
 * mutations (`core/mutations/*`). `from` models each axis honestly — a lifecycle
 * move names its accepted source states (one, or the set a terminal/reopen move
 * accepts) and its destination; a hold move names the overlay entered or the
 * `none` it releases to; an archive move names the project state edge.
 */
export type OpTransition =
  | { axis: 'lifecycle'; from: readonly Lifecycle[]; to: Lifecycle }
  | { axis: 'hold'; from: Hold; to: Hold }
  | { axis: 'archive'; from: ArchiveState; to: ArchiveState };

/** One uniform verb's pure dispatch facts (ADR 0025 Decision 3). */
export type OpFact = {
  /** The id-kind the verb resolves and acts on (drives the transport grammar). */
  subject: OpSubject;
  /** Whether a trailing reason is accepted (recorded on the transition log). */
  reason: OpReason;
  /** The descriptive state transition — the arrow every view renders from. */
  transition: OpTransition;
  /** One canonical sentence — the lower-case prose base every transport's view
   * template composes (with the transition arrow, reason clause, echo clause). */
  summary: string;
};

/**
 * The operation facts — one entry per uniform verb (keyed by verb; the
 * concern-grouped iteration order lives in {@link UNIFORM_VERBS}, which the
 * transports loop). The CLI dispatch/echo/help, the MCP registrations, and the
 * HTTP routes all derive from this one table; adding a uniform verb is one entry
 * here plus one core mutation (ADR 0025). `as const` keeps each transition's
 * literal shape so the core can bind `run` against it and compile-check
 * completeness.
 */
export const OP_FACTS = {
  abandon: {
    reason: 'optional',
    subject: 'task',
    summary: 'abandon a task (kept, not deleted)',
    transition: {
      axis: 'lifecycle',
      from: ['todo', 'in_progress', 'under_review'],
      to: 'abandoned',
    },
  },
  archive: {
    reason: 'optional',
    subject: 'project',
    summary: 'archive a project — freeze + hide it and its subtree (reversible)',
    transition: { axis: 'archive', from: 'active', to: 'archived' },
  },
  block: {
    reason: 'optional',
    subject: 'task',
    summary: 'mark as externally blocked',
    transition: { axis: 'hold', from: 'none', to: 'blocked' },
  },
  done: {
    reason: 'none',
    subject: 'task',
    summary: 'complete a task (approves a review)',
    transition: { axis: 'lifecycle', from: ['todo', 'in_progress', 'under_review'], to: 'done' },
  },
  park: {
    reason: 'optional',
    subject: 'task',
    summary: 'put a task on hold',
    transition: { axis: 'hold', from: 'none', to: 'parked' },
  },
  reopen: {
    reason: 'optional',
    subject: 'task',
    summary: 'reopen a terminal task',
    transition: { axis: 'lifecycle', from: ['done', 'abandoned'], to: 'in_progress' },
  },
  return: {
    reason: 'optional',
    subject: 'task',
    summary: 'send back for changes',
    transition: { axis: 'lifecycle', from: ['under_review'], to: 'in_progress' },
  },
  start: {
    reason: 'none',
    subject: 'task',
    summary: 'begin a task',
    transition: { axis: 'lifecycle', from: ['todo'], to: 'in_progress' },
  },
  submit: {
    reason: 'none',
    subject: 'task',
    summary: 'submit for review',
    transition: { axis: 'lifecycle', from: ['in_progress'], to: 'under_review' },
  },
  unarchive: {
    reason: 'none',
    subject: 'project',
    summary: 'restore an archived project',
    transition: { axis: 'archive', from: 'archived', to: 'active' },
  },
  unblock: {
    reason: 'none',
    subject: 'task',
    summary: 'clear the blocked hold',
    transition: { axis: 'hold', from: 'blocked', to: 'none' },
  },
  unpark: {
    reason: 'none',
    subject: 'task',
    summary: 'clear the parked hold',
    transition: { axis: 'hold', from: 'parked', to: 'none' },
  },
} as const satisfies Record<UniformVerb, OpFact>;

/** Is `verb` one of the twelve uniform verbs? The transport membership gate. */
export function isUniformVerb(verb: string): verb is UniformVerb {
  return verb in OP_FACTS;
}

/** A lifecycle state a verb never moves *out* of — the terminal pair. A move
 * *to* one renders no echo/help arrow (the reopen/done asymmetry, ADR 0025). */
export function isTerminalLifecycle(state: Lifecycle): boolean {
  return state === 'done' || state === 'abandoned';
}
