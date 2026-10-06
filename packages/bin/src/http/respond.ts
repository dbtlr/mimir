import { MimirError, validation } from '../core';
import type { ErrorCode } from '../core';

/**
 * Response plumbing for the resource envelope: JSON rendering, the error
 * envelope → HTTP status mapping, and strict body parsing.
 *
 * The error body is the existing envelope verbatim (`{"error":{code,message,
 * hint?}}` — the same contract `--json` callers parse); HTTP adds only the
 * status code. The API grants no CORS (MMR-426): production is same-origin
 * behind the proxy (ADR 0012), and the dev console reaches it through the
 * Vite proxy, so no other page on loopback can read or write it cross-origin.
 */

/** A JSON response. */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

/** Envelope `code` → HTTP status. Invariant refusals are conflicts with current state. */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  conflict: 409,
  invariant: 409,
  not_found: 404,
  validation: 400,
};

/** Render any thrown error as the envelope + its status; non-domain errors are 500s. */
export function errorResponse(req: Request, error: unknown): Response {
  if (error instanceof MimirError) {
    const body = {
      error: {
        code: error.code,
        message: error.message,
        ...(error.hint !== undefined ? { hint: error.hint } : {}),
      },
    };
    return json(body, STATUS_BY_CODE[error.code]);
  }
  // A non-domain error is an internal fault: the envelope ships a house-voice
  // fact + a next move (output-voice.md — library text never ships, and every
  // error points somewhere), while the raw detail is preserved for the operator
  // on stderr (consistent with how `serve` logs), never in the response.
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  // One JSON payload keeps embedded control characters escaped, so raw
  // exception text can't forge extra records in the line-oriented serve log
  // (the u2028/u2029 line separators survive JSON.stringify and are escaped
  // by hand).
  const diagnostic = JSON.stringify({
    detail,
    method: req.method,
    path: new URL(req.url).pathname,
  })
    .replace(/\u2028/g, String.raw`\u2028`)
    .replace(/\u2029/g, String.raw`\u2029`);
  console.error(`✗ serve: request did not complete — ${diagnostic}`);
  const body = {
    error: {
      code: 'internal',
      hint: "run 'mimir doctor'",
      message: 'the request did not complete',
    },
  };
  return json(body, 500);
}

/** Run a handler, rendering any thrown error through the envelope. */
export async function guarded(req: Request, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    return errorResponse(req, error);
  }
}

/**
 * Parse a JSON object body, rejecting unknown fields (a structural fault —
 * the caller's program is wrong). An empty body reads as `{}` so bodyless
 * actions (`start`, `unpark`…) need no ceremony.
 */
export async function readBody(
  req: Request,
  allowed: readonly string[],
): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.trim() === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw validation('request body is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw validation('request body must be a JSON object');
  }
  // Validated just above: a non-null, non-array object — i.e. a string-keyed record.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const body = parsed as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw validation(`unknown body field ${key}`, `fields: ${allowed.join(', ')}`);
    }
  }
  return body;
}

/** An optional string field — present means a string, anything else is structural. */
export function strField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw validation(`${key} must be a string`);
  }
  return value;
}

/** An optional boolean field — present means a boolean, anything else is structural. */
export function boolField(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw validation(`${key} must be a boolean`);
  }
  return value;
}

/** A required string field. */
export function requiredStr(body: Record<string, unknown>, key: string, verb: string): string {
  const value = strField(body, key);
  if (value === undefined) {
    throw validation(`${verb} requires ${key}`);
  }
  return value;
}

/** An optional string-or-string-array field, normalized to an array. */
export function strList(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value) && value.every((v): v is string => typeof v === 'string')) {
    return value;
  }
  throw validation(`${key} must be a string or an array of strings`);
}
