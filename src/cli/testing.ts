/**
 * Shared test utilities for CLI tests. Not bundled in production output.
 */

import type { Io } from "./render";

export interface CapturingIo extends Io {
  out: string[];
  err: string[];
}

export function fakeIo(isTTY = false): CapturingIo {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    isTTY,
    plain: true,
    write: (s) => out.push(s),
    error: (s) => err.push(s),
  };
}
