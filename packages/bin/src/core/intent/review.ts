import type {
  NodeView,
  ReviewDecisionGroup,
  ReviewProject,
  ReviewReport,
  ReviewTriageGroup,
  ReviewWorkRow,
  SeedView,
  WorkNeedsYouReason,
  WorkShippedTask,
} from '@mimir/contract';

import { recentDaysWindow } from '../dates';
import { isTerminalWord, nodeStatusWord } from '../derive';
import type { Node, Project } from '../model';
import { listSeedsResolved } from '../seeds/intent';
import type { Store } from '../store';
import { now } from '../time';
import {
  NEEDS_YOU_REASON_ORDER,
  SHIPPED_WINDOW_DAYS,
  abandonedOf,
  byNeedsYouOrder,
  classifyWork,
  cmpStr,
  goingColdRowsOf,
  latestOf,
  nowRowsOf,
  projectKeyOf,
  runnableRowsOf,
  seqOf,
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
  /** Decision nodes in the work page's order (verdicts, blocks, questions; newest first). */
  decisions: { node: Node; reason: WorkNeedsYouReason }[];
  seeds: SeedView[];
  goingCold: number;
  findings: number;
  inFlight: number;
  live: number;
};

const triageCount = (f: ProjectFacts): number => f.seeds.length + f.goingCold + f.findings;

const cmpKey = (a: ProjectFacts, b: ProjectFacts): number => cmpStr(a.project.key, b.project.key);

/** The reason that decides a project's urgency, and when its newest decision of that reason moved. */
const leadOf = (f: ProjectFacts): { rank: number; updatedAt: string } | undefined => {
  const [lead] = f.decisions;
  return lead === undefined
    ? undefined
    : { rank: NEEDS_YOU_REASON_ORDER.indexOf(lead.reason), updatedAt: lead.node.updated_at };
};

/**
 * Project order: projects with decisions first, by leading reason, then the
 * newer leading decision, then key; the rest by triage count (most first),
 * then key.
 */
function byProjectOrder(a: ProjectFacts, b: ProjectFacts): number {
  const left = leadOf(a);
  const right = leadOf(b);
  if (left !== undefined && right !== undefined) {
    return left.rank - right.rank || cmpStr(right.updatedAt, left.updatedAt) || cmpKey(a, b);
  }
  if (left !== undefined || right !== undefined) {
    return left === undefined ? 1 : -1;
  }
  return triageCount(b) - triageCount(a) || cmpKey(a, b);
}

/** A finish candidate: the finished task and when it finished. */
type Finish = { node: Node; at: string };

/** Newer finish first; the higher seq breaks a same-millisecond tie, as on the work page. */
const newerFinish = (a: Finish, b: Finish): number =>
  cmpStr(b.at, a.at) || seqOf(b.node.id) - seqOf(a.node.id);

/**
 * The newest done or abandoned task among `finished`, the work page's Shipped
 * rule without its window. A done task finished at `completed_at`. An abandon
 * finished at its transition, which only history records; `updated_at` is
 * never earlier, so only the abandons that could beat the newest done task are
 * read.
 */
async function lastFinishOf(
  store: Store,
  viewOf: (node: Node) => Promise<NodeView>,
  finished: readonly Node[],
): Promise<WorkShippedTask | null> {
  const [lastDone] = finished
    .filter((n) => n.lifecycle === 'done')
    .map((node) => ({ at: node.completed_at ?? node.updated_at, node }))
    .toSorted(newerFinish);
  const abandons = finished.filter(
    (n) => n.lifecycle === 'abandoned' && (lastDone === undefined || n.updated_at >= lastDone.at),
  );
  const histories = await store.bodySections.readSectionsMany(
    abandons.map((n) => n.id),
    { history: true },
  );
  const reasons = new Map<string, string | null>();
  const candidates: Finish[] = abandons.map((node) => {
    const abandoned = abandonedOf(node, histories.get(node.id)?.history ?? []);
    reasons.set(node.id, abandoned.reason);
    return { at: abandoned.at, node };
  });
  if (lastDone !== undefined) {
    candidates.push(lastDone);
  }
  const [last] = candidates.toSorted(newerFinish);
  return last === undefined
    ? null
    : {
        abandonReason: reasons.get(last.node.id) ?? null,
        finishedAt: last.at,
        stale: false,
        task: await viewOf(last.node),
      };
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
 * - `decisions`: per project with any, the work page's `needsYou` rows (the
 *   membership rule is `needsYouReasonOf`), projects in urgency order.
 * - `queue`: every decision's task id, verdicts then blocks then questions,
 *   newest first within each reason, ignoring project.
 * - `triage`: per project with anything to triage, the untriaged seeds (oldest
 *   first), the tasks going cold, and the findings; most first, then key.
 * - `projects`: every active project in the rail's order (pinned first, then
 *   newest activity), with its decision, triage, in-flight, live, and going-cold
 *   counts. `live` is the `--status live` group: every status but done and
 *   abandoned, so parked work counts.
 * - `now`, `shipped`, `runnable`, `goingCold` (MMR-504): the work page's rows
 *   across every active project. They come from the work page's own section
 *   rules and row builders ({@link classifyWork}), run once over all the
 *   projects' tasks, so a project's rows here equal its work report's. Across
 *   projects `now` lists the most recently started first, `runnable` follows the
 *   `projects` order and then each project's rank, `goingCold` the longest quiet
 *   first, and `shipped` the newest first. `shipped` needs `timeZone` to place
 *   its window and is empty without one.
 * - `lastFinished`: the newest done or abandoned task, for the page's all-clear
 *   state; null when nothing has finished.
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
  const seedsByProject = Map.groupBy(views, (v) => v.project);
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

  const decisionsByProject = Map.groupBy(
    buckets.needsYou.toSorted(byNeedsYouOrder),
    (d) => d.node.project_id,
  );
  const inFlightByProject = Map.groupBy(buckets.now, (n) => n.project_id);
  const coldByProject = Map.groupBy(buckets.stale, (n) => n.project_id);

  const facts: ProjectFacts[] = projects
    .map((project) => ({
      decisions: decisionsByProject.get(project.key) ?? [],
      findings: findingCounts.get(project.key) ?? 0,
      goingCold: coldByProject.get(project.key)?.length ?? 0,
      inFlight: inFlightByProject.get(project.key)?.length ?? 0,
      live: (tasksByProject.get(project.key) ?? []).filter(
        (n) => !isTerminalWord(nodeStatusWord(set, n)),
      ).length,
      project,
      seeds: seedsByProject.get(project.key) ?? [],
    }))
    .toSorted(byProjectOrder);

  const questionIds = facts.flatMap((f) =>
    f.decisions.filter((d) => d.reason === 'needs_answers').map((d) => d.node.id),
  );
  const [questions, nowRows, shippedRows, runnableRows, coldViews, lastFinished] =
    await Promise.all([
      store.bodySections.readSectionsMany(questionIds, { annotations: true }),
      nowRowsOf(source),
      shippedRowsOf(source, shippedWindow),
      runnableRowsOf(source),
      goingColdRowsOf(source),
      lastFinishOf(
        store,
        source.viewOf,
        tasks.filter((n) => n.lifecycle === 'done' || n.lifecycle === 'abandoned'),
      ),
    ]);
  const decisions: ReviewDecisionGroup[] = await Promise.all(
    facts
      .filter((f) => f.decisions.length > 0)
      .map(async (f) => ({
        project: { key: f.project.key, name: f.project.name },
        rows: await Promise.all(
          f.decisions.map(async ({ node, reason }) => ({
            question:
              reason === 'needs_answers'
                ? (latestOf(questions.get(node.id)?.annotations)?.content ?? null)
                : null,
            reason,
            stale: buckets.staleIds.has(node.id),
            task: await source.viewOf(node),
          })),
        ),
      })),
  );

  const queue = facts
    .flatMap((f) => f.decisions)
    .toSorted(byNeedsYouOrder)
    .map((d) => d.node.id);

  const triage: ReviewTriageGroup[] = facts
    .filter((f) => triageCount(f) > 0)
    .toSorted((a, b) => triageCount(b) - triageCount(a) || cmpKey(a, b))
    .map((f) => ({
      findings: f.findings,
      goingCold: f.goingCold,
      project: { key: f.project.key, name: f.project.name },
      seeds: f.seeds,
    }));

  const railOrder = byRailOrder(activity);
  const reviewProjects: ReviewProject[] = facts
    .toSorted((a, b) => railOrder(a.project, b.project))
    .map((f) => ({
      decisions: f.decisions.length,
      goingCold: f.goingCold,
      inFlight: f.inFlight,
      key: f.project.key,
      live: f.live,
      name: f.project.name,
      triage: triageCount(f),
    }));

  const railIndex = new Map(reviewProjects.map((p, i) => [p.key, i]));

  return {
    decisions,
    goingCold: coldViews.map((task) => ({ project: projectKeyOf(task.id), task })),
    lastFinished,
    now: tagged(nowRows).toSorted((a, b) => cmpStr(b.startedAt, a.startedAt)),
    projects: reviewProjects,
    queue,
    // Project order, then the project's own rank: the rows arrive in one global
    // rank order, which restricted to a project is that project's rank order, and
    // the sort is stable.
    runnable: tagged(runnableRows).toSorted(
      (a, b) => (railIndex.get(a.project) ?? 0) - (railIndex.get(b.project) ?? 0),
    ),
    shipped: tagged(shippedRows),
    triage,
  };
}
