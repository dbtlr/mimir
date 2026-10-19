import { MimirError } from '@mimir/contract';

/**
 * An HTTP-answered failure: the server was reachable and returned a non-2xx
 * status. Carrying the status lets callers separate "the server said no"
 * from "the server never answered" — e.g. a board whose project 404s under
 * archived-404 semantics (ADR 0015) renders a not-found notice instead of
 * the false Offline banner. Lives apart from health.ts so components can
 * import the type guard without dragging in the fetch seam (which tests
 * routinely mock away).
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Whether `error` is an Engine refusal (`MimirError`, ADR 0034). By name, not
 * `instanceof`: the host may load core's copy of the class apart from the
 * console's, and either copy is the same refusal.
 */
export function isEngineRefusal(error: unknown): error is MimirError {
  return error instanceof Error && error.name === 'MimirError' && 'code' in error;
}

/**
 * A server function that faulted inside the host, as the console receives it:
 * the same house-voice refusal `/trpc` gives an internal fault. The
 * cause stays in the host's log; nothing of it crosses the wire.
 */
export class HostFaultError extends Error {
  readonly hint = "run 'mimir doctor'";

  constructor() {
    super('the request did not complete');
    this.name = 'HostFaultError';
  }
}

/** True when the server answered not found — gone/archived, not unreachable. */
export function isNotFound(error: unknown): boolean {
  return (
    (error instanceof ApiError && error.status === 404) ||
    (error instanceof MimirError && error.code === 'not_found')
  );
}
