/**
 * Mutation command handlers for the CLI write surface (Phase 3).
 * Each handler receives a `Ctx` built once in `run.ts` and shared across all
 * write verbs. Tasks 4–8 will add more handlers here and cases to `run.ts`.
 */

import { abandonTask, completeTask, startTask } from "../core";
import type { Db } from "../core";
import { usage } from "./errors";
import type { Format, Io } from "./render";
import { echoNode, resolveNode } from "./resolve";

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
export function requirePos(c: Ctx, i: number, verb: string): string {
  const v = c.positionals[i];
  if (v === undefined) throw usage(`${verb} requires a node id (KEY-seq)`);
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
  const reason = c.positionals.slice(2).join(" ") || undefined;
  await abandonTask(c.db, id, reason);
  await echoNode(c.db, id, c.format, c.io);
  return 0;
}
