/**
 * Domain errors the core raises. Each carries a stable `code` the transports
 * map to an exit status / error envelope (Phase 3). The DB owns row-local
 * integrity; these cover the *behavioral* invariants it can't express
 * (parent type-correctness, cycle-freedom, named-target existence).
 *
 * The error class and code live in `@mimir/contract` so a RemoteEngine can
 * reconstruct the same error without importing the store-owning core.
 */
// re-exported AND used locally — a plain `export … from` wouldn't bind it here
// oxlint-disable-next-line unicorn/prefer-export-from
import { MimirError } from '@mimir/contract';

export type { ErrorCode } from '@mimir/contract';
export { MimirError };
export { projectNotFound } from '@mimir/contract';

export const notFound = (message: string, hint?: string): MimirError =>
  new MimirError('not_found', message, hint);

export const validation = (message: string, hint?: string): MimirError =>
  new MimirError('validation', message, hint);
export const conflict = (message: string, hint?: string): MimirError =>
  new MimirError('conflict', message, hint);
export const invariant = (message: string, hint?: string): MimirError =>
  new MimirError('invariant', message, hint);
