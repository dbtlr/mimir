import { engineSchemas, parseEngineInput } from '@mimir/contract';
import type { EngineDecision, EngineInput } from '@mimir/contract';
import { createServerFn } from '@tanstack/react-start';

import { writeDecisionAnswers } from '../../server/decision-answer-writes';
import { parseAnswerDecisions } from '../../server/decision-answers';
import type { AnswerDecisionsInput, DecisionAnswers } from '../../server/decision-answers';
import type { T3WakeInput } from '../../server/t3-states';
import { decisionTarget, deliveryTarget, wakeAttemptSchema } from '../../server/t3-wake';
import { engine, hostLog, t3Integration } from './engine';

export type {
  AnswerDecisionsInput,
  DecisionAnswer,
  DecisionAnswerResult,
  DecisionAnswers,
} from '../../server/decision-answers';
export type { T3WakeField, T3WakeInput, T3WakeState, T3Woken } from '../../server/t3-states';

/*
 * The operator's delivery and decision writes (ADR 0040, the wake). Each
 * waking function is one Engine method plus the wake that tells the delivery's
 * T3 thread the operator acted: it validates its Engine input and the browser's
 * `attempt`, runs the write (which throws as it would alone when the Engine
 * refuses it), then sends the wake and answers `{ record, wake }`. Nothing
 * after the write throws. `confirm` never wakes and answers the bare record;
 * `wakeT3` resends one wake from a state's `retry` and answers a wake state.
 * Only these console functions wake: a write through `/trpc` never does.
 *
 * Like nodes.ts, each is written out as a top-level declaration: Start's
 * compiler extracts each server function from one, so they cannot be
 * generated in a loop. The cache keys and the toasts live in
 * delivery-mutations.ts.
 */

/** The field every waking function takes beside its Engine input: the browser's attempt id. */
const attemptField = { attempt: wakeAttemptSchema };

/** Clear a delivery's stop, then wake its thread. */
export const deliveryUnblock = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'deliveryUnblock'> & { attempt: string }) =>
    parseEngineInput(engineSchemas.deliveryUnblock.input.extend(attemptField), input),
  )
  .handler(async ({ data: { attempt, ...input } }) =>
    (await t3Integration()).writeAndWake(
      'deliveryUnblock',
      attempt,
      async () => (await engine()).deliveryUnblock(input),
      deliveryTarget,
    ),
  );

/** Pause a delivery, then wake its thread. */
export const deliveryPark = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'deliveryPark'> & { attempt: string }) =>
    parseEngineInput(engineSchemas.deliveryPark.input.extend(attemptField), input),
  )
  .handler(async ({ data: { attempt, ...input } }) =>
    (await t3Integration()).writeAndWake(
      'deliveryPark',
      attempt,
      async () => (await engine()).deliveryPark(input),
      deliveryTarget,
    ),
  );

/** Resume a paused delivery, then wake its thread. */
export const deliveryUnpark = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'deliveryUnpark'> & { attempt: string }) =>
    parseEngineInput(engineSchemas.deliveryUnpark.input.extend(attemptField), input),
  )
  .handler(async ({ data: { attempt, ...input } }) =>
    (await t3Integration()).writeAndWake(
      'deliveryUnpark',
      attempt,
      async () => (await engine()).deliveryUnpark(input),
      deliveryTarget,
    ),
  );

/** Send a delivery's milestone back, then wake its thread. */
export const deliveryReturn = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'deliveryReturn'> & { attempt: string }) =>
    parseEngineInput(engineSchemas.deliveryReturn.input.extend(attemptField), input),
  )
  .handler(async ({ data: { attempt, ...input } }) =>
    (await t3Integration()).writeAndWake(
      'deliveryReturn',
      attempt,
      async () => (await engine()).deliveryReturn(input),
      deliveryTarget,
    ),
  );

/** Abandon a delivery, then wake its thread. */
export const deliveryAbandon = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'deliveryAbandon'> & { attempt: string }) =>
    parseEngineInput(engineSchemas.deliveryAbandon.input.extend(attemptField), input),
  )
  .handler(async ({ data: { attempt, ...input } }) =>
    (await t3Integration()).writeAndWake(
      'deliveryAbandon',
      attempt,
      async () => (await engine()).deliveryAbandon(input),
      deliveryTarget,
    ),
  );

/** Edit a delivery's fields, then wake the thread its handles name after the edit. */
export const deliveryUpdate = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'deliveryUpdate'> & { attempt: string }) =>
    parseEngineInput(engineSchemas.deliveryUpdate.input.extend(attemptField), input),
  )
  .handler(async ({ data: { attempt, ...input } }) =>
    (await t3Integration()).writeAndWake(
      'deliveryUpdate',
      attempt,
      async () => (await engine()).deliveryUpdate(input),
      deliveryTarget,
    ),
  );

/** Overturn a decision, then wake the thread of the delivery it names (none: no wake). */
export const overturn = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'overturn'> & { attempt: string }) =>
    parseEngineInput(engineSchemas.overturn.input.extend(attemptField), input),
  )
  .handler(async ({ data: { attempt, ...input } }) =>
    (await t3Integration()).writeAndWake(
      'overturn',
      attempt,
      async () => (await engine()).overturn(input),
      decisionTarget,
    ),
  );

/** Confirm a decision. A confirm changes nothing the agent built on, so it never wakes. */
export const confirm = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'confirm'>) =>
    parseEngineInput(engineSchemas.confirm.input, input),
  )
  .handler(async ({ data }) => (await engine()).confirm(data));

/**
 * The decisions walkthrough's Send (ADR 0040, MMR-703 refinement): write each
 * answer in order as its own Engine write, then have the T3 adapter wake the
 * delivery's thread once when an overturn landed. A refused answer does not
 * stop the rest.
 */
export const answerDecisions = createServerFn({ method: 'POST' })
  .validator((input: AnswerDecisionsInput) => parseAnswerDecisions(input))
  .handler(async ({ data }): Promise<DecisionAnswers<EngineDecision>> =>
    writeDecisionAnswers(
      {
        engine: await engine(),
        log: await hostLog(),
        wake: (await t3Integration()).wakeAfterAnswers,
      },
      data,
    ),
  );

/**
 * Resend one wake from a state's `retry`. It writes nothing; it answers a
 * wake state alone, `invalid` naming the field when the input fails its check.
 */
export const wakeT3 = createServerFn({ method: 'POST' })
  .validator((input: T3WakeInput) => input)
  .handler(async ({ data }) => (await t3Integration()).wakeT3(data));
