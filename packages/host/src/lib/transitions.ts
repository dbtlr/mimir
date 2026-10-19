import type { StatusWord } from '@mimir/contract';

/** The mutation verbs a human can drive from the console (lifecycle + hold). */
export type TransitionVerb =
  | 'start'
  | 'unqueue'
  | 'submit'
  | 'return'
  | 'done'
  | 'abandon'
  | 'reopen'
  | 'park'
  | 'unpark'
  | 'block'
  | 'unblock';

export type VerbSpec = {
  verb: TransitionVerb;
  label: string;
  /** park/block/abandon/return/reopen carry an optional reason → open the reason dialog first. */
  needsReason: boolean;
};

const LABEL: Record<TransitionVerb, string> = {
  abandon: 'Abandon',
  block: 'Mark blocked',
  done: 'Mark done',
  park: 'Park for later',
  reopen: 'Reopen',
  return: 'Send back',
  start: 'Start',
  submit: 'Submit for review',
  unblock: 'Unblock',
  unpark: 'Resume',
  unqueue: 'Cancel reservation',
};

/** The plain-language label for a transition — the one source for every console surface. */
export function transitionLabel(verb: TransitionVerb): string {
  return LABEL[verb];
}

const NEEDS_REASON = new Set<TransitionVerb>([
  'park',
  'block',
  'abandon',
  'return',
  'reopen',
  'unqueue',
]);

/**
 * The verbs offered for each displayed status word — keyed on what the operator
 * sees, not raw lifecycle, so we never offer Start on a held card. Mirrors the
 * core verb guards exactly (start needs todo or queued; done/abandon need non-terminal;
 * park/block need non-terminal, non-queued + hold=none; unpark/unblock need the matching
 * hold). The core stays the authority and rejects anything illegal.
 */
const VERBS: Partial<Record<StatusWord, TransitionVerb[]>> = {
  abandoned: ['reopen'],
  awaiting: ['start', 'park', 'block', 'abandon'],
  blocked: ['unblock', 'abandon'],
  done: ['reopen'],
  in_progress: ['submit', 'done', 'park', 'block', 'abandon'],
  parked: ['unpark', 'abandon'],
  queued: ['start', 'unqueue', 'done', 'abandon'],
  ready: ['start', 'park', 'block', 'abandon'],
  under_review: ['done', 'return', 'park', 'block', 'abandon'],
};

export function availableTransitions(status: StatusWord): VerbSpec[] {
  return (VERBS[status] ?? []).map((verb) => ({
    label: transitionLabel(verb),
    needsReason: NEEDS_REASON.has(verb),
    verb,
  }));
}
