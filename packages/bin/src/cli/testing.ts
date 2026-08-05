/**
 * Shared test utilities for CLI tests. Not bundled in production output.
 */

import type { Io } from '../presentation';

export type CapturingIo = {
  out: string[];
  err: string[];
} & Io;

/** The fixed render zone every CLI test reads in — never the machine's, so a
 * tz-labeled assertion means the same thing on any developer's box. */
const TEST_ZONE = 'America/New_York';

/**
 * `plain` defaults to `true` regardless of `isTTY` — most tests want captured
 * output free of ANSI. Pass `{ plain: false }` to exercise the color path
 * (MMR-300) alongside a real `isTTY`; `zone` overrides the fixed render zone
 * (ADR 0029).
 */
export function fakeIo(isTTY = false, opts: { plain?: boolean; zone?: string } = {}): CapturingIo {
  const out: string[] = [];
  const err: string[] = [];
  return {
    err,
    error: (s) => err.push(s),
    isTTY,
    out,
    plain: opts.plain ?? true,
    write: (s) => out.push(s),
    zone: opts.zone ?? TEST_ZONE,
  };
}
