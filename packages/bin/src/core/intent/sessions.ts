import type { NodeRef, OverviewSession } from '@mimir/contract';

/**
 * The recent-sessions composition (MMR-322, ADR 0026 Decision 4) — pure over
 * data the caller already read, so the join rule is unit-testable without a
 * store and replaceable wholesale when phase 4 gives sessions an explicit key.
 *
 * Two layers, deliberately separable:
 *
 * - **Mechanical** ({@link groupSessionRows}) — transition-log rows grouped by
 *   the `session` resume handle they echoed (MMR-320). The grouping itself is
 *   exact: the handle on a row IS that row's session id, and no inference
 *   happens here. What the grouping can SEE is narrower than "what the session
 *   did", because only some boundaries echo a handle at all (MMR-320's policy,
 *   which stands):
 *
 *   - `start` echoes the claim state and the clearing verbs (`done`/`abandon`,
 *     `park`/`block`) echo what they cleared — these rows group;
 *   - `submit`/`return`/`reopen`/`unpark`/`unblock` move no handle and echo
 *     none, so a review-only session produces no group at all;
 *   - a clearing row echoes the handles the task still CARRIED, i.e. the
 *     CLAIMING session's — so a takeover that never re-stated `--session`
 *     credits its terminal row to the session it took over from.
 *
 *   A row with no handle — every row written before MMR-320, and every boundary
 *   that moves none — joins no group. `transitions` counts handle-echoing rows,
 *   not boundaries crossed.
 * - **Editorial** ({@link joinSessionSummaries}) — `session_summary`-tagged
 *   artifacts matched onto those groups by linked-task overlap. This half IS a
 *   heuristic, and disclosed as one: an artifact names the tasks it covers, not
 *   the session it belongs to, so overlap is the only evidence available today.
 */

/**
 * The tag that marks an artifact as a session retrospective (ADR 0026 Decision
 * 4). Deliberately NOT the legacy `session_log` convention: the artifact is a
 * retrospective, not a transcript — the raw log stays with the harness.
 */
export const SESSION_SUMMARY_TAG = 'session_summary';

/** One transition-log row that carried a session handle, flattened for grouping. */
export type SessionRow = {
  /** The `session` handle the row echoed. */
  session: string;
  /** The row's timestamp (ISO-ms-Z). */
  at: string;
  /** The task whose `## History` the row came from. */
  task: NodeRef;
};

/** A derived session activity group — the mechanical layer, before any join. */
export type SessionGroup = {
  id: string;
  from: string;
  to: string;
  transitions: number;
  tasks: NodeRef[];
};

/** A `session_summary` artifact as the join needs it — identity, lede, and the
 * node stems it links, newest-first ordering supplied by `created_at`. */
export type SessionSummaryArtifact = {
  id: string;
  title: string;
  /** The MMR-319 lede; `null` when the artifact carries none. */
  summary: string | null;
  createdAt: string;
  /** Linked node stems (`KEY-seq`). */
  links: readonly string[];
};

/** Descending string compare — ISO-ms-Z timestamps sort lexically. */
function newestFirst(a: string, b: string): number {
  if (a < b) {
    return 1;
  }
  return a > b ? -1 : 0;
}

/**
 * Group transition rows into session activity groups: one group per distinct
 * `session` handle, carrying its window (`min`/`max` of `at`), the tasks it
 * touched in first-touch order, and its row count. Groups come back newest-first
 * by last activity. Rows arrive in any order; the caller need not pre-sort.
 */
export function groupSessionRows(rows: readonly SessionRow[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup & { seen: Set<string> }>();
  for (const row of rows) {
    let group = groups.get(row.session);
    if (group === undefined) {
      group = {
        from: row.at,
        id: row.session,
        seen: new Set<string>(),
        tasks: [],
        to: row.at,
        transitions: 0,
      };
      groups.set(row.session, group);
    }
    group.transitions += 1;
    if (row.at < group.from) {
      group.from = row.at;
    }
    if (row.at > group.to) {
      group.to = row.at;
    }
    if (!group.seen.has(row.task.id)) {
      group.seen.add(row.task.id);
      group.tasks.push(row.task);
    }
  }
  return [...groups.values()].map(({ seen: _seen, ...group }) => group).toSorted(byLastActivity);
}

/** Newest last activity first, with the session id as the tiebreak so two groups
 * that ended in the same millisecond keep a stable order regardless of how the
 * rows arrived. Applied by BOTH exported functions — `joinSessionSummaries` is
 * exported and must not depend on its caller having pre-sorted. */
function byLastActivity(a: { to: string; id: string }, b: { to: string; id: string }): number {
  return newestFirst(a.to, b.to) || cmpId(a.id, b.id);
}

function cmpId(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * Join `session_summary` artifacts onto activity groups by linked-task overlap,
 * yielding the section's entries newest-first.
 *
 * The rule, stated as it is implemented — artifacts are walked newest-first, and
 * each claims the **newest still-unclaimed group its links overlap**:
 *
 * - **newest artifact wins** a contested group, because an older artifact only
 *   ever sees groups the newer ones passed over;
 * - **one group, one artifact**, because a claimed group leaves the candidate
 *   pool — a summary is a retrospective of one sitting, not a label reapplied to
 *   every task it happens to mention;
 * - **an orphan artifact keeps its own entry** (`id: null`), so a session that
 *   produced knowledge without crossing a status boundary is not silently
 *   dropped — the section would otherwise under-report exactly the sessions
 *   whose only output was the write-up.
 */
export function joinSessionSummaries(
  groups: readonly SessionGroup[],
  artifacts: readonly SessionSummaryArtifact[],
): OverviewSession[] {
  // Re-sorted with the same tiebreak `groupSessionRows` applies: this function is
  // exported, so which group a contested artifact claims must not depend on the
  // caller having pre-ordered its input.
  const ordered = groups.toSorted(byLastActivity);
  const claimed = new Map<string, SessionSummaryArtifact>();
  const orphans: SessionSummaryArtifact[] = [];

  for (const artifact of artifacts.toSorted(
    (a, b) => newestFirst(a.createdAt, b.createdAt) || cmpId(a.id, b.id),
  )) {
    const links = new Set(artifact.links);
    // `ordered` is already newest-first, so the first overlap IS the newest one.
    const match = ordered.find(
      (group) => !claimed.has(group.id) && group.tasks.some((task) => links.has(task.id)),
    );
    if (match === undefined) {
      orphans.push(artifact);
    } else {
      claimed.set(match.id, artifact);
    }
  }

  const entries: OverviewSession[] = ordered.map((group) => {
    const entry: OverviewSession = {
      from: group.from,
      id: group.id,
      tasks: group.tasks,
      to: group.to,
      transitions: group.transitions,
    };
    const artifact = claimed.get(group.id);
    if (artifact !== undefined) {
      entry.artifact = toEntryArtifact(artifact);
    }
    return entry;
  });

  for (const artifact of orphans) {
    entries.push({
      artifact: toEntryArtifact(artifact),
      from: artifact.createdAt,
      id: null,
      // A knowledge-only entry has no derived task set of its own; the artifact's
      // links are its subject, and `get KEY-aN` is where they are read in full.
      tasks: [],
      to: artifact.createdAt,
      transitions: 0,
    });
  }

  // A summary-only entry has no session id to tiebreak on, so it falls back to
  // its artifact id — still total, still caller-order-independent.
  return entries.toSorted(
    (a, b) =>
      newestFirst(a.to, b.to) || cmpId(a.id ?? a.artifact?.id ?? '', b.id ?? b.artifact?.id ?? ''),
  );
}

function toEntryArtifact(artifact: SessionSummaryArtifact): OverviewSession['artifact'] {
  return {
    id: artifact.id,
    ...(artifact.summary === null ? {} : { summary: artifact.summary }),
    title: artifact.title,
  };
}
