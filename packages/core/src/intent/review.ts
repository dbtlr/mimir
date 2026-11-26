import type {
  ReviewNeedsYouGroup,
  ReviewProject,
  ReviewReport,
  ReviewWorkRow,
  WorkNeedsYouRow,
  WorkNowTask,
} from '@mimir/contract';

import { recentDaysWindow } from '../dates';
import { isTerminalWord, nodeStatusWord } from '../derive';
import type { Project } from '../model';
import { listSeedsResolved } from '../seeds/intent';
import type { Store } from '../store';
import { now } from '../time';
import {
  recordNeedsYou,
  byNeedsYouRowOrder,
  needsYouFactsOf,
  needsYouRank,
  needsYouClock,
  needsYouId,
  needsYouProject,
} from './needs-you';
import {
  SHIPPED_WINDOW_DAYS,
  classifyWork,
  cmpStr,
  isRunnable,
  latestOf,
  nowRowsOf,
  projectKeyOf,
  shippedRowsOf,
  workRowSource,
} from './work';

/**
 * The review page (MMR-477): the console's cross-project derivation of what
 * needs the operator. Ordering rules are ADR 0019's MMR-476 refinement.
 */

export type ReviewOptions = {
  /** Reference time (ISO-ms-Z) for staleness; defaults to now. */
  asOf?: string;
  /**
   * The caller's IANA zone, which places the `shipped` window (ADR 0029). Without
   * it the window cannot be placed and `shipped` is empty.
   */
  timeZone?: string;
};

/** Everything the page derives about one active project before it is ordered. */
type ProjectFacts = {
  project: Project;
  /** The project’s needs-you set in the shared five-kind order. */
  needsYou: WorkNeedsYouRow[];
  untriaged: number;
  goingCold: number;
  findings: number;
  inFlight: number;
  live: number;
  runnable: number;
};

const triageCount = (f: ProjectFacts): number => f.untriaged + f.goingCold + f.findings;

/** How many of `items` each key holds. */
function countBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** A now row's latest move: a review's submit, otherwise its reservation or start. */
const lastMoveOf = (row: WorkNowTask): string => row.submittedAt ?? row.startedAt;

/**
 * Urgency order over projects with needs-you rows: the leading row's kind,
 * then the newer leading record by its own clock, then key.
 */
function byUrgency(
  a: { key: string; lead: WorkNeedsYouRow },
  b: { key: string; lead: WorkNeedsYouRow },
): number {
  return (
    needsYouRank(a.lead) - needsYouRank(b.lead) ||
    cmpStr(needsYouClock(b.lead), needsYouClock(a.lead)) ||
    cmpStr(a.key, b.key)
  );
}

/**
 * The rail's project order: pinned projects first, then the most recent
 * activity (newest first), then key. `activity` is `Store.loadProjectActivity`;
 * a project it does not name falls back to its own `updated_at`.
 */
const byRailOrder =
  (activity: ReadonlyMap<string, string>) =>
  (a: Project, b: Project): number =>
    Number(b.pinned) - Number(a.pinned) ||
    cmpStr(activity.get(b.key) ?? b.updated_at, activity.get(a.key) ?? a.updated_at) ||
    cmpStr(a.key, b.key);

/** Tag each work-page row with the project its task belongs to. */
const tagged = <T extends { task: { id: string } }>(rows: readonly T[]): ReviewWorkRow<T>[] =>
  rows.map((row) => ({ ...row, project: projectKeyOf(row.task.id) }));

/**
 * The review page across every active (non-archived) project.
 *
 * - `needsYou`: per project with any, the work page's `needsYou` rows (task rows
 *   follow `needsYouReasonOf`; delivery and decision rows come from
 *   `recordNeedsYou`), projects in urgency order.
 * - `queue`: each member’s kind and id, in the shared order across projects.
 * - `projects`: every active project in the rail's order (pinned first, then
 *   newest activity), with its counts: needs-you, in-flight, live, untriaged
 *   seeds, doctor findings, runnable, going cold, and triage (untriaged plus going
 *   cold plus findings). `live` is the `--status live` group: every status but
 *   done and abandoned, so parked work counts. `runnable` and `goingCold` count
 *   the project's work-page `frontier.runnable` and `goingCold` rows without
 *   building them (MMR-763).
 * - `now`, `shipped` (MMR-504): the work page's rows across every active
 *   project. They come from the work page's own section rules and row builders
 *   ({@link classifyWork}), run once over all the projects' tasks, so a
 *   project's rows here equal its work report's. Across projects `now` lists
 *   the latest move (submit, else start) first and `shipped` the newest first.
 *   `shipped` needs `timeZone` to place its window and is empty without one.
 *
 * `findings` is the `doctor` finding count per project key; a key that is not
 * an active project (`store`, an archived project) is ignored. Core never runs
 * doctor itself, so the caller supplies the counts, as a promise when the scan
 * is still running so it overlaps the store load.
 */
export async function reviewOf(
  store: Store,
  findings: ReadonlyMap<string, number> | Promise<ReadonlyMap<string, number>>,
  opts: ReviewOptions = {},
): Promise<ReviewReport> {
  const asOf = opts.asOf ?? now();
  const shippedWindow =
    opts.timeZone === undefined
      ? undefined
      : recentDaysWindow(asOf, SHIPPED_WINDOW_DAYS, opts.timeZone);
  // `new` is the untriaged lane; the same load serves the node derivation below.
  const [{ set, views }, findingCounts, activity] = await Promise.all([
    listSeedsResolved(store, { status: 'new' }),
    findings,
    store.loadProjectActivity(),
  ]);
  const untriagedByProject = countBy(views, (v) => v.project);
  const projects = set.ws.projects.filter((p) => p.archived_at === null);
  const tasksByProject = new Map(
    projects.map((p) => [
      p.key,
      (set.nodesByProject.get(p.key) ?? []).filter((n) => n.type === 'task'),
    ]),
  );
  const tasks = [...tasksByProject.values()].flat();
  const buckets = classifyWork(set, tasks, { asOf, shippedWindow });
  const source = workRowSource(store, set, buckets);

  const questions = await store.bodySections.readSectionsMany(
    buckets.needsYou.filter((d) => d.reason === 'needs_answers').map((d) => d.node.id),
    { annotations: true },
  );
  const taskRows: WorkNeedsYouRow[] = await Promise.all(
    buckets.needsYou.map(async ({ node, reason }) => ({
      kind: 'task',
      question:
        reason === 'needs_answers'
          ? (latestOf(questions.get(node.id)?.annotations)?.content ?? null)
          : null,
      reason,
      stale: buckets.staleIds.has(node.id),
      task: await source.viewOf(node),
    })),
  );
  const allNeedsYou = [...taskRows, ...(await recordNeedsYou(store, set))].toSorted(
    byNeedsYouRowOrder,
  );
  const needsYouByProject = Map.groupBy(allNeedsYou, needsYouProject);
  const inFlightByProject = countBy(buckets.now, (n) => n.project_id);
  const coldByProject = countBy(buckets.stale, (n) => n.project_id);
  const runnableByProject = countBy(buckets.frontier.filter(isRunnable), (e) => e.node.project_id);

  const facts: ProjectFacts[] = projects.map((project) => ({
    findings: findingCounts.get(project.key) ?? 0,
    goingCold: coldByProject.get(project.key) ?? 0,
    inFlight: inFlightByProject.get(project.key) ?? 0,
    live: (tasksByProject.get(project.key) ?? []).filter(
      (n) => !isTerminalWord(nodeStatusWord(set, n)),
    ).length,
    needsYou: needsYouByProject.get(project.key) ?? [],
    project,
    runnable: runnableByProject.get(project.key) ?? 0,
    untriaged: untriagedByProject.get(project.key) ?? 0,
  }));

  const [nowRows, shippedRows] = await Promise.all([
    nowRowsOf(source),
    shippedRowsOf(source, shippedWindow),
  ]);
  const needsYou: ReviewNeedsYouGroup[] = facts
    .flatMap((f) => {
      const [lead] = f.needsYou;
      return lead === undefined ? [] : [{ facts: f, key: f.project.key, lead }];
    })
    .toSorted(byUrgency)
    .map(({ facts: f }) => ({
      project: { key: f.project.key, name: f.project.name },
      rows: f.needsYou,
    }));
  const queue = allNeedsYou.map((row) => ({ id: needsYouId(row), kind: row.kind }));

  const railOrder = byRailOrder(activity);
  const reviewProjects: ReviewProject[] = facts
    .toSorted((a, b) => railOrder(a.project, b.project))
    .map((f) => ({
      findings: f.findings,
      goingCold: f.goingCold,
      inFlight: f.inFlight,
      key: f.project.key,
      live: f.live,
      name: f.project.name,
      needsYou: f.needsYou.length,
      runnable: f.runnable,
      triage: triageCount(f),
      untriaged: f.untriaged,
    }));

  return {
    needsYou,
    needsYouFacts: needsYouFactsOf(set, allNeedsYou),
    now: tagged(nowRows).toSorted((a, b) => cmpStr(lastMoveOf(b), lastMoveOf(a))),
    projects: reviewProjects,
    queue,
    shipped: tagged(shippedRows),
  };
}
