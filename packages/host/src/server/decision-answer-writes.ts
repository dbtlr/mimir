import type { Engine, EngineDecision } from '@mimir/contract';

import { isEngineRefusal } from '../api/errors';
import { parseAnswerDecisions } from './decision-answers';
import type { DecisionAnswer, DecisionAnswerResult, DecisionAnswers } from './decision-answers';
import type { T3AnswersWake } from './t3';
import { logEvent } from './t3-http';
import type { T3WakeState } from './t3-states';
import { sinceBefore } from './t3-wake';

/*
 * The decisions walkthrough's Send on the host (ADR 0040, MMR-703
 * refinement). The console function owns the Engine writes, one per answer;
 * the T3 adapter owns only the one wake after them, as `writeAndWake` splits
 * a single write from its wake. Server only: it calls the Engine.
 */

/** What a Send writes through and wakes with. */
export type DecisionAnswerWrites = {
  engine: Pick<Engine, 'confirm' | 'getDecision' | 'overturn'>;
  /** The T3 adapter's wake for a Send, after its answers are written. */
  wake: (request: T3AnswersWake) => Promise<T3WakeState>;
  log?: (line: string) => void;
  clock?: () => number;
};

/** Whether an Engine error is one an answer reports as `refused`: a refusal, not an invariant fault. */
const isAnswerRefusal = (error: unknown): error is Error =>
  isEngineRefusal(error) && error.code !== 'invariant';

/** What a fault's log line may say of its error: the class name and a MimirError's code, never the message. */
function faultFields(error: unknown): Record<string, string> {
  if (!(error instanceof Error)) {
    return { error: typeof error };
  }
  return isEngineRefusal(error) ? { code: error.code, error: error.name } : { error: error.name };
}

/** Read, check membership, and write one answer; refusals and faults are outcomes. */
async function answerOne(
  options: Required<DecisionAnswerWrites>,
  answer: DecisionAnswer,
  delivery: string | null,
): Promise<DecisionAnswerResult<EngineDecision>> {
  const { engine } = options;
  const { id } = answer;
  try {
    const decision = await engine.getDecision({ id });
    if (decision.delivery !== delivery) {
      return { id, outcome: 'refused', reason: `${id} is not in this walkthrough` };
    }
    if (answer.verdict === 'confirm') {
      const record = await engine.confirm({
        id,
        ...(answer.note === undefined ? {} : { note: answer.note }),
      });
      return { id, outcome: 'confirmed', record };
    }
    const record = await engine.overturn({
      id,
      ...(answer.note === undefined ? {} : { note: answer.note }),
      ...(answer.option === undefined ? {} : { option: answer.option }),
    });
    return { id, outcome: 'overturned', record };
  } catch (error) {
    if (isAnswerRefusal(error)) {
      return { id, outcome: 'refused', reason: error.message };
    }
    logEvent(options, 'decision_answer_fault', { decision: id, ...faultFields(error) });
    return { id, outcome: 'failed' };
  }
}

/**
 * Write each answer in the order given as its own Engine write, then wake the
 * delivery's thread at most once. `input` is checked first
 * ({@link parseAnswerDecisions}), and its refusal throws; after it, nothing
 * throws. `since` is the clock read just before the first answer's read, less
 * a millisecond, so the since read shows every answer of the Send.
 */
export async function writeDecisionAnswers(
  writes: DecisionAnswerWrites,
  input: unknown,
): Promise<DecisionAnswers<EngineDecision>> {
  const { answers, attempt, delivery } = parseAnswerDecisions(input);
  const options: Required<DecisionAnswerWrites> = {
    clock: writes.clock ?? Date.now,
    engine: writes.engine,
    log: writes.log ?? ((line) => console.error(line)),
    wake: writes.wake,
  };
  const since = sinceBefore(options.clock());
  const results: DecisionAnswerResult<EngineDecision>[] = [];
  for (const answer of answers) {
    results.push(await answerOne(options, answer, delivery));
  }
  const overturned = results.some((result) => result.outcome === 'overturned');
  return { results, wake: await options.wake({ attempt, delivery, overturned, since }) };
}
