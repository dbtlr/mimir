import type { Verdicts } from "../contract/dto";
import type { Node } from "../db/schema";
import type { Db, Tx } from "./context";
import { hasUnsettledPrereq, isNodeSettled, isTerminalWord, nodeStatusWord } from "./derive";
import { loadNode } from "./lookup";
import { now } from "./time";

/**
 * The derived predicate vocabulary (design spec §4, glossary). Each is computed
 * live because it depends on dependencies or ancestors and flips silently when
 * *those* change — storing it would reintroduce the sync surface Mimir exists
 * to remove.
 */

type Executor = Db | Tx;

/** `ready` — the headline: a todo, un-held task with every prerequisite settled. */
export async function isReady(tx: Executor, task: Node): Promise<boolean> {
  if (task.type !== "task" || task.lifecycle !== "todo" || task.hold !== "none") {
    return false;
  }
  return !(await hasUnsettledPrereq(tx, task.id));
}

/** `awaiting` — `ready`'s involuntary sibling: todo + un-held but with ≥1 unsettled prerequisite. */
export async function isAwaiting(tx: Executor, task: Node): Promise<boolean> {
  if (task.type !== "task" || task.lifecycle !== "todo" || task.hold !== "none") {
    return false;
  }
  return hasUnsettledPrereq(tx, task.id);
}

/** `blocked` — the manual hold overlay (distinct from the derived `awaiting`). */
export function isBlocked(task: Node): boolean {
  return task.type === "task" && task.hold === "blocked";
}

/** `blocking` — this node is a prerequisite of ≥1 still-unsettled dependent. */
export async function isBlocking(tx: Executor, node: Node): Promise<boolean> {
  const dependents = await tx
    .selectFrom("dependency")
    .innerJoin("node", "node.id", "dependency.node_id")
    .where("dependency.depends_on_node_id", "=", node.id)
    .select(["node.id", "node.type", "node.lifecycle"])
    .execute();
  for (const dependent of dependents) {
    if (!(await isNodeSettled(tx, dependent))) {
      return true;
    }
  }
  return false;
}

/** Default `stale` threshold — fixed (the Brief defers per-size refinement). 14 days. */
export const STALE_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;

export interface StaleOptions {
  /** Reference time (ISO-ms-Z). Defaults to now — injectable for tests. */
  asOf?: string;
  thresholdMs?: number;
}

/**
 * `stale` — a task whose Status word is `in_progress`, `ready`, or `blocked` and
 * whose `updated_at` is older than the threshold (glossary). Mutes `parked` and
 * `awaiting` (auto-clearing / deliberately set aside — don't nag); chases
 * `blocked` (untouched-for-weeks is exactly the nudge).
 */
export async function isStale(
  tx: Executor,
  task: Node,
  options: StaleOptions = {},
): Promise<boolean> {
  if (task.type !== "task") {
    return false;
  }
  const word = await nodeStatusWord(tx, task);
  if (word !== "in_progress" && word !== "ready" && word !== "blocked") {
    return false;
  }
  const asOf = options.asOf ?? now();
  const thresholdMs = options.thresholdMs ?? STALE_THRESHOLD_MS;
  const ageMs = Date.parse(asOf) - Date.parse(task.updated_at);
  return ageMs > thresholdMs;
}

/**
 * `orphaned` — a non-terminal task stranded under a parent whose *other*
 * children are all terminal (so the parent is effectively closed out around it).
 *
 * The original glossary wording — "parent phase/initiative is done/abandoned" —
 * is unsatisfiable under strict derivation: a non-leaf can never roll up to a
 * terminal word while it still has a live child (this very task). The glossary
 * `orphaned` entry was refined (2026-06-05) to the meaningful sibling of that
 * intent, which this computes: a non-terminal task whose every *other* sibling
 * is terminal (a sole live child is not orphaned).
 */
export async function isOrphaned(tx: Executor, task: Node): Promise<boolean> {
  if (task.type !== "task" || task.parent_id === null) {
    return false;
  }
  if (task.lifecycle === "done" || task.lifecycle === "abandoned") {
    return false;
  }
  const parent = await loadNode(tx, task.parent_id);
  if (parent === undefined || parent.type === "task") {
    return false;
  }
  const siblings = await tx
    .selectFrom("node")
    .selectAll()
    .where("parent_id", "=", parent.id)
    .where("id", "!=", task.id)
    .execute();
  if (siblings.length === 0) {
    return false;
  }
  for (const sibling of siblings) {
    if (!isTerminalWord(await nodeStatusWord(tx, sibling))) {
      return false;
    }
  }
  return true;
}

/**
 * All non-status verdicts for one node in one read (the `verdicts` facet —
 * the API record's always-on derivation). Status words carry everything else.
 */
export async function verdictsOf(
  tx: Executor,
  node: Node,
  options: StaleOptions = {},
): Promise<Verdicts> {
  return {
    stale: await isStale(tx, node, options),
    blocking: await isBlocking(tx, node),
    orphaned: await isOrphaned(tx, node),
  };
}
