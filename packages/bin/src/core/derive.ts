import type { StatusWord } from "@mimir/contract";
import type { Node } from "../db/schema";
import type { Db, Tx } from "./context";
import { invariant } from "./errors";
import { renderNodeId } from "./lookup";
import { type Distribution, interpret, tally, taskStatus } from "./status";

/**
 * The live-derivation layer: a node's Status word, the rollup distribution, and
 * the completeness notion the dependency predicates rest on. Everything here is
 * computed on read — never stored (the spine; ADR 0001/0008).
 */

type Executor = Db | Tx;

/** Terminal = a decided end state. `abandoned` counts as terminal (and never freezes a parent). */
export function isTerminalWord(word: StatusWord): boolean {
  return word === "done" || word === "abandoned";
}

/**
 * Is a node "settled" for dependency purposes — i.e. it no longer holds up work
 * that depends on it? A task is settled iff its lifecycle is terminal; a
 * non-leaf iff its rollup is terminal.
 *
 * A dependency is satisfied when its prerequisite is **terminal**, so an
 * *abandoned* prerequisite satisfies (it no longer blocks), consistent with
 * "abandoned never freezes." ADR 0001's original shorthand was "all deps done";
 * refined (2026-06-05) to "all deps settled" so an abandoned prerequisite does
 * not strand its dependent forever — see ADR 0001 § "Refinement — dependency
 * satisfaction is terminal, not done."
 */
export async function isNodeSettled(
  tx: Executor,
  node: Pick<Node, "id" | "type" | "lifecycle">,
): Promise<boolean> {
  if (node.type === "task") {
    return node.lifecycle === "done" || node.lifecycle === "abandoned";
  }
  return isTerminalWord(interpret(await childDistribution(tx, node.id)));
}

/** Does this task have ≥1 unsettled prerequisite? (The derived `awaiting` condition.) */
export async function hasUnsettledPrereq(tx: Executor, taskId: number): Promise<boolean> {
  const prereqs = await tx
    .selectFrom("dependency")
    .innerJoin("node", "node.id", "dependency.depends_on_node_id")
    .where("dependency.node_id", "=", taskId)
    .select(["node.id", "node.type", "node.lifecycle"])
    .execute();
  for (const prereq of prereqs) {
    if (!(await isNodeSettled(tx, prereq))) {
      return true;
    }
  }
  return false;
}

/** Project any node to its Status word (ADR 0008): a task via its axes + readiness, a non-leaf via `interpret`. */
export async function nodeStatusWord(tx: Executor, node: Node): Promise<StatusWord> {
  if (node.type === "task") {
    if (node.lifecycle === null || node.hold === null) {
      const rendered = (await renderNodeId(tx, node.id)) ?? "task";
      throw invariant(`${rendered} is missing a status axis`);
    }
    const awaiting = await hasUnsettledPrereq(tx, node.id);
    return taskStatus({ lifecycle: node.lifecycle, hold: node.hold, awaiting });
  }
  return interpret(await childDistribution(tx, node.id));
}

/** The rollup distribution over a node's **direct** children (their Status words tallied). */
export async function childDistribution(tx: Executor, nodeId: number): Promise<Distribution> {
  const children = await tx
    .selectFrom("node")
    .selectAll()
    .where("parent_id", "=", nodeId)
    .execute();
  const words: StatusWord[] = [];
  for (const child of children) {
    words.push(await nodeStatusWord(tx, child));
  }
  return tally(words);
}

/** `status_of` — a node's distribution and its single `interpret` label together (label = what, distribution = why). */
export async function statusOf(
  tx: Executor,
  node: Node,
): Promise<{ status: StatusWord; distribution: Distribution }> {
  if (node.type === "task") {
    return { status: await nodeStatusWord(tx, node), distribution: {} };
  }
  const distribution = await childDistribution(tx, node.id);
  return { status: interpret(distribution), distribution };
}

/**
 * The status tally over a project's **leaf tasks** — every `type = "task"` node
 * in the project (any depth), its derived status word counted (MMR-105). The
 * leaf-level sibling of {@link childDistribution} (direct children) and
 * {@link rootDistribution} (project roots); backs the fleet card's vitals panel.
 */
export async function leafDistribution(tx: Executor, projectId: number): Promise<Distribution> {
  const tasks = await tx
    .selectFrom("node")
    .selectAll()
    .where("project_id", "=", projectId)
    .where("type", "=", "task")
    .execute();
  const words: StatusWord[] = [];
  for (const task of tasks) {
    words.push(await nodeStatusWord(tx, task));
  }
  return tally(words);
}

/** The rollup distribution over a project's **root** nodes (the cascade's top step, MMR-32). */
export async function rootDistribution(tx: Executor, projectId: number): Promise<Distribution> {
  const roots = await tx
    .selectFrom("node")
    .selectAll()
    .where("project_id", "=", projectId)
    .where("parent_id", "is", null)
    .execute();
  const words: StatusWord[] = [];
  for (const root of roots) {
    words.push(await nodeStatusWord(tx, root));
  }
  return tally(words);
}

/** `status_of` for a whole project — `interpret` over its root nodes. */
export async function statusOfProject(
  tx: Executor,
  projectId: number,
): Promise<{ status: StatusWord; distribution: Distribution }> {
  const distribution = await rootDistribution(tx, projectId);
  return { status: interpret(distribution), distribution };
}
