/**
 * The sandbox tooling's failures in Loom's shape. A condition the operator can
 * act on (an unknown sandbox, a failed subprocess, a refused ownership check)
 * is a `SandboxError`, which Loom prints as one line and exits 1; a malformed
 * option is a `SandboxUsageError`, exit 2. Anything else that escapes is a
 * defect, and Loom reports it with its stack.
 */
import { FatalError, UsageError } from '@loomcli/core';

/** A sandbox operation refused or failed for a reason the operator can act on. Exit 1. */
export class SandboxError extends FatalError {
  static override readonly code: string = 'sandbox';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SandboxError';
  }
}

/** A sandbox option value is malformed. Exit 2. */
export class SandboxUsageError extends UsageError {
  static override readonly code: string = 'usage';

  constructor(message: string) {
    super(message);
    this.name = 'SandboxUsageError';
  }
}
