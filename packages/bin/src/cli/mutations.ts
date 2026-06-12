/**
 * Mutation command handlers for the CLI write surface (Phase 3).
 * Each handler receives a `Ctx` built once in `run.ts` and shared across all
 * write verbs. Tasks 4–8 will add more handlers here and cases to `run.ts`.
 */

import {
  abandonTask,
  annotate,
  attachArtifact,
  blockTask,
  completeTask,
  createInitiative,
  createPhase,
  createProject,
  createTask,
  depend,
  findArtifactByRef,
  findNodeByRef,
  getArtifact,
  moveNode,
  parseIdentity,
  notFound,
  parkTask,
  reorder,
  resolveEntityToken,
  startTask,
  tagEntities,
  unblockTask,
  undepend,
  unparkTask,
  untagEntities,
  updateArtifact,
  updateNode,
  validation,
} from "../core";
import type { Db, RankPosition, UpdateFields } from "../core";
import { usage } from "./errors";
import { parsePriority, parseSize } from "./parse";
import { renderArtifactDetail } from "./render";
import type { Format, Io } from "./render";
import { echoNode, readContent, resolveNode, resolveParent, resolveProject } from "./resolve";

/** Shared dispatch context built once in `run.ts` for every write verb. */
export interface Ctx {
  db: Db;
  /** Full positionals including the verb at [0]. */
  positionals: string[];
  values: Record<string, unknown>;
  format: Format;
  io: Io;
}

/** Assert that positional at index `i` is present and non-blank, else throw a usage error. */
export function requirePos(c: Ctx, i: number, verb: string, noun = "a node id (KEY-seq)"): string {
  const v = c.positionals[i];
  if (v === undefined || v.trim() === "") throw usage(`${verb} requires ${noun}`);
  return v;
}

/**
 * Assert a flag's token is non-blank, else throw a usage error — a blank
 * where a required id belongs is a malformed invocation, not a lookup miss
 * (MMR-41: `--to ''` is usage/exit 2, never not_found/exit 1).
 */
function requireToken(value: string, verb: string, flag: string): string {
  if (value.trim() === "") throw usage(`${verb} --${flag} expects an id (KEY-seq)`);
  return value;
}

export async function cmdStart(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, "start"), "task");
  await startTask(c.db, id);
  await echoNode(c.db, id, c.format, c.io);
  return 0;
}

export async function cmdDone(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, "done"), "task");
  await completeTask(c.db, id);
  await echoNode(c.db, id, c.format, c.io);
  return 0;
}

export async function cmdAbandon(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, "abandon"), "task");
  await abandonTask(c.db, id, reasonTail(c));
  await echoNode(c.db, id, c.format, c.io);
  return 0;
}

const reasonTail = (c: Ctx): string | undefined => c.positionals.slice(2).join(" ") || undefined;

export async function cmdPark(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, "park"), "task");
  await parkTask(c.db, id, reasonTail(c));
  await echoNode(c.db, id, c.format, c.io);
  return 0;
}

export async function cmdUnpark(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, "unpark"), "task");
  await unparkTask(c.db, id);
  await echoNode(c.db, id, c.format, c.io);
  return 0;
}

export async function cmdBlock(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, "block"), "task");
  await blockTask(c.db, id, reasonTail(c));
  await echoNode(c.db, id, c.format, c.io);
  return 0;
}

export async function cmdUnblock(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, "unblock"), "task");
  await unblockTask(c.db, id);
  await echoNode(c.db, id, c.format, c.io);
  return 0;
}

async function resolveIds(db: Db, csv: string, verb: string, flag: string): Promise<number[]> {
  const tokens = csv.split(",").map((t) => requireToken(t, verb, flag).trim());
  return Promise.all(tokens.map((t) => resolveNode(db, t)));
}

export async function cmdDepend(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, "depend"));
  const on = lastFlag(c, "on");
  if (on === undefined) throw usage("depend requires --on <ids>");
  await depend(c.db, id, await resolveIds(c.db, on, "depend", "on"));
  await echoNode(c.db, id, c.format, c.io);
  return 0;
}

export async function cmdUndepend(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, "undepend"));
  const on = lastFlag(c, "on");
  if (on === undefined) throw usage("undepend requires --on <ids>");
  await undepend(c.db, id, await resolveIds(c.db, on, "undepend", "on"));
  await echoNode(c.db, id, c.format, c.io);
  return 0;
}

export async function cmdMove(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, "move"));
  if (typeof c.values.to !== "string") throw usage("move requires --to <parent>");
  const parentId = await resolveNode(c.db, requireToken(c.values.to, "move", "to"));
  await moveNode(c.db, id, parentId);
  await echoNode(c.db, id, c.format, c.io);
  return 0;
}

export async function cmdReorder(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, "reorder"), "task");
  let position: RankPosition;
  let refId: number | null = null;
  const before = lastFlag(c, "before");
  const after = lastFlag(c, "after");
  if (c.values.top === true) {
    position = "top";
  } else if (c.values.bottom === true) {
    position = "bottom";
  } else if (before !== undefined) {
    position = "before";
    refId = await resolveNode(c.db, requireToken(before, "reorder", "before"));
  } else if (after !== undefined) {
    position = "after";
    refId = await resolveNode(c.db, requireToken(after, "reorder", "after"));
  } else {
    throw usage("reorder requires one of --top | --bottom | --before <id> | --after <id>");
  }
  await reorder(c.db, id, position, refId);
  await echoNode(c.db, id, c.format, c.io);
  return 0;
}

export async function cmdUpdate(c: Ctx): Promise<number> {
  const token = requirePos(c, 1, "update");
  if (parseIdentity(token)?.kind === "artifact") {
    return await cmdUpdateArtifact(c, token);
  }
  const id = await resolveNode(c.db, token);
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

/** `update KEY-aN` — title is an artifact's one mutable field (MMR-40). */
async function cmdUpdateArtifact(c: Ctx, token: string): Promise<number> {
  for (const [key, flag] of [
    ["desc", "--desc"],
    ["priority", "--priority"],
    ["size", "--size"],
    ["target", "--target"],
    ["ref", "--ref"],
  ] as const) {
    if (c.values[key] !== undefined) {
      throw validation(`${flag} applies only to nodes — title is an artifact's one mutable field`);
    }
  }
  const identity = parseIdentity(token);
  if (identity?.kind !== "artifact") throw notFound(`no artifact with id ${token}`);
  const artifact = await findArtifactByRef(c.db, identity);
  if (artifact === undefined) throw notFound(`no artifact ${token}`);
  if (typeof c.values.title === "string") {
    await updateArtifact(c.db, artifact.id, { title: c.values.title });
  }
  renderArtifactDetail(await getArtifact(c.db, token), c.format, c.io);
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

export async function cmdAttach(c: Ctx): Promise<number> {
  const file = optStr(c, "file");
  // Content from --file, else stdin — but never block on an interactive TTY.
  const content =
    file !== undefined ? await Bun.file(file).text() : c.io.isTTY ? "" : await Bun.stdin.text();
  if (content.trim() === "") throw usage("attach requires content (--file <path> or piped stdin)");

  // Node references: the positional primary (if any) + --link csv.
  const linkTokens: string[] = [];
  const primary = c.positionals[1];
  if (primary !== undefined) linkTokens.push(primary);
  if (typeof c.values.link === "string") {
    linkTokens.push(
      ...c.values.link
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    );
  }

  let projectId: number;
  const linkNodeIds: number[] = [];
  if (linkTokens.length > 0) {
    const nodes = await Promise.all(
      linkTokens.map(async (t) => {
        const n = await findNodeByRef(c.db, t);
        if (n === undefined) throw notFound(`no node ${t}`);
        return n;
      }),
    );
    const projects = new Set(nodes.map((n) => n.project_id));
    if (projects.size > 1) throw validation("all attached nodes must be in one project");
    const [projectIdFromNodes] = projects; // number | undefined under noUncheckedIndexedAccess
    if (projectIdFromNodes === undefined)
      throw validation("internal: nodes resolved but project_id missing");
    projectId = projectIdFromNodes;
    linkNodeIds.push(...nodes.map((n) => n.id));
    if (typeof c.values.project === "string") {
      const explicit = await resolveProject(c.db, c.values.project);
      if (explicit !== projectId)
        throw validation("--project disagrees with the linked node(s)' project");
    }
  } else {
    projectId = await resolveProject(
      c.db,
      strFlag(c, "project", "attach requires a node id or --project <KEY>"),
    );
  }

  const explicitTitle = optStr(c, "title");
  const basename = file?.split("/").pop();
  const title = explicitTitle ?? basename;
  if (title === undefined || title.trim() === "") {
    throw usage("attach from stdin requires --title <text>");
  }
  const { renderedId } = await attachArtifact(c.db, {
    projectId,
    title,
    content,
    linkNodeIds,
    tags: tagFlags(c),
  });
  if (c.format === "json" || c.format === "jsonl")
    c.io.write(JSON.stringify({ artifact: { id: renderedId } }));
  else if (c.format === "ids") c.io.write(renderedId);
  else c.io.write(`${c.io.plain ? "[ok]" : "\x1b[32m✓\x1b[0m"} attached artifact ${renderedId}`);
  return 0;
}

function strFlag(c: Ctx, name: string, msg: string): string {
  const v = c.values[name];
  if (typeof v !== "string") throw usage(msg);
  return v;
}

/**
 * Read a flag that parseArgs collects as `multiple` (shared with the query
 * date-ops, MMR-33) as a single string — the last occurrence wins.
 */
function lastFlag(c: Ctx, name: string): string | undefined {
  const v = c.values[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length > 0) {
    const last: unknown = v[v.length - 1];
    return typeof last === "string" ? last : undefined;
  }
  return undefined;
}

function optStr(c: Ctx, name: string): string | undefined {
  const v = c.values[name];
  return typeof v === "string" ? v : undefined;
}

/** The repeatable `--tag` values on create (MMR-31). */
function tagFlags(c: Ctx): string[] | undefined {
  const v = c.values.tag;
  return Array.isArray(v) && v.length > 0 ? (v as string[]) : undefined;
}

const splitCsv = (csv: string): string[] =>
  csv
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

/** Echo a tag/untag result — ids + tags, no node reload (the op is the news). */
function echoTagOp(c: Ctx, verb: "tagged" | "untagged", ids: string[], tags: string[]): void {
  if (c.format === "json" || c.format === "jsonl") {
    c.io.write(JSON.stringify({ [verb]: { ids, tags } }));
  } else if (c.format === "ids") {
    c.io.write(ids.join("\n"));
  } else {
    const glyph = c.io.plain ? "[ok]" : "\x1b[32m✓\x1b[0m";
    c.io.write(`${glyph} ${verb} ${ids.join(", ")}: ${tags.join(", ")}`);
  }
}

export async function cmdTag(c: Ctx): Promise<number> {
  const ids = splitCsv(requirePos(c, 1, "tag", "ids (comma-separated)"));
  if (ids.length === 0) throw usage("tag requires ids (comma-separated)");
  const tags = c.positionals.slice(2);
  if (tags.length === 0) throw usage("tag requires at least one tag");
  const targets = await Promise.all(ids.map((t) => resolveEntityToken(c.db, t)));
  await tagEntities(c.db, targets, tags, optStr(c, "note"));
  echoTagOp(c, "tagged", ids, tags);
  return 0;
}

export async function cmdUntag(c: Ctx): Promise<number> {
  const ids = splitCsv(requirePos(c, 1, "untag", "ids (comma-separated)"));
  if (ids.length === 0) throw usage("untag requires ids (comma-separated)");
  const tags = c.positionals.slice(2);
  if (tags.length === 0) throw usage("untag requires at least one tag");
  const targets = await Promise.all(ids.map((t) => resolveEntityToken(c.db, t)));
  await untagEntities(c.db, targets, tags);
  echoTagOp(c, "untagged", ids, tags);
  return 0;
}

export async function cmdCreate(c: Ctx): Promise<number> {
  const type = c.positionals[1];
  switch (type) {
    case "project": {
      // Positional name like every other create type (MMR-35); --name still works.
      const name = c.positionals[2] ?? optStr(c, "name");
      if (name === undefined) {
        throw usage("create project requires a name", 'create project "Name" --key KEY');
      }
      const key = strFlag(c, "key", "create project requires --key");
      // The key is immutable, so creation is the one gated write (ADR 0011
      // grooming): interactive sessions confirm at a prompt; non-interactive
      // callers must pass -y/--yes — the recorded proof confirmation happened.
      if (c.values.yes !== true) {
        if (!c.io.isTTY) {
          throw usage(
            `create project ${key}: the key is immutable — confirmation required`,
            "re-run with -y/--yes to confirm",
          );
        }
        if (
          !globalThis.confirm(`create project ${key} ("${name}") — the key is immutable. proceed?`)
        ) {
          c.io.error(`${c.io.plain ? "[err]" : "\x1b[31m✗\x1b[0m"} aborted`);
          return 1;
        }
      }
      const project = await createProject(c.db, {
        key,
        name,
        tags: tagFlags(c),
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
        tags: tagFlags(c),
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
        tags: tagFlags(c),
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
        tags: tagFlags(c),
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
