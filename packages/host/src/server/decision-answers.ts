import { MimirError, parseEngineInput } from '@mimir/contract';
import { z } from 'zod';

import type { T3WakeState } from './t3-states';
import { wakeAttemptSchema } from './t3-wake';

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

const DELIVERY_ID = /^([A-Z]{2,4})-d(\d{1,10})$/;
const DECISION_ID = /^([A-Z]{2,4})-q(\d{1,10})$/;

/** A delivery id in canonical form (`MMR-d03` is `MMR-d3`), or null when it is not one. */
export function canonicalDeliveryId(id: string): string | null {
  const match = DELIVERY_ID.exec(id);
  return match === null ? null : `${match[1] ?? ''}-d${String(Number(match[2]))}`;
}

/** A decision id in canonical form (`MMR-q07` is `MMR-q7`), or null when it is not one. */
export function canonicalDecisionId(id: string): string | null {
  const match = DECISION_ID.exec(id);
  return match === null ? null : `${match[1] ?? ''}-q${String(Number(match[2]))}`;
}

/** The project key an id of the form `KEY-xN` starts with. */
const projectOf = (id: string): string => id.slice(0, id.indexOf('-'));

const answerSchema = z.discriminatedUnion('verdict', [
  z.strictObject({
    id: z.string(),
    note: z.string().optional(),
    verdict: z.literal('confirm'),
  }),
  z.strictObject({
    id: z.string(),
    note: z.string().optional(),
    option: z.number().int().positive().optional(),
    verdict: z.literal('overturn'),
  }),
]);

const inputSchema = z.strictObject({
  answers: z.array(answerSchema).min(1).max(MAX_DECISION_ANSWERS),
  attempt: wakeAttemptSchema,
  delivery: z.string().nullable(),
});

/**
 * Check `answerDecisions`'s input before anything is written, and return it
 * with every id in canonical form. Every refusal is a `validation` error, as
 * an Engine input error is. Whether an overturn has an option or a note is the
 * Engine's check, per answer.
 */
export function parseAnswerDecisions(input: unknown): AnswerDecisionsInput {
  const parsed = parseEngineInput(inputSchema, input);
  const delivery = parsed.delivery === null ? null : canonicalDeliveryId(parsed.delivery);
  if (parsed.delivery !== null && delivery === null) {
    throw new MimirError('validation', `delivery: "${parsed.delivery}" is not a delivery id`);
  }
  const answers = parsed.answers.map((answer): DecisionAnswer => {
    const id = canonicalDecisionId(answer.id);
    if (id === null) {
      throw new MimirError('validation', `answers: "${answer.id}" is not a decision id`);
    }
    return { ...answer, id };
  });
  const seen = new Set<string>();
  for (const { id } of answers) {
    if (seen.has(id)) {
      throw new MimirError('validation', `answers: ${id} is answered more than once`);
    }
    seen.add(id);
  }
  const projects = new Set(answers.map(({ id }) => projectOf(id)));
  if (delivery !== null) {
    projects.add(projectOf(delivery));
  }
  if (projects.size > 1) {
    throw new MimirError('validation', 'answers: decisions must all belong to one project');
  }
  return { answers, attempt: parsed.attempt, delivery };
}
