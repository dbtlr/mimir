import { type ErrorCode, MimirError, validation } from "../core";

/**
 * Response plumbing for the resource envelope: JSON rendering, the error
 * envelope → HTTP status mapping, dev-only CORS, and strict body parsing.
 *
 * The error body is the existing envelope verbatim (`{"error":{code,message,
 * hint?}}` — the same contract `--json` callers parse); HTTP adds only the
 * status code. CORS exists solely so a localhost dev server (the Phase-5 UI)
 * can reach the API — production is same-origin behind the proxy (ADR 0012).
 */

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/** Reflect localhost dev origins only; any other origin gets no CORS grant. */
export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (origin === null || !LOCAL_ORIGIN.test(origin)) {
    return {};
  }
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "origin",
  };
}

/** A JSON response with CORS headers when the request carries a dev origin. */
export function json(req: Request, data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(req) },
  });
}

/** The CORS preflight answer — 204, headers only. */
export function preflight(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

/** Envelope `code` → HTTP status. Invariant refusals are conflicts with current state. */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  not_found: 404,
  validation: 400,
  conflict: 409,
  invariant: 409,
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
    return json(req, body, STATUS_BY_CODE[error.code]);
  }
  const message = error instanceof Error ? error.message : String(error);
  return json(req, { error: { code: "internal", message } }, 500);
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
  if (text.trim() === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw validation("request body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw validation("request body must be a JSON object");
  }
  const body = parsed as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw validation(`unknown body field ${key}`, `fields: ${allowed.join(", ")}`);
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
  if (typeof value !== "string") {
    throw validation(`${key} must be a string`);
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
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value) && value.every((v): v is string => typeof v === "string")) {
    return value;
  }
  throw validation(`${key} must be a string or an array of strings`);
}
