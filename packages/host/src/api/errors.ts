/**
 * An HTTP-answered failure: the server was reachable and returned a non-2xx
 * status. Carrying the status lets callers separate "the server said no"
 * from "the server never answered" — e.g. a board whose project 404s under
 * archived-404 semantics (ADR 0015) renders a not-found notice instead of
 * the false Offline banner. Lives apart from client.ts so components can
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

/** True when the server answered 404 — gone/archived, not unreachable. */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}
