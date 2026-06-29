/**
 * Wire-envelope types — the shapes every machine consumer parses byte-for-byte
 * (CLI `--json` callers, the UI over the HTTP API). The classes that *raise*
 * errors stay behind the transports in `core`; only the rendered shapes live
 * here (contract holds what crosses the wire; core holds what guards it).
 */

/** Stable category carried by every rendered error (output-contract reference). */
export type ErrorCode = 'not_found' | 'validation' | 'conflict' | 'invariant';

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
