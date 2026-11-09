// The contract, not core: the console's server-function module loads this file too.
import { parseEngineInput } from '@mimir/contract';
import { z } from 'zod';

import type { GroomCancelTarget, GroomTarget } from './agent-console-states';

const targetSchema = z.strictObject({
  project: z.string().min(1),
  task: z.string().min(1),
});

/**
 * The card read's and the start's input: one task in one project. A malformed
 * input is a thrown validation error; whether the task exists, belongs to the
 * project, and is `todo` is the runner's to answer as a refusal.
 */
export const parseGroomTarget = (input: unknown): GroomTarget =>
  parseEngineInput(targetSchema, input);

/** The shape `randomUUID` gives a run id: lowercase hex in 8-4-4-4-12 groups. */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const cancelSchema = z.strictObject({
  runId: z.string().min(1).max(36).regex(RUN_ID),
});

/**
 * The cancel's input: one run id in the shape the runner makes. A malformed
 * input is a thrown validation error; whether a run has that id is the
 * runner's to answer.
 */
export const parseGroomCancelTarget = (input: unknown): GroomCancelTarget =>
  parseEngineInput(cancelSchema, input);
