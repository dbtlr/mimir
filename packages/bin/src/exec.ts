/**
 * The one impure process edge: run an argv, capture exit code and output.
 * Consumers (the launchd supervisor, the vault's git operations) take an
 * `Exec` so tests inject a fake; `bunExec` is the real implementation.
 */

export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};
export type ExecOpts = {
  /**
   * Kill the process after this many ms and return code 124 (the coreutils
   * `timeout` convention). Guards against a hung filesystem — a `git` on a
   * stalled `/Volumes` mount would otherwise block the run without bound.
   */
  timeoutMs?: number;
};
export type Exec = (argv: string[], opts?: ExecOpts) => Promise<ExecResult>;

/** The exit code a timed-out command reports, matching coreutils `timeout`. */
export const TIMED_OUT = 124;

/** Run an argv via Bun, capturing exit code and output; optionally time-bounded. */
export const bunExec: Exec = async (argv, opts) => {
  const controller = opts?.timeoutMs === undefined ? undefined : new AbortController();
  let timedOut = false;
  const timer =
    controller === undefined || opts?.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, opts.timeoutMs);
  const proc = Bun.spawn(argv, { signal: controller?.signal, stderr: 'pipe', stdout: 'pipe' });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // An abort SIGKILLs the process, so `code` reflects the signal — report the
    // timeout distinctly (124) rather than a confusing signal exit code.
    if (timedOut) {
      return { code: TIMED_OUT, stderr: `timed out after ${String(opts?.timeoutMs)}ms`, stdout };
    }
    return { code, stderr, stdout };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};
