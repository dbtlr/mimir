/** Keep caller-controlled text inside one line of structured diagnostics. */
export function formatDiagnostic(fields: Record<string, unknown>): string {
  return JSON.stringify(fields)
    .replace(/\u2028/g, String.raw`\u2028`)
    .replace(/\u2029/g, String.raw`\u2029`);
}

/**
 * The operator-facing fields of a thrown value. Message and stack are kept
 * apart because a stack need not repeat its message: a Zod v4 failure's stack
 * is just `ZodError`, while the message names the failing fields.
 */
export function describeFault(error: unknown): { message: string; stack?: string } {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }
  return error.stack === undefined
    ? { message: error.message }
    : { message: error.message, stack: error.stack };
}
