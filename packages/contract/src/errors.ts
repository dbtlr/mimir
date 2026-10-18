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
