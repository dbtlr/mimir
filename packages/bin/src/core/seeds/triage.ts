import type {
  HistoryEntry,
  SeedLifecycle,
  TriageReport,
  UpstreamResolution,
} from '@mimir/contract';

import { deriveSet, findProjectInSet, renderNodeIdFromSet } from '../derive';
import { parseSeedRef } from '../ids';
import { annotate } from '../mutations';
import type { Store } from '../store';
import { listSeeds } from './intent';
import { seedLane } from './lane';
import { isTerminalSeed } from './store';

/**
 * The triage pass (MMR-246) — `mimir triage [KEY]`, an explicit-run
 * reconciliation over ONE board, self-contained (no vault-wide scans, no
 * cross-board mutation). Three checks:
 *
 * - (a) the board's new/untriaged seeds — surfaced from the lane classifier.
 * - (b) the board's promoted seeds whose spawned work has all settled
 *   (`readyToResolve`) — an attention signal, NEVER an auto-close.
 * - (c) the board's OWN tasks whose `upstream` seed (on any board) went
 *   terminal — an idempotent annotation is appended recording the resolution,
 *   and an unblock is SUGGESTED (triage never transitions anything).
 *
 * Checks (a)/(b) reuse the MMR-245 resolving seam ({@link listSeeds} +
 * {@link seedLane} + the `readyToResolve` derivation): no lane/readiness/archive
 * logic is re-derived here. Check (c) writes through the existing task annotation
 * path ({@link annotate}), inheriting its guarantees.
 */

/** The machine-recognizable marker grammar (MMR-246) — the durable contract that
 * makes the pass idempotent. The head `upstream <KEY-sN> <resolved|rejected>`
 * carries the seed id + terminal so a re-run recognizes its own prior annotation
 * and skips; the optional `: <reason>` is human-facing detail, not part of the key.
 * The terminal word must be followed by `:` (a reason rides) or end-of-line
 * (`\s*$`, the bare head) — trailing prose (`… resolved by the team`) is a
 * hand-written note, NOT the machine marker, so it never false-positives. */
const UPSTREAM_MARKER = /^upstream (\S+) (resolved|rejected)(?::|\s*$)/;

/** Render the check-(c) annotation content — the marker head plus the seed's
 * terminal reason when one exists. The head is the idempotency key. */
export function renderUpstreamAnnotation(
  seedId: string,
  lifecycle: 'resolved' | 'rejected',
  reason: string | null,
): string {
  const head = `upstream ${seedId} ${lifecycle}`;
  return reason !== null && reason.trim() !== '' ? `${head}: ${reason}` : head;
}

/** Does an existing annotation already record THIS seed going to THIS terminal?
 * Keyed on `(seedId, lifecycle)` only — the reason text is deliberately ignored,
 * so a hand-edited reason never causes a duplicate annotation on a re-run. */
export function annotationRecordsResolution(
  content: string,
  seedId: string,
  lifecycle: 'resolved' | 'rejected',
): boolean {
  const match = UPSTREAM_MARKER.exec(content.trimStart());
  return match !== null && match[1] === seedId && match[2] === lifecycle;
}

/** The reason on the seed's LAST `lifecycle` transition into `terminal` — the
 * resolution/rejection note. `null` when the History carries no such record
 * (a hand-cleared or absent terminal record — the pass degrades gracefully). */
function terminalReason(history: readonly HistoryEntry[], terminal: SeedLifecycle): string | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry !== undefined && entry.kind === 'lifecycle' && entry.to === terminal) {
      return entry.reason;
    }
  }
  return null;
}

/**
 * Resolve the board a triage run targets from a raw argument and the bound scope,
 * trimming and rejecting an empty/blank value with ONE friendly error (MMR-246).
 * Shared by the CLI and MCP fronts so `''`/`'   '` reads the same as a missing
 * board (the friendly "triage requires a board"), never falling through to a
 * generic `projectNotFound`. Each front keeps its own error semantics by passing
 * its factory: the CLI's `usage` (exit 2), the MCP's `validation`.
 */
export function resolveBoard(
  raw: string | undefined,
  boundScope: string | undefined,
  makeError: (message: string, hint?: string) => Error,
): string {
  const board = (raw ?? boundScope)?.trim();
  if (board === undefined || board === '') {
    throw makeError('triage requires a board', 'pass a KEY or bind a board first (mimir bind KEY)');
  }
  return board;
}

export type TriageOptions = {
  /** The board to reconcile (a project KEY). */
  board: string;
  /** Preview only — report what WOULD be annotated, write nothing (default: false). */
  dryRun?: boolean;
};

export async function triage(store: Store, opts: TriageOptions): Promise<TriageReport> {
  const dryRun = opts.dryRun ?? false;

  // (a)+(b): the board's live seeds through the resolving seam. `listSeeds` also
  // validates the board is a known ACTIVE project (throws otherwise), so it is
  // the single gate — an archived/absent board never reaches the writes below.
  const liveSeeds = await listSeeds(store, { project: opts.board, status: 'live' });
  const untriaged = liveSeeds.filter((seed) => seedLane(seed) === 'untriaged');
  const readyToResolve = liveSeeds.filter((seed) => seedLane(seed) === 'ready');

  // (c): the board's OWN tasks with an `upstream` ref. A malformed ref was already
  // nulled at the reader's grammar tier, so any non-null `upstream` is valid s-grammar.
  const set = deriveSet(await store.loadWorkingSet());
  const project = findProjectInSet(set, opts.board);
  const tasks =
    project === undefined
      ? []
      : (set.nodesByProject.get(project.id) ?? []).filter(
          (node) => node.type === 'task' && node.upstream !== null,
        );

  const upstreamResolutions: UpstreamResolution[] = [];
  for (const task of tasks) {
    const upstream = task.upstream;
    if (upstream === null) {
      continue;
    }
    const ref = parseSeedRef(upstream);
    if (ref === null) {
      continue;
    }
    // Cross-board: the upstream seed's store read resolves by KEY-sN on ANY board.
    const seedRec = await store.seeds.load(ref.key, ref.seq);
    if (seedRec === undefined || !isTerminalSeed(seedRec.lifecycle)) {
      continue;
    }
    // `isTerminalSeed` narrows the lifecycle to `resolved | rejected` (the guard).
    const terminal = seedRec.lifecycle;
    const taskStem = renderNodeIdFromSet(set, task);
    if (taskStem === null) {
      continue;
    }
    const reason = terminalReason(
      (await store.seeds.loadHistory(ref.key, ref.seq)) ?? [],
      terminal,
    );

    // Idempotency: skip a task whose annotations already record THIS terminal for
    // THIS seed. The existing annotations read through the task's annotation seam.
    const existing = await store.bodySections.readAnnotations(task.id, taskStem);
    const alreadyRecorded = existing.some((note) =>
      annotationRecordsResolution(note.content, upstream, terminal),
    );

    let annotated = false;
    if (!alreadyRecorded && !dryRun) {
      await annotate(store, task.id, renderUpstreamAnnotation(upstream, terminal, reason));
      annotated = true;
    }

    upstreamResolutions.push({
      alreadyRecorded,
      annotated,
      blocked: task.hold === 'blocked',
      lifecycle: terminal,
      reason,
      task: taskStem,
      upstream,
    });
  }

  return { board: opts.board, dryRun, readyToResolve, untriaged, upstreamResolutions };
}
