/**
 * Shared test utilities for CLI tests. Not bundled in production output.
 */

import type { Io } from './render';

export type CapturingIo = {
  out: string[];
  err: string[];
} & Io;

export function fakeIo(isTTY = false): CapturingIo {
  const out: string[] = [];
  const err: string[] = [];
  return {
    err,
    error: (s) => err.push(s),
    isTTY,
    out,
    plain: true,
    write: (s) => out.push(s),
  };
}
