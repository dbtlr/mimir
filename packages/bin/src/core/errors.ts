/**
 * Domain errors the core raises. Each carries a stable `code` the transports
 * map to an exit status / error envelope (Phase 3). The DB owns row-local
 * integrity; these cover the *behavioral* invariants it can't express
 * (parent type-correctness, cycle-freedom, named-target existence).
 *
 * `ErrorCode` itself is wire vocabulary and lives in `@mimir/contract`;
 * re-exported here for the core's own raisers.
 */
// re-exported AND used locally — a plain `export … from` wouldn't bind it here
// oxlint-disable-next-line unicorn/prefer-export-from
import type { ErrorCode } from '@mimir/contract';

export type { ErrorCode };

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

export const notFound = (message: string, hint?: string): MimirError =>
  new MimirError('not_found', message, hint);

/** Canonical project-miss — token-as-subject; all transports emit the same hint. */
export const projectNotFound = (key: string): MimirError =>
  notFound(`${key} doesn't exist`, `create it: mimir create project "Name" --key ${key} -y`);
export const validation = (message: string, hint?: string): MimirError =>
  new MimirError('validation', message, hint);
export const conflict = (message: string, hint?: string): MimirError =>
  new MimirError('conflict', message, hint);
export const invariant = (message: string, hint?: string): MimirError =>
  new MimirError('invariant', message, hint);

/**
 * The single source of truth for the degraded-document refusal: a mutating write
 * whose target carries no usable `updated_at` for the write's CAS drift guard —
 * a hand-edited or pre-mimir document. Raised by both write seams that share the
 * co-write invariant: the node/project write path (`assertCoWriteGuards`,
 * MMR-303) and the seed store (MMR-313). `subject` is the offending path, or the
 * writer's comma-joined list of them. Both point the operator at the one repair.
 */
export const degradedUpdatedAt = (subject: string): MimirError =>
  validation(
    `${subject} carries no usable updated_at for the write's drift guard`,
    "the document was hand-edited or predates mimir management — run 'mimir doctor --fix' to repair it",
  );
