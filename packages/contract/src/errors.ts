import { z } from 'zod';

export const errorCodeSchema = z.enum(['not_found', 'validation', 'conflict', 'invariant']);
export type ErrorCode = z.output<typeof errorCodeSchema>;

export const mimirErrorSchema = z.object({
  code: errorCodeSchema,
  hint: z.string().optional(),
  message: z.string(),
});

/** Shared identity lets local and remote callers handle the same domain refusals. */
export class MimirError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'MimirError';
    this.code = code;
    this.hint = hint;
  }
}

/** Canonical project-miss — token-as-subject; all transports emit the same hint. */
export const projectNotFound = (key: string): MimirError =>
  new MimirError(
    'not_found',
    `${key} doesn't exist`,
    `create it: mimir create project "Name" --key ${key} -y`,
  );

/** The long prose fields that clear only on `null`, never on blank text. */
export type ClearOnlyProse = 'description' | 'next';

/**
 * Canonical refusal of a blank `description` or `next`. Mimir keeps no earlier
 * version of this prose, so a blank (usually an empty script input) is refused
 * and `null` is the one way to clear. Clients that expose the clear as their
 * own act (the CLI's `--clear-direction`) recognize this message by its field.
 */
export const blankProse = (field: ClearOnlyProse): MimirError =>
  new MimirError('validation', `${field} cannot be blank`, 'send null to clear it');
