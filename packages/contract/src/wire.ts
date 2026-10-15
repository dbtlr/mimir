/**
 * Wire-envelope types — the shapes every machine consumer parses byte-for-byte
 * (CLI `--json` callers, the UI over the HTTP API). The shared domain error
 * identity and its schema live in `errors`; core owns the rules that raise it.
 */

// oxlint-disable-next-line unicorn/prefer-export-from
import type { ErrorCode } from './errors';

export type { ErrorCode };

/**
 * The error envelope: `{"error":{code,message,hint?}}` on stderr (CLI) or as
 * the HTTP error body. `usage` appears only on the CLI — a transport code for
 * malformed invocations, never raised by the core.
 */
export type ErrorEnvelope = {
  error: {
    code: ErrorCode | 'usage';
    message: string;
    hint?: string;
  };
};

/**
 * The collection envelope: every HTTP collection is `{items: [...]}`, never a
 * bare array, reserving room for cursor/pagination metadata as a non-breaking
 * sibling key (ADR 0012).
 */
export type Items<T> = {
  items: T[];
};
