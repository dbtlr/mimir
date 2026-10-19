/**
 * Wire-envelope types — the shapes every machine consumer parses byte-for-byte
 * (CLI `--json` callers and MCP clients). The shared domain error
 * identity and its schema live in `errors`; core owns the rules that raise it.
 */

// oxlint-disable-next-line unicorn/prefer-export-from
import type { ErrorCode } from './errors';

export type { ErrorCode };

/**
 * The error envelope: `{"error":{code,message,hint?}}` on the CLI's stderr.
 * `usage` appears only on the CLI — a transport code for malformed
 * invocations, never raised by the core. The host's own refusals share the
 * shape with host-only codes (`forbidden_host`, `forbidden_origin`, `gone`).
 */
export type ErrorEnvelope = {
  error: {
    code: ErrorCode | 'usage';
    message: string;
    hint?: string;
  };
};
