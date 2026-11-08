/** The `code` of a failed system call (`ENOENT`, `EACCES`, ...), or undefined for any other error. */
export function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}
