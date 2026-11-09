// The contract, not core: the console's server-function module loads this file too.
import { parseEngineInput } from '@mimir/contract';
import { z } from 'zod';

import type { GroomTarget } from './agent-console-states';

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
