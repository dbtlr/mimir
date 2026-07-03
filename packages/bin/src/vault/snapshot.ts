/**
 * The vault git snapshot (MMR-146) — the commit cadence ADR 0016 deferred:
 * periodic snapshots, not per-write commits. Modeled on the atlas snapshotter's
 * hard-won posture:
 *
 *   - **Quiet-success / loud-exception.** A clean tree, a local commit, a clean
 *     push all return with no `alerts`; the caller stays silent and exits 0.
 *     `alerts` is non-empty only when something needs a human — then the caller
 *     prints them and exits nonzero (launchd simply fires again next interval).
 *   - **Commit first, then reconcile.** Stage + commit local work, THEN push;
 *     a push is attempted cheaply first and only reconciled (fetch + merge, not
 *     rebase — both sides preserved) when the remote has moved on.
 *   - **Refuse to pile on.** Detached HEAD or an in-progress merge/rebase is an
 *     alert, never a commit over a half-finished state.
 *   - **Bounded.** Every git call is timeout-wrapped, because the vault can live
 *     on a hangable `/Volumes` mount and a stalled `git` must not wedge the run.
 *
 * The core is pure over the `Exec` seam and an injected `stamp`, so the whole
 * decision tree is testable with a scripted fake — no real git, no clock.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { TIMED_OUT } from '../exec';
import type { Exec } from '../exec';
import { gitAt } from './git';

export type SnapshotOutcome =
  /** Nothing to commit and nothing to push — a silent no-op. */
  | 'clean'
  /** Committed (or already current) but not pushed — local-only by config or absence of a remote. */
  | 'committed'
  /** Committed (or already current) and pushed cleanly. */
  | 'pushed'
  /** Pushed after reconciling with a diverged upstream (fetch + merge). */
  | 'reconciled';

export type SnapshotResult = {
  outcome: SnapshotOutcome;
  committed: boolean;
  pushed: boolean;
  branch?: string;
  /** Non-empty ⇒ something needs a human; the caller prints these and exits nonzero. */
  alerts: string[];
  /** Degraded-but-handled notes (e.g. a push that was reconciled) — logged, never fatal. */
  warnings: string[];
};

export type SnapshotOptions = {
  path: string;
  exec: Exec;
  /** ISO timestamp for the commit message — injected so the core has no clock. */
  stamp: string;
  /** Remote URL to adopt as `origin` when the branch has no upstream (`[vault] snapshot.upstream`). */
  upstream?: string;
  /** Push after committing. Default true; false = purely local snapshots. */
  push?: boolean;
  /** Reconcile (fetch + merge) a rejected push. Default true; false = a rejected push is an alert. */
  pull?: boolean;
  /** Timeout for local inspections (default 15s). */
  quickTimeoutMs?: number;
  /** Timeout for commit + network ops (default 45s). */
  timeoutMs?: number;
};

const DEFAULT_QUICK_MS = 15_000;
const DEFAULT_LONG_MS = 45_000;

/** True if a merge/rebase is mid-flight — committing over it would corrupt the reconciliation. */
function operationInProgress(path: string): boolean {
  const gitDir = join(path, '.git');
  return (
    existsSync(join(gitDir, 'rebase-merge')) ||
    existsSync(join(gitDir, 'rebase-apply')) ||
    existsSync(join(gitDir, 'MERGE_HEAD'))
  );
}

export async function snapshotVault(opts: SnapshotOptions): Promise<SnapshotResult> {
  const quick = opts.quickTimeoutMs ?? DEFAULT_QUICK_MS;
  const long = opts.timeoutMs ?? DEFAULT_LONG_MS;
  const push = opts.push ?? true;
  const pull = opts.pull ?? true;
  const git = gitAt(opts.path, opts.exec);
  const warnings: string[] = [];
  const alert = (message: string, extra: Partial<SnapshotResult> = {}): SnapshotResult => ({
    alerts: [message],
    committed: false,
    outcome: 'clean',
    pushed: false,
    warnings,
    ...extra,
  });

  // Preflight through the timeout-bounded git seam first — NOT a bare
  // existsSync, which would block the event loop unbounded on a hung /Volumes
  // mount (the exact failure this module guards against). A quick, killable
  // `rev-parse` distinguishes a hung mount (timeout) from a responsive one; the
  // subsequent existsSync only ever runs after that returned, so it is safe.
  const inside = await git.capture(['rev-parse', '--is-inside-work-tree'], quick);
  if (inside.code === TIMED_OUT) {
    return alert(
      `git could not inspect ${opts.path} within ${String(quick)}ms — the volume may be hanging`,
    );
  }
  if (inside.code !== 0) {
    // The bounded call returned, so the filesystem is responsive: a plain
    // existsSync now safely tells "missing volume" from "not a git repository".
    return alert(
      existsSync(opts.path)
        ? `${opts.path} is not a git repository`
        : `vault not found at ${opts.path}`,
    );
  }
  const branchResult = await git.capture(['branch', '--show-current'], quick);
  const branch = branchResult.stdout.trim();
  if (branchResult.code === TIMED_OUT) {
    return alert(`git timed out reading the branch of ${opts.path}`);
  }
  // A nonzero (non-timeout) exit is a git error, NOT detached HEAD — both leave
  // an empty branch, so guard the error case before assuming detached HEAD.
  if (branchResult.code !== 0) {
    return alert(`git could not read the branch of ${opts.path}${detail(branchResult.stderr)}`);
  }
  if (branch === '') {
    return alert(`${opts.path} is in detached HEAD — not snapshotting`);
  }
  // operationInProgress uses existsSync on .git/*, safe here: the two bounded
  // git calls above already succeeded, proving the mount is responsive.
  if (operationInProgress(opts.path)) {
    return alert(`an in-progress merge/rebase exists in ${opts.path} — not committing over it`, {
      branch,
    });
  }

  // Stage everything (adds, edits, deletes) then commit iff something staged.
  const add = await git.capture(['add', '-A'], long);
  if (add.code !== 0) {
    return alert(`git add failed in ${opts.path}${detail(add.stderr)}`, { branch });
  }
  const staged = await git.capture(['diff', '--cached', '--quiet'], quick);
  if (staged.code === TIMED_OUT) {
    return alert(`git diff timed out in ${opts.path}`, { branch });
  }
  let committed = false;
  if (staged.code !== 0) {
    const commit = await git.capture(['commit', '-m', `auto snapshot: ${opts.stamp}`], long);
    if (commit.code !== 0) {
      return alert(`git commit failed in ${opts.path}${detail(commit.stderr)}`, { branch });
    }
    committed = true;
  }

  const localResult = (): SnapshotResult => ({
    alerts: [],
    branch,
    committed,
    outcome: committed ? 'committed' : 'clean',
    pushed: false,
    warnings,
  });

  // Push disabled by config → a purely local, durable snapshot.
  if (!push) {
    return localResult();
  }

  return await pushPhase(
    git,
    { branch, committed, localResult, long, pull, quick, warnings },
    opts,
  );
}

type PushContext = {
  branch: string;
  committed: boolean;
  localResult: () => SnapshotResult;
  quick: number;
  long: number;
  pull: boolean;
  warnings: string[];
};

/** The push half: cheap push first, reconcile (fetch + merge) only on rejection. */
async function pushPhase(
  git: ReturnType<typeof gitAt>,
  ctx: PushContext,
  opts: SnapshotOptions,
): Promise<SnapshotResult> {
  const { branch, committed, quick, long, pull, warnings } = ctx;
  const fail = (message: string): SnapshotResult => ({
    alerts: [message],
    branch,
    committed,
    outcome: committed ? 'committed' : 'clean',
    pushed: false,
    warnings,
  });
  const pushed = (outcome: SnapshotOutcome): SnapshotResult => ({
    alerts: [],
    branch,
    committed,
    outcome,
    pushed: true,
    warnings,
  });

  const upstream = await git.capture(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    quick,
  );
  if (upstream.code === TIMED_OUT) {
    return fail(`git timed out resolving the upstream of ${branch}`);
  }

  // No branch upstream: establish one if there's an origin (or a configured URL
  // to adopt as origin); otherwise this is a purely local repo — nothing to push.
  if (upstream.code !== 0) {
    const hasOrigin = (await git.probe(['remote', 'get-url', 'origin'], quick)) === 0;
    if (!hasOrigin && opts.upstream === undefined) {
      return ctx.localResult();
    }
    if (!hasOrigin && opts.upstream !== undefined) {
      const add = await git.capture(['remote', 'add', 'origin', opts.upstream], quick);
      if (add.code !== 0) {
        return fail(`could not add origin ${opts.upstream}${detail(add.stderr)}`);
      }
    }
    const first = await git.capture(['push', '-u', 'origin', branch], long);
    if (first.code !== 0) {
      return fail(`push -u origin ${branch} failed${detail(first.stderr)}`);
    }
    return pushed('pushed');
  }

  // Steady state: try the cheap push first.
  if ((await git.probe(['push'], long)) === 0) {
    return pushed('pushed');
  }
  if (!pull) {
    return fail(`push to ${upstream.stdout.trim()} was rejected and reconcile is disabled`);
  }
  return await reconcile(git, ctx, upstream.stdout.trim(), { fail, pushed });
}

/** A rejected push, with reconcile enabled: fetch, retry, merge (not rebase), push. */
async function reconcile(
  git: ReturnType<typeof gitAt>,
  ctx: PushContext,
  upstreamName: string,
  make: { fail: (m: string) => SnapshotResult; pushed: (o: SnapshotOutcome) => SnapshotResult },
): Promise<SnapshotResult> {
  const { long, warnings } = ctx;
  const fetch = await git.capture(['fetch', '--prune'], long);
  if (fetch.code !== 0) {
    return make.fail(`push was rejected and the follow-up fetch failed${detail(fetch.stderr)}`);
  }
  // A transient rejection may clear once fetch has run.
  if ((await git.probe(['push'], long)) === 0) {
    warnings.push('snapshot: push succeeded after a fetch');
    return make.pushed('reconciled');
  }
  const merge = await git.capture(['merge', '--no-edit', upstreamName], long);
  if (merge.code !== 0) {
    // Leave a clean tree behind: abort the mechanical merge and hand the
    // conflict to a human. The local commit is already safe on disk.
    await git.capture(['merge', '--abort'], ctx.quick);
    return make.fail(
      `snapshot hit an unresolved merge conflict with ${upstreamName} — manual reconciliation needed`,
    );
  }
  if ((await git.probe(['push'], long)) === 0) {
    warnings.push(`snapshot: merged ${upstreamName} and pushed`);
    return make.pushed('reconciled');
  }
  return make.fail(`merged ${upstreamName} cleanly but the push still failed`);
}

const detail = (stderr: string): string => {
  const trimmed = stderr.trim();
  return trimmed === '' ? '' : ` (${trimmed})`;
};
