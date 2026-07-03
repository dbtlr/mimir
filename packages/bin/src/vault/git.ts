/**
 * Git over the vault, as a thin seam over `Exec` (MMR-142, MMR-146). Identity,
 * signing, and hooks are pinned per-command so commits never depend on (or
 * touch) the operator's global git config — a global `commit.gpgsign=true` with
 * no key in the daemon context would otherwise fail every vault commit.
 *
 * Two postures share this one builder:
 *   - `run` records a failure as a warning and continues (converge's "the vault
 *     works, but has no history" degradation).
 *   - `capture`/`probe` return the raw exit code so the caller decides what a
 *     nonzero means — the snapshot command needs this to tell a rejected push
 *     (recoverable) from a hung filesystem (an alert).
 */
import type { Exec, ExecResult } from '../exec';

export type GitCapture = { code: number; stdout: string; stderr: string };

export type Git = {
  /** Run; a nonzero exit is recorded in `warnings` and returns false. */
  run: (args: string[], failure: string, timeoutMs?: number) => Promise<boolean>;
  /** A probe whose nonzero exit is an answer, not a failure — never warns. */
  probe: (args: string[], timeoutMs?: number) => Promise<number>;
  /** Full result (code + output) for callers that branch on the exit code. */
  capture: (args: string[], timeoutMs?: number) => Promise<GitCapture>;
  warnings: string[];
};

export function gitAt(path: string, exec: Exec): Git {
  const warnings: string[] = [];
  const argv = (args: string[]): string[] => [
    'git',
    '-C',
    path,
    '-c',
    'user.name=mimir',
    '-c',
    'user.email=mimir@localhost',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    ...args,
  ];
  // A missing git binary rejects the exec itself (spawn ENOENT) — that is a
  // degraded environment, not a git failure. Code 127 keeps it distinct from a
  // real nonzero git exit and from a timeout (124).
  const attempt = async (args: string[], timeoutMs?: number): Promise<ExecResult> => {
    try {
      return await exec(argv(args), timeoutMs === undefined ? undefined : { timeoutMs });
    } catch (error) {
      return {
        code: 127,
        stderr: error instanceof Error ? error.message : String(error),
        stdout: '',
      };
    }
  };
  return {
    async capture(args: string[], timeoutMs?: number): Promise<GitCapture> {
      return await attempt(args, timeoutMs);
    },
    async probe(args: string[], timeoutMs?: number): Promise<number> {
      return (await attempt(args, timeoutMs)).code;
    },
    async run(args: string[], failure: string, timeoutMs?: number): Promise<boolean> {
      const result = await attempt(args, timeoutMs);
      if (result.code !== 0) {
        const detail = result.stderr.trim();
        warnings.push(`git: ${failure}${detail === '' ? '' : ` (${detail})`}`);
        return false;
      }
      return true;
    },
    warnings,
  };
}
