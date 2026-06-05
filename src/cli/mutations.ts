/**
 * Mutation command handlers for the CLI write surface (Phase 3).
 * Each handler receives a `Ctx` built once in `run.ts` and shared across all
 * write verbs. Tasks 4–8 will add more handlers here and cases to `run.ts`.
 */

import {
  abandonTask,
  annotate,
  blockTask,
  completeTask,
  createInitiative,
  createPhase,
  createProject,
  createTask,
  depend,
  moveNode,
  parkTask,
  reorder,
  startTask,
  unblockTask,
  undepend,
  unparkTask,
  updateNode,
} from "../core";
import type { Db, RankPosition, UpdateFields } from "../core";
import { usage } from "./errors";
import { parsePriority, parseSize } from "./parse";
import type { Format, Io } from "./render";
import { echoNode, readContent, resolveNode, resolveParent } from "./resolve";

/** Shared dispatch context built once in `run.ts` for every write verb. */
export interface Ctx {
  db: Db;
  /** Full positionals including the verb at [0]. */
  positionals: string[];
  values: Record<string, unknown>;
  format: Format;
  io: Io;
}

/** Assert that positional at index `i` is present, else throw a usage error. */
export function requirePos(c: Ctx, i: number, verb: string, noun = "a node id (KEY-seq)"): string {
  const v = c.positionals[i];
  if (v === undefined) throw usage(`${verb} requires ${noun}`);
  return v;
}

export async function cmdStart(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, "start"));
  await startTask(c.db, id);
  await echoNode(c.db, id, c.format, c.io);
  return 0;
}

export async function cmdDone(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, "done"));
  await completeTask(c.db, id);
  await echoNode(c.db, id, c.format, c.io);
  return 0;
}

export async function cmdAbandon(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, "abandon"));
  await abandonTask(c.db, id, reasonTail(c));
  await echoNode(c.db, id, c.format, c.io);
  return 0;
}

const reasonTail = (c: Ctx): string | undefined => c.positionals.slice(2).join(" ") || undefined;

export async function cmdPark(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, "park"));
  await parkTask(c.db, id, reasonTail(c));
  await echoNode(c.db, id, c.format, c.io);
  return 0;
}

export async function cmdUnpark(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, "unpark"));
  await unparkTask(c.db, id);
  await echoNode(c.db, id, c.format, c.io);
  return 0;
}

export async function cmdBlock(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, "block"));
  await blockTask(c.db, id, reasonTail(c));
  await echoNode(c.db, id, c.format, c.io);
  return 0;
}

export async function cmdUnblock(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, "unblock"));
  await unblockTask(c.db, id);
  await echoNode(c.db, id, c.format, c.io);
  return 0;
}

async function resolveIds(db: Db, csv: string): Promise<number[]> {
  return Promise.all(csv.split(",").map((t) => resolveNode(db, t.trim())));
}

export async function cmdDepend(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, "depend"));
  if (typeof c.values.on !== "string") throw usage("depend requires --on <ids>");
  await depend(c.db, id, await resolveIds(c.db, c.values.on));
  await echoNode(c.db, id, c.format, c.io);
  return 0;
}

export async function cmdUndepend(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, "undepend"));
  if (typeof c.values.on !== "string") throw usage("undepend requires --on <ids>");
  await undepend(c.db, id, await resolveIds(c.db, c.values.on));
  await echoNode(c.db, id, c.format, c.io);
  return 0;
}

export async function cmdMove(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, "move"));
  if (typeof c.values.to !== "string") throw usage("move requires --to <parent>");
  const parentId = await resolveNode(c.db, c.values.to);
  await moveNode(c.db, id, parentId);
  await echoNode(c.db, id, c.format, c.io);
  return 0;
}

export async function cmdReorder(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, "reorder"));
  let position: RankPosition;
  let refId: number | null = null;
  if (c.values.top === true) {
    position = "top";
  } else if (c.values.bottom === true) {
    position = "bottom";
  } else if (typeof c.values.before === "string") {
    position = "before";
    refId = await resolveNode(c.db, c.values.before);
  } else if (typeof c.values.after === "string") {
    position = "after";
    refId = await resolveNode(c.db, c.values.after);
  } else {
    throw usage("reorder requires one of --top | --bottom | --before <id> | --after <id>");
  }
  await reorder(c.db, id, position, refId);
  await echoNode(c.db, id, c.format, c.io);
  return 0;
}

export async function cmdUpdate(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, "update"));
  const fields: UpdateFields = {};
  if (typeof c.values.title === "string") fields.title = c.values.title;
  if (typeof c.values.desc === "string") fields.description = c.values.desc;
  if (typeof c.values.priority === "string") fields.priority = parsePriority(c.values.priority);
  if (typeof c.values.size === "string") fields.size = parseSize(c.values.size);
  if (typeof c.values.target === "string") fields.target = c.values.target;
  if (typeof c.values.ref === "string") fields.externalRef = c.values.ref;
  await updateNode(c.db, id, fields);
  await echoNode(c.db, id, c.format, c.io);
  return 0;
}

export async function cmdAnnotate(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, "annotate"));
  const content = await readContent(c.positionals.slice(2), c.io);
  if (content === "") throw usage("annotate requires content (positional or stdin)");
  await annotate(c.db, id, content);
  await echoNode(c.db, id, c.format, c.io);
  return 0;
}

function strFlag(c: Ctx, name: string, msg: string): string {
  const v = c.values[name];
  if (typeof v !== "string") throw usage(msg);
  return v;
}

function optStr(c: Ctx, name: string): string | undefined {
  const v = c.values[name];
  return typeof v === "string" ? v : undefined;
}

export async function cmdCreate(c: Ctx): Promise<number> {
  const type = c.positionals[1];
  switch (type) {
    case "project": {
      const project = await createProject(c.db, {
        key: strFlag(c, "key", "create project requires --key"),
        name: strFlag(c, "name", "create project requires --name"),
        repo: optStr(c, "repo"),
        path: optStr(c, "path"),
      });
      if (c.format === "json" || c.format === "jsonl") {
        c.io.write(JSON.stringify({ project: { key: project.key, name: project.name } }));
      } else if (c.format === "ids") {
        c.io.write(project.key);
      } else {
        c.io.write(`${c.io.plain ? "[ok]" : "\x1b[32m✓\x1b[0m"} created project ${project.key}`);
      }
      return 0;
    }
    case "initiative": {
      const title = requirePos(c, 2, "create initiative", "a title");
      const parent = await resolveParent(
        c.db,
        strFlag(c, "parent", "create initiative requires --parent <KEY>"),
      );
      if (parent.kind !== "project") throw usage("an initiative's --parent must be a project KEY");
      const node = await createInitiative(c.db, {
        projectId: parent.id,
        title,
        description: optStr(c, "desc"),
      });
      await echoNode(c.db, node.id, c.format, c.io);
      return 0;
    }
    case "phase": {
      const title = requirePos(c, 2, "create phase", "a title");
      const parent = await resolveParent(
        c.db,
        strFlag(c, "parent", "create phase requires --parent <id>"),
      );
      if (parent.kind !== "node")
        throw usage("a phase's --parent must be an initiative node (KEY-seq)");
      const node = await createPhase(c.db, {
        parentId: parent.id,
        title,
        description: optStr(c, "desc"),
        target: optStr(c, "target"),
      });
      await echoNode(c.db, node.id, c.format, c.io);
      return 0;
    }
    case "task": {
      const title = requirePos(c, 2, "create task", "a title");
      const parent = await resolveParent(
        c.db,
        strFlag(c, "parent", "create task requires --parent <id>"),
      );
      if (parent.kind !== "node")
        throw usage("a task's --parent must be a phase or initiative node (KEY-seq)");
      const node = await createTask(c.db, {
        parentId: parent.id,
        title,
        description: optStr(c, "desc"),
        priority:
          typeof c.values.priority === "string" ? parsePriority(c.values.priority) : undefined,
        size: typeof c.values.size === "string" ? parseSize(c.values.size) : undefined,
        externalRef: optStr(c, "ref"),
      });
      await echoNode(c.db, node.id, c.format, c.io);
      return 0;
    }
    default:
      throw usage(
        `create: unknown type ${type ?? "(none)"} (expected project|initiative|phase|task)`,
      );
  }
}
