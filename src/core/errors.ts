/**
 * Domain errors the core raises. Each carries a stable `code` the transports
 * map to an exit status / error envelope (Phase 3). The DB owns row-local
 * integrity; these cover the *behavioral* invariants it can't express
 * (parent type-correctness, cycle-freedom, named-target existence).
 */
export type ErrorCode = "not_found" | "validation" | "conflict" | "invariant";

export class MimirError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = `MimirError(${code})`;
    this.code = code;
  }
}

export const notFound = (message: string): MimirError => new MimirError("not_found", message);
export const validation = (message: string): MimirError => new MimirError("validation", message);
export const conflict = (message: string): MimirError => new MimirError("conflict", message);
export const invariant = (message: string): MimirError => new MimirError("invariant", message);
