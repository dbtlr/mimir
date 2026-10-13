import type {
  AnnotationView,
  HistoryEntry,
  NodeRef,
  NodeView,
  WorkFrontierTask,
  WorkNeedsYouReason,
  WorkNeedsYouTask,
  WorkNowTask,
  WorkReport,
  WorkScope,
  WorkShippedTask,
  WorkUnlockGroup,
  WorkWaitingTask,
} from '@mimir/contract';

import { recentDaysWindow, withinWindow } from '../dates';
import type { DerivationSet } from '../derive';
import { deriveSet, findNodeInSet, hasUnsettledPrereq, nodeStatusWord } from '../derive';
import { notFound, projectNotFound, validation } from '../errors';
import { parseIdentity } from '../ids';
import type { Node } from '../model';
import { isStale } from '../predicates';
import { boardOrder } from '../resource';
import type { Store } from '../store';
import { now } from '../time';
import { byRankOrder } from './queries';
import { buildAwaitingOn, buildNodeView } from './view';

/**
 * The work page (MMR-469): the console's per-scope derivation. A scope is a
 * project, or an initiative or phase and its whole subtree; a task has no work
 * page. Rows are tasks, plus the initiatives and phases that read to break down
 * (in `frontier.toGroom` only), and no section is capped (the page is a working surface, not the
 * orientation digest {@link import('./queries').overviewOf} is).
 */

export type WorkOptions = {
  /** Reference time (ISO-ms-Z) for the shipped window and staleness; defaults to now. */
  asOf?: string;
  /** The caller's IANA zone, which decides where the shipped days begin and end (ADR 0029). Required: there is no fallback zone. */
  timeZone: string;
};

/** The shipped window spans this many caller-local calendar days, today included. */
const SHIPPED_WINDOW_DAYS = 7;

/** The scope's identity, every task beneath it, and every container beneath it (the scope itself excluded). */
type ScopedTasks = { scope: WorkScope; projectKey: string; tasks: Node[]; containers: Node[] };

/** Resolve the scope id to its identity and every task beneath it. */
function resolveWorkScope(set: DerivationSet, id: string): ScopedTasks {
  const identity = parseIdentity(id);
  if (identity?.kind === 'artifact') {
    throw validation(`${id} is an artifact, not a project, initiative, or phase`);
  }
  if (identity?.kind === 'seed') {
    throw validation(`${id} is a seed, not a project, initiative, or phase`);
  }
  if (identity?.kind === 'project') {
    const project = set.projectByKey.get(identity.key);
    // An archived project reads as absent, like every other view (ADR 0015).
    if (project === undefined || project.archived_at !== null) {
      throw projectNotFound(identity.key);
    }
    const nodes = set.nodesByProject.get(project.key) ?? [];
    return {
      containers: nodes.filter((n) => n.type !== 'task'),
      projectKey: project.key,
      scope: { id: project.key, kind: 'project', title: project.name },
      tasks: nodes.filter((n) => n.type === 'task'),
    };
  }
  const root = findNodeInSet(set, id);
  if (root === undefined || set.archivedProjects.has(root.project_id)) {
    throw notFound(`${id} doesn't exist`);
  }
  if (root.type === 'task') {
    throw validation(
      `${id} is a task, not a project, initiative, or phase`,
      'a work page covers a project or a container',
    );
  }
  const tasks: Node[] = [];
  const containers: Node[] = [];
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    for (const child of set.childrenByParent.get(node.id) ?? []) {
      if (child.type === 'task') {
        tasks.push(child);
      } else {
        containers.push(child);
        pending.push(child);
      }
    }
  }
  return {
    containers,
    projectKey: root.project_id,
    scope: { id: root.id, kind: root.type, title: root.title },
    tasks,
  };
}

/** Newest `updated_at` first, then lowest seq — a deterministic recency order. */
export const byRecency = (a: Node, b: Node): number =>
  cmpStr(b.updated_at, a.updated_at) || a.seq - b.seq;

/** Ordinal string comparison — the canonical timestamps sort chronologically as text. */
export function cmpStr(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/** The needs-you reasons in page order: a verdict, then a block on the operator, then a question. */
export const NEEDS_YOU_REASON_ORDER: readonly WorkNeedsYouReason[] = [
  'under_review',
  'blocked',
  'needs_answers',
];

/**
 * Why a task waits on the operator, or `undefined` when it does not: under
 * review, blocked with an owner of `you`, or a `todo` with no hold whose
 * grooming state is needs-answers. The one membership rule the work page's
 * `needsYou` and the review page's decisions share. `word` is the task's
 * {@link nodeStatusWord}.
 */
export function needsYouReasonOf(
  node: Node,
  word: ReturnType<typeof nodeStatusWord>,
): WorkNeedsYouReason | undefined {
  if (word === 'under_review') {
    return 'under_review';
  }
  if (word === 'blocked' && node.block_owner === 'you') {
    return 'blocked';
  }
  if (node.lifecycle === 'todo' && node.hold === 'none' && node.grooming === 'needs_answers') {
    return 'needs_answers';
  }
  return undefined;
}

/** The statuses a prerequisite can hold and still be "one step away" from done. */
const ONE_STEP_STATUSES = new Set(['in_progress', 'under_review', 'ready']);

/**
 * Is this todo task (or break-down container) on the frontier — ready, or
 * awaiting only prerequisites that are themselves in flight or ready (at most
 * one step from startable)? A
 * prerequisite that is blocked, parked, or itself awaiting puts the task two or
 * more steps away. Own and ancestor-inherited edges both count, and a
 * prerequisite outside the scope still gates.
 */
function frontierPrereqs(set: DerivationSet, node: Node): NodeRef[] | undefined {
  if (!hasUnsettledPrereq(set, node.id)) {
    return [];
  }
  const awaitingOn = buildAwaitingOn(set, node.id);
  return awaitingOn.every((ref) => ONE_STEP_STATUSES.has(ref.status ?? ''))
    ? awaitingOn
    : undefined;
}

export const latestOf = <T>(items: readonly T[] | undefined): T | undefined => items?.at(-1);

/**
 * When the task last started: its latest move into in_progress that did not come
 * back from review. A start and a reopen count; a return from review continues
 * the same run of work.
 */
function startedAtOf(task: Node, history: readonly HistoryEntry[]): string {
  const start = latestOf(
    history.filter(
      (h) => h.kind === 'lifecycle' && h.to === 'in_progress' && h.from !== 'under_review',
    ),
  );
  return start?.at ?? task.updated_at;
}

/** The abandon transition's time and reason; falls back to the row's stamp when the log is silent. */
export function abandonedOf(
  task: Node,
  history: readonly HistoryEntry[],
): { at: string; reason: string | null } {
  const entry = latestOf(history.filter((h) => h.kind === 'lifecycle' && h.to === 'abandoned'));
  return { at: entry?.at ?? task.updated_at, reason: entry?.reason ?? null };
}

/**
 * The work page for a project key, or an initiative/phase id (its whole subtree).
 *
 * Sections:
 * - `now`: in-progress tasks, with when they started, the latest note, and any
 *   linked Scratchpads (harness/branch/host/session/externalRef ride the task).
 * - `needsYou`: under review, then blocked with an owner of `you`, then
 *   needs-answers todos (the latest note is the question); newest first within each.
 * - `frontier`: todo tasks at most one step from startable. Groomed and ready are
 *   `runnable` (`next` order); groomed and awaiting are `nextToUnlock`; ungroomed
 *   ones are `toGroom`, followed by the initiatives and phases in scope that read
 *   to break down (no children at all, ADR 0033), under the same one-step rule on
 *   their own and inherited edges. A groomed, ready task with no rank has no
 *   row, as `next` omits it. A needs-answers task is in `needsYou`, not
 *   here. `waitingOnOthers` holds the tasks blocked with an owner of `others`,
 *   oldest update first (blocking clears rank, so rank order is not available).
 * - `shipped`: done or abandoned during the last 7 caller-local calendar days
 *   (today included, in `timeZone`), newest first.
 * - `goingCold`: every stale task in scope, oldest first. It is the one section
 *   that repeats tasks other sections show; the other sections flag them `stale`.
 *
 * Elsewhere a task appears in one section only, in page order. Parked tasks
 * have no row.
 */
export async function workPageOf(store: Store, id: string, opts: WorkOptions): Promise<WorkReport> {
  const set = deriveSet(await store.loadWorkingSet());
  const { scope, projectKey, tasks, containers } = resolveWorkScope(set, id);
  const asOf = opts.asOf ?? now();
  const shippedWindow = recentDaysWindow(asOf, SHIPPED_WINDOW_DAYS, opts.timeZone);
  const rankOrder = byRankOrder(set);

  const nowNodes: Node[] = [];
  const needsYou: { node: Node; reason: WorkNeedsYouReason }[] = [];
  const frontier: { node: Node; awaitingOn: NodeRef[] }[] = [];
  const waitingOnOthers: Node[] = [];
  const shippedCandidates: Node[] = [];
  const staleIds = new Set<string>();

  for (const node of tasks.toSorted(rankOrder)) {
    const word = nodeStatusWord(set, node);
    const needsYouReason = needsYouReasonOf(node, word);
    if (word === 'in_progress') {
      nowNodes.push(node);
    } else if (needsYouReason !== undefined) {
      needsYou.push({ node, reason: needsYouReason });
    } else if (word === 'blocked' && node.block_owner === 'others') {
      waitingOnOthers.push(node);
    } else if (node.lifecycle === 'todo' && node.hold === 'none') {
      const awaitingOn = frontierPrereqs(set, node);
      if (awaitingOn !== undefined) {
        frontier.push({ awaitingOn, node });
      }
    } else if (node.lifecycle === 'done' || node.lifecycle === 'abandoned') {
      // Prefilter on the stamp that moves at (or after) the finish; the exact
      // time is settled below. `completed_at` is the done stamp; an abandon
      // only touches `updated_at`.
      const stamp =
        node.lifecycle === 'done' ? (node.completed_at ?? node.updated_at) : node.updated_at;
      if (stamp >= (shippedWindow.from?.at ?? '')) {
        shippedCandidates.push(node);
      }
    }
    if (isStale(set, node, { asOf })) {
      staleIds.add(node.id);
    }
  }

  // Initiatives and phases with no children at all read to break down (ADR 0033).
  // Any child counts, finished, parked, or an open-ended home included (the
  // rollup drops that last one, so the children list is tested, not the tally).
  // A standing open-ended home is meant to stay empty, so it is not a row itself.
  const breakDown = containers
    .filter((c) => c.open_ended !== true && (set.childrenByParent.get(c.id) ?? []).length === 0)
    .toSorted(boardOrder)
    .flatMap((node) => {
      const awaitingOn = frontierPrereqs(set, node);
      return awaitingOn === undefined ? [] : [{ awaitingOn, node }];
    });

  const needsAnswers = needsYou.filter((n) => n.reason === 'needs_answers').map((n) => n.node.id);
  const abandonedStems = shippedCandidates
    .filter((n) => n.lifecycle === 'abandoned')
    .map((n) => n.id);
  const [nowSections, questionSections, abandonSections, scratchpads] = await Promise.all([
    store.bodySections.readSectionsMany(
      nowNodes.map((n) => n.id),
      { annotations: true, history: true },
    ),
    store.bodySections.readSectionsMany(needsAnswers, { annotations: true }),
    store.bodySections.readSectionsMany(abandonedStems, { history: true }),
    nowNodes.length === 0 ? Promise.resolve([]) : store.scratchpads.list(projectKey),
  ]);

  // A task can sit in several next-to-unlock groups; build its view once per call.
  const views = new Map<string, NodeView>();
  const viewOf = async (node: Node): Promise<NodeView> => {
    const cached = views.get(node.id);
    if (cached !== undefined) {
      return cached;
    }
    const view = await buildNodeView(store.bodySections, store.artifacts, set, node);
    views.set(node.id, view);
    return view;
  };

  const nowRows: WorkNowTask[] = await Promise.all(
    nowNodes.map(async (node) => {
      const sections = nowSections.get(node.id);
      const note: AnnotationView | undefined = latestOf(sections?.annotations);
      return {
        latestNote: note ?? null,
        scratchpads: scratchpads
          .filter((pad) => pad.anchors.includes(node.id))
          .map((pad) => ({ id: pad.id, title: pad.title })),
        stale: staleIds.has(node.id),
        startedAt: startedAtOf(node, sections?.history ?? []),
        task: await viewOf(node),
      };
    }),
  );

  const needsYouRows: WorkNeedsYouTask[] = await Promise.all(
    needsYou
      .toSorted(
        (a, b) =>
          NEEDS_YOU_REASON_ORDER.indexOf(a.reason) - NEEDS_YOU_REASON_ORDER.indexOf(b.reason) ||
          byRecency(a.node, b.node),
      )
      .map(async ({ node, reason }) => ({
        question:
          reason === 'needs_answers'
            ? (latestOf(questionSections.get(node.id)?.annotations)?.content ?? null)
            : null,
        reason,
        stale: staleIds.has(node.id),
        task: await viewOf(node),
      })),
  );

  const frontierRow = async (entry: {
    node: Node;
    awaitingOn: NodeRef[];
  }): Promise<WorkFrontierTask> => ({
    awaitingOn: entry.awaitingOn.map((ref) => ref.id),
    breakDown: entry.node.type !== 'task',
    stale: staleIds.has(entry.node.id),
    task: await viewOf(entry.node),
  });
  const groomed = frontier.filter((e) => e.node.grooming === 'groomed');
  // Runnable is `next`'s selection: ready and ranked.
  const runnable = await Promise.all(
    groomed.filter((e) => e.awaitingOn.length === 0 && e.node.rank !== null).map(frontierRow),
  );
  const toGroom = await Promise.all(
    [...frontier.filter((e) => e.node.grooming !== 'groomed'), ...breakDown].map(frontierRow),
  );
  const waiting: WorkWaitingTask[] = await Promise.all(
    waitingOnOthers
      .toSorted((a, b) => cmpStr(a.updated_at, b.updated_at) || a.seq - b.seq)
      .map(async (node) => {
        const task = await viewOf(node);
        return { blockReason: task.holdReason ?? null, stale: staleIds.has(node.id), task };
      }),
  );
  const nextToUnlock = await groupByPrerequisite(
    set,
    groomed.filter((e) => e.awaitingOn.length > 0),
    frontierRow,
  );

  const shipped: WorkShippedTask[] = [];
  for (const node of shippedCandidates) {
    const abandoned =
      node.lifecycle === 'abandoned'
        ? abandonedOf(node, abandonSections.get(node.id)?.history ?? [])
        : undefined;
    const finishedAt = abandoned?.at ?? node.completed_at ?? node.updated_at;
    if (withinWindow(shippedWindow, finishedAt)) {
      shipped.push({
        abandonReason: abandoned?.reason ?? null,
        finishedAt,
        stale: staleIds.has(node.id),
        task: await viewOf(node),
      });
    }
  }
  // Newest first; the higher seq (created later, so most likely finished later)
  // breaks a same-millisecond tie.
  shipped.sort((a, b) => cmpStr(b.finishedAt, a.finishedAt) || seqOf(b.task.id) - seqOf(a.task.id));

  // Going cold repeats tasks other sections show; those rows carry `stale` too.
  const goingCold = await Promise.all(
    tasks
      .filter((n) => staleIds.has(n.id))
      .toSorted((a, b) => cmpStr(a.updated_at, b.updated_at) || a.seq - b.seq)
      .map(viewOf),
  );

  return {
    frontier: { nextToUnlock, runnable, toGroom, waitingOnOthers: waiting },
    goingCold,
    needsYou: needsYouRows,
    now: nowRows,
    scope,
    shipped,
  };
}

export const seqOf = (id: string): number => Number(id.slice(id.lastIndexOf('-') + 1));

/**
 * Group groomed-and-awaiting tasks by the prerequisite each waits on. A task
 * waiting on several in-frontier prerequisites appears under EACH of them, so
 * whichever prerequisite lands first shows what it is holding up. Groups follow
 * the prerequisites' board order; tasks inside a group keep rank order.
 */
async function groupByPrerequisite(
  set: DerivationSet,
  entries: readonly { node: Node; awaitingOn: NodeRef[] }[],
  rowOf: (entry: { node: Node; awaitingOn: NodeRef[] }) => Promise<WorkFrontierTask>,
): Promise<WorkUnlockGroup[]> {
  const groups = new Map<string, { prerequisite: NodeRef; entries: (typeof entries)[number][] }>();
  for (const entry of entries) {
    for (const prerequisite of entry.awaitingOn) {
      const group = groups.get(prerequisite.id);
      if (group === undefined) {
        groups.set(prerequisite.id, { entries: [entry], prerequisite });
      } else {
        group.entries.push(entry);
      }
    }
  }
  const rankOrder = byRankOrder(set);
  const ordered = [...groups.values()].toSorted((a, b) => {
    const left = set.nodeById.get(a.prerequisite.id);
    const right = set.nodeById.get(b.prerequisite.id);
    return left === undefined || right === undefined ? 0 : rankOrder(left, right);
  });
  return Promise.all(
    ordered.map(async (group) => ({
      prerequisite: {
        id: group.prerequisite.id,
        status: group.prerequisite.status,
        title: group.prerequisite.title,
      },
      tasks: await Promise.all(group.entries.map(rowOf)),
    })),
  );
}
