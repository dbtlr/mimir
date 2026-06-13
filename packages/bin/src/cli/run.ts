import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { cmdSelfUpdate, cmdService, type ServiceDeps } from "../service";
import {
  CHEAP_FACETS,
  FACET_NAMES,
  type FacetName,
  type FieldFilter,
  type NodeView,
  type QueryOp,
  STATUS_SELECTOR_VALUES,
  type SetResult,
  type StatusSelector,
  VERDICT_VALUES,
  type Verdict,
  type VerdictSelector,
} from "@mimir/contract";
import {
  MimirError,
  formatIds,
  formatSetJson,
  formatSetJsonl,
  formatStatusJson,
  getArtifact,
  getNode,
  listNodes,
  nextTasks,
  parseFilterToken,
  parseIdentity,
  statusOfNode,
} from "../core";
import type { Db } from "../core";
import { FULL_HELP, TERSE_HELP } from "./help";
import {
  FORMATS,
  type Format,
  type Io,
  renderArtifactDetail,
  renderNodeView,
  renderRecords,
  renderStatus,
  renderTable,
} from "./render";
import { exitCodeFor, isRenderable, renderError, renderWarnings, usage } from "./errors";
import { BINDING_FILE, writeBinding } from "./binding";
import { SKILL_AGENTS, SKILL_FILES, type SkillAgent, skillDirFor } from "./skill-assets";
import { resolveProject } from "./resolve";
import { parsePriority, parseSize } from "./parse";
import {
  type Ctx,
  cmdAbandon,
  cmdAnnotate,
  cmdAttach,
  cmdBlock,
  cmdCreate,
  cmdDepend,
  cmdDone,
  cmdMove,
  cmdPark,
  cmdReorder,
  cmdStart,
  cmdTag,
  cmdUnblock,
  cmdUndepend,
  cmdUnpark,
  cmdUntag,
  cmdUpdate,
} from "./mutations";

const OPTIONS = {
  scope: { type: "string", short: "s" },
  priority: { type: "string", short: "p" },
  size: { type: "string" },
  status: { type: "string" },
  is: { type: "string", multiple: true },
  "not-is": { type: "string", multiple: true },
  eq: { type: "string", multiple: true },
  "not-eq": { type: "string", multiple: true },
  in: { type: "string", multiple: true },
  "not-in": { type: "string", multiple: true },
  has: { type: "string", multiple: true },
  missing: { type: "string", multiple: true },
  before: { type: "string", multiple: true },
  on: { type: "string", multiple: true },
  after: { type: "string", multiple: true },
  "not-before": { type: "string", multiple: true },
  "not-after": { type: "string", multiple: true },
  tag: { type: "string", short: "t", multiple: true },
  note: { type: "string" },
  type: { type: "string" },
  limit: { type: "string", short: "n" },
  col: { type: "string", multiple: true },
  format: { type: "string", short: "f" },
  ascii: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  // Write-surface flags — `--on` / `--before` / `--after` are shared with the
  // query date-ops above (multiple); the write verbs read the last value.
  to: { type: "string" },
  parent: { type: "string" },
  key: { type: "string" },
  name: { type: "string" },
  desc: { type: "string" },
  target: { type: "string" },
  ref: { type: "string" },
  file: { type: "string" },
  link: { type: "string" },
  project: { type: "string" },
  top: { type: "boolean" },
  bottom: { type: "boolean" },
  title: { type: "string" },
  yes: { type: "boolean", short: "y" },
  // skill install
  global: { type: "boolean" },
  local: { type: "boolean" },
  agent: { type: "string" },
  // service flag
  port: { type: "string" },
} as const;

/**
 * Per-invocation environment defaults resolved by the composition root —
 * the Project Binding scope (ADR 0011) and the directory `bind` writes into.
 * Injected so the CLI stays testable without touching the real cwd.
 */
export interface Defaults {
  scope?: string;
  cwd?: string;
  /** Real service/self-update edges; absent where supervision is unavailable (tests). */
  service?: ServiceDeps;
}

/**
 * The effective `-s` scope: an explicit flag wins; the literal `all` is the
 * cross-project escape (a key is uppercase, so `all` can never collide);
 * otherwise the Project Binding's key, if any.
 */
function effectiveScope(
  explicit: string | undefined,
  bound: string | undefined,
): string | undefined {
  if (explicit === "all") return undefined;
  return explicit ?? bound;
}

/**
 * Run the CLI for one invocation. `argv` is the args after `mimir`; `getDb`
 * lazily supplies an open, migrated database — it must be idempotent (the
 * caller owns the connection's lifecycle) and is called only by verbs that
 * touch data, so help/usage/`skill` paths never open a store (MMR-39); `io`
 * is the injected sink + presentation context. Returns the process exit code.
 */
export async function runCli(
  argv: string[],
  getDb: () => Db | Promise<Db>,
  io: Io,
  defaults: Defaults = {},
): Promise<number> {
  let values: {
    scope?: string;
    priority?: string;
    size?: string;
    status?: string;
    is?: string[];
    "not-is"?: string[];
    eq?: string[];
    "not-eq"?: string[];
    in?: string[];
    "not-in"?: string[];
    has?: string[];
    missing?: string[];
    before?: string[];
    on?: string[];
    after?: string[];
    "not-before"?: string[];
    "not-after"?: string[];
    tag?: string[];
    note?: string;
    type?: string;
    limit?: string;
    col?: string[];
    format?: string;
    ascii?: boolean;
    help?: boolean;
    // Write-surface flags
    to?: string;
    parent?: string;
    key?: string;
    name?: string;
    desc?: string;
    target?: string;
    ref?: string;
    file?: string;
    link?: string;
    project?: string;
    top?: boolean;
    bottom?: boolean;
    title?: string;
    yes?: boolean;
    global?: boolean;
    local?: boolean;
    agent?: string;
    port?: string;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const fmt = errorFormat(argv);
    renderError(usage(msg), fmt, io);
    if (fmt !== "json" && fmt !== "jsonl") io.error(TERSE_HELP);
    return 2;
  }

  const command = positionals[0];
  if (command === undefined || values.help === true) {
    io.write(argv.includes("--help") ? FULL_HELP : TERSE_HELP);
    return 0;
  }

  const ctx: Io = { ...io, plain: io.plain || values.ascii === true };

  try {
    // The write echo's format, picked inside the try block so a bad --format
    // value is caught and rendered.
    const singleFormat = pickFormat(values.format, "single", ctx);
    // Mutation context shared across all write-verb handlers — built lazily so
    // the store is acquired only by verbs that actually touch data (MMR-39):
    // help, usage errors, and `skill install` never open or create it.
    const mkCtx = async (): Promise<Ctx> => ({
      db: await getDb(),
      positionals,
      values: values as Record<string, unknown>,
      format: singleFormat,
      io: ctx,
    });

    switch (command) {
      case "next":
        return runSet(
          await nextTasks(await getDb(), {
            scope: effectiveScope(values.scope, defaults.scope),
            priority: parsePriority(values.priority),
            size: parseSize(values.size),
            verdicts: parseVerdicts(values.is, values["not-is"]),
            filters: parseFilters(values),
            limit: parseLimit(values.limit),
            facets: parseFacets(values.col),
          }),
          values.format,
          ctx,
        );
      case "list":
        return runSet(
          await listNodes(await getDb(), {
            scope: effectiveScope(values.scope, defaults.scope),
            status: parseStatus(values.status),
            verdicts: parseVerdicts(values.is, values["not-is"]),
            filters: parseFilters(values),
            priority: parsePriority(values.priority),
            size: parseSize(values.size),
            tag: values.tag?.[0],
            limit: parseLimit(values.limit),
            facets: parseFacets(values.col),
          }),
          values.format,
          ctx,
        );
      case "get": {
        const id = requireId(positionals[1], "get");
        const db = await getDb();
        if (parseIdentity(id)?.kind === "artifact") {
          const content = (values.col ?? []).includes("content");
          renderArtifactDetail(
            await getArtifact(db, id, { content }),
            pickFormat(values.format, "single", ctx),
            ctx,
          );
          return 0;
        }
        const facets = parseFacets(values.col);
        const node = await getNode(db, id, {
          facets: facets.length > 0 ? [...new Set([...CHEAP_FACETS, ...facets])] : undefined,
        });
        return renderSingle(node, values.format, ctx);
      }
      case "status": {
        const id = requireId(positionals[1], "status");
        const status = await statusOfNode(await getDb(), id);
        const format = pickFormat(values.format, "status", ctx);
        ctx.write(format === "json" ? formatStatusJson(status) : renderStatus(status, ctx));
        return 0;
      }
      case "start":
        return await cmdStart(await mkCtx());
      case "done":
        return await cmdDone(await mkCtx());
      case "abandon":
        return await cmdAbandon(await mkCtx());
      case "park":
        return await cmdPark(await mkCtx());
      case "unpark":
        return await cmdUnpark(await mkCtx());
      case "block":
        return await cmdBlock(await mkCtx());
      case "unblock":
        return await cmdUnblock(await mkCtx());
      case "depend":
        return await cmdDepend(await mkCtx());
      case "undepend":
        return await cmdUndepend(await mkCtx());
      case "move":
        return await cmdMove(await mkCtx());
      case "reorder":
        return await cmdReorder(await mkCtx());
      case "update":
        return await cmdUpdate(await mkCtx());
      case "annotate":
        return await cmdAnnotate(await mkCtx());
      case "attach":
        return await cmdAttach(await mkCtx());
      case "create":
        return await cmdCreate(await mkCtx());
      case "tag":
        return await cmdTag(await mkCtx());
      case "untag":
        return await cmdUntag(await mkCtx());
      case "skill": {
        const sub = positionals[1];
        if (sub !== "install") {
          throw usage("skill: unknown subcommand (expected: skill install)");
        }
        if (values.global === true && values.local === true) {
          throw usage("skill install takes --global or --local, not both");
        }
        const agent = values.agent ?? "claude";
        if (!(SKILL_AGENTS as readonly string[]).includes(agent)) {
          throw usage(`unknown agent: ${agent} (expected ${SKILL_AGENTS.join("|")})`);
        }
        const base = values.local === true ? (defaults.cwd ?? process.cwd()) : homedir();
        const dir = skillDirFor(agent as SkillAgent, base);
        for (const f of SKILL_FILES) {
          const target = `${dir}/${f.path}`;
          mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
          writeFileSync(target, f.content);
        }
        if (singleFormat === "json" || singleFormat === "jsonl") {
          ctx.write(JSON.stringify({ installed: { path: dir, files: SKILL_FILES.length, agent } }));
        } else if (singleFormat === "ids") {
          ctx.write(dir);
        } else {
          const glyph = ctx.plain ? "[ok]" : "\x1b[32m✓\x1b[0m";
          ctx.write(`${glyph} installed the mimir skill → ${dir} (${SKILL_FILES.length} files)`);
        }
        return 0;
      }
      case "bind": {
        const key = positionals[1];
        if (key === undefined) throw usage("bind requires a project KEY");
        await resolveProject(await getDb(), key); // validates the project exists (not_found otherwise)
        writeBinding(defaults.cwd ?? process.cwd(), key);
        if (singleFormat === "json" || singleFormat === "jsonl") {
          ctx.write(JSON.stringify({ bound: { project: key, file: BINDING_FILE } }));
        } else if (singleFormat === "ids") {
          ctx.write(key);
        } else {
          const glyph = ctx.plain ? "[ok]" : "\x1b[32m✓\x1b[0m";
          ctx.write(`${glyph} bound to ${key} (${BINDING_FILE})`);
        }
        return 0;
      }
      case "service": {
        if (defaults.service === undefined) {
          throw usage("service is unavailable in this context");
        }
        return await cmdService(positionals, { port: values.port }, ctx, defaults.service);
      }
      case "self-update": {
        if (defaults.service === undefined) {
          throw usage("self-update is unavailable in this context");
        }
        return await cmdSelfUpdate(ctx, defaults.service);
      }
      default:
        throw usage(`unknown command: ${command}`);
    }
  } catch (error) {
    if (isRenderable(error)) {
      renderError(error, errorFormat(argv), ctx);
      return exitCodeFor(error);
    }
    throw error;
  }
}

/**
 * Determine the error rendering format from the raw argv. Returns "json" or
 * "jsonl" iff the user explicitly requested it, else "records" (human default).
 * Scanning raw argv avoids depending on the already-parsed values, which may
 * not be available when a parseArgs failure occurs.
 *
 * Handles both separate-token form (`--format json`) and equals form
 * (`--format=json`, `-f=json`).
 */
function errorFormat(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    // Equals form: --format=json or -f=json
    const eqMatch = /^(?:--format|-f)=(.+)$/.exec(arg);
    if (eqMatch) {
      const val = eqMatch[1];
      if (val === "json" || val === "jsonl") return val;
      continue;
    }
    // Separate-token form: --format json or -f json
    if ((arg === "-f" || arg === "--format") && i < argv.length - 1) {
      const val = argv[i + 1] ?? "";
      if (val === "json" || val === "jsonl") return val;
    }
  }
  return "records";
}

function runSet(result: SetResult<NodeView>, explicit: string | undefined, io: Io): number {
  const format = pickFormat(explicit, "set", io);
  if (result.warnings !== undefined && result.warnings.length > 0) {
    renderWarnings(result.warnings, format, io);
  }
  switch (format) {
    case "ids":
      io.write(formatIds(result.items));
      break;
    case "json":
      io.write(formatSetJson(result));
      break;
    case "jsonl":
      io.write(formatSetJsonl(result.items));
      break;
    case "records":
      io.write(result.items.map((n) => renderRecords(n, io)).join("\n\n"));
      break;
    case "table":
      io.write(renderTable(result, io));
      break;
  }
  return 0;
}

function renderSingle(node: NodeView, explicit: string | undefined, io: Io): number {
  renderNodeView(node, pickFormat(explicit, "single", io), io);
  return 0;
}

function pickFormat(
  explicit: string | undefined,
  kind: "set" | "single" | "status",
  io: Io,
): Format {
  if (explicit !== undefined) {
    if (!(FORMATS as readonly string[]).includes(explicit)) {
      throw usage(`unknown format: ${explicit} (expected ${FORMATS.join("|")})`);
    }
    return explicit as Format;
  }
  if (!io.isTTY) {
    return kind === "status" ? "json" : "ids";
  }
  if (kind === "set") return "table";
  return kind === "status" ? "json" : "records";
}

function requireId(id: string | undefined, command: string): string {
  if (id === undefined) {
    throw usage(`${command} requires an id (KEY | KEY-seq | KEY-aN)`);
  }
  return id;
}

/**
 * The flat `--col` vocabulary (MMR-38) — the dot prefix is gone (it fenced a
 * dynamic namespace Mimir doesn't have). One closed list; `content` is
 * artifact-only and handled by the `get KEY-aN` path.
 */
function parseFacets(cols: string[] | undefined): FacetName[] {
  const facets: FacetName[] = [];
  for (const col of cols ?? []) {
    if (col.startsWith(".")) {
      throw usage(`columns are flat now: --col ${col.slice(1)} (the dot prefix was dropped)`);
    }
    if (col === "content") continue; // artifact-only; a node simply has no body
    if (!(FACET_NAMES as readonly string[]).includes(col)) {
      throw usage(`unknown column: ${col}`, `columns: ${[...FACET_NAMES, "content"].join(", ")}`);
    }
    facets.push(col as FacetName);
  }
  return facets;
}

function parseStatus(value: string | undefined): StatusSelector | undefined {
  if (value === undefined) return undefined;
  if (!(STATUS_SELECTOR_VALUES as readonly string[]).includes(value)) {
    throw usage(`invalid status: ${value} (expected ${STATUS_SELECTOR_VALUES.join("|")})`);
  }
  return value as StatusSelector;
}

function parseVerdicts(is: string[] | undefined, notIs: string[] | undefined): VerdictSelector[] {
  const out: VerdictSelector[] = [];
  const take = (tokens: string[] | undefined, negate: boolean): void => {
    for (const token of tokens ?? []) {
      if (!(VERDICT_VALUES as readonly string[]).includes(token)) {
        throw usage(`invalid verdict: ${token} (expected ${VERDICT_VALUES.join("|")})`);
      }
      out.push({ verdict: token as Verdict, negate });
    }
  };
  take(is, false);
  take(notIs, true);
  return out;
}

/** The query-op flags, in declaration order. */
const OP_FLAGS = [
  "eq",
  "not-eq",
  "in",
  "not-in",
  "has",
  "missing",
  "before",
  "on",
  "after",
  "not-before",
  "not-after",
] as const;

/**
 * Collect FIELD:VALUE filter tokens from the op flags. Structural faults
 * (unknown field, operator-type mismatch) surface as usage — the caller's
 * invocation is wrong (exit 2); the same fault over MCP stays `validation`.
 */
function parseFilters(values: Record<string, unknown>): FieldFilter[] {
  const filters: FieldFilter[] = [];
  for (const op of OP_FLAGS) {
    const tokens = values[op];
    if (!Array.isArray(tokens)) continue;
    for (const token of tokens as string[]) {
      try {
        filters.push(parseFilterToken(op as QueryOp, token));
      } catch (error) {
        if (error instanceof MimirError) throw usage(error.message, error.hint);
        throw error;
      }
    }
  }
  return filters;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) {
    throw usage(`invalid limit: ${value}`);
  }
  return n;
}
