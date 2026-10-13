import type {
  ReviewDecisionGroup,
  ReviewProject,
  ReviewReport,
  ReviewTriageGroup,
  SeedView,
  WorkNeedsYouReason,
  WorkShippedTask,
} from '@mimir/contract';

import type { DerivationSet } from '../derive';
import { nodeStatusWord } from '../derive';
import type { Node, Project } from '../model';
import { isStale } from '../predicates';
import { listSeedsResolved } from '../seeds/intent';
import type { Store } from '../store';
import { now } from '../time';
import { buildNodeView } from './view';
import {
  NEEDS_YOU_REASON_ORDER,
  abandonedOf,
  byNeedsYouOrder,
  cmpStr,
  latestOf,
  needsYouReasonOf,
  seqOf,
} from './work';

/**
 * The review page (MMR-477): the console's cross-project derivation of what
 * needs the operator. Ordering rules are ADR 0019's MMR-476 refinement.
 */

export type ReviewOptions = {
  /** Reference time (ISO-ms-Z) for staleness; defaults to now. */
  asOf?: string;
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
  set: DerivationSet,
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
        task: await buildNodeView(store.bodySections, store.artifacts, set, last.node),
      };
}

/**
 * The review page across every active (non-archived) project.
 *
 * - `decisions`: per project with any, the work page's `needsYou` rows (the
 *   membership rule is {@link needsYouReasonOf}), projects in urgency order.
 * - `queue`: every decision's task id, verdicts then blocks then questions,
 *   newest first within each reason, ignoring project.
 * - `triage`: per project with anything to triage, the untriaged seeds (oldest
 *   first), the tasks going cold, and the findings; most first, then key.
 * - `projects`: every active project in the decisions order, then by triage.
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
  // `new` is the untriaged lane; the same load serves the node derivation below.
  const [{ set, views }, findingCounts] = await Promise.all([
    listSeedsResolved(store, { status: 'new' }),
    findings,
  ]);
  const seedsByProject = Map.groupBy(views, (v) => v.project);
  const finished: Node[] = [];

  const facts: ProjectFacts[] = set.ws.projects
    .filter((p) => p.archived_at === null)
    .map((project) => {
      const decisions: ProjectFacts['decisions'] = [];
      let goingCold = 0;
      let inFlight = 0;
      for (const node of set.nodesByProject.get(project.key) ?? []) {
        if (node.type !== 'task') {
          continue;
        }
        if (node.lifecycle === 'done' || node.lifecycle === 'abandoned') {
          finished.push(node);
        }
        const word = nodeStatusWord(set, node);
        const reason = needsYouReasonOf(node, word);
        if (reason !== undefined) {
          decisions.push({ node, reason });
        }
        if (word === 'in_progress') {
          inFlight += 1;
        }
        if (isStale(set, node, { asOf })) {
          goingCold += 1;
        }
      }
      decisions.sort(byNeedsYouOrder);
      return {
        decisions,
        findings: findingCounts.get(project.key) ?? 0,
        goingCold,
        inFlight,
        project,
        seeds: seedsByProject.get(project.key) ?? [],
      };
    })
    .toSorted(byProjectOrder);

  const questionIds = facts.flatMap((f) =>
    f.decisions.filter((d) => d.reason === 'needs_answers').map((d) => d.node.id),
  );
  const questions = await store.bodySections.readSectionsMany(questionIds, { annotations: true });
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
            stale: isStale(set, node, { asOf }),
            task: await buildNodeView(store.bodySections, store.artifacts, set, node),
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

  const projects: ReviewProject[] = facts.map((f) => ({
    decisions: f.decisions.length,
    inFlight: f.inFlight,
    key: f.project.key,
    name: f.project.name,
    triage: triageCount(f),
  }));

  return {
    decisions,
    lastFinished: await lastFinishOf(store, set, finished),
    projects,
    queue,
    triage,
  };
}
