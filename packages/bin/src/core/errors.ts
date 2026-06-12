/**
 * Domain errors the core raises. Each carries a stable `code` the transports
 * map to an exit status / error envelope (Phase 3). The DB owns row-local
 * integrity; these cover the *behavioral* invariants it can't express
 * (parent type-correctness, cycle-freedom, named-target existence).
 *
 * `ErrorCode` itself is wire vocabulary and lives in `@mimir/contract`;
 * re-exported here for the core's own raisers.
 */
import type { ErrorCode } from "@mimir/contract";

export type { ErrorCode };

export class MimirError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = `MimirError(${code})`;
    this.code = code;
    this.hint = hint;
  }
}

export const notFound = (message: string, hint?: string): MimirError =>
  new MimirError("not_found", message, hint);
export const validation = (message: string, hint?: string): MimirError =>
  new MimirError("validation", message, hint);
export const conflict = (message: string, hint?: string): MimirError =>
  new MimirError("conflict", message, hint);
export const invariant = (message: string, hint?: string): MimirError =>
  new MimirError("invariant", message, hint);
