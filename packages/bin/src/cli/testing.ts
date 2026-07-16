/**
 * Shared test utilities for CLI tests. Not bundled in production output.
 */

import type { Io } from './render';

export type CapturingIo = {
  out: string[];
  err: string[];
} & Io;

/**
 * `plain` defaults to `true` regardless of `isTTY` — most tests want captured
 * output free of ANSI. Pass `{ plain: false }` to exercise the color path
 * (MMR-300) alongside a real `isTTY`.
 */
export function fakeIo(isTTY = false, opts: { plain?: boolean } = {}): CapturingIo {
  const out: string[] = [];
  const err: string[] = [];
  return {
    err,
    error: (s) => err.push(s),
    isTTY,
    out,
    plain: opts.plain ?? true,
    write: (s) => out.push(s),
  };
}
