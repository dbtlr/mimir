// The contract, not core: the console's server-function module loads this file too.
import { parseEngineInput } from '@mimir/contract';
import { z } from 'zod';

import { T3_ATTEMPT_PATTERN, T3_RUNTIME_MODES } from './t3-states';

const catalogSchema = z.strictObject({ project: z.string().min(1) });

/** What the T3 catalog function takes: the Mimir project to list launch systems for. */
export type T3CatalogInput = z.output<typeof catalogSchema>;
export const parseT3CatalogInput = (input: unknown): T3CatalogInput =>
  parseEngineInput(catalogSchema, input);

/*
 * The launch input's structure (ADR 0040, Launch). A malformed structure is a
 * thrown validation error. What the adapter checks against the chosen system
 * (step 2) is left well-formed here so it reads `invalid`, naming the field:
 * a `branch` beside a `root` workspace, and the branch's grammar.
 */
const launchSchema = z.strictObject({
  attempt: z.string().regex(T3_ATTEMPT_PATTERN),
  environmentId: z.string().min(1),
  interactionMode: z.enum(['default', 'plan']),
  model: z.strictObject({
    instanceId: z.string().min(1),
    model: z.string().min(1),
    options: z.array(
      z.strictObject({
        id: z.string().min(1),
        value: z.union([z.string(), z.number(), z.boolean()]),
      }),
    ),
  }),
  projectId: z.string().min(1),
  runtimeMode: z.enum(T3_RUNTIME_MODES),
  task: z.string().min(1),
  workspace: z.strictObject({
    branch: z.string().optional(),
    type: z.enum(['root', 'worktree']),
  }),
});

/**
 * The launch input as the adapter receives it: `T3LaunchInput` widened so a
 * `root` workspace may carry a `branch` for step 2 to refuse.
 */
export type T3LaunchRequest = z.output<typeof launchSchema>;
export const parseT3LaunchInput = (input: unknown): T3LaunchRequest =>
  parseEngineInput(launchSchema, input);
