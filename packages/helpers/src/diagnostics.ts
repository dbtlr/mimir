/** Keep caller-controlled text inside one line of structured diagnostics. */
export function formatDiagnostic(fields: Record<string, unknown>): string {
  return JSON.stringify(fields)
    .replace(/\u2028/g, String.raw`\u2028`)
    .replace(/\u2029/g, String.raw`\u2029`);
}
