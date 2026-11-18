import type { T3WakeState } from './t3-states';

/*
 * The shapes of `answerDecisions` (ADR 0040, MMR-703 refinement): the
 * decisions walkthrough's Send. The console's server-function module and the
 * browser both load this file, so it holds types and pure helpers only.
 */

/** One answer the walkthrough sends: a confirm, or an overturn to an option and/or with a note. */
export type DecisionAnswer =
  | { id: string; verdict: 'confirm'; note?: string }
  | { id: string; verdict: 'overturn'; option?: number; note?: string };

/**
 * What `answerDecisions` takes: the browser's attempt id, the delivery whose
 * decisions the walkthrough shows (null for a project's decisions with no
 * delivery), and one to 100 answers in the order to write them.
 */
export type AnswerDecisionsInput = {
  attempt: string;
  delivery: string | null;
  answers: DecisionAnswer[];
};

/** One answer's outcome, under the decision's canonical id. */
export type DecisionAnswerResult<Decision> =
  | { id: string; outcome: 'confirmed' | 'overturned'; record: Decision }
  | { id: string; outcome: 'refused'; reason: string }
  | { id: string; outcome: 'failed' };

/** What `answerDecisions` answers: one result per answer, in input order, and the one wake. */
export type DecisionAnswers<Decision> = {
  results: DecisionAnswerResult<Decision>[];
  wake: T3WakeState;
};

/** The most answers one Send takes; a walkthrough opening holds at most this many decisions. */
export const MAX_DECISION_ANSWERS = 100;
