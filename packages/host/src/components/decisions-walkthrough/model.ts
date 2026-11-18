import type { DecisionAnswer } from '../../api/fns/deliveries';
import type { DecisionDraft } from '../../lib/decision-drafts';
import type { Instant } from '../../lib/time';
import { MAX_DECISION_ANSWERS } from '../../server/decision-answers';
import type { Verdict } from './copy';

/*
 * The decisions walkthrough's data: the decision as both of its reads give it,
 * the operator's selection on each, and the answer a selection sends. Pure, so
 * the set's order and the written answers are tested without rendering.
 */

/** A provisional decision, as the delivery page's read and a work page's Needs you both carry it. */
export type WalkDecision = {
  id: string;
  seq: number;
  class: string;
  created_at: Instant;
  delivery: string | null;
  lifecycle: string;
  options: string[];
  project_key: string;
  question: string;
  recommended: number;
  taken: number;
  tasks: string[];
  why: string | null;
};

/** The option number selected, or `custom` for "Something else". */
export type Choice = number | 'custom';

/** What the operator has chosen for one decision. */
export type Selection = { choice: Choice; answer: string; note: string };

/**
 * The set a walkthrough opens on: the provisional decisions, oldest first (the
 * order the agent decided in), at most the most one Send takes.
 */
export function walkSet<D extends Pick<WalkDecision, 'lifecycle' | 'seq'>>(
  decisions: readonly D[],
): D[] {
  return decisions
    .filter((d) => d.lifecycle === 'provisional')
    .toSorted((a, b) => a.seq - b.seq)
    .slice(0, MAX_DECISION_ANSWERS);
}

/** A decision's selection on arrival: its draft when the draft still fits, else the answer taken. */
export function initialSelection(
  decision: Pick<WalkDecision, 'options' | 'taken'>,
  draft: DecisionDraft | null,
): Selection {
  const fits =
    draft !== null &&
    (draft.choice === 'custom' || (draft.choice >= 1 && draft.choice <= decision.options.length));
  return fits
    ? { answer: draft.answer, choice: draft.choice, note: draft.note }
    : { answer: '', choice: decision.taken, note: '' };
}

/** What the selection does to the decision. */
export function verdictOf(decision: Pick<WalkDecision, 'taken'>, selection: Selection): Verdict {
  if (selection.choice === 'custom') {
    return 'custom';
  }
  return selection.choice === decision.taken ? 'confirm' : 'overturn';
}

/** "Something else" with no words in it cannot be sent. */
export function isBlankCustom(selection: Selection): boolean {
  return selection.choice === 'custom' && selection.answer.trim() === '';
}

/** The answer's text: the chosen option's, or the operator's own words. */
export function answerText(decision: Pick<WalkDecision, 'options'>, selection: Selection): string {
  return selection.choice === 'custom'
    ? selection.answer.trim()
    : (decision.options[selection.choice - 1] ?? '');
}

/**
 * The note that travels with the answer: the own-answer text for "Something
 * else" (the note box is hidden then), else the note box's text. Empty when
 * there is none.
 */
export function noteOf(selection: Selection): string {
  return (selection.choice === 'custom' ? selection.answer : selection.note).trim();
}

/** The answer `answerDecisions` takes for a selection. */
export function answerFor(
  decision: Pick<WalkDecision, 'id' | 'taken'>,
  selection: Selection,
): DecisionAnswer {
  const note = noteOf(selection);
  const withNote = note === '' ? {} : { note };
  const { choice } = selection;
  if (choice === 'custom') {
    return { id: decision.id, verdict: 'overturn', ...withNote };
  }
  if (choice === decision.taken) {
    return { id: decision.id, verdict: 'confirm', ...withNote };
  }
  return { id: decision.id, option: choice, verdict: 'overturn', ...withNote };
}

/** The key a set's drafts are kept under: a delivery's id, or a project's key. */
export type WalkScope =
  | { kind: 'delivery'; id: string; title: string }
  | { kind: 'project'; key: string };

/** The delivery a Send names (null for a project's decisions), and the key its drafts carry. */
export function scopeDelivery(scope: WalkScope): string | null {
  return scope.kind === 'delivery' ? scope.id : null;
}
export function scopeSet(scope: WalkScope): string {
  return scope.kind === 'delivery' ? scope.id : scope.key;
}
/** The project key of a scope, for the header and the link back. */
export function scopeProject(scope: WalkScope): string {
  return scope.kind === 'project' ? scope.key : scope.id.split('-')[0]!;
}

/** The walkthrough set a decision belongs to: its delivery's id, or its project's key when it names none. */
export function setOfDecision(decision: Pick<WalkDecision, 'delivery' | 'project_key'>): string {
  return decision.delivery ?? decision.project_key;
}
