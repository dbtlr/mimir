/**
 * Mimir's failures in Loom's failure shape `{code, exitCode, message, hints}`.
 * A domain refusal (`MimirError`) exits 1 with its code in kebab case, and a
 * usage error Mimir raises exits 2 with the code `usage`. A failure's hint is
 * its one hint line. Loom raises its own parser faults in its own voice.
 */
import { FatalError, plugin, translate, UsageError } from '@loomcli/core';
import type { FailureHook, Plugin } from '@loomcli/core';
import { MimirError } from '@mimir/contract';
import type { ErrorCode } from '@mimir/contract';

/** A usage error Mimir raises: the invocation is wrong. Exit 2. */
export class MimirUsageError extends UsageError {
  static override readonly code: string = 'usage';
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'MimirUsageError';
    this.hint = hint;
  }
}

/** A domain refusal the Engine raised. Exit 1; each code is a subclass. */
export abstract class DomainError extends FatalError {
  readonly hint: string | undefined;

  constructor(error: MimirError) {
    super(error.message, { cause: error });
    this.name = 'DomainError';
    this.hint = error.hint;
  }
}

export class NotFoundError extends DomainError {
  static override readonly code: string = 'not-found';

  constructor(error: MimirError) {
    super(error);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends DomainError {
  static override readonly code: string = 'validation';

  constructor(error: MimirError) {
    super(error);
    this.name = 'ValidationError';
  }
}

export class ConflictError extends DomainError {
  static override readonly code: string = 'conflict';

  constructor(error: MimirError) {
    super(error);
    this.name = 'ConflictError';
  }
}

export class InvariantError extends DomainError {
  static override readonly code: string = 'invariant';

  constructor(error: MimirError) {
    super(error);
    this.name = 'InvariantError';
  }
}

const DOMAIN_ERRORS: Record<ErrorCode, new (error: MimirError) => DomainError> = {
  conflict: ConflictError,
  invariant: InvariantError,
  not_found: NotFoundError,
  validation: ValidationError,
};

/** The domain failure for a `MimirError`. */
export function domainError(error: MimirError): DomainError {
  return new DOMAIN_ERRORS[error.code](error);
}

/** Re-raise a core grammar refusal as the usage error it is, hint intact. */
export function asUsage(error: unknown): never {
  if (error instanceof MimirError) {
    throw new MimirUsageError(error.message, error.hint);
  }
  throw error;
}

const hintOf: FailureHook = (failure, { style }) =>
  (failure instanceof DomainError || failure instanceof MimirUsageError) &&
  failure.hint !== undefined
    ? style.escape(failure.hint)
    : undefined;

/** Translates every `MimirError` a command lets through, and prints each failure's hint under it. */
export function failures(): Plugin {
  return plugin('@mimir/cli/failures', {
    onFailure: hintOf,
    translators: [translate(MimirError, domainError)],
  });
}
